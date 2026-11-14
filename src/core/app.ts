// src/core/app.ts — 应用生命周期：安装 / 启动 / 停止 / 清数据 / 前台识别
import { adb } from "./adb.ts";

export type InstallResult = { ok: boolean; detail: string };

export async function install(serial: string, apkPath: string): Promise<InstallResult> {
  const r = await adb(["install", "-r", "-t", apkPath], { serial, timeoutMs: 300_000 });
  const out = (r.out + r.err).trim();
  const ok = /Success/i.test(out) && !/Failure/i.test(out);
  return { ok, detail: out };
}

export async function uninstall(serial: string, pkg: string): Promise<InstallResult> {
  const r = await adb(["uninstall", pkg], { serial, timeoutMs: 120_000 });
  const out = (r.out + r.err).trim();
  return { ok: /Success/i.test(out), detail: out };
}

/** 解析包的 launcher activity：`pkg/.MainActivity` */
export async function resolveLauncherActivity(serial: string, pkg: string): Promise<string | undefined> {
  const r = await adb(
    ["shell", `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`],
    { serial, timeoutMs: 20_000 },
  );
  const line = r.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("/"))
    .pop();
  if (!line) return undefined;
  return line.includes("/") ? line : undefined;
}

export type LaunchResult = {
  ok: boolean;
  component?: string;
  totalTimeMs?: number;
  waitTimeMs?: number;
  status?: string;
  detail: string;
};

export async function launch(serial: string, pkg: string, activity?: string): Promise<LaunchResult> {
  const component = activity ?? (await resolveLauncherActivity(serial, pkg));
  if (!component) {
    return {
      ok: false,
      detail: `没能解析出 ${pkg} 的 launcher activity。请显式传 activity（形如 pkg/.MainActivity）。`,
    };
  }
  const comp = component.includes("/") ? component : `${pkg}/${component}`;
  const r = await adb(["shell", `am start -W -n ${comp}`], { serial, timeoutMs: 60_000 });
  const out = (r.out + r.err).trim();
  const total = out.match(/TotalTime:\s*(\d+)/)?.[1];
  const wait = out.match(/WaitTime:\s*(\d+)/)?.[1];
  const status = out.match(/Status:\s*(\S+)/)?.[1];
  return {
    ok: /Status:\s*ok/i.test(out) || /TotalTime/i.test(out),
    component: comp,
    totalTimeMs: total ? Number(total) : undefined,
    waitTimeMs: wait ? Number(wait) : undefined,
    status,
    detail: out,
  };
}

export async function stop(serial: string, pkg: string): Promise<void> {
  await adb(["shell", `am force-stop ${pkg}`], { serial, timeoutMs: 20_000 });
}

export async function clearData(serial: string, pkg: string): Promise<string> {
  const r = await adb(["shell", `pm clear ${pkg}`], { serial, timeoutMs: 30_000 });
  return (r.out + r.err).trim();
}

export type Foreground = { package?: string; activity?: string; raw: string };

export async function foreground(serial: string): Promise<Foreground> {
  const r = await adb(["shell", "dumpsys activity activities"], { serial, timeoutMs: 30_000 });
  const text = r.out;
  // 不同版本/ROM 的字段名不同：ResumedActivity / topResumedActivity / mResumedActivity / realActivity
  const m =
    text.match(/\b(?:top)?[Rr]esumedActivity\b[^\n]*?u0\s+([\w.]+)\/([\w.$]+)/) ??
    text.match(/\brealActivity=([\w.]+)\/([\w.$]+)/);
  if (!m) {
    const w = await adb(["shell", "dumpsys window | grep -m1 mCurrentFocus"], { serial, timeoutMs: 20_000 });
    const wm = w.out.match(/([\w.]+)\/([\w.$]+)/);
    return { package: wm?.[1], activity: wm?.[2], raw: (wm ? w.out : text).slice(0, 500) };
  }
  return { package: m[1], activity: m[2], raw: m[0] };
}

/** 已安装包列表（可选按前缀过滤） */
export async function packages(serial: string, filter?: string): Promise<string[]> {
  const r = await adb(["shell", `pm list packages ${filter ? `| grep -i ${filter}` : ""}`], {
    serial,
    timeoutMs: 30_000,
  });
  return r.out
    .split("\n")
    .map((l) => l.replace(/^package:/, "").trim())
    .filter(Boolean);
}
