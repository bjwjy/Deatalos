import type { NetworkConnection, NetworkEndpoint, NetworkProject, NetworkRoute } from '@hyd/domain';
import type { Point } from './network-cad.mjs';

export type TrimTrack = { edge: NetworkConnection; points: readonly Point[] };
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const fromNode = (edge: NetworkConnection, id: string) => edge.from.kind === 'node' && edge.from.nodeId === id;

// Follow every incident ideal route from this node up to its first divergence.
// A vertex in one polyline may be in the middle of a segment in another.
export function sharedTail(project: NetworkProject, id: string, tracks: readonly TrimTrack[]) {
  if (tracks.length < 2 || tracks.some((track) => track.edge.kind !== 'ideal')) return;
  const paths = tracks.map(({ edge, points }) => {
    const forward = fromNode(edge, id);
    const ordered = forward ? [...points] : [...points].reverse();
    return { edge, forward, points: ordered.filter((p, i) => !i || !same(p, ordered[i - 1]!)), index: 1 };
  });
  const start = paths[0]?.points[0];
  if (!start || paths.some((path) => !path.points[0] || !same(path.points[0], start))) return;
  let cursor = start,
    length = 0;
  const prefix = [start];
  while (paths.every((path) => path.index < path.points.length)) {
    const next = paths.map((path) => path.points[path.index]!);
    const dx = Math.sign(next[0]!.x - cursor.x),
      dy = Math.sign(next[0]!.y - cursor.y);
    if ((dx && dy) || next.some((p) => Math.sign(p.x - cursor.x) !== dx || Math.sign(p.y - cursor.y) !== dy)) break;
    const step = next.reduce((min, p) => Math.min(min, distance(cursor, p)), Infinity);
    cursor = { x: cursor.x + dx * step, y: cursor.y + dy * step };
    prefix.push(cursor);
    length += step;
    for (const path of paths) if (same(cursor, path.points[path.index]!)) path.index++;
  }
  if (!length) return;
  const complete = paths.filter((path) => path.index === path.points.length);
  if (complete.length > 1 || complete.length === paths.length) return;
  const end = complete[0];
  const existing = end && (end.forward ? end.edge.to : end.edge.from);
  const remaining = paths.filter((path) => path !== end);
  if (!existing && remaining.length < 2) return;
  const cut = cursor;
  const replacementRoutes = new Map<string, NetworkRoute>();
  // Preserve the drawn suffix, including the surviving manual bends, in the edge's original direction.
  for (const path of remaining) {
    const rest = [cut, ...path.points.slice(path.index)];
    if (!path.forward) rest.reverse();
    const interior = rest.slice(1, -1),
      a = rest[0]!,
      b = rest.at(-1)!;
    if (!interior.length) interior.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    replacementRoutes.set(path.edge.id, { connectionId: path.edge.id, mode: 'manual', points: interior });
  }
  return {
    prefix,
    length,
    apply(): NetworkProject {
      const endpoint: NetworkEndpoint = existing ?? {
        kind: 'node',
        nodeId: 'j_' + crypto.randomUUID().replaceAll('-', ''),
      };
      const rebound = project.design.connections
        .filter((edge) => edge.id !== end?.edge.id)
        .map((edge) => {
          if (!replacementRoutes.has(edge.id)) return edge;
          return fromNode(edge, id) ? { ...edge, from: endpoint } : { ...edge, to: endpoint };
        });
      const nodes = project.design.nodes.filter((node) => node.id !== id);
      const positions = project.layout.nodes.filter((node) => node.nodeId !== id);
      if (!existing && endpoint.kind === 'node') {
        nodes.push({ id: endpoint.nodeId, kind: 'ideal-hydraulic', label: '' });
        positions.push({ nodeId: endpoint.nodeId, ...cut });
      }
      const routes = project.layout.routes.filter(
        (route) => route.connectionId !== end?.edge.id && !replacementRoutes.has(route.connectionId),
      );
      return {
        ...project,
        design: { ...project.design, nodes, connections: rebound },
        layout: { ...project.layout, nodes: positions, routes: [...routes, ...replacementRoutes.values()] },
      };
    },
  };
}
