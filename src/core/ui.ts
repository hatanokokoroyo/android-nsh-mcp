// src/core/ui.ts — 元素树：uiautomator dump → 结构化节点（可点、可等、可过滤）
import { adb } from "./adb.ts";

export type UiNode = {
  uid: string;
  cls: string;
  text: string;
  desc: string;
  id: string;
  bounds: { x: number; y: number; w: number; h: number };
  center: { x: number; y: number };
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  checked?: boolean;
  selected?: boolean;
  scrollable?: boolean;
  package?: string;
  depth: number;
};

export type UiSnapshot = {
  serial: string;
  package?: string;
  width?: number;
  height?: number;
  nodes: UiNode[];
  total: number;
  truncated: boolean;
  tookMs: number;
};

const ATTR = /([\w:-]+)="([^"]*)"/g;

function parseBounds(v?: string): { x: number; y: number; w: number; h: number } | undefined {
  const m = v?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return undefined;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/** dump 一份 window_dump.xml（先落盘再 cat，避免 exec-out 截断大 XML） */
export async function dumpXml(serial: string): Promise<string> {
  const path = "/sdcard/android-nsh-mcp-window.xml";
  const d = await adb(["shell", `uiautomator dump --compressed ${path}`], { serial, timeoutMs: 30_000 });
  if (d.code !== 0 && !/dumped to/i.test(d.out)) {
    throw new Error(`uiautomator dump 失败：${(d.err || d.out).trim()}`);
  }
  const c = await adb(["exec-out", `cat ${path}`], { serial, timeoutMs: 30_000 });
  if (c.code !== 0 || !c.out.includes("<hierarchy")) {
    throw new Error(`读取元素树失败：${(c.err || "输出里没有 <hierarchy>").trim()}`);
  }
  return c.out;
}

/** 解析 uiautomator XML 为扁平节点列表（保持层级 depth） */
export function parseXml(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  let depth = 0;
  let idx = 0;
  const tagRe = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    if (m[0] === "</node>") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attrs = new Map<string, string>();
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[1] ?? ""))) attrs.set(a[1], a[2]);
    const bounds = parseBounds(attrs.get("bounds"));
    const text = attrs.get("text") ?? "";
    const desc = attrs.get("content-desc") ?? "";
    const id = attrs.get("resource-id") ?? "";
    if (bounds) {
      nodes.push({
        uid: `n${idx++}`,
        cls: (attrs.get("class") ?? "").replace(/^android\.widget\./, ""),
        text,
        desc,
        id,
        bounds,
        center: { x: bounds.x + Math.floor(bounds.w / 2), y: bounds.y + Math.floor(bounds.h / 2) },
        clickable: attrs.get("clickable") === "true",
        enabled: attrs.get("enabled") !== "false",
        focused: attrs.get("focused") === "true",
        checked: attrs.has("checked") ? attrs.get("checked") === "true" : undefined,
        selected: attrs.has("selected") ? attrs.get("selected") === "true" : undefined,
        scrollable: attrs.has("scrollable") ? attrs.get("scrollable") === "true" : undefined,
        package: attrs.get("package"),
        depth,
      });
    }
    if (!m[2]) depth++;
  }
  return nodes;
}

function screenSize(nodes: UiNode[]): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const n of nodes) {
    w = Math.max(w, n.bounds.x + n.bounds.w);
    h = Math.max(h, n.bounds.y + n.bounds.h);
  }
  return { width: w, height: h };
}

export type UiQuery = {
  text?: string;
  idContains?: string;
  cls?: string;
  clickableOnly?: boolean;
  minSize?: number;
  limit?: number;
};

export async function snapshot(
  serial: string,
  query: UiQuery = {},
): Promise<UiSnapshot> {
  const t0 = Date.now();
  const xml = await dumpXml(serial);
  const all = parseXml(xml);
  const minSize = query.minSize ?? 1;
  const limit = query.limit ?? 120;

  const textRe = query.text ? new RegExp(query.text, "i") : undefined;
  const idNeedle = query.idContains?.toLowerCase();
  const clsNeedle = query.cls?.toLowerCase();

  const filtered = all.filter((n) => {
    if (n.bounds.w < minSize || n.bounds.h < minSize) return false;
    if (query.clickableOnly && !n.clickable) return false;
    if (textRe && !textRe.test(n.text) && !textRe.test(n.desc) && !textRe.test(n.id)) return false;
    if (idNeedle && !n.id.toLowerCase().includes(idNeedle)) return false;
    if (clsNeedle && !n.cls.toLowerCase().includes(clsNeedle)) return false;
    return true;
  });

  const size = screenSize(all);
  const pkg = all.find((n) => n.package)?.package;
  return {
    serial,
    package: pkg,
    ...size,
    nodes: filtered.slice(0, limit),
    total: filtered.length,
    truncated: filtered.length > limit,
    tookMs: Date.now() - t0,
  };
}

/** 找元素：优先 testID（NSH 约定），退化到文本/描述/资源 id */
export async function findByTestId(serial: string, testId: string): Promise<UiNode | undefined> {
  const s = await snapshot(serial, { limit: 100000 });
  const needle = testId.toLowerCase();
  return (
    s.nodes.find((n) => n.id.toLowerCase().endsWith(`:id/${needle}`) || n.id.toLowerCase() === needle) ??
    s.nodes.find((n) => n.desc.toLowerCase() === needle || n.text.toLowerCase() === needle) ??
    s.nodes.find((n) => n.id.toLowerCase().includes(needle))
  );
}

/** 等待某个条件出现（一次调用内轮询，省模型往返） */
export async function waitFor(
  serial: string,
  cond: { text?: string; testId?: string; gone?: boolean },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ found: boolean; waitedMs: number; node?: UiNode }> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const intervalMs = opts.intervalMs ?? 500;
  const t0 = Date.now();
  let last: UiNode | undefined;
  while (Date.now() - t0 < timeoutMs) {
    const snap = await snapshot(serial, { limit: 100000 });
    const needle = (cond.text ?? cond.testId ?? "").toLowerCase();
    last = snap.nodes.find(
      (n) =>
        n.text.toLowerCase().includes(needle) ||
        n.desc.toLowerCase().includes(needle) ||
        n.id.toLowerCase().includes(needle),
    );
    if (cond.gone ? !last : !!last) {
      return { found: !cond.gone, waitedMs: Date.now() - t0, node: last };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { found: false, waitedMs: Date.now() - t0, node: last };
}

/** 紧凑渲染，便于模型阅读（一行一节点） */
export function render(s: UiSnapshot): string {
  const head = `# ${s.serial} pkg=${s.package ?? "?"} screen=${s.width}x${s.height} nodes=${s.nodes.length}/${s.total}${s.truncated ? " (truncated)" : ""} dump=${s.tookMs}ms`;
  const lines = s.nodes.map((n) => {
    const tags = [
      n.clickable ? "click" : "",
      n.focused ? "focus" : "",
      n.scrollable ? "scroll" : "",
      n.checked ? "checked" : "",
      n.enabled ? "" : "disabled",
    ].filter(Boolean).join(",");
    const label = [n.text && `"${n.text}"`, n.desc && `desc="${n.desc}"`, n.id && `id=${n.id}`]
      .filter(Boolean)
      .join(" ");
    return `${n.uid} ${"  ".repeat(Math.min(n.depth, 6))}${n.cls} [${n.bounds.x},${n.bounds.y} ${n.bounds.w}x${n.bounds.h}]${tags ? ` {${tags}}` : ""} ${label}`;
  });
  return [head, ...lines].join("\n");
}
