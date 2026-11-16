// src/mcp/server.ts — MCP 传输层（stdio）：只做参数校验、结果整形、错误翻译
// 业务逻辑全部在 ../core/ 里，便于以后加 extension / CLI / HTTP 适配层。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as adb from "../core/adb.ts";
import * as ui from "../core/ui.ts";
import * as input from "../core/input.ts";
import * as logcatMod from "../core/logcat.ts";
import * as appMod from "../core/app.ts";
import { screenshot } from "../core/screenshot.ts";

const ALLOW_SHELL = process.env.ANDROID_MCP_ALLOW_SHELL === "1";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const server = new McpServer({
  name: "android-nsh-mcp",
  version: "0.1.0",
});

const deviceArg = {
  device: z
    .string()
    .optional()
    .describe("目标设备 serial；只有一台在线设备时可省略"),
};

// ── 设备与体检 ──────────────────────────────────────────────────────────────

server.registerTool(
  "devices",
  {
    title: "List Android devices",
    description:
      "列出已连接设备及其型号/系统版本/ABI。给一台设备时自动成为默认目标。不传 device 的其它工具都依赖这里的结果。",
    inputSchema: { ...deviceArg },
  },
  async ({ device }) => {
    try {
      const list = await adb.listDevices();
      const lines = list.map((d) => `- ${d.serial}  state=${d.state}  model=${d.model ?? "?"}  transport=${d.transportId ?? "?"}`);
      let info = "";
      try {
        const serial = await adb.resolveSerial(device);
        const i = await adb.deviceInfo(serial);
        info = `\n选中: ${i.serial}\n  ${i.brand ?? ""} ${i.model ?? ""}  Android ${i.androidRelease ?? "?"} (API ${i.sdk ?? "?"})  ${i.abi ?? ""}`;
      } catch (e) {
        info = `\n未选中设备: ${(e as Error).message}`;
      }
      return ok([`# 设备 ${list.length} 台`, ...lines, info].join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "doctor",
  {
    title: "Diagnose adb / hot-reload chain",
    description:
      "体检 adb 可用性、adb server 归属（WSL 本地 vs 经 mirrored loopback 复用 Windows 的）、mirrored 网络配置、adb reverse 可用性。热更新/连接不通时先跑这个。",
    inputSchema: { ...deviceArg },
  },
  async ({ device }) => {
    try {
      const r = await adb.doctor(device);
      const env = r.environment;
      const lines = [
        `adb: ${r.adb.bin}  version=${r.adb.version ?? "?"}`,
        `WSL: ${env.wsl}  networkingMode=${env.networkingMode ?? "(未配置)"}  mirrored=${env.mirrored}  adbServer=${env.adbServer}`,
        env.wslconfig ? `wslconfig: ${env.wslconfig}` : "",
        `endpoint: ${env.endpoint} (${env.endpointSource ?? "default"})`,
        env.windowsAdb ? `windows adb: ${env.windowsAdb.version ?? "?"} ${env.windowsAdb.bin}` : "",
        `候选端口: ${env.candidates.map((c) => `${c.endpoint}${c.adb ? `[${c.devices.length} 台]` : "[不可达]"}`).join(", ")}`,
        `设备: ${r.devices.map((d) => `${d.serial}(${d.state})`).join(", ") || "无"}`,
        r.selected ? `选中: ${r.selected}` : "",
        r.deviceInfo ? `  ${r.deviceInfo.brand} ${r.deviceInfo.model}  Android ${r.deviceInfo.androidRelease} (API ${r.deviceInfo.sdk})  ${r.deviceInfo.abi}` : "",
        `adb reverse: ${r.reverse.supported ? "可用" : "不可用"} — ${r.reverse.note}`,
        r.hints.length ? `\n提示:\n${r.hints.map((h) => `- ${h}`).join("\n")}` : "",
      ].filter(Boolean);
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── 看 ──────────────────────────────────────────────────────────────────────

server.registerTool(
  "screenshot",
  {
    title: "Capture the screen",
    description:
      "截屏并返回 PNG（可直接看）。默认把长边缩到 1200 以省 token；需要看细节就传 crop 指定区域并按需放大 maxDim。",
    inputSchema: {
      ...deviceArg,
      maxDim: z.number().int().min(0).max(4000).optional().describe("返回图最长边像素，默认 1200，0=不缩放"),
      crop: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe("裁剪区域（设备像素，坐标从左上角）"),
    },
  },
  async ({ device, maxDim, crop }) => {
    try {
      const serial = await adb.resolveSerial(device);
      const shot = await screenshot(serial, { crop, maxDim: maxDim ?? 1200 });
      const meta = `# ${serial} 截图 ${shot.width}x${shot.height} ${Math.round(shot.bytes / 1024)}KB${shot.note ? `（${shot.note}）` : ""}`;
      return {
        content: [
          { type: "image" as const, data: shot.png.toString("base64"), mimeType: "image/png" },
          { type: "text" as const, text: meta },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ui",
  {
    title: "Dump the view hierarchy",
    description:
      "uiautomator 元素树，每个节点有 uid/class/text/desc/id/bounds/clickable。比截图省 token 且能直接点（把 uid 传给 tap）。dump 一次 1-3 秒，能用 wait_for 就别反复调它。",
    inputSchema: {
      ...deviceArg,
      text: z.string().optional().describe("按文本/描述/资源 id 正则过滤"),
      idContains: z.string().optional().describe("资源 id 包含子串（NSH 的 testID 会出现在这里）"),
      cls: z.string().optional().describe("类名包含子串，如 Button"),
      clickableOnly: z.boolean().optional(),
      minSize: z.number().int().optional().describe("过滤小于该尺寸的装饰节点，默认 1"),
      limit: z.number().int().min(1).max(2000).optional().describe("最多返回节点数，默认 120"),
    },
  },
  async ({ device, ...q }) => {
    try {
      const serial = await adb.resolveSerial(device);
      const snap = await ui.snapshot(serial, q);
      return ok(ui.render(snap));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wait_for",
  {
    title: "Wait for UI to change",
    description:
      "在设备上轮询直到出现（或消失）某段文本/testID，返回命中的节点。比反复调 ui 省往返。",
    inputSchema: {
      ...deviceArg,
      text: z.string().optional(),
      testId: z.string().optional(),
      gone: z.boolean().optional().describe("true = 等它消失"),
      timeoutMs: z.number().int().min(100).max(60000).optional().describe("默认 8000"),
    },
  },
  async ({ device, text, testId, gone, timeoutMs }) => {
    try {
      if (!text && !testId) throw new Error("text 或 testId 至少给一个");
      const serial = await adb.resolveSerial(device);
      const r = await ui.waitFor(serial, { text, testId, gone }, { timeoutMs });
      if (!r.found) return ok(`未在 ${r.waitedMs}ms 内${gone ? "消失" : "出现"}：${text ?? testId}${r.node ? `\n最后看到：${r.node.cls} "${r.node.text}" ${r.node.id}` : ""}`);
      return ok(
        `命中（${r.waitedMs}ms）：${r.node?.uid} ${r.node?.cls} text="${r.node?.text}" id=${r.node?.id} @[${r.node?.bounds.x},${r.node?.bounds.y} ${r.node?.bounds.w}x${r.node?.bounds.h}]`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "logcat",
  {
    title: "Read logs",
    description:
      "读 logcat（默认最近 200 行，可 level/tag/grep 过滤，可限到某个进程 pid）。NSH 的 JS 报错也会落在这里。",
    inputSchema: {
      ...deviceArg,
      lines: z.number().int().min(1).max(5000).optional(),
      level: z.enum(["V", "D", "I", "W", "E", "F"]).optional().describe("最低级别"),
      tag: z.string().optional(),
      grep: z.string().optional().describe("正则，匹配整行"),
      buffer: z.enum(["main", "system", "crash", "events"]).optional(),
      pid: z.number().int().optional(),
      pkg: z.string().optional().describe("按包名自动换算 pid"),
    },
  },
  async ({ device, pkg, ...q }) => {
    try {
      const serial = await adb.resolveSerial(device);
      const pid = q.pid ?? (pkg ? await logcatMod.pidOf(serial, pkg) : undefined);
      const r = await logcatMod.logcat(serial, { ...q, pid });
      const body = r.lines.map((l) => l.raw).join("\n");
      return ok(`# ${serial} ${r.total} 行${pid ? ` pid=${pid}` : ""}\n${body || "(无匹配日志)"}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "crashes",
  {
    title: "Read crashes and ANRs",
    description: "从 crash 缓冲聚合最近的崩溃/ANR，带堆栈头部与 Java/Kotlin 帧。改完代码先跑它。",
    inputSchema: { ...deviceArg, limit: z.number().int().min(1).max(20).optional() },
  },
  async ({ device, limit }) => {
    try {
      const serial = await adb.resolveSerial(device);
      const r = await logcatMod.crashes(serial, limit ?? 5);
      if (r.count === 0) return ok("没有崩溃/ANR 记录");
      return ok(
        r.items
          .map((it, i) => `## ${i + 1}. ${it.kind}\n${it.header}\n${it.body ? `--- 帧 ---\n${it.body}` : ""}`)
          .join("\n\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ── 动 ──────────────────────────────────────────────────────────────────────

server.registerTool(
  "tap",
  {
    title: "Tap",
    description: "点击。优先传 uid（来自 ui/wait_for），也可传设备像素坐标 x/y。",
    inputSchema: {
      ...deviceArg,
      uid: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  async ({ device, uid, x, y }) => {
    try {
      const serial = await adb.resolveSerial(device);
      let px = x;
      let py = y;
      if (uid) {
        const snap = await ui.snapshot(serial, { limit: 100000 });
        const node = snap.nodes.find((n) => n.uid === uid);
        if (!node) throw new Error(`uid=${uid} 不在当前界面（元素树已变，重跑 ui）`);
        px = node.center.x;
        py = node.center.y;
      }
      if (px === undefined || py === undefined) throw new Error("要么给 uid，要么给 x/y");
      await input.tap(serial, px, py);
      return ok(`已点击 ${Math.round(px)},${Math.round(py)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "swipe",
  {
    title: "Swipe / scroll",
    description: "滑动。滚列表用大距离+短时长；精确拖拉用长时长。",
    inputSchema: {
      ...deviceArg,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      durationMs: z.number().int().min(1).max(5000).optional(),
    },
  },
  async ({ device, ...p }) => {
    try {
      const serial = await adb.resolveSerial(device);
      await input.swipe(serial, p);
      return ok(`已滑动 (${p.x1},${p.y1}) → (${p.x2},${p.y2}) ${p.durationMs ?? 300}ms`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "input_text",
  {
    title: "Type text",
    description:
      "输入文本。auto：ASCII 走 `input text`，非 ASCII 走 ADBKeyboard（需设备已装）；method=ascii 强制纯 ASCII。中文长文本建议配合 ui 先聚焦输入框。",
    inputSchema: {
      ...deviceArg,
      text: z.string().min(1),
      method: z.enum(["auto", "adbkeyboard", "ascii"]).optional(),
      enter: z.boolean().optional().describe("输入后按回车"),
    },
  },
  async ({ device, text, method, enter }) => {
    try {
      const serial = await adb.resolveSerial(device);
      const r = await input.typeText(serial, text, { method });
      if (enter) await input.key(serial, "enter");
      return ok(`已输入 ${text.length} 字符（方法：${r.method}）${enter ? " + Enter" : ""}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "key",
  {
    title: "Press a key",
    description: "按键：back/home/recents/enter/tab/delete/up/down/left/right/volumeup/volumedown/power 或任意 KEYCODE_*。",
    inputSchema: { ...deviceArg, name: z.string().min(1) },
  },
  async ({ device, name }) => {
    try {
      const serial = await adb.resolveSerial(device);
      const code = await input.key(serial, name);
      return ok(`已发送 ${code}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── 应用 ────────────────────────────────────────────────────────────────────

server.registerTool(
  "app",
  {
    title: "Manage the app",
    description:
      "应用操作：install（给 apk 路径）/ launch（给 pkg，自动解析 launcher activity，返回启动耗时）/ stop / clear / foreground（当前前台）/ packages（列表）",
    inputSchema: {
      ...deviceArg,
      action: z.enum(["install", "launch", "stop", "clear", "foreground", "packages"]),
      pkg: z.string().optional(),
      apk: z.string().optional(),
      activity: z.string().optional(),
    },
  },
  async ({ device, action, pkg, apk, activity }) => {
    try {
      const serial = await adb.resolveSerial(device);
      switch (action) {
        case "install": {
          if (!apk) throw new Error("install 需要 apk 路径");
          const r = await appMod.install(serial, apk);
          return ok(`${r.ok ? "安装成功" : "安装失败"}：${r.detail}`);
        }
        case "launch": {
          if (!pkg) throw new Error("launch 需要 pkg");
          const r = await appMod.launch(serial, pkg, activity);
          return ok(
            `${r.ok ? "已启动" : "启动失败"} ${r.component ?? pkg}\n  Status=${r.status ?? "?"} TotalTime=${r.totalTimeMs ?? "?"}ms WaitTime=${r.waitTimeMs ?? "?"}ms\n${r.detail.slice(0, 600)}`,
          );
        }
        case "stop": {
          if (!pkg) throw new Error("stop 需要 pkg");
          await appMod.stop(serial, pkg);
          return ok(`已停止 ${pkg}`);
        }
        case "clear": {
          if (!pkg) throw new Error("clear 需要 pkg");
          return ok(await appMod.clearData(serial, pkg));
        }
        case "foreground": {
          const f = await appMod.foreground(serial);
          return ok(`前台: ${f.package ?? "?"}/${f.activity ?? "?"}`);
        }
        case "packages": {
          const list = await appMod.packages(serial, pkg);
          return ok(`${list.length} 个包\n${list.slice(0, 200).join("\n")}`);
        }
        default:
          throw new Error(`未知 action: ${action}`);
      }
    } catch (e) {
      return fail(e);
    }
  },
);

// ── 逃生舱 ──────────────────────────────────────────────────────────────────

server.registerTool(
  "shell",
  {
    title: "Run an adb shell command (opt-in)",
    description: ALLOW_SHELL
      ? "执行任意 adb shell 命令（已通过 ANDROID_MCP_ALLOW_SHELL=1 开启）。输出截断到 20KB。"
      : "未启用。设置环境变量 ANDROID_MCP_ALLOW_SHELL=1 后重启 MCP 才能用（安全默认：关闭）。",
    inputSchema: { ...deviceArg, cmd: z.string().min(1) },
  },
  async ({ device, cmd }) => {
    if (!ALLOW_SHELL) {
      return fail("shell 工具默认关闭；如确需使用，在 mcp.json 的 env 里加 ANDROID_MCP_ALLOW_SHELL=1 并 /reload");
    }
    try {
      const serial = await adb.resolveSerial(device);
      const r = await adb.adb(["shell", cmd], { serial, timeoutMs: 60_000 });
      const out = (r.out + (r.err ? `\n[stderr] ${r.err}` : "")).slice(0, 20_000);
      return ok(`$ adb shell ${cmd}\n${out}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
