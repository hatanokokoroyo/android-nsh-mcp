// src/core/logcat.ts — 日志读取（增量、可过滤、崩溃聚合）
import { adb } from "./adb.ts";

export type LogLine = {
  raw: string;
  time?: string;
  pid?: string;
  tid?: string;
  level?: string;
  tag?: string;
  msg: string;
};

const LEVEL_ORDER: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 6 };

/** 解析 threadtime 格式：`07-12 10:00:00.123  1234  1250 I Tag     : msg` */
export function parseLines(out: string): LogLine[] {
  return out
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((raw) => {
      const m = raw.match(
        /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]*?)\s*:\s(.*)$/,
      );
      if (!m) return { raw, msg: raw };
      return { raw, time: m[1], pid: m[2], tid: m[3], level: m[4], tag: m[5].trim(), msg: m[6] };
    });
}

export type LogQuery = {
  lines?: number;
  level?: "V" | "D" | "I" | "W" | "E" | "F";
  tag?: string;
  grep?: string;
  buffer?: "main" | "system" | "crash" | "events";
  pid?: number;
};

export async function logcat(serial: string, q: LogQuery = {}): Promise<{ lines: LogLine[]; total: number }> {
  const n = Math.min(Math.max(q.lines ?? 200, 1), 5000);
  const args = ["logcat", "-d", "-v", "threadtime", "-t", String(n)];
  if (q.buffer) args.push("-b", q.buffer);
  const r = await adb(args, { serial, timeoutMs: 30_000 });
  if (r.code !== 0 && !r.out) throw new Error(`logcat 失败：${r.err || "无输出"}`);

  let lines = parseLines(r.out);
  const minLevel = q.level ? LEVEL_ORDER[q.level] : undefined;
  if (minLevel !== undefined) {
    lines = lines.filter((l) => l.level && LEVEL_ORDER[l.level] >= minLevel);
  }
  if (q.tag) {
    const t = q.tag.toLowerCase();
    lines = lines.filter((l) => l.tag?.toLowerCase().includes(t));
  }
  if (q.pid) lines = lines.filter((l) => l.pid === String(q.pid));
  if (q.grep) {
    let re: RegExp;
    try {
      re = new RegExp(q.grep, "i");
    } catch {
      throw new Error(`grep 不是合法正则：${q.grep}`);
    }
    lines = lines.filter((l) => re.test(l.raw));
  }
  return { lines, total: lines.length };
}

export type CrashReport = {
  count: number;
  items: Array<{ kind: "FATAL" | "ANR" | "OTHER"; header: string; body: string }>;
};

/** 从 crash buffer 聚合崩溃/ANR：同一条堆栈去掉重复帧后保留头部 */
export async function crashes(serial: string, limit = 5): Promise<CrashReport> {
  const r = await adb(["logcat", "-d", "-b", "crash", "-v", "threadtime", "-t", "4000"], {
    serial,
    timeoutMs: 40_000,
  });
  const text = r.out || "";
  const items: CrashReport["items"] = [];
  const blocks = text.split(/\n(?=\d{2}-\d{2}\s+\d{2}:\d{2})/);
  for (const block of blocks) {
    if (!/FATAL EXCEPTION|ANR in|E AndroidRuntime/.test(block)) continue;
    const kind = /ANR in/.test(block) ? "ANR" : /FATAL EXCEPTION|AndroidRuntime/.test(block) ? "FATAL" : "OTHER";
    const lines = block.split("\n").filter((l) => l.trim());
    const header = lines.slice(0, 6).join("\n");
    // 保留 .java/.kt 帧（去掉重复的原生帧噪音），最多 25 行
    const frames = lines.filter((l) => /\bat\s|Caused by|\.java:|\.kt:/.test(l)).slice(0, 25);
    items.push({ kind: kind as "FATAL" | "ANR" | "OTHER", header, body: frames.join("\n") });
    if (items.length >= limit * 3) break;
  }
  return { count: items.length, items: items.slice(0, limit) };
}

/** 当前前台应用的 pid，用于把 logcat 收窄到本应用 */
export async function pidOf(serial: string, pkg: string): Promise<number | undefined> {
  const r = await adb(["shell", `pidof ${pkg}`], { serial, timeoutMs: 15_000 });
  const pid = r.out.trim().split(/\s+/)[0];
  return pid && /^\d+$/.test(pid) ? Number(pid) : undefined;
}
