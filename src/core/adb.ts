// src/core/adb.ts — adb 访问层：设备解析、命令执行、环境体检（doctor）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { run, text, type ExecResult } from "./exec.ts";

/** 找 adb：环境变量 → ANDROID_HOME → 常见安装位置 → PATH */
function findAdb(): string {
  if (process.env.ADB_BIN) return process.env.ADB_BIN;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    `${process.env.HOME}/Android/Sdk`,
    "/usr/lib/android-sdk",
    "/opt/android-sdk",
  ].filter(Boolean) as string[];
  for (const r of roots) {
    const p = `${r}/platform-tools/adb`;
    if (existsSync(p)) return p;
  }
  return "adb";
}

export const ADB_BIN = findAdb();

export const IS_WSL =
  existsSync("/proc/version") &&
  /microsoft/i.test(readFileSync("/proc/version", "utf8"));

const DEFAULT_ENDPOINT = "tcp:127.0.0.1:5037";
const CANDIDATE_PORTS = [5037, 5038, 5039, 5040];

export type EndpointSource = "env" | "auto" | "default" | null;

export type EndpointProbe = {
  endpoint: string;
  adb: boolean;
  devices: Device[];
  error?: string;
};

/** 显式配置优先；没有配置时由 resolveEndpoint() 在候选端口里自动发现。 */
function explicitEndpoint(): string | null {
  const socket = process.env.ANDROID_MCP_ADB_SERVER_SOCKET || process.env.ADB_SERVER_SOCKET;
  if (socket) {
    const short = /^tcp:(\d+)$/.exec(socket);
    return short ? `tcp:127.0.0.1:${short[1]}` : socket;
  }
  const port = process.env.ANDROID_ADB_SERVER_PORT;
  if (port && /^\d+$/.test(port)) return `tcp:127.0.0.1:${port}`;
  return null;
}

let cachedEndpoint: string | null = explicitEndpoint();
let endpointSource: EndpointSource = cachedEndpoint ? "env" : null;

function adbEnv(endpoint: string | null): Record<string, string | undefined> {
  const env = { ...process.env };
  if (endpoint) {
    env.ADB_SERVER_SOCKET = endpoint;
    delete env.ANDROID_ADB_SERVER_PORT;
  }
  return env;
}

/** 当前连接目标（doctor 与日志用）。 */
export function currentEndpoint(): { endpoint: string; source: EndpointSource } {
  return { endpoint: cachedEndpoint ?? DEFAULT_ENDPOINT, source: endpointSource };
}

/** 设备换了 server 或端口后，让下一次调用重新发现。显式配置不会被清掉。 */
export function resetEndpoint(): void {
  if (endpointSource === "env") return;
  cachedEndpoint = null;
  endpointSource = null;
}

export type Device = {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  transportId?: string;
  raw: string;
};

export type AdbResult = { code: number; out: string; err: string };

async function rawAdb(
  args: string[],
  opts: { serial?: string; timeoutMs?: number; endpoint: string | null },
): Promise<ExecResult> {
  const full = opts.serial ? ["-s", opts.serial, ...args] : args;
  return run(ADB_BIN, full, {
    timeoutMs: opts.timeoutMs ?? 30_000,
    env: adbEnv(opts.endpoint),
  });
}

/**
 * adb server 用 `000chost:version` 握手：只连 TCP 不保证是 adb，
 * 而直接 `adb devices` 打到非 adb 端口会挂住。
 */
function isAdbServer(endpoint: string, timeoutMs = 400): Promise<boolean> {
  const m = /^tcp:([^:]+):(\d+)$/.exec(endpoint);
  if (!m) return Promise.resolve(false);
  const host = m[1]!;
  const port = Number(m[2]);
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write("000chost:version"));
    socket.once("data", (buf) => done(buf.toString("utf8", 0, 4) === "OKAY"));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** WSL 下从 Windows 的 adb 进程命令行补充非标准端口（best effort）。 */
async function windowsAdbServerPorts(): Promise<number[]> {
  const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (!IS_WSL || !existsSync(powershell)) return [];
  const r = await run(
    powershell,
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='adb.exe'\" | Select-Object -ExpandProperty CommandLine",
    ],
    { timeoutMs: 1500, env: process.env },
  );
  const ports = new Set<number>();
  for (const m of text(r).matchAll(/-L\s+tcp:(\d+)/g)) ports.add(Number(m[1]));
  return [...ports];
}

async function candidateEndpoints(): Promise<string[]> {
  const ports = new Set<number>(CANDIDATE_PORTS);
  for (const port of await windowsAdbServerPorts()) ports.add(port);
  const endpoints = [...ports].map((port) => `tcp:127.0.0.1:${port}`);
  const explicit = explicitEndpoint();
  return explicit ? [explicit, ...endpoints.filter((endpoint) => endpoint !== explicit)] : endpoints;
}

async function probeEndpoint(endpoint: string): Promise<EndpointProbe> {
  if (!(await isAdbServer(endpoint))) return { endpoint, adb: false, devices: [] };
  const r = await rawAdb(["devices", "-l"], { endpoint, timeoutMs: 1_500 });
  if (r.code !== 0) {
    return { endpoint, adb: true, devices: [], error: r.stderr.trim() || "adb devices 失败" };
  }
  return { endpoint, adb: true, devices: parseDevices(text(r)) };
}

async function discoverEndpoint(): Promise<{ endpoint: string; source: EndpointSource; probes: EndpointProbe[] }> {
  const probes = await Promise.all((await candidateEndpoints()).map(probeEndpoint));
  const withDevice = probes.find((p) => p.devices.some((d) => READY_STATES.has(d.state)));
  const anyAdb = probes.find((p) => p.adb);
  const chosen = withDevice ?? anyAdb;
  return { endpoint: chosen?.endpoint ?? DEFAULT_ENDPOINT, source: chosen ? "auto" : "default", probes };
}

async function ensureEndpoint(): Promise<string | null> {
  if (cachedEndpoint) return cachedEndpoint;
  const found = await discoverEndpoint();
  if (found.source === "auto") {
    cachedEndpoint = found.endpoint;
    endpointSource = "auto";
    return cachedEndpoint;
  }
  // WSL 不能自己起 server：在 mirrored 模式下会和 Windows 抢 5037。
  if (IS_WSL) {
    cachedEndpoint = DEFAULT_ENDPOINT;
    endpointSource = "default";
    return cachedEndpoint;
  }
  endpointSource = "default";
  return null;
}

/** 执行 adb；serial 为空表示交给 adb 自己选（多设备时会失败，由上层解析） */
export async function adb(
  args: string[],
  opts: { serial?: string; timeoutMs?: number } = {},
): Promise<AdbResult> {
  const r = await rawAdb(args, { ...opts, endpoint: await ensureEndpoint() });
  return { code: r.code, out: text(r), err: r.stderr.trim() };
}

/** 执行 adb 并返回原始 Buffer（截图这类二进制输出用） */
export async function adbBuffer(
  args: string[],
  opts: { serial?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; buf: Buffer; err: string }> {
  const r = await rawAdb(args, { ...opts, endpoint: await ensureEndpoint(), timeoutMs: opts.timeoutMs ?? 60_000 });
  return { ok: r.code === 0, buf: r.stdout, err: r.stderr.trim() };
}

function parseDevices(out: string): Device[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((raw) => {
      const parts = raw.split(/\s+/);
      const serial = parts[0] ?? "";
      const state = parts[1] ?? "";
      const kv = new Map<string, string>();
      for (const p of parts.slice(2)) {
        const i = p.indexOf(":");
        if (i > 0) kv.set(p.slice(0, i), p.slice(i + 1));
      }
      return {
        serial,
        state,
        model: kv.get("model"),
        product: kv.get("product"),
        transportId: kv.get("transport_id"),
        raw,
      };
    });
}

export async function listDevices(): Promise<Device[]> {
  const first = await adb(["devices", "-l"], { timeoutMs: 5_000 });
  if (first.code !== 0) {
    throw new Error(
      `adb 不可用（${ADB_BIN}，endpoint=${currentEndpoint().endpoint}）：${first.err || "命令失败"}\n` +
        `排查：确认 Android SDK platform-tools 在 PATH 里，或设置 ADB_BIN / ANDROID_HOME。`,
    );
  }
  let devices = parseDevices(first.out);
  // 自动发现时 server 可能刚启动；空列表就重探一次。
  if (devices.length === 0 && endpointSource === "auto") {
    resetEndpoint();
    const second = await adb(["devices", "-l"], { timeoutMs: 5_000 });
    if (second.code === 0) devices = parseDevices(second.out);
  }
  return devices;
}

const READY_STATES = new Set(["device"]);

/**
 * 解析目标设备：
 *  - 传入 serial 则校验它在线
 *  - 未传则要求恰好一台在线设备（0 台/多台都给出可操作提示）
 */
export async function resolveSerial(requested?: string): Promise<string> {
  const devices = await listDevices();
  if (requested) {
    const d = devices.find((x) => x.serial === requested || x.serial.startsWith(requested));
    if (!d) {
      throw new Error(
        `找不到设备 ${requested}。当前：${devices.map((x) => `${x.serial}(${x.state})`).join(", ") || "无"}`,
      );
    }
    if (!READY_STATES.has(d.state)) {
      throw new Error(
        `设备 ${d.serial} 状态是 "${d.state}"，不可用。` +
          (d.state === "unauthorized" ? "请在手机上点「允许 USB 调试」。" : ""),
      );
    }
    return d.serial;
  }
  const ready = devices.filter((d) => READY_STATES.has(d.state));
  if (ready.length === 1) return ready[0].serial;
  if (ready.length === 0) {
    const pending = devices.map((d) => `${d.serial}(${d.state})`).join(", ");
    const ep = currentEndpoint();
    throw new Error(
      `没有可用设备。${pending ? `当前：${pending}` : ""}\n` +
        `当前 endpoint：${ep.endpoint}（${ep.source ?? "default"}）。\n` +
        `排查：手机 USB 调试是否开启/已授权；无线调试是否仍连接（adb connect ip:port）；` +
        `Windows/WSL 是否各起了一个 adb server（端口漂移时 MCP 会自动探测 5037–5040）。`,
    );
  }
  throw new Error(
    `有 ${ready.length} 台设备在线，请显式指定 device：${ready.map((d) => d.serial).join(", ")}`,
  );
}

export type DeviceInfo = {
  serial: string;
  model?: string;
  brand?: string;
  androidRelease?: string;
  sdk?: string;
  abi?: string;
};

export async function deviceInfo(serial: string): Promise<DeviceInfo> {
  const r = await adb(
    [
      "shell",
      "getprop ro.product.model; getprop ro.product.brand; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi",
    ],
    { serial, timeoutMs: 15_000 },
  );
  const lines = r.out.split("\n").map((l) => l.trim());
  return {
    serial,
    model: lines[0],
    brand: lines[1],
    androidRelease: lines[2],
    sdk: lines[3],
    abi: lines[4],
  };
}

// ── 体检 ────────────────────────────────────────────────────────────────────

function wslconfigFacts(): { path?: string; networkingMode?: string; hasInterop?: boolean } {
  if (!IS_WSL) return {};
  const candidates: string[] = [];
  try {
    for (const user of readdirSync("/mnt/c/Users")) {
      const p = `/mnt/c/Users/${user}/.wslconfig`;
      if (existsSync(p)) candidates.push(p);
    }
  } catch {
    /* /mnt/c 不可读则忽略 */
  }
  const path = candidates[0];
  if (!path) return { path: undefined };
  const body = readFileSync(path, "utf8");
  const mode = body.match(/^\s*networkingMode\s*=\s*(\S+)/m)?.[1];
  return { path, networkingMode: mode };
}

/** 本机自己监听的 adb 端口（有本地 adb server）。读 /proc/net/tcp，无需 root */
function localAdbServerPorts(): number[] {
  const ports = new Set<number>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1] ?? "";
      const st = cols[3] ?? "";
      if (st !== "0A") continue; // 0A = LISTEN
      const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
      if (port >= 5037 && port <= 5040) ports.add(port);
    }
  }
  return [...ports];
}

function windowsAdbInfo(): { bin: string; version?: string } | undefined {
  if (!IS_WSL) return undefined;
  const candidates: string[] = [];
  try {
    for (const user of readdirSync("/mnt/c/Users")) {
      for (const sdk of ["AppData/Local/Android/Sdk", "Android/Sdk"]) {
        const p = `/mnt/c/Users/${user}/${sdk}/platform-tools/adb.exe`;
        if (existsSync(p)) candidates.push(p);
      }
    }
  } catch {
    /* /mnt/c 不可读则忽略 */
  }
  return candidates[0] ? { bin: candidates[0] } : undefined;
}

export type DoctorReport = {
  adb: { bin: string; version?: string };
  environment: {
    wsl: boolean;
    wslconfig?: string;
    networkingMode?: string;
    mirrored: boolean;
    adbServer: "local" | "forwarded-to-windows" | "unknown";
    endpoint: string;
    endpointSource: EndpointSource;
    candidates: EndpointProbe[];
    windowsAdb?: { bin: string; version?: string };
  };
  devices: Device[];
  selected?: string;
  deviceInfo?: DeviceInfo;
  reverse: { supported: boolean; note: string };
  hints: string[];
};

/**
 * 体检：把「为什么 adb/热更新不通」变成可读结论。
 * 重点检测 mirrored 网络 + Windows 侧 adb server 的组合（本项目默认依赖它）。
 */
export async function doctor(serial?: string): Promise<DoctorReport> {
  const hints: string[] = [];
  const cfg = wslconfigFacts();
  const localPorts = localAdbServerPorts();
  const mirrored = cfg.networkingMode === "mirrored";
  const explicit = explicitEndpoint();

  const probes = await Promise.all((await candidateEndpoints()).map(probeEndpoint));
  const withDevice = probes.find((p) => p.devices.some((d) => READY_STATES.has(d.state)));
  const anyAdb = probes.find((p) => p.adb);
  const chosenProbe = explicit
    ? probes.find((p) => p.endpoint === explicit)
    : withDevice ?? anyAdb;
  const endpoint = explicit ?? chosenProbe?.endpoint ?? DEFAULT_ENDPOINT;
  const source: EndpointSource = explicit ? "env" : chosenProbe ? "auto" : "default";
  if (!explicit) {
    // 非 WSL 且没发现 server 时不要缓存默认端口，留给 adb 自己启动本地 server。
    if (source === "auto" || IS_WSL) {
      cachedEndpoint = endpoint;
      endpointSource = source;
    }
  }

  const ver = await adb(["version"], { timeoutMs: 10_000 });
  const version = (ver.out.match(/Version\s+([0-9.]+)/)?.[1]) ?? undefined;

  let devices: Device[] = [];
  let devInfo: DeviceInfo | undefined;
  let chosen: string | undefined;
  if (chosenProbe) {
    devices = chosenProbe.devices;
  } else {
    try {
      devices = await listDevices();
    } catch {
      /* resolveSerial 会给出更完整的错误 */
    }
  }
  try {
    chosen = await resolveSerial(serial);
    devInfo = await deviceInfo(chosen);
  } catch (e) {
    hints.push((e as Error).message);
  }

  let adbServer: DoctorReport["environment"]["adbServer"] = "unknown";
  if (IS_WSL) {
    adbServer = localPorts.length > 0 ? "local" : "forwarded-to-windows";
    if (localPorts.length > 0) {
      hints.push(
        `WSL 自己监听了 adb 端口 ${localPorts.join(", ")}；mirrored 模式下会和 Windows 抢同一个端口，` +
          `建议只保留一侧 server（通常让 Windows 持有 5037）。`,
      );
    }
    if (localPorts.length === 0 && !mirrored) {
      hints.push(
        "WSL 没有本地 adb server，且 networkingMode 不是 mirrored：WSL 的 adb 客户端无法连到 Windows 的 server。" +
          "两种解法：① 在 .wslconfig 里设 networkingMode=mirrored；② 改用 usbipd-win 把 USB 直接透传给 WSL。",
      );
    }
    if (localPorts.length === 0 && mirrored) {
      hints.push(
        "当前形态：adb server 在 Windows，WSL 经 mirrored loopback 复用。" +
          "adb reverse 的落点是 Windows 的 loopback，由 mirrored 网络转发到 WSL —— 已实测可用，但依赖该配置。",
      );
    }
  }

  const adbEndpoints = probes.filter((p) => p.adb).map((p) => p.endpoint);
  if (adbEndpoints.length > 1) {
    hints.push(
      `发现多个 adb server：${adbEndpoints.join(", ")}。` +
        `设备在 ${withDevice?.endpoint ?? "无设备 server"}；建议只保留一个（通常 5037），避免端口漂移。`,
    );
  }
  if (!explicit && withDevice && withDevice.endpoint !== DEFAULT_ENDPOINT) {
    hints.push(
      `自动发现：默认 ${DEFAULT_ENDPOINT} 没有设备，设备在 ${withDevice.endpoint}。` +
        `MCP 已自动切过去；建议之后把 Windows/WSL 收敛到同一个 server。`,
    );
  }
  if (explicit && !probes.find((p) => p.endpoint === explicit)?.adb) {
    hints.push(`显式 endpoint ${explicit} 不可达；显式配置优先，不会自动回退。`);
  }
  if (adbEndpoints.length === 0) {
    hints.push("没有发现可达的 adb server；检查手机 USB/授权，或在 Windows 上运行 adb start-server。");
  }

  const winAdb = windowsAdbInfo();
  if (winAdb) {
    const wr = await run(winAdb.bin, ["version"], { timeoutMs: 3_000 });
    winAdb.version = text(wr).match(/Version\s+([0-9.]+)/)?.[1];
    if (version && winAdb.version && version !== winAdb.version) {
      hints.push(
        `WSL adb ${version} 与 Windows adb ${winAdb.version} 版本不一致；` +
          `建议对齐 platform-tools，避免 client/server 重启和端口争抢。`,
      );
    }
  }

  // reverse 探测：注册一个临时端口再撤销（不依赖设备上是否有服务在听）
  let reverse = { supported: false, note: "" };
  if (chosen) {
    const probe = 40000 + Math.floor(Math.random() * 2000);
    const ar = await adb(["reverse", `tcp:${probe}`, `tcp:${probe}`], { serial: chosen, timeoutMs: 15_000 });
    if (ar.code === 0) {
      const list = await adb(["reverse", "--list"], { serial: chosen, timeoutMs: 10_000 });
      const ok = list.out.includes(String(probe));
      await adb(["reverse", `--remove`, `tcp:${probe}`], { serial: chosen, timeoutMs: 10_000 });
      reverse = {
        supported: ok,
        note: ok
          ? "adb reverse 可用：nsh dev 的 8790 端口可以直达设备 127.0.0.1:8790"
          : "adb reverse 注册后未出现在列表里，热更新可能不通",
      };
      if (!ok) hints.push(reverse.note);
    } else {
      reverse = { supported: false, note: `adb reverse 失败：${ar.err || "未知"}` };
      hints.push(reverse.note);
    }
  } else {
    reverse = { supported: false, note: "无可用设备，跳过 reverse 探测" };
  }

  return {
    adb: { bin: ADB_BIN, version },
    environment: {
      wsl: IS_WSL,
      wslconfig: cfg.path,
      networkingMode: cfg.networkingMode,
      mirrored,
      adbServer,
      endpoint,
      endpointSource: source,
      candidates: probes,
      windowsAdb: winAdb,
    },
    devices,
    selected: chosen,
    deviceInfo: devInfo,
    reverse,
    hints,
  };
}
