import type { NetworkProject } from '@hyd/domain';
import { annotationBoxes } from './network-layout-assemblies.js';
import {
  distance,
  onSegment,
  pointKey,
  required,
  type Point,
  type Track,
  type TreeGeometry,
} from './network-tree-geometry.js';
import type { HydraulicTreeDrawing } from './network-tree-routing.js';

export interface NetworkRoutingScore {
  readonly valid: boolean;
  readonly length: number;
  readonly bends: number;
  readonly longestLine: number;
  readonly longLines: number;
  readonly crossings: number;
  readonly overlap: number;
  readonly foreignTouches: number;
  readonly near: number;
  readonly annotationCollisions: number;
  readonly positionDistance: number;
  readonly terms: {
    readonly length: number;
    readonly bends: number;
    readonly crossings: number;
    readonly near: number;
    readonly position: number;
  };
  readonly score: number;
}
const overlap = (a: number, b: number, c: number, d: number) =>
  Math.max(0, Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)));
function nearLength(a: Track, b: Track): number {
  const av = a.from.x === a.to.x,
    bv = b.from.x === b.to.x;
  const axis = av ? a.from.x : a.from.y,
    other = bv ? b.from.x : b.from.y;
  const low = av ? Math.min(a.from.y, a.to.y) : Math.min(a.from.x, a.to.x),
    high = av ? Math.max(a.from.y, a.to.y) : Math.max(a.from.x, a.to.x);
  const bLow = bv ? Math.min(b.from.y, b.to.y) : Math.min(b.from.x, b.to.x),
    bHigh = bv ? Math.max(b.from.y, b.to.y) : Math.max(b.from.x, b.to.x);
  if (av === bv) {
    const gap = Math.abs(axis - other);
    return gap > 0 && gap < 4 ? overlap(low, high, bLow, bHigh) : 0;
  }
  return Math.max(bLow - axis, axis - bHigh, 0) < 4 ? overlap(low, high, other - 4, other + 4) : 0;
}
/** Stop pricing at ports and real branches, never at ordinary elbows or redundant drawing vertices. */
function visibleLines(
  project: NetworkProject,
  tracks: readonly Track[],
  geometry: TreeGeometry,
): { length: number; bends: number }[] {
  const physical = new Set(
    project.design.connections
      .flatMap((e) => [e.from, e.to])
      .filter((e) => e.kind === 'port')
      .flatMap((e) => {
        const p = geometry.position(project, e);
        return p ? [pointKey(p)] : [];
      }),
  );
  const lines: { length: number; bends: number }[] = [];
  for (const netId of new Set(tracks.map((t) => t.netId))) {
    const own = tracks.filter((t) => t.netId === netId),
      points = new Map<string, Point>(),
      adjacency = new Map<string, Set<string>>();
    for (const { from, to } of own) {
      points.set(pointKey(from), from);
      points.set(pointKey(to), to);
    }
    for (const id of points.keys()) adjacency.set(id, new Set());
    for (const { from, to } of own) {
      const cuts = [...points.values()]
        .filter((p) => onSegment(p, from, to))
        .sort((a, b) => distance(from, a) - distance(from, b));
      for (let i = 1; i < cuts.length; i++) {
        const a = pointKey(required(cuts[i - 1])),
          b = pointKey(required(cuts[i]));
        if (a === b) continue;
        required(adjacency.get(a)).add(b);
        required(adjacency.get(b)).add(a);
      }
    }
    const stop = (id: string) => required(adjacency.get(id)).size !== 2 || physical.has(id),
      visited = new Set<string>();
    const edgeKey = (a: string, b: string) => [a, b].sort().join('|');
    for (const start of [...points.keys()].sort((a, b) => Number(stop(b)) - Number(stop(a))))
      for (const first of required(adjacency.get(start))) {
        if (visited.has(edgeKey(start, first))) continue;
        let previous = start,
          current = first,
          length = 0,
          bends = 0,
          direction = 0;
        for (;;) {
          visited.add(edgeKey(previous, current));
          const a = required(points.get(previous)),
            b = required(points.get(current));
          length += distance(a, b);
          const d = a.x === b.x ? 2 : 1;
          if (direction && d !== direction) bends++;
          direction = d;
          if (stop(current)) break;
          const next = [...required(adjacency.get(current))].find((id) => !visited.has(edgeKey(current, id)));
          if (!next) break;
          previous = current;
          current = next;
        }
        lines.push({ length, bends });
      }
  }
  return lines;
}
/** The verified C-assembly-v1 coefficients, whole-value tiers (not marginal excess).
 * Foreign overlap/contact invalidates a candidate; true crossings are counted once. */
export function scoreHydraulicTree(
  drawing: HydraulicTreeDrawing,
  geometry: TreeGeometry,
  sharedTerminal?: (point: Point, a: string, b: string) => boolean,
  conflict?: (point: Point, a: string, b: string) => void,
): NetworkRoutingScore {
  const { project, tracks } = drawing,
    lines = visibleLines(project, tracks, geometry);
  let foreignOverlap = 0,
    near = 0,
    crossings = 0,
    foreignTouches = 0;
  const contacts = new Map<string, { p: Point; a: string; b: string }>();
  for (const [i, a] of tracks.entries())
    for (const b of tracks.slice(i + 1)) {
      if (a.netId === b.netId) continue;
      near += (nearLength(a, b) + nearLength(b, a)) / 2;
      const av = a.from.x === a.to.x,
        bv = b.from.x === b.to.x;
      let p: Point;
      if (av === bv) {
        const axis = av ? 'x' : 'y',
          along = av ? 'y' : 'x';
        if (a.from[axis] !== b.from[axis]) continue;
        const lo = Math.max(Math.min(a.from[along], a.to[along]), Math.min(b.from[along], b.to[along]));
        const hi = Math.min(Math.max(a.from[along], a.to[along]), Math.max(b.from[along], b.to[along]));
        foreignOverlap += Math.max(0, hi - lo);
        if (hi > lo && conflict) {
          const mid = (lo + hi) / 2;
          conflict(av ? { x: a.from.x, y: mid } : { x: mid, y: a.from.y }, a.netId, b.netId);
        }
        if (hi < lo) continue;
        p = av ? { x: a.from.x, y: lo } : { x: lo, y: a.from.y };
      } else {
        const [v, h] = av ? [a, b] : [b, a];
        p = { x: v.from.x, y: h.from.y };
        if (!onSegment(p, v.from, v.to) || !onSegment(p, h.from, h.to)) continue;
      }
      const ids = [a.netId, b.netId].sort();
      contacts.set(pointKey(p) + '|' + ids.join('|'), { p, a: a.netId, b: b.netId });
    }
  const directions = (p: Point, netId: string) => {
    const out = new Set<string>();
    for (const t of tracks.filter((t) => t.netId === netId && onSegment(p, t.from, t.to)))
      for (const q of [t.from, t.to]) {
        if (q.x < p.x) out.add('L');
        if (q.x > p.x) out.add('R');
        if (q.y < p.y) out.add('U');
        if (q.y > p.y) out.add('D');
      }
    return [...out].sort().join('');
  };
  for (const { p, a, b } of contacts.values()) {
    if (sharedTerminal?.(p, a, b)) continue;
    const da = directions(p, a),
      db = directions(p, b);
    if ((da === 'LR' && db === 'DU') || (db === 'LR' && da === 'DU')) crossings++;
    else {
      foreignTouches++;
      conflict?.(p, a, b);
    }
  }
  const boxes = geometry.obstacles(project),
    labels = annotationBoxes(project);
  const intersects = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  let annotationCollisions = 0;
  for (const [i, a] of labels.entries()) {
    for (const b of boxes) if (a.id !== b.id && intersects(a, b)) annotationCollisions++;
    for (const b of labels.slice(i + 1)) if (intersects(a, b)) annotationCollisions++;
  }
  const pairs = new Set<string>();
  let positionDistance = 0;
  for (const { from, to } of project.design.connections) {
    if (from.kind !== 'port' || to.kind !== 'port' || from.componentId === to.componentId) continue;
    const key = [from.componentId, to.componentId].sort().join('|');
    if (pairs.has(key)) continue;
    pairs.add(key);
    const a = required(boxes.find((b) => b.id === from.componentId)),
      b = required(boxes.find((b) => b.id === to.componentId));
    const gap = Math.max(0, a.left - b.right, b.left - a.right) + Math.max(0, a.top - b.bottom, b.top - a.bottom);
    positionDistance += gap * (gap <= 40 ? 0.25 : gap <= 120 ? 1 : 3);
  }
  const count = project.design.components.filter((c) => c.typeId !== 'controller').length;
  const effective = lines.reduce((sum, l) => sum + l.length * (l.length <= 75 ? 0.5 : l.length <= 400 ? 1 : 4), 0);
  const average = count ? effective / count : 0,
    pricedAverage = average * (average <= 200 ? 0.25 : 1);
  const length = lines.reduce((sum, l) => sum + l.length, 0),
    bends = lines.reduce((sum, l) => sum + l.bends, 0);
  const lengthCost = 16 * (pricedAverage / 100) ** 2;
  const terms = {
    length: lengthCost,
    bends: 0.5 * bends ** 2,
    crossings: 25 * crossings ** 2,
    near: (near / 40) ** 2,
    position: Math.min(count ? 0.5 * (positionDistance / count / 20) ** 2 : 0, 0.15 * lengthCost),
  };
  const bodiesClear = !boxes.some((a, i) => boxes.slice(i + 1).some((b) => intersects(a, b)));
  return {
    valid: count > 0 && bodiesClear && foreignOverlap === 0 && foreignTouches === 0,
    length,
    bends,
    longestLine: Math.max(0, ...lines.map((l) => l.length)),
    longLines: lines.filter((l) => l.length > 400).length,
    crossings,
    overlap: foreignOverlap,
    foreignTouches,
    near,
    annotationCollisions,
    positionDistance,
    terms,
    score: Object.values(terms).reduce((a, b) => a + b, 0),
  };
}
