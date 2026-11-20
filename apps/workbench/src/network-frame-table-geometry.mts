import type { DrawingTableCell as Cell } from '@hyd/application';
export type Rect = Pick<Cell, 'left' | 'right' | 'top' | 'bottom'>;
export type Axis = 'x' | 'y';
export const frame: Rect = { left: 0, top: 0, right: 18000, bottom: 5600 };
const blank = () => ({ id: 'c' + crypto.randomUUID(), text: '' });
export function splitRect(rect: Rect, rows: number, cols: number, keep?: Cell): Cell[] {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 1 ||
    cols < 1 ||
    rows * cols > 128 ||
    (rect.right - rect.left) / cols < 400 ||
    (rect.bottom - rect.top) / rows < 300
  )
    return [];
  const x = (i: number) => Math.round(rect.left + ((rect.right - rect.left) * i) / cols);
  const y = (i: number) => Math.round(rect.top + ((rect.bottom - rect.top) * i) / rows);
  return Array.from({ length: rows * cols }, (_, i) => {
    const col = i % cols,
      row = Math.floor(i / cols);
    return { ...(i === 0 && keep ? keep : blank()), left: x(col), right: x(col + 1), top: y(row), bottom: y(row + 1) };
  });
}
export function bounds(cells: readonly Rect[]): Rect {
  return {
    left: Math.min(...cells.map((c) => c.left)),
    right: Math.max(...cells.map((c) => c.right)),
    top: Math.min(...cells.map((c) => c.top)),
    bottom: Math.max(...cells.map((c) => c.bottom)),
  };
}
export const intersects = (a: Rect, b: Rect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
export function rectangular(cells: readonly Cell[]) {
  const box = bounds(cells);
  return (
    cells.length > 1 &&
    cells.reduce((sum, c) => sum + (c.right - c.left) * (c.bottom - c.top), 0) ===
      (box.right - box.left) * (box.bottom - box.top)
  );
}
/** Only include the immediately adjacent strip if all its cells complete a rectangle. */
export function verticalMergeGroup(cells: readonly Cell[], source: Cell, up: boolean): Cell[] {
  const neighbours = cells.filter(
    (c) => (up ? c.bottom === source.top : c.top === source.bottom) && c.left < source.right && c.right > source.left,
  );
  const group = [source, ...neighbours];
  return neighbours.every((c) => c.left >= source.left && c.right <= source.right) && rectangular(group) ? group : [];
}

/** Use space on either side while preserving the outside edges of the title block. */
export function sizeCell(
  cells: readonly Cell[],
  source: Cell,
  width: number,
  height: number,
): readonly Cell[] | undefined {
  let next = cells;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 400 ||
    height < 300 ||
    width > frame.right ||
    height > frame.bottom
  )
    return;
  for (const [axis, target] of [
    ['x', width],
    ['y', height],
  ] as const) {
    const [lo, hi] = sides(axis);
    for (const side of [hi, lo]) {
      const c = next.find((cell) => cell.id === source.id)!;
      const delta = target - (c[hi] - c[lo]);
      if (!delta) break;
      const edge = divider(next, c, axis, c[side]);
      if (edge) next = edge.move(c[side] + (side === hi ? delta : -delta));
    }
    const actual = next.find((cell) => cell.id === source.id)!;
    if (actual[hi] - actual[lo] !== target) return;
  }
  return next;
}
const sides = (axis: Axis) =>
  axis === 'x' ? (['left', 'right', 'top', 'bottom'] as const) : (['top', 'bottom', 'left', 'right'] as const);
export function divider(cells: readonly Cell[], cell: Cell, axis: Axis, at: number, entire = false) {
  const [lo, hi, a, b] = sides(axis);
  if (at <= 0 || at >= frame[hi]) return null;
  const incident = cells.filter((c) => c[lo] === at || c[hi] === at);
  let start = entire ? 0 : cell[a],
    end = entire ? frame[b] : cell[b];
  // A T junction moves with every neighbour sharing a positive length of this edge.
  for (;;) {
    const touching = incident.filter((c) => c[a] < end && c[b] > start);
    const nextStart = Math.min(start, ...touching.map((c) => c[a])),
      nextEnd = Math.max(end, ...touching.map((c) => c[b]));
    if (nextStart === start && nextEnd === end) break;
    start = nextStart;
    end = nextEnd;
  }
  const affected = incident.filter((c) => c[a] < end && c[b] > start);
  const min = axis === 'x' ? 400 : 300;
  return {
    axis,
    at,
    start,
    end,
    move(position: number): Cell[] {
      const low = Math.max(...affected.filter((c) => c[hi] === at).map((c) => c[lo] + min));
      const high = Math.min(...affected.filter((c) => c[lo] === at).map((c) => c[hi] - min));
      const to = Math.max(low, Math.min(high, Math.round(position)));
      return cells.map((c) => (affected.includes(c) ? { ...c, [c[lo] === at ? lo : hi]: to } : c));
    },
  };
}
export function changeBand(
  cells: readonly Cell[],
  selected: Cell,
  axis: Axis,
  insert: boolean,
  after = false,
): Cell[] | undefined {
  const [lo, hi] = sides(axis),
    limit = frame[hi],
    min = axis === 'x' ? 400 : 300;
  const lines = [...new Set(cells.flatMap((c) => [c[lo], c[hi]]))].sort((a, b) => a - b);
  const at = after ? selected[hi] : selected[lo];
  const start = after ? lines[lines.indexOf(at) - 1] : at,
    end = after ? at : lines[lines.indexOf(at) + 1];
  if (start === undefined || end === undefined) return;
  const width = end - start;
  if (!insert && width === limit) return;
  const scale = (n: number) => Math.round((n * limit) / (limit + (insert ? width : -width)));
  const result: Cell[] = [];
  for (const c of cells) {
    if (insert) {
      result.push({
        ...c,
        [lo]: scale(c[lo] + (c[lo] >= at ? width : 0)),
        [hi]: scale(c[hi] + (c[hi] > at ? width : 0)),
      });
      if ((after ? c[hi] : c[lo]) === at)
        result.push({
          ...blank(),
          left: c.left,
          right: c.right,
          top: c.top,
          bottom: c.bottom,
          [lo]: scale(at),
          [hi]: scale(at + width),
        });
    } else {
      const shift = (n: number) => scale(n <= start ? n : Math.max(start, n - width));
      if (shift(c[hi]) > shift(c[lo])) result.push({ ...c, [lo]: shift(c[lo]), [hi]: shift(c[hi]) });
    }
  }
  // At a T junction derive the inserted strip from the cells on the chosen side.
  if (result.length > 128 || result.some((c) => c[hi] - c[lo] < min)) return;
  return result;
}
