// src/core/exec.ts — 进程执行的最小封装（无第三方依赖）
import { execFile } from "node:child_process";

export type ExecResult = {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
};

/**
 * 以 Buffer 方式执行命令，永不抛异常（错误信息通过 code/stderr 返回），
 * 便于上层把 adb 的失败翻译成可读建议。
 */
export function run(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer" as never,
        cwd: opts.cwd,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
        if (err && (err as { killed?: boolean }).killed) timedOut = true;
        const errText = String(stderr ?? "").trim() || (err ? String((err as Error).message ?? "") : "");
        resolve({
          code: Number.isFinite(code) ? code : 1,
          stdout: (stdout as unknown as Buffer) ?? Buffer.alloc(0),
          stderr: errText,
          timedOut,
        });
      },
    );
    child.stdin?.end();
  });
}

export function text(r: ExecResult): string {
  return r.stdout.toString("utf8");
}

/** 一行摘要，用于工具返回里的人类可读尾部 */
export function brief(r: ExecResult, max = 400): string {
  const s = (text(r) + "\n" + r.stderr).trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
