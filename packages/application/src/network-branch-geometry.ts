import { limits, type NetworkEndpoint, type NetworkProject } from '@hyd/domain';
import { networkTreeGeometry, type DrawingPoint, type DrawingSegment } from './network-routing.js';
import { shortestTreeAttachment } from './network-tree-search.js';
import { portTerminal } from './network-tree-routing.js';
import {
  compactTreePath,
  distance,
  onSegment,
  pointKey,
  samePoint,
  segments,
  treeGraph,
  type Box,
} from './network-tree-geometry.js';
import { readTreeRoutes } from './network-routing-cache.js';

export type BranchPaths = ReadonlyMap<string, readonly DrawingPoint[]>;
export interface BranchRoute {
  readonly points: readonly DrawingPoint[];
  readonly cost: number;
}
export const branchEndpointKey = (end: NetworkEndpoint): string =>
  end.kind === 'node' ? 'n:' + end.nodeId : JSON.stringify([end.componentId, end.portId]);

/** Ideal editing connectivity only; never traverses a component or a physical pipe. */
export function branchNet(project: NetworkProject, start: NetworkEndpoint): ReadonlySet<string> {
  const keys = new Set([branchEndpointKey(start)]),
    ids = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of project.design.connections) {
      if (edge.kind !== 'ideal' || ids.has(edge.id)) continue;
      const a = branchEndpointKey(edge.from),
        b = branchEndpointKey(edge.to);
      if (!keys.has(a) && !keys.has(b)) continue;
      keys.add(a);
      keys.add(b);
      ids.add(edge.id);
      changed = true;
    }
  }
  return ids;
}
export function networkBranchConnectionGroups(project: NetworkProject): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const edge of project.design.connections) {
    if (edge.kind !== 'ideal' || result.has(edge.id)) continue;
    for (const id of branchNet(project, edge.from)) result.set(id, edge.id);
  }
  return result;
}

/** Derived dots for shared ideal drawing tracks. Physical ports and persisted
 * junctions already have markers and remain the only editable endpoints. */
export function networkDrawingJunctions(
  project: NetworkProject,
): readonly { point: DrawingPoint; connectionId: string }[] {
  const paths = readTreeRoutes(project, networkTreeGeometry);
  if (paths?.size !== project.design.connections.length) return [];
  // The optional markers must not turn a large imported drawing cache into a quadratic render cost.
  if ([...paths.values()].reduce((sum, path) => sum + path.length, 0) > 1024) return [];
  const groups = new Map<string, { tracks: DrawingSegment[]; ends: DrawingPoint[] }>();
  for (const [id, group] of networkBranchConnectionGroups(project)) {
    const path = paths.get(id);
    const from = path?.[0],
      to = path?.at(-1);
    if (!path || !from || !to) continue;
    const current = groups.get(group) ?? { tracks: [], ends: [] };
    current.tracks.push(...segments(path));
    current.ends.push(from, to);
    groups.set(group, current);
  }
  const endpoints = new Set(
    [...paths.values()].flatMap((path) => [path[0], path.at(-1)].flatMap((p) => (p ? [pointKey(p)] : []))),
  );
  const junctions: { point: DrawingPoint; connectionId: string }[] = [];
  for (const [connectionId, { tracks, ends }] of groups) {
    if (ends.length <= 2) continue;
    const graph = treeGraph(tracks, ends);
    for (const [id, neighbors] of graph.adjacency) {
      const point = graph.points.get(id);
      if (point && neighbors.size >= 3 && !endpoints.has(id)) junctions.push({ point, connectionId });
    }
  }
  return junctions;
}

/** Ordinary transverse interior crossings are allowed. Overlaps, T contacts and corner contacts are not. */
export function branchCrossingCount(
  points: readonly DrawingPoint[],
  occupied: readonly DrawingSegment[],
  contacts: readonly DrawingPoint[] = [],
): number {
  let crossings = 0;
  const start = points[0],
    end = points.at(-1);
  if (!start || !end) return Infinity;
  for (const a of segments(points))
    for (const b of occupied) {
      const av = a.from.x === a.to.x,
        bv = b.from.x === b.to.x;
      if (av === bv) {
        if ((av && a.from.x !== b.from.x) || (!av && a.from.y !== b.from.y)) continue;
        const axis = av ? 'y' : 'x';
        const low = Math.max(Math.min(a.from[axis], a.to[axis]), Math.min(b.from[axis], b.to[axis]));
        const high = Math.min(Math.max(a.from[axis], a.to[axis]), Math.max(b.from[axis], b.to[axis]));
        if (high > low) return Infinity;
        if (high === low) {
          const p = av ? { x: a.from.x, y: low } : { x: low, y: a.from.y };
          if (!samePoint(p, start) && !samePoint(p, end) && !contacts.some((q) => samePoint(p, q))) return Infinity;
        }
      } else {
        const p = av ? { x: a.from.x, y: b.from.y } : { x: b.from.x, y: a.from.y };
        if (!onSegment(p, a.from, a.to) || !onSegment(p, b.from, b.to)) continue;
        if (samePoint(p, start) || samePoint(p, end) || contacts.some((q) => samePoint(p, q))) continue;
        if ([a.from, a.to, b.from, b.to].some((q) => samePoint(q, p))) return Infinity;
        crossings++;
      }
    }
  return crossings;
}
export function branchPathCost(
  points: readonly DrawingPoint[],
  occupied: readonly DrawingSegment[],
  contacts: readonly DrawingPoint[] = [],
  crossingCost = 64,
): number {
  const crossings = branchCrossingCount(points, occupied, contacts);
  if (!Number.isFinite(crossings)) return Infinity;
  return (
    segments(points).reduce((n, s) => n + distance(s.from, s.to), 0) +
    Math.max(0, points.length - 2) * 24 +
    crossings * crossingCost
  );
}

/** One bounded, local route. Existing paths and physical pipe parameters are untouched. */
export function routeBranch(
  project: NetworkProject,
  paths: BranchPaths,
  from: NetworkEndpoint,
  to: NetworkEndpoint,
  createdNodes: ReadonlySet<string>,
): BranchRoute | null {
  const a = portTerminal(project, from, networkTreeGeometry),
    b = portTerminal(project, to, networkTreeGeometry);
  if (!a || !b || samePoint(a.p, b.p)) return null;
  // Several real edges may leave the SAME oil port. Its registered outward stub
  // is necessarily shared; exempt only that stub of edges incident to this port.
  // The rest of each track, and every foreign edge, still blocks overlap.
  const tracks = [...paths].flatMap(([id, points]) => {
    const edge = project.design.connections.find((e) => e.id === id);
    const stubs = [a, b].filter(
      (t) =>
        t.end.kind === 'port' &&
        edge &&
        [edge.from, edge.to].some((e) => branchEndpointKey(e) === branchEndpointKey(t.end)),
    );
    return segments(points).flatMap((span) => {
      const cuts = [span.from, span.to, ...stubs.flatMap((t) => [t.p, t.exit])]
        .filter((p) => onSegment(p, span.from, span.to))
        .sort((p, q) => distance(span.from, p) - distance(span.from, q));
      return segments(cuts).filter(({ from, to }) => {
        if (samePoint(from, to)) return false;
        const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
        return !stubs.some((t) => onSegment(middle, t.p, t.exit));
      });
    });
  });
  const obstacles: Box[] = [...networkTreeGeometry.obstacles(project)];
  for (const p of project.layout.nodes) {
    if ([from, to].some((e) => e.kind === 'node' && e.nodeId === p.nodeId)) continue;
    obstacles.push({ left: p.x - 4, right: p.x + 4, top: p.y - 4, bottom: p.y + 4 });
  }
  // Block every foreign end/corner; no accidental join is inferred from a drawing crossing.
  for (const points of paths.values())
    for (const p of points) {
      if (samePoint(p, a.p) || samePoint(p, b.p) || samePoint(p, a.exit) || samePoint(p, b.exit)) continue;
      obstacles.push({ left: p.x - 1, right: p.x + 1, top: p.y - 1, bottom: p.y + 1 });
    }
  const clearExit = (terminal: typeof a) =>
    terminal !== null &&
    networkTreeGeometry.clear(
      terminal.p,
      terminal.exit,
      networkTreeGeometry
        .obstacles(project)
        .filter((box) => terminal.end.kind !== 'port' || box.id !== terminal.end.componentId),
    );
  if (!clearExit(a) || !clearExit(b)) return null;
  const incident = new Set(
    project.design.connections
      .filter((e) => [e.from, e.to].some((p) => [from, to].some((q) => branchEndpointKey(p) === branchEndpointKey(q))))
      .map((e) => e.id),
  );
  const occupied = [...paths].filter(([id]) => !incident.has(id)).flatMap(([, p]) => segments(p));
  const contacts = [a, b].filter((t) => t.end.kind === 'port').map((t) => t.exit);
  const routes: readonly DrawingPoint[][] = [
    compactTreePath([a.p, a.exit, { x: b.exit.x, y: a.exit.y }, b.exit, b.p]),
    compactTreePath([a.p, a.exit, { x: a.exit.x, y: b.exit.y }, b.exit, b.p]),
  ];
  let best: { points: readonly DrawingPoint[]; cost: number } | null = null;
  const verticalJoin = (points: readonly DrawingPoint[]): number => {
    const joins = (end: NetworkEndpoint, a: DrawingPoint | undefined, b: DrawingPoint | undefined) =>
      end.kind === 'node' && createdNodes.has(end.nodeId) && a && b && a.x === b.x ? 1 : 0;
    return joins(from, points[0], points[1]) + joins(to, points.at(-1), points.at(-2));
  };
  const consider = (points: readonly DrawingPoint[]) => {
    if (
      !segments(points).every((s, i, list) =>
        networkTreeGeometry.clear(
          s.from,
          s.to,
          obstacles.filter(
            (box) =>
              !(
                (i === 0 && from.kind === 'port' && 'id' in box && box.id === from.componentId) ||
                (i === list.length - 1 && to.kind === 'port' && 'id' in box && box.id === to.componentId)
              ),
          ),
        ),
      )
    )
      return;
    if (!Number.isFinite(branchPathCost(points, occupied))) return;
    const cost = branchPathCost(points, tracks, contacts);
    if (
      Number.isFinite(cost) &&
      (!best || cost < best.cost || (cost === best.cost && verticalJoin(points) > verticalJoin(best.points)))
    )
      best = { points, cost };
  };
  for (const points of routes) consider(points);
  if (!best) {
    const found = shortestTreeAttachment(a.exit, [{ from: b.exit, to: b.exit }], obstacles, tracks, {
      clear: networkTreeGeometry.clear,
      maximumGrid: 6000,
      maximumExpanded: 4000,
      allowedContacts: [a.exit, b.exit],
    });
    if (found.ok) consider(compactTreePath([a.p, ...found.points, b.p]));
  }
  return best;
}

/** A valid requested connection must not depend on aesthetic search succeeding.
 * This is explicitly a BASIC drawing, not an obstacle-free success. Try simple
 * exterior channels before retaining an orthogonal path through crowded geometry. */
export function basicBranchRoute(
  project: NetworkProject,
  paths: BranchPaths,
  from: NetworkEndpoint,
  to: NetworkEndpoint,
): BranchRoute | null {
  const a = portTerminal(project, from, networkTreeGeometry),
    b = portTerminal(project, to, networkTreeGeometry);
  if (!a || !b || samePoint(a.p, b.p)) return null;
  const boxes = networkTreeGeometry.obstacles(project),
    tracks = [...paths.values()].flatMap(segments);
  const candidates: DrawingPoint[][] = [
    [a.p, a.exit, { x: a.exit.x, y: b.exit.y }, b.exit, b.p],
    [a.p, a.exit, { x: b.exit.x, y: a.exit.y }, b.exit, b.p],
  ];
  const clamp = (v: number) => Math.max(-limits.canvasCoordinate, Math.min(limits.canvasCoordinate, v));
  for (const x of [
    clamp(Math.min(a.exit.x, b.exit.x, ...boxes.map((b) => b.left)) - 12),
    clamp(Math.max(a.exit.x, b.exit.x, ...boxes.map((b) => b.right)) + 12),
  ])
    candidates.push([a.p, a.exit, { x, y: a.exit.y }, { x, y: b.exit.y }, b.exit, b.p]);
  for (const y of [
    clamp(Math.min(a.exit.y, b.exit.y, ...boxes.map((b) => b.top)) - 12),
    clamp(Math.max(a.exit.y, b.exit.y, ...boxes.map((b) => b.bottom)) + 12),
  ])
    candidates.push([a.p, a.exit, { x: a.exit.x, y }, { x: b.exit.x, y }, b.exit, b.p]);
  let best: BranchRoute | null = null;
  for (const raw of candidates) {
    const points = compactTreePath(raw),
      spans = segments(points);
    const blocked = spans.filter(
      (s, i) =>
        !networkTreeGeometry.clear(
          s.from,
          s.to,
          boxes.filter(
            (box) =>
              !(
                (i === 0 && from.kind === 'port' && box.id === from.componentId) ||
                (i === spans.length - 1 && to.kind === 'port' && box.id === to.componentId)
              ),
          ),
        ),
    ).length;
    const collision = Number.isFinite(branchPathCost(points, tracks)) ? 0 : 1;
    const cost =
      blocked * 1e6 +
      collision * 1e5 +
      spans.reduce((sum, s) => sum + distance(s.from, s.to), 0) +
      Math.max(0, points.length - 2) * 24;
    if (!best || cost < best.cost) best = { points, cost };
  }
  return best;
}
