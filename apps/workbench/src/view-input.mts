/** Display/input policy only. No physics, file or clock state lives here. */
export function decimalInput(text: string): { ok: true; value: number; text: string } | { ok: false; message: string } {
  const normalized = text
    .trim()
    .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10))
    .replace(/．/g, '.')
    .replace(/－/g, '-');
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) || !Number.isFinite(Number(normalized)))
    return { ok: false, message: '请输入有限十进制数字，例如63；不接受单位、表达式或千位逗号。' };
  return { ok: true, value: Number(normalized), text: normalized };
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}
export function circuitViewport(
  points: readonly LayoutPoint[],
  width: number,
  height: number,
  fit: boolean,
  focus?: LayoutPoint,
): { x: number; y: number; width: number; height: number; scale: number; limited: boolean } {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const left = Math.min(0, ...xs) - 130,
    top = Math.min(0, ...ys) - 110;
  const right = Math.max(870, ...xs) + 130,
    bottom = Math.max(480, ...ys) + 110;
  const w = right - left,
    h = bottom - top;
  // Avoid a million-pixel scroll surface. The original document remains intact;
  // object location supplies a finite window around any selected object.
  if (w > 12000 || h > 12000)
    return {
      x: (focus?.x ?? points[0]?.x ?? 500) - 600,
      y: (focus?.y ?? points[0]?.y ?? 295) - 400,
      width: 1200,
      height: 800,
      scale: 1,
      limited: true,
    };
  return {
    x: left,
    y: top,
    width: w,
    height: h,
    scale: fit ? Math.min(1, Math.max(1, width - 20) / w, Math.max(1, height - 20) / h) : 1,
    limited: false,
  };
}
