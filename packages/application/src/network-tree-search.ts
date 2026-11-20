import type { DrawingSegment } from './network-routing.js';
import { distance, required, type Point, type Box } from './network-tree-geometry.js';
export interface TreeSearchPolicy {
  /** Explicit branch terminals may touch their own incident tracks. */
  readonly allowedContacts?: readonly Point[];
  readonly direction?: number;
  readonly bendCost?: number;
  readonly crossingCost?: number;
  readonly nearWeight?: number;
  readonly maximumGrid?: number;
  readonly maximumExpanded?: number;
}
export type TreeSearchResult =
  | {
      readonly ok: true;
      readonly points: readonly Point[];
      readonly cost: number;
      readonly expanded: number;
      readonly size: number;
    }
  | { readonly ok: false; readonly reason: string; readonly expanded?: number; readonly size?: number };
const clamp = (v: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
const on = (p: Point, { from: a, to: b }: DrawingSegment) =>
  a.x === b.x ? p.x === a.x && p.y === clamp(p.y, a.y, b.y) : p.y === a.y && p.x === clamp(p.x, a.x, b.x);
const overlap = (a: number, b: number, c: number, d: number) =>
  Math.max(0, Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)));

/** A* to an entire existing net, rather than to a preselected junction. Search
 * states include the arrival direction. The Manhattan distance to the union of
 * target segments is admissible; all length/bend/congestion costs are nonnegative.
 * Optimality applies only to this one attachment on the bounded visibility grid. */
export function shortestTreeAttachment(
  start: Point,
  tracks: readonly DrawingSegment[],
  obstacles: readonly Box[],
  occupied: readonly DrawingSegment[],
  {
    clear,
    direction = 0,
    bendCost = 24,
    crossingCost = 512,
    nearWeight = 2,
    maximumGrid = 32000,
    maximumExpanded = 24000,
    allowedContacts = [],
  }: TreeSearchPolicy & { clear(a: Point, b: Point, boxes: readonly Box[]): boolean },
): TreeSearchResult {
  if (!tracks.length) return { ok: false, reason: 'Empty target tree' };
  const endpoints = tracks.flatMap(({ from, to }) => [from, to]);
  const channels = (axis: 'x' | 'y') =>
    [
      ...new Set(
        occupied
          .filter(({ from, to }) => (axis === 'x' ? from.x === to.x : from.y === to.y))
          .flatMap(({ from }) => [from[axis] - 4, from[axis] + 4, from[axis] - 10, from[axis] + 10]),
      ),
    ]
      .sort((a, b) => Math.abs(a - start[axis]) - Math.abs(b - start[axis]) || a - b)
      .slice(0, 24);
  const xs = [
    ...new Set([
      start.x,
      ...endpoints.map((p) => p.x),
      ...obstacles.flatMap((b) => [b.left, b.right]),
      ...channels('x'),
    ]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([
      start.y,
      ...endpoints.map((p) => p.y),
      ...obstacles.flatMap((b) => [b.top, b.bottom]),
      ...channels('y'),
    ]),
  ].sort((a, b) => a - b);
  const width = xs.length,
    size = width * ys.length;
  if (size > maximumGrid) return { ok: false, reason: 'Tree visibility grid budget exceeded', size };
  const point = (id: number): Point => ({ x: required(xs[id % width]), y: required(ys[Math.floor(id / width)]) });
  const at = (p: Point) => ys.indexOf(p.y) * width + xs.indexOf(p.x);
  const foreign = (p: Point) =>
    !allowedContacts.some((q) => p.x === q.x && p.y === q.y) && occupied.some((line) => on(p, line));
  const goals = new Set<number>();
  for (const line of tracks) {
    const vertical = line.from.x === line.to.x;
    const values = vertical ? ys : xs;
    for (const v of values) {
      const p = vertical ? { x: line.from.x, y: v } : { x: v, y: line.from.y };
      if (on(p, line) && clear(p, p, obstacles) && !foreign(p)) goals.add(at(p));
    }
  }
  if (!goals.size || !clear(start, start, obstacles)) return { ok: false, reason: 'Blocked tree or source' };
  const heuristic = (p: Point) =>
    Math.min(
      ...tracks.map(({ from: a, to: b }) =>
        a.x === b.x
          ? Math.abs(p.x - a.x) + Math.abs(p.y - clamp(p.y, a.y, b.y))
          : Math.abs(p.y - a.y) + Math.abs(p.x - clamp(p.x, a.x, b.x)),
      ),
    );
  const columns = new Map<number, readonly DrawingSegment[]>(),
    rows = new Map<number, readonly DrawingSegment[]>();
  function tracksAlong(vertical: boolean, axis: number): readonly DrawingSegment[] {
    const index = vertical ? columns : rows;
    const cached = index.get(axis);
    if (cached) return cached;
    // Preserve the original track order and exact crossing inequalities. The
    // remaining along-axis tests still use the actual adjacent grid points.
    const relevant = occupied.filter(({ from: c, to: d }) => {
      if (vertical === (c.x === d.x)) return Math.abs(axis - (vertical ? c.x : c.y)) < 4;
      return vertical
        ? axis > Math.min(c.x, d.x) && axis < Math.max(c.x, d.x)
        : axis > Math.min(c.y, d.y) && axis <= Math.max(c.y, d.y);
    });
    index.set(axis, relevant);
    return relevant;
  }
  const congestion = (a: Point, b: Point) => {
    let cost = 0;
    const av = a.x === b.x;
    for (const { from: c, to: d } of tracksAlong(av, av ? a.x : a.y)) {
      const bv = c.x === d.x;
      if (av === bv) {
        const gap = av ? Math.abs(a.x - c.x) : Math.abs(a.y - c.y);
        const length = av ? overlap(a.y, b.y, c.y, d.y) : overlap(a.x, b.x, c.x, d.x);
        if (gap === 0 && length > 0) return Infinity;
        if (gap > 0 && gap < 4) cost += nearWeight * length;
      } else {
        const [v, h] = av
          ? [
              { from: a, to: b },
              { from: c, to: d },
            ]
          : [
              { from: c, to: d },
              { from: a, to: b },
            ];
        if (
          v.from.x > Math.min(h.from.x, h.to.x) &&
          v.from.x < Math.max(h.from.x, h.to.x) &&
          h.from.y > Math.min(v.from.y, v.to.y) &&
          h.from.y <= Math.max(v.from.y, v.to.y)
        )
          cost += crossingCost;
      }
    }
    return cost;
  };
  // Arrival direction affects the bend penalty only. Visits to the same
  // directed edge can reuse its obstacle and congestion result in this search.
  const edgePenalties = new Float64Array(size * 4).fill(NaN);
  const estimates = new Float64Array(size).fill(NaN);
  const costs = new Float64Array(size * 3).fill(Infinity),
    previous = new Int32Array(size * 3).fill(-1),
    touchesForeign = new Uint8Array(size),
    heap: Visit[] = [];
  type Visit = { state: number; cost: number; f: number };
  const less = (a: Visit, b: Visit) =>
    a.f < b.f || (a.f === b.f && (a.cost < b.cost || (a.cost === b.cost && a.state < b.state)));
  const push = (entry: Visit) => {
    heap.push(entry);
    let i = heap.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (!less(entry, required(heap[p]))) break;
      heap[i] = required(heap[p]);
      i = p;
    }
    heap[i] = entry;
  };
  const pop = () => {
    const result = required(heap[0]),
      last = required(heap.pop());
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && less(required(heap[child + 1]), required(heap[child]))) child++;
        if (!less(required(heap[child]), last)) break;
        heap[i] = required(heap[child]);
        i = child;
      }
      heap[i] = last;
    }
    return result;
  };
  const initial = at(start) * 3 + direction;
  costs[initial] = 0;
  push({ state: initial, cost: 0, f: heuristic(start) });
  let expanded = 0;
  while (heap.length) {
    const visit = pop();
    if (visit.cost !== costs[visit.state]) continue;
    if (++expanded > maximumExpanded) return { ok: false, reason: 'Tree A* expansion budget exceeded', expanded };
    const id = Math.floor(visit.state / 3),
      arrival = visit.state % 3,
      p = point(id);
    if (goals.has(id)) {
      const points: Point[] = [];
      for (let state = visit.state; state !== -1; state = required(previous[state]))
        points.push(point(Math.floor(state / 3)));
      return { ok: true, points: points.reverse(), cost: visit.cost, expanded, size };
    }
    const x = id % width,
      y = Math.floor(id / width);
    for (let side = 0; side < 4; side++) {
      let next: number;
      switch (side) {
        case 0:
          if (x === 0) continue;
          next = id - 1;
          break;
        case 1:
          if (x + 1 === width) continue;
          next = id + 1;
          break;
        case 2:
          if (y === 0) continue;
          next = id - width;
          break;
        default:
          if (y + 1 === ys.length) continue;
          next = id + width;
      }
      const d = side < 2 ? 1 : 2;
      const q = point(next);
      if (arrival && arrival !== d) {
        if (!touchesForeign[id]) touchesForeign[id] = foreign(p) ? 2 : 1;
        if (touchesForeign[id] === 2) continue;
      }
      const edge = id * 4 + side;
      let penalty = required(edgePenalties[edge]);
      if (Number.isNaN(penalty)) {
        penalty = clear(p, q, obstacles) ? congestion(p, q) : Infinity;
        edgePenalties[edge] = penalty;
      }
      if (penalty === Infinity) continue;
      const cost = visit.cost + distance(p, q) + (arrival && arrival !== d ? bendCost : 0) + penalty;
      const state = next * 3 + d;
      if (cost >= required(costs[state])) continue;
      costs[state] = cost;
      previous[state] = visit.state;
      let estimate = required(estimates[next]);
      if (Number.isNaN(estimate)) estimates[next] = estimate = heuristic(q);
      push({ state, cost, f: cost + estimate });
    }
  }
  return { ok: false, reason: 'No route to existing same-net geometry', expanded, size };
}
