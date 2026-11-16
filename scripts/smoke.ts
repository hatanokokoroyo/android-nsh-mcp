// scripts/smoke.ts — 冒烟：把 M1 的能力全跑一遍（不依赖 MCP 客户端）
// 用法: node scripts/smoke.ts [serial]
import { writeFileSync } from "node:fs";
import * as adb from "../src/core/adb.ts";
import * as ui from "../src/core/ui.ts";
import * as logcat from "../src/core/logcat.ts";
import * as app from "../src/core/app.ts";
import { screenshot } from "../src/core/screenshot.ts";

const only = process.argv[2];
const results: Array<[string, string]> = [];
const record = (name: string, detail: string) => {
  results.push([name, detail]);
  console.log(`[${name}] ${detail}`);
};

const t = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  const t0 = Date.now();
  try {
    const v = await fn();
    record(name, `ok ${Date.now() - t0}ms`);
    return v;
  } catch (e) {
    record(name, `FAIL ${Date.now() - t0}ms ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
};

const serial = await t("resolve device", () => adb.resolveSerial(only));
if (!serial) process.exit(1);

const info = await t("device info", () => adb.deviceInfo(serial));
if (info) record("  props", `${info.brand} ${info.model} Android ${info.androidRelease} (API ${info.sdk}) ${info.abi}`);

await t("doctor", async () => {
  const d = await adb.doctor(serial);
  record("  reverse", d.reverse.supported ? "supported" : `not supported (${d.reverse.note})`);
  record("  adbServer", `${d.environment.adbServer} mirrored=${d.environment.mirrored}`);
  record("  endpoint", `${d.environment.endpoint} (${d.environment.endpointSource ?? "default"})`);
  record(
    "  candidates",
    d.environment.candidates.map((c) => `${c.endpoint}:${c.devices.length}`).join(", "),
  );
  return d;
});

const shot = await t("screenshot", () => screenshot(serial, { maxDim: 800 }));
if (shot) {
  writeFileSync("/tmp/android-nsh-mcp-smoke.png", shot.png);
  record("  image", `${shot.width}x${shot.height} ${Math.round(shot.bytes / 1024)}KB → /tmp/android-nsh-mcp-smoke.png`);
}

const snap = await t("ui dump", () => ui.snapshot(serial, { limit: 8, minSize: 8 }));
if (snap) {
  record("  tree", `pkg=${snap.package} screen=${snap.width}x${snap.height} nodes=${snap.total} (${snap.tookMs}ms)`);
  for (const n of snap.nodes.slice(0, 5)) {
    record("  node", `${n.uid} ${n.cls} "${n.text}" id=${n.id} [${n.bounds.x},${n.bounds.y} ${n.bounds.w}x${n.bounds.h}]`);
  }
}

await t("logcat", async () => {
  const r = await logcat.logcat(serial, { lines: 50, level: "I" });
  record("  lines", `${r.total}`);
  return r;
});

await t("crashes", async () => {
  const r = await logcat.crashes(serial, 2);
  record("  count", String(r.count));
  return r;
});

await t("foreground app", async () => {
  const f = await app.foreground(serial);
  record("  fg", `${f.package ?? "?"}/${f.activity ?? "?"}`);
  return f;
});

await t("packages", async () => {
  const p = await app.packages(serial);
  record("  count", String(p.length));
  return p;
});

const failed = results.filter(([name, detail]) => !name.startsWith("  ") && detail.startsWith("FAIL"));
console.log(`\n===== ${results.filter(([n]) => !n.startsWith("  ")).length} 项检查，失败 ${failed.length} =====`);
process.exit(failed.length > 0 ? 1 : 0);
