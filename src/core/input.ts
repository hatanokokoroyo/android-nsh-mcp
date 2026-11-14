// src/core/input.ts — 输入注入：点击 / 滑动 / 文本 / 按键
// 文本输入的三种方法：
//   app        首选：走应用自建调试通道（NSH 应用用 host handler 收文本）——见 docs/design.md
//   adbkeyboard 备用：ADBKeyboard IME 广播（支持 Unicode）
//   ascii      兜底：adb shell input text（仅 ASCII）
import { adb } from "./adb.ts";

const KEYCODES: Record<string, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  space: "KEYCODE_SPACE",
  delete: "KEYCODE_DEL",
  backspace: "KEYCODE_DEL",
  escape: "KEYCODE_ESCAPE",
  up: "KEYCODE_DPAD_UP",
  down: "KEYCODE_DPAD_DOWN",
  left: "KEYCODE_DPAD_LEFT",
  right: "KEYCODE_DPAD_RIGHT",
  volumeup: "KEYCODE_VOLUME_UP",
  volumedown: "KEYCODE_VOLUME_DOWN",
  power: "KEYCODE_POWER",
  wakeup: "KEYCODE_WAKEUP",
  sleep: "KEYCODE_SLEEP",
  search: "KEYCODE_SEARCH",
  menu: "KEYCODE_MENU",
};

export async function tap(serial: string, x: number, y: number): Promise<void> {
  const r = await adb(["shell", `input tap ${Math.round(x)} ${Math.round(y)}`], { serial, timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`点击失败：${(r.err || r.out).trim()}`);
}

export async function swipe(
  serial: string,
  p: { x1: number; y1: number; x2: number; y2: number; durationMs?: number },
): Promise<void> {
  const d = p.durationMs ?? 300;
  const r = await adb(
    ["shell", `input swipe ${Math.round(p.x1)} ${Math.round(p.y1)} ${Math.round(p.x2)} ${Math.round(p.y2)} ${Math.round(d)}`],
    { serial, timeoutMs: 20_000 },
  );
  if (r.code !== 0) throw new Error(`滑动失败：${(r.err || r.out).trim()}`);
}

export async function key(serial: string, name: string): Promise<string> {
  const code = KEYCODES[name.toLowerCase()] ?? (name.toUpperCase().startsWith("KEYCODE_") ? name.toUpperCase() : `KEYCODE_${name.toUpperCase()}`);
  const r = await adb(["shell", `input keyevent ${code}`], { serial, timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`按键失败：${(r.err || r.out).trim()}`);
  return code;
}

// ── 文本输入 ────────────────────────────────────────────────────────────────

const ADBKB_PKG = "com.android.adbkeyboard";
const ADBKB_IME = `${ADBKB_PKG}/.AdbIME`;

export async function adbKeyboardInstalled(serial: string): Promise<boolean> {
  const r = await adb(["shell", `pm list packages ${ADBKB_PKG}`], { serial, timeoutMs: 15_000 });
  return r.out.includes(ADBKB_PKG);
}

async function currentIme(serial: string): Promise<string> {
  const r = await adb(["shell", "settings get secure default_input_method"], { serial, timeoutMs: 15_000 });
  return r.out.trim();
}

function isAscii(s: string): boolean {
  return /^[\x20-\x7e\n\t]*$/.test(s);
}

/** adb shell input text 的转义：空格用 %s，其余 shell 元字符做引号保护 */
function escapeForInputText(s: string): string {
  return s.replace(/([\\"'`$&|;<>()*?#~!\[\]{}])/g, "\\$1").replace(/ /g, "%s");
}

async function typeAscii(serial: string, value: string): Promise<void> {
  const r = await adb(["shell", `input text "${escapeForInputText(value)}"`], { serial, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`input text 失败：${(r.err || r.out).trim()}`);
}

/**
 * ADBKeyboard：把文本以 base64 广播给 IME。会临时切换默认输入法并在结束后还原。
 * 需要设备已安装 ADBKeyboard.apk（见 README 的安装命令）。
 */
async function typeViaAdbKeyboard(serial: string, value: string): Promise<void> {
  const prev = await currentIme(serial);
  const prevUsable = prev && prev !== "null" && prev.length > 0;
  try {
    if (!prev.includes(ADBKB_PKG)) {
      await adb(["shell", `ime enable ${ADBKB_IME}`], { serial, timeoutMs: 15_000 });
      const set = await adb(["shell", `ime set ${ADBKB_IME}`], { serial, timeoutMs: 15_000 });
      if (set.code !== 0) throw new Error(`切换 ADBKeyboard 失败：${(set.err || set.out).trim()}`);
    }
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const r = await adb(
      ["shell", `am broadcast -a ADB_INPUT_B64 --es msg '${b64}'`],
      { serial, timeoutMs: 20_000 },
    );
    if (r.code !== 0 || /error/i.test(r.err)) {
      throw new Error(`ADBKeyboard 广播失败：${(r.err || r.out).trim()}`);
    }
  } finally {
    if (prevUsable && !prev.includes(ADBKB_PKG)) {
      await adb(["shell", `ime set ${prev}`], { serial, timeoutMs: 15_000 }).catch(() => undefined);
    }
  }
}

export type TextMethod = "auto" | "app" | "adbkeyboard" | "ascii";

export type TypeResult = {
  method: "app" | "adbkeyboard" | "ascii";
  note?: string;
};

/**
 * 输入文本。默认 auto：优先 app 通道（需调用方提供 appText），
 * 非 ASCII 优先 ADBKeyboard，ASCII 优先 input text。
 */
export async function typeText(
  serial: string,
  value: string,
  opts: {
    method?: TextMethod;
    appText?: () => Promise<void>;
  } = {},
): Promise<TypeResult> {
  const method = opts.method ?? "auto";

  if (method === "app" || (method === "auto" && opts.appText && !isAscii(value))) {
    if (!opts.appText) {
      throw new Error("method=app 需要应用侧调试通道（M2 才接；当前请用 adbkeyboard 或 ascii）");
    }
    await opts.appText();
    return { method: "app" };
  }

  if (method === "ascii") {
    if (!isAscii(value)) throw new Error("method=ascii 只能输入 ASCII");
    await typeAscii(serial, value);
    return { method: "ascii" };
  }

  if (method === "adbkeyboard" || (method === "auto" && !isAscii(value))) {
    if (!(await adbKeyboardInstalled(serial))) {
      throw new Error(
        "设备上没有 ADBKeyboard（com.android.adbkeyboard），无法输入非 ASCII 文本。\n" +
          "安装：curl -L -o /tmp/ADBKeyboard.apk https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk && adb install -r /tmp/ADBKeyboard.apk\n" +
          "或用 method=ascii 输入纯英文。",
      );
    }
    await typeViaAdbKeyboard(serial, value);
    return { method: "adbkeyboard" };
  }

  await typeAscii(serial, value);
  return { method: "ascii" };
}
