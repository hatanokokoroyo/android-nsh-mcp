// src/core/screenshot.ts — 截屏（exec-out）+ 裁剪/降采样（pngjs，纯 JS 无原生依赖）
import { PNG } from "pngjs";
import { adb, adbBuffer } from "./adb.ts";

export type Rect = { x: number; y: number; w: number; h: number };

export type Shot = {
  png: Buffer;
  width: number;
  height: number;
  bytes: number;
  note?: string;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * 取一张 PNG。优先 `exec-out screencap -p`（不做换行转换）；
 * 若拿到的不是合法 PNG（老设备/通道污染），回退到 shell + base64。
 */
export async function screencapRaw(serial: string): Promise<Buffer> {
  const direct = await adbBuffer(["exec-out", "screencap -p"], { serial, timeoutMs: 60_000 });
  if (direct.ok && direct.buf.length > 8 && direct.buf.subarray(0, 4).equals(PNG_MAGIC)) {
    return direct.buf;
  }
  const b64 = await adb(["shell", "screencap -p | base64"], { serial, timeoutMs: 60_000 });
  const buf = Buffer.from(b64.out.replace(/\s+/g, ""), "base64");
  if (buf.length > 8 && buf.subarray(0, 4).equals(PNG_MAGIC)) return buf;
  throw new Error(
    `截屏失败：只拿到 ${direct.buf.length} 字节，且 base64 回退也不像 PNG。` +
      `stderr=${direct.err || b64.err || "无"}`,
  );
}

/** 截屏 + 可选裁剪/等比缩小，返回可直传给模型的 PNG */
export async function screenshot(
  serial: string,
  opts: { crop?: Rect; maxDim?: number } = {},
): Promise<Shot> {
  const raw = await screencapRaw(serial);
  const src = PNG.sync.read(raw);
  let { width, height } = src;
  let px = src.data;
  let note: string | undefined;

  if (opts.crop) {
    const c = opts.crop;
    const x = Math.max(0, Math.min(width - 1, Math.round(c.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(c.y)));
    const w = Math.max(1, Math.min(width - x, Math.round(c.w)));
    const h = Math.max(1, Math.min(height - y, Math.round(c.h)));
    const out = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++) {
      px.copy(out, row * w * 4, ((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4);
    }
    px = out;
    width = w;
    height = h;
  }

  const maxDim = opts.maxDim ?? 1200;
  if (maxDim > 0 && Math.max(width, height) > maxDim) {
    const scale = maxDim / Math.max(width, height);
    const nw = Math.max(1, Math.round(width * scale));
    const nh = Math.max(1, Math.round(height * scale));
    const out = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(height - 1, Math.floor(y / scale));
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(width - 1, Math.floor(x / scale));
        const si = (sy * width + sx) * 4;
        const di = (y * nw + x) * 4;
        out[di] = px[si];
        out[di + 1] = px[si + 1];
        out[di + 2] = px[si + 2];
        out[di + 3] = px[si + 3];
      }
    }
    note = `已从 ${width}x${height} 缩到 ${nw}x${nh}（maxDim=${maxDim}）`;
    px = out;
    width = nw;
    height = nh;
  }

  const png = new PNG({ width, height });
  px.copy(png.data);
  const buf = PNG.sync.write(png);
  return { png: buf, width, height, bytes: buf.length, note };
}
