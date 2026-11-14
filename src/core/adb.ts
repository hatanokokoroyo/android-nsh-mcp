// src/core/adb.ts — adb 访问层：设备解析、命令执行、环境体检（doctor）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { run, text } from "./exec.ts";

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

export type Device = {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  transportId?: string;
  raw: string;
};

export type AdbResult = { code: number; out: string; err: string };

/** 执行 adb；serial 为空表示交给 adb 自己选（多设备时会失败，由上层解析） */
export async function adb(
  args: string[],
  opts: { serial?: string; timeoutMs?: number } = {},
): Promise<AdbResult> {
  const full = opts.serial ? ["-s", opts.serial, ...args] : args;
  const r = await run(ADB_BIN, full, { timeoutMs: opts.timeoutMs ?? 30_000 });
  return { code: r.code, out: text(r), err: r.stderr.trim() };
}

/** 执行 adb 并返回原始 Buffer（截图这类二进制输出用） */
export async function adbBuffer(
  args: string[],
  opts: { serial?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; buf: Buffer; err: string }> {
  const full = opts.serial ? ["-s", opts.serial, ...args] : args;
  const r = await run(ADB_BIN, full, { timeoutMs: opts.timeoutMs ?? 60_000 });
  return { ok: r.code === 0, buf: r.stdout, err: r.stderr.trim() };
}

export async function listDevices(): Promise<Device[]> {
  const r = await adb(["devices", "-l"], { timeoutMs: 15_000 });
  if (r.code !== 0) {
    throw new Error(
      `adb 不可用（${ADB_BIN}）：${r.err || "命令失败"}\n` +
        `排查：确认 Android SDK platform-tools 在 PATH 里，或设置 ADB_BIN / ANDROID_HOME。`,
    );
  }
  return r.out
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
    throw new Error(
      `没有可用设备。${pending ? `当前：${pending}` : ""}\n` +
        `排查：手机 USB 调试是否开启/已授权；无线调试是否仍连接（adb connect ip:port）。`,
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

/** 本机是否自己监听 5037（有本地 adb server）。读 /proc/net/tcp，无需 root */
function localAdbServerListening(): boolean {
  const hexPort = (5037).toString(16).toUpperCase().padStart(4, "0");
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1] ?? "";
      const st = cols[3] ?? "";
      if (local.endsWith(":" + hexPort) && st === "0A") return true; // 0A = LISTEN
    }
  }
  return false;
}

export type DoctorReport = {
  adb: { bin: string; version?: string };
  environment: {
    wsl: boolean;
    wslconfig?: string;
    networkingMode?: string;
    mirrored: boolean;
    adbServer: "local" | "forwarded-to-windows" | "unknown";
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
  const ver = await adb(["version"], { timeoutMs: 10_000 });
  const version = (ver.out.match(/Version\s+([0-9.]+)/)?.[1]) ?? undefined;

  const cfg = wslconfigFacts();
  const local = localAdbServerListening();
  const mirrored = cfg.networkingMode === "mirrored";

  let devices: Device[] = [];
  let devInfo: DeviceInfo | undefined;
  let chosen: string | undefined;
  try {
    devices = await listDevices();
  } catch (e) {
    hints.push(`adb devices 失败：${(e as Error).message}`);
  }
  try {
    chosen = await resolveSerial(serial);
    devInfo = await deviceInfo(chosen);
  } catch (e) {
    hints.push((e as Error).message);
  }

  let adbServer: DoctorReport["environment"]["adbServer"] = "unknown";
  if (IS_WSL) {
    adbServer = local ? "local" : "forwarded-to-windows";
    if (!local && !mirrored) {
      hints.push(
        "WSL 没有本地 adb server，且 networkingMode 不是 mirrored：WSL 的 adb 客户端无法连到 Windows 的 5037。" +
          "两种解法：① 在 .wslconfig 里设 networkingMode=mirrored；② 改用 usbipd-win 把 USB 直接透传给 WSL。",
      );
    }
    if (!local && mirrored) {
      hints.push(
        "当前形态：adb server 在 Windows，WSL 经 mirrored loopback 复用。" +
          "adb reverse 的落点是 Windows 的 loopback，由 mirrored 网络转发到 WSL —— 已实测可用，但依赖该配置。",
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
    },
    devices,
    selected: chosen,
    deviceInfo: devInfo,
    reverse,
    hints,
  };
}
