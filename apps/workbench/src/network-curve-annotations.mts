type Point = { readonly x: number; readonly y: number };
type Box = Point & { readonly width: number; readonly height: number };
export interface CurveMark {
  readonly point: Point;
  readonly color: string;
  readonly lines: readonly string[];
  readonly offsetX?: number;
  readonly offsetY?: number;
}
interface Bounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly headroomBottom: number;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function intersects(a: Point, b: Point, box: Box, pad: number): boolean {
  const low = Math.max(Math.min(a.x, b.x), box.x - pad);
  const high = Math.min(Math.max(a.x, b.x), box.x + box.width + pad);
  if (low > high) return false;
  const at = (x: number) => a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
  const [y1, y2] = a.x === b.x ? [a.y, b.y] : [at(low), at(high)];
  return Math.max(y1, y2) >= box.y - pad && Math.min(y1, y2) <= box.y + box.height + pad;
}

function crossesGuide(start: Point, end: Point, a: Point, b: Point): boolean {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const sx = b.x - a.x,
    sy = b.y - a.y;
  const x = a.x - start.x,
    y = a.y - start.y;
  const cross = dx * sy - dy * sx;
  if (Math.abs(cross) < 1e-6) {
    if (Math.abs(x * dy - y * dx) > 1e-6) return false;
    const length = dx * dx + dy * dy;
    if (length === 0) return false;
    const first = (x * dx + y * dy) / length;
    const last = ((x + sx) * dx + (y + sy) * dy) / length;
    return Math.max(first, last) > 1e-6 && Math.min(first, last) < 1;
  }
  const alongGuide = (x * sy - y * sx) / cross;
  const alongCurve = (x * dy - y * dx) / cross;
  return alongGuide > 1e-6 && alongGuide <= 1 && alongCurve >= 0 && alongCurve <= 1;
}

/** Find room inside the axes. The upper tick interval is a fallback, not an overlay row. */
export function layoutCurveMark(
  mark: CurveMark,
  bounds: Bounds,
  segments: readonly (readonly [Point, Point])[],
  occupied: Box[],
): { readonly box: Box; readonly guide: Point | null } | null {
  const { point } = mark;
  const width = Math.min(
    Math.max(96, ...mark.lines.map((line) => [...line].length * 10 + 18)),
    bounds.right - bounds.left - 8,
  );
  const height = mark.lines.length * 16 + 11;
  if (width < 65 || bounds.bottom - bounds.top < height + 8) return null;
  const candidate = (x: number, y: number, minY: number): Box => ({
    x: clamp(x, bounds.left + 4, bounds.right - width - 4),
    y: clamp(y, minY, bounds.bottom - height - 4),
    width,
    height,
  });
  const near: Box[] = [];
  for (const gap of [11, 24, 42, 58, 82, 112, 150, 192, 240, 300])
    for (const x of [point.x + gap, point.x - width - gap, point.x - width / 2])
      for (const y of [point.y - height - gap, point.y + gap, point.y - height / 2])
        near.push(candidate(x + (mark.offsetX ?? 0), y + (mark.offsetY ?? 0), bounds.top + 4));
  const spare: Box[] = [];
  for (let x = bounds.left + 4; x + width <= bounds.right - 4; x += width + 8)
    spare.push(candidate(x, bounds.top + 4, bounds.top + 4));
  spare.sort((a, b) => Math.abs(a.x + width / 2 - point.x) - Math.abs(b.x + width / 2 - point.x));
  let aboveWithoutGuide: Box | undefined;
  for (const box of point.y - bounds.headroomBottom < height ? [...spare, ...near] : [...near, ...spare]) {
    if (
      occupied.some(
        (other) =>
          box.x < other.x + other.width + 4 &&
          box.x + width + 4 > other.x &&
          box.y < other.y + other.height + 4 &&
          box.y + height + 4 > other.y,
      ) ||
      segments.some(([a, b]) => intersects(a, b, box, 5))
    )
      continue;
    const edge = { x: clamp(point.x, box.x, box.x + width), y: clamp(point.y, box.y, box.y + height) };
    const guide =
      box.y > point.y
        ? { x: clamp(point.x, box.x + 7, box.x + width - 7), y: box.y }
        : Math.hypot(edge.x - point.x, edge.y - point.y) >= 36
          ? edge
          : null;
    if (guide && segments.some(([a, b]) => crossesGuide(point, guide, a, b))) {
      if (box.y + height < point.y) aboveWithoutGuide ??= box;
      continue;
    }
    occupied.push(box);
    return { box, guide };
  }
  if (aboveWithoutGuide) {
    occupied.push(aboveWithoutGuide);
    return { box: aboveWithoutGuide, guide: null };
  }
  return null;
}
