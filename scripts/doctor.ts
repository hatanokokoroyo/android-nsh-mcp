// scripts/doctor.ts — CLI 版体检（不经过 MCP，排查时最直接）
// 用法: node scripts/doctor.ts [serial]
import * as adb from "../src/core/adb.ts";

const serial = process.argv[2];
const r = await adb.doctor(serial);

const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(16)} ${v ?? "-"}`);

console.log("== adb ==");
line("bin", r.adb.bin);
line("version", r.adb.version);

console.log("== 环境 ==");
line("WSL", r.environment.wsl);
line("wslconfig", r.environment.wslconfig);
line("networkingMode", r.environment.networkingMode);
line("mirrored", r.environment.mirrored);
line("adbServer", r.environment.adbServer);

console.log("== 设备 ==");
for (const d of r.devices) line(d.serial, `${d.state} model=${d.model ?? "?"} transport=${d.transportId ?? "?"}`);
if (r.deviceInfo) {
  line("选中", r.selected);
  line("机型", `${r.deviceInfo.brand ?? ""} ${r.deviceInfo.model ?? ""}`);
  line("系统", `Android ${r.deviceInfo.androidRelease ?? "?"} (API ${r.deviceInfo.sdk ?? "?"}) ${r.deviceInfo.abi ?? ""}`);
}

console.log("== adb reverse ==");
line("supported", r.reverse.supported);
line("note", r.reverse.note);

if (r.hints.length) {
  console.log("== 提示 ==");
  for (const h of r.hints) console.log(`  - ${h}`);
}
