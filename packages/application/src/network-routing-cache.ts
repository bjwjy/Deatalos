import { limits, type NetworkProject } from '@hyd/domain';
import { canonical } from './content.js';
import { samePoint, segments, type Point, type TreeGeometry } from './network-tree-geometry.js';

/** Optional drawing-only metadata. Old files need no migration; invalidated geometry uses the
 * legacy derived path until the next explicit routing command. Never read by the solver. */
export const networkTreeRouteCacheKey = 'metadata.org.deatalos.routing.c-assembly-v1';
function geometryKey(project: NetworkProject): string {
  return canonical({
    components: project.design.components,
    nodes: project.design.nodes,
    connections: project.design.connections,
    positions: project.layout.components,
    junctions: project.layout.nodes,
  });
}
const arrangementPolicy = 'verified-routing-v6';
export function saveTreeRoutes(
  project: NetworkProject,
  paths: ReadonlyMap<string, readonly Point[]>,
  purpose?: 'arrangement',
): NetworkProject {
  return {
    ...project,
    extensions: {
      ...project.extensions,
      [networkTreeRouteCacheKey]: {
        version: 1,
        ...(purpose === 'arrangement' ? { arrangementPolicy } : {}),
        geometryKey: geometryKey(project),
        paths: [...paths].map(([connectionId, points]) => ({
          connectionId,
          points: points.map(({ x, y }) => ({ x, y })),
        })),
      },
    },
  };
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Repeating the same bounded search on its own output is a no-op until geometry or route modes change. */
export function hasCurrentArrangement(project: NetworkProject, geometry: TreeGeometry): boolean {
  const payload: unknown = project.extensions[networkTreeRouteCacheKey];
  return (
    record(payload) &&
    payload.arrangementPolicy === arrangementPolicy &&
    project.layout.routes.every((r) => r.mode === 'avoid') &&
    readTreeRoutes(project, geometry)?.size === project.design.connections.length
  );
}
/** Treat persisted extension content as untrusted; do not coerce or supply missing coordinates. */
export function readTreeRoutes(
  project: NetworkProject,
  geometry: TreeGeometry,
): ReadonlyMap<string, readonly Point[]> | null {
  const payload: unknown = project.extensions[networkTreeRouteCacheKey];
  if (
    !record(payload) ||
    payload.version !== 1 ||
    payload.geometryKey !== geometryKey(project) ||
    !Array.isArray(payload.paths) ||
    payload.paths.length !== project.design.connections.length
  )
    return null;
  const paths = new Map<string, readonly Point[]>();
  const boxes = geometry.obstacles(project);
  const rows: readonly unknown[] = payload.paths;
  for (const row of rows) {
    if (
      !record(row) ||
      typeof row.connectionId !== 'string' ||
      !Array.isArray(row.points) ||
      row.points.length < 2 ||
      row.points.length > 4096
    )
      return null;
    const edge = project.design.connections.find((e) => e.id === row.connectionId);
    // Branch edits rebase untouched pipe drawing paths as well. This cache never
    // supplies pipe length, loss parameters or a physical split.
    if (!edge || paths.has(edge.id)) return null;
    if (project.layout.routes.find((r) => r.connectionId === edge.id)?.mode !== 'avoid') continue;
    const points: Point[] = [];
    const coordinates: readonly unknown[] = row.points;
    for (const raw of coordinates) {
      if (
        !record(raw) ||
        typeof raw.x !== 'number' ||
        typeof raw.y !== 'number' ||
        !Number.isFinite(raw.x) ||
        !Number.isFinite(raw.y) ||
        Math.abs(raw.x) > limits.canvasCoordinate ||
        Math.abs(raw.y) > limits.canvasCoordinate
      )
        return null;
      points.push({ x: raw.x, y: raw.y });
    }
    const a = geometry.position(project, edge.from),
      b = geometry.position(project, edge.to),
      first = points[0],
      last = points.at(-1);
    if (!a || !b || !first || !last || !samePoint(a, first) || !samePoint(b, last)) return null;
    const spans = segments(points);
    for (const [i, { from, to }] of spans.entries()) {
      if (from.x !== to.x && from.y !== to.y) return null;
      const obstacles = boxes.filter(
        (box) =>
          !(
            (i === 0 && edge.from.kind === 'port' && edge.from.componentId === box.id) ||
            (i === spans.length - 1 && edge.to.kind === 'port' && edge.to.componentId === box.id)
          ),
      );
      if (!geometry.clear(from, to, obstacles)) return null;
    }
    paths.set(edge.id, points);
  }
  return paths;
}
