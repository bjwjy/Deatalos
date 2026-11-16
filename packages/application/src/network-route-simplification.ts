import {
  ContractReader,
  diagnostic,
  immutable,
  parseNetworkProject,
  type NetworkProject,
  type NetworkRoute,
  type Result,
} from '@hyd/domain';
import {
  basicDrawingRoute,
  drawingSegmentClear,
  networkDrawingObstacles,
  networkEndpointPosition,
  type DrawingPoint,
} from './network-routing.js';

export interface NetworkRouteSimplificationPlan {
  readonly document: NetworkProject;
  readonly changedIds: readonly string[];
}

// Drawing coordinates only; this is neither a pipe-length tolerance nor a screen/DPI threshold.
const tolerance = 2;
const same = (a: DrawingPoint, b: DrawingPoint) => a.x === b.x && a.y === b.y;
const between = (value: number, a: number, b: number) => value >= Math.min(a, b) && value <= Math.max(a, b);
function compact(points: readonly DrawingPoint[]): DrawingPoint[] {
  const result: DrawingPoint[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && same(last, point)) continue;
    while (result.length >= 2) {
      const a = result.at(-2),
        b = result.at(-1);
      if (!a || !b) break;
      if (
        (a.x === b.x && b.x === point.x && between(b.y, a.y, point.y)) ||
        (a.y === b.y && b.y === point.y && between(b.x, a.x, point.x))
      )
        result.pop();
      else break;
    }
    result.push(point);
  }
  return result;
}
const direction = (a: DrawingPoint, b: DrawingPoint) => ({ x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) });
function sameDirection(before: readonly DrawingPoint[], after: readonly DrawingPoint[], endpoint: 'start' | 'end') {
  const a = endpoint === 'start' ? before[0] : before.at(-2),
    b = endpoint === 'start' ? before[1] : before.at(-1),
    c = endpoint === 'start' ? after[0] : after.at(-2),
    d = endpoint === 'start' ? after[1] : after.at(-1);
  return !!a && !!b && !!c && !!d && same(direction(a, b), direction(c, d));
}

function simplifyRoute(project: NetworkProject, route: NetworkRoute): NetworkRoute {
  if (route.mode !== 'manual') return route;
  const edge = project.design.connections.find((item) => item.id === route.connectionId);
  if (!edge) return route;
  const start = networkEndpointPosition(project, edge.from),
    end = networkEndpointPosition(project, edge.to);
  if (!start || !end) return route;
  const original = basicDrawingRoute(start, end, route);
  let points = compact(original);
  const obstacles = [
    ...networkDrawingObstacles(project),
    ...project.layout.nodes
      .filter(
        (node) => ![edge.from, edge.to].some((endpoint) => endpoint.kind === 'node' && endpoint.nodeId === node.nodeId),
      )
      .map((node) => ({
        id: 'node:' + node.nodeId,
        left: node.x - 12,
        right: node.x + 12,
        top: node.y - 12,
        bottom: node.y + 12,
      })),
  ];
  for (let i = 0; i + 2 < points.length; i++) {
    for (let j = points.length - 1; j >= i + 2; j--) {
      const a = points[i],
        b = points[j];
      if (!a || !b) continue;
      const axis =
        Math.abs(b.x - a.x) > tolerance && Math.abs(b.y - a.y) <= tolerance
          ? 'x'
          : Math.abs(b.y - a.y) > tolerance && Math.abs(b.x - a.x) <= tolerance
            ? 'y'
            : null;
      if (!axis) continue;
      const cross = axis === 'x' ? 'y' : 'x',
        sign = Math.sign(b[axis] - a[axis]);
      const before = points.slice(i, j + 1);
      if (
        !before.every((p, k) => {
          const previous = before[k - 1];
          return (
            Math.abs(p[cross] - a[cross]) <= tolerance &&
            between(p[axis], a[axis], b[axis]) &&
            (k === 0 || (previous !== undefined && (p[axis] - previous[axis]) * sign >= 0))
          );
        })
      )
        continue;
      const middle = axis === 'x' ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      const replacement = compact([a, middle, b]);
      if (replacement.length >= before.length) continue;
      if (i === 0 && edge.from.kind === 'port' && !sameDirection(original, replacement, 'start')) continue;
      if (j === points.length - 1 && edge.to.kind === 'port' && !sameDirection(original, replacement, 'end')) continue;
      if (
        !replacement.slice(1).every((p, k) => {
          const from = replacement[k];
          return from !== undefined && drawingSegmentClear(from, p, obstacles);
        })
      )
        continue;
      points = compact([...points.slice(0, i), ...replacement, ...points.slice(j + 1)]);
      // Every replacement strictly removes vertices, so revisiting the join is bounded and cannot oscillate.
      i = Math.max(-1, i - 1);
      break;
    }
  }
  if (JSON.stringify(points) === JSON.stringify(original)) return route;
  let anchors = points.slice(1, -1);
  if (!anchors.length) {
    const preserved = route.points.find(
      (p) =>
        !same(p, start) &&
        !same(p, end) &&
        (start.x === end.x
          ? p.x === start.x && between(p.y, start.y, end.y)
          : p.y === start.y && between(p.x, start.x, end.x)),
    );
    anchors = [preserved ?? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }];
  }
  return JSON.stringify(anchors) === JSON.stringify(route.points) ? route : { ...route, points: anchors };
}

/** Pure layout candidate. The existing session owns revisions, history, dirty state and commit failure. */
export function planNetworkRouteSimplification(
  document: unknown,
  connectionIds: unknown,
): Result<NetworkRouteSimplificationPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const reader = new ContractReader();
  const ids =
    connectionIds === null
      ? parsed.value.design.connections.map((edge) => edge.id)
      : reader
          .array(connectionIds, '/routeSimplification/connectionIds', 1000)
          .map((id, i) => reader.id(id, '/routeSimplification/connectionIds/' + i));
  reader.unique(ids, '/routeSimplification/connectionIds');
  const range = reader.finish(ids);
  if (!range.ok) return range;
  if (ids.some((id) => !parsed.value.design.connections.some((edge) => edge.id === id)))
    return {
      ok: false,
      diagnostics: [
        diagnostic('ROUTE_INVALID', '/routeSimplification/connectionIds', '整理范围含不存在的连接；工程保持。'),
      ],
    };
  const changedIds: string[] = [];
  const routes = parsed.value.layout.routes.map((route) => {
    if (!ids.includes(route.connectionId)) return route;
    const next = simplifyRoute(parsed.value, route);
    if (next !== route) changedIds.push(route.connectionId);
    return next;
  });
  const candidate = parseNetworkProject({ ...parsed.value, layout: { ...parsed.value.layout, routes } });
  return candidate.ok ? { ok: true, value: immutable({ document: candidate.value, changedIds }) } : candidate;
}
