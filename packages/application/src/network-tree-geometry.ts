import type { NetworkEndpoint, NetworkProject } from '@hyd/domain';
import type { DrawingObstacle, DrawingPoint, DrawingSegment } from './network-routing.js';

export type Point = DrawingPoint;
export type Track = DrawingSegment & { readonly netId: string };
export type Box = Omit<DrawingObstacle, 'id'>;
export interface TreeGeometry {
  obstacles(project: NetworkProject): readonly DrawingObstacle[];
  position(project: NetworkProject, endpoint: NetworkEndpoint): Point | null;
  clear(a: Point, b: Point, boxes: readonly Box[]): boolean;
}
/** An absent indexed entry here is an implementation defect, never a user-input fallback. */
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Hydraulic drawing invariant violated');
  return value;
}
export const pointKey = ({ x, y }: Point): string => `${x},${y}`;
export const distance = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
export const between = (v: number, a: number, b: number): boolean => v >= Math.min(a, b) && v <= Math.max(a, b);
export const onSegment = (p: Point, a: Point, b: Point): boolean =>
  (a.x === b.x && p.x === a.x && between(p.y, a.y, b.y)) || (a.y === b.y && p.y === a.y && between(p.x, a.x, b.x));
export const segments = (points: readonly Point[]): DrawingSegment[] =>
  points.slice(1).map((to, i) => ({ from: required(points[i]), to }));
export function compactTreePath(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1),
      before = out.at(-2);
    if (last && samePoint(last, p)) continue;
    if (last && before && onSegment(last, before, p)) out.pop();
    out.push({ x: p.x, y: p.y });
  }
  return out;
}
export function projected(p: Point, { from: a, to: b }: DrawingSegment): Point {
  return a.x === b.x
    ? { x: a.x, y: Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), p.y)) }
    : { x: Math.max(Math.min(a.x, b.x), Math.min(Math.max(a.x, b.x), p.x)), y: a.y };
}

export interface DrawingTree {
  readonly points: ReadonlyMap<string, Point>;
  readonly adjacency: ReadonlyMap<string, ReadonlySet<string>>;
}
/** Split a same-net union at intersections; minimum spanning tree removes geometric loops.
 * Keep every physical port and explicitly positioned node, prune other dead ends. */
export function treeGraph(tracks: readonly DrawingSegment[], terminals: readonly Point[]): DrawingTree {
  const points = new Map(terminals.map((p) => [pointKey(p), p]));
  for (const { from, to } of tracks) {
    points.set(pointKey(from), from);
    points.set(pointKey(to), to);
  }
  for (const [i, a] of tracks.entries())
    for (const b of tracks.slice(i + 1)) {
      const [h, v] = a.from.y === a.to.y ? [a, b] : [b, a];
      const p = { x: v.from.x, y: h.from.y };
      if (h.from.y === h.to.y && v.from.x === v.to.x && onSegment(p, h.from, h.to) && onSegment(p, v.from, v.to))
        points.set(pointKey(p), p);
    }
  const edges = new Map<string, { a: string; b: string; length: number }>();
  for (const { from, to } of tracks) {
    const cuts = [...points.values()]
      .filter((p) => onSegment(p, from, to))
      .sort((a, b) => distance(from, a) - distance(from, b));
    for (let i = 1; i < cuts.length; i++) {
      const p = required(cuts[i - 1]),
        q = required(cuts[i]),
        a = pointKey(p),
        b = pointKey(q);
      if (a !== b) edges.set([a, b].sort().join('|'), { a, b, length: distance(p, q) });
    }
  }
  const parents = new Map([...points.keys()].map((id) => [id, id]));
  const root = (start: string): string => {
    let id = start;
    while (required(parents.get(id)) !== id) id = required(parents.get(id));
    return id;
  };
  const adjacency = new Map([...points.keys()].map((id) => [id, new Set<string>()]));
  for (const { a, b } of [...edges.values()].sort((a, b) => a.length - b.length || a.a.localeCompare(b.a))) {
    const ra = root(a),
      rb = root(b);
    if (ra === rb) continue;
    parents.set(ra, rb);
    required(adjacency.get(a)).add(b);
    required(adjacency.get(b)).add(a);
  }
  const keep = new Set(terminals.map(pointKey));
  const leaves = [...adjacency].filter(([id, next]) => next.size <= 1 && !keep.has(id)).map(([id]) => id);
  for (const id of leaves) {
    const next = required(adjacency.get(id));
    for (const peer of next) {
      const links = required(adjacency.get(peer));
      links.delete(id);
      if (links.size === 1 && !keep.has(peer)) leaves.push(peer);
    }
    next.clear();
  }
  return { points, adjacency };
}
export function treePath(tree: DrawingTree, start: string, end: string): Point[] | null {
  const previous = new Map<string, string | null>([[start, null]]),
    queue = [start];
  for (const id of queue) {
    if (id === end) break;
    for (const peer of tree.adjacency.get(id) ?? []) {
      if (previous.has(peer)) continue;
      previous.set(peer, id);
      queue.push(peer);
    }
  }
  if (!previous.has(end)) return null;
  const points: Point[] = [];
  for (let id: string | null = end; id !== null; id = required(previous.get(id)))
    points.push(required(tree.points.get(id)));
  return compactTreePath(points.reverse());
}
