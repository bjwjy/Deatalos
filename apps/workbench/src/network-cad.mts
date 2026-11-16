import {
  networkComponentBounds,
  networkTextLayout,
  networkDefinition,
  networkPortActive,
  type NetworkEndpoint,
  type NetworkProject,
  type NetworkRoute,
} from '@hyd/domain';
import { networkEndpointPosition, networkDrawingObstacles, type NetworkSelection } from '@hyd/application';
export { networkDeleteSelection as deleteSelection } from '@hyd/application';
export { networkMoveSelection as moveSelection } from '@hyd/application';
import { connectionRoute } from './network-presentation.mjs';

export type Point = { readonly x: number; readonly y: number };
export type Viewport = { readonly centerX: number; readonly centerY: number; readonly zoom: number };
export type Selection = NetworkSelection;
export const selectionKey = (s: Selection): string => `${s.kind}:${s.id}`;
export const clampCoordinate = (n: number): number => Math.max(-1e6, Math.min(1e6, n));
export const defaultConnectionRadius = 12;
/** Screen-space picking does not enlarge physical geometry. Near ties require a deliberate zoom. */
export function nearestEndpoint(
  project: NetworkProject,
  screen: Point,
  toScreen: (point: Point) => Point,
  includeNodes: boolean,
  radius = defaultConnectionRadius,
): { kind: 'hit'; endpoint: NetworkEndpoint } | { kind: 'ambiguous' } | null {
  const endpoints: NetworkEndpoint[] = project.design.components.flatMap((component) =>
    (networkDefinition(component.definition.id, component.definition.version)?.ports ?? [])
      .filter((port) => networkPortActive(component, port.id))
      .map((port) => ({
        kind: 'port',
        componentId: component.id,
        portId: port.id,
      })),
  );
  if (includeNodes) endpoints.push(...project.design.nodes.map((node) => ({ kind: 'node' as const, nodeId: node.id })));
  const hits = endpoints
    .flatMap((endpoint) => {
      const point = networkEndpointPosition(project, endpoint);
      if (!point) return [];
      const projected = toScreen(point),
        distance = Math.hypot(projected.x - screen.x, projected.y - screen.y);
      return distance <= radius ? [{ endpoint, distance }] : [];
    })
    .sort((a, b) => a.distance - b.distance);
  const first = hits[0];
  if (!first) return null;
  if (hits[1] && hits[1].distance - first.distance <= 2) return { kind: 'ambiguous' };
  return { kind: 'hit', endpoint: first.endpoint };
}
export function screenToWorld(p: Point, view: Viewport, size: Point): Point {
  return { x: view.centerX + (p.x - size.x / 2) / view.zoom, y: view.centerY + (p.y - size.y / 2) / view.zoom };
}
export function worldToScreen(p: Point, view: Viewport, size: Point): Point {
  return { x: (p.x - view.centerX) * view.zoom + size.x / 2, y: (p.y - view.centerY) * view.zoom + size.y / 2 };
}
export function zoomAt(view: Viewport, screen: Point, size: Point, zoom: number): Viewport {
  const world = screenToWorld(screen, view, size),
    z = Math.max(0.0001, Math.min(8, zoom));
  return {
    centerX: clampCoordinate(world.x - (screen.x - size.x / 2) / z),
    centerY: clampCoordinate(world.y - (screen.y - size.y / 2) / z),
    zoom: z,
  };
}
export function endpointPosition(
  project: NetworkProject,
  endpoint: NetworkProject['design']['connections'][number]['from'],
): Point | null {
  return networkEndpointPosition(project, endpoint);
}

/** Preserve saved interior anchors. Repair only the orthogonal joins, without
 * moving the actual endpoint or claiming that drawing distance is pipe length. */
export function resolveRoute(a: Point, b: Point, route?: NetworkRoute): Point[] {
  if (!route || route.mode !== 'manual') return [...connectionRoute(a, b)];
  const result: Point[] = [a];
  for (const p of [...route.points, b]) {
    const last = result.at(-1)!;
    if (last.x !== p.x && last.y !== p.y) result.push({ x: p.x, y: last.y });
    if (result.at(-1)!.x !== p.x || result.at(-1)!.y !== p.y) result.push(p);
  }
  return result;
}
export function manualRoute(id: string, points: readonly Point[]): NetworkRoute {
  // Keep explicit drawing anchors. Layout movement adapts terminal elbows in
  // the application layer; unrelated manually chosen middle bends remain fixed.
  return { connectionId: id, mode: 'manual', points };
}
export function moveRouteSegment(points: readonly Point[], index: number, delta: Point): Point[] {
  const a = points[index]!,
    b = points[index + 1]!;
  return points.map((p, i) =>
    i === index || i === index + 1
      ? a.x === b.x
        ? { x: clampCoordinate(p.x + delta.x), y: p.y }
        : { x: p.x, y: clampCoordinate(p.y + delta.y) }
      : p,
  );
}
/** Edit the displayed polyline, then save interior elbows only. Former endpoint
 * copies must not become persistent anchors on every segment adjustment. */
export function segmentRoute(id: string, points: readonly Point[], index: number, delta: Point): NetworkRoute {
  const a = points[index],
    b = points[index + 1],
    start = points[0],
    end = points.at(-1);
  if (!a || !b || !start || !end) throw new RangeError('Segment index is outside the drawing route');
  const axis = a.x === b.x ? 'x' : 'y';
  let coordinate = clampCoordinate(a[axis] + delta[axis]);
  // Snap at the first adjacent parallel run reached, eliminating its redundant
  // elbow pair instead of turning it into a new backtrack. Drawing units only.
  const reached = [points[index - 1], points[index + 2]]
    .filter((p): p is Point => p !== undefined && p[axis] !== a[axis])
    .map((p) => p[axis])
    .filter(
      (value) =>
        Math.abs(value - coordinate) <= 2 ||
        ((value - a[axis]) * (coordinate - a[axis]) > 0 && Math.abs(value - a[axis]) <= Math.abs(coordinate - a[axis])),
    )
    .sort((x, y) => Math.abs(x - a[axis]) - Math.abs(y - a[axis]));
  if (reached[0] !== undefined) coordinate = reached[0];
  const moved = moveRouteSegment(
    points,
    index,
    axis === 'x' ? { x: coordinate - a.x, y: 0 } : { x: 0, y: coordinate - a.y },
  );
  const compact: Point[] = [];
  for (const point of [start, ...moved, end]) {
    const last = compact.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    while (compact.length >= 2) {
      const previous = compact.at(-2),
        middle = compact.at(-1);
      if (!previous || !middle) break;
      const between = (value: number, x: number, y: number) => value >= Math.min(x, y) && value <= Math.max(x, y);
      if (
        (previous.x === middle.x && middle.x === point.x && between(middle.y, previous.y, point.y)) ||
        (previous.y === middle.y && middle.y === point.y && between(middle.x, previous.x, point.x))
      )
        compact.pop();
      else break;
    }
    compact.push(point);
  }
  const interior = compact.slice(1, -1);
  return manualRoute(id, interior.length ? interior : [{ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }]);
}
export function projectBounds(project: NetworkProject): { left: number; right: number; top: number; bottom: number } {
  const probePoints = (project.layout.probes ?? []).flatMap((p) => [
    { x: p.x - 150, y: p.y - 65 },
    { x: p.x + 150, y: p.y + 95 },
    ...(p.signalPoints ?? []),
  ]);
  const points: Point[] = project.layout.components.flatMap((p) => [
    { x: p.x - 225, y: p.y - 80 },
    { x: p.x + 225, y: p.y + 100 },
  ]);
  points.push(...probePoints);
  for (const text of project.layout.texts ?? [])
    points.push({ x: text.x, y: text.y }, { x: text.x + text.width, y: text.y + networkTextLayout(text).height });
  for (const bounds of networkDrawingObstacles(project))
    points.push({ x: bounds.left - 20, y: bounds.top - 30 }, { x: bounds.right + 20, y: bounds.bottom + 70 });
  points.push(
    ...project.layout.nodes.flatMap((p) => [
      { x: p.x - 20, y: p.y - 20 },
      { x: p.x + 100, y: p.y + 20 },
    ]),
  );
  for (const r of project.layout.routes) if (r.mode === 'manual') points.push(...r.points);
  if (!points.length) return { left: 0, right: 1200, top: 0, bottom: 800 };
  return {
    left: Math.min(...points.map((p) => p.x)) - 40,
    right: Math.max(...points.map((p) => p.x)) + 40,
    top: Math.min(...points.map((p) => p.y)) - 40,
    bottom: Math.max(...points.map((p) => p.y)) + 40,
  };
}
export function fitViewport(project: NetworkProject, size: Point): Viewport {
  const b = projectBounds(project);
  return {
    centerX: (b.left + b.right) / 2,
    centerY: (b.top + b.bottom) / 2,
    zoom: Math.max(0.0001, Math.min(8, size.x / (b.right - b.left), size.y / (b.bottom - b.top))),
  };
}
export function marqueeSelection(
  project: NetworkProject,
  start: Point,
  end: Point,
  paths: readonly { readonly id: string; readonly points: readonly Point[] }[],
): Selection[] {
  const box = {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  };
  if (end.x >= start.x)
    return [
      ...project.layout.components.flatMap((p): Selection[] => {
        const c = project.design.components.find((c) => c.id === p.componentId),
          bounds = c && networkComponentBounds(c, p);
        return bounds &&
          bounds.left >= box.left &&
          bounds.right <= box.right &&
          bounds.top >= box.top &&
          bounds.bottom <= box.bottom
          ? [{ kind: 'component', id: p.componentId }]
          : [];
      }),
      ...(project.layout.texts ?? [])
        .filter(
          (item) =>
            item.x >= box.left &&
            item.x + item.width <= box.right &&
            item.y >= box.top &&
            item.y + networkTextLayout(item).height <= box.bottom,
        )
        .map((item) => ({ kind: 'text' as const, id: item.id })),
      ...(project.layout.probes ?? [])
        .filter(
          (item) =>
            item.x - 30 >= box.left && item.x + 30 <= box.right && item.y - 43 >= box.top && item.y + 69 <= box.bottom,
        )
        .map((item) => ({ kind: 'probe' as const, id: item.probeId })),
    ];
  const inside = (p: Point) => p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
  const crosses = (a: Point, b: Point) => {
    let low = 0,
      high = 1;
    for (const axis of [
      { a: a.x, delta: b.x - a.x, min: box.left, max: box.right },
      { a: a.y, delta: b.y - a.y, min: box.top, max: box.bottom },
    ]) {
      if (axis.delta === 0) {
        if (axis.a < axis.min || axis.a > axis.max) return false;
        continue;
      }
      const t1 = (axis.min - axis.a) / axis.delta,
        t2 = (axis.max - axis.a) / axis.delta;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
    return true;
  };
  return paths
    .filter(
      (path) =>
        path.points.some(inside) ||
        path.points.some((p, i) => {
          const previous = path.points[i - 1];
          return previous ? crosses(previous, p) : false;
        }),
    )
    .map((path) => ({ kind: 'connection', id: path.id }));
}
