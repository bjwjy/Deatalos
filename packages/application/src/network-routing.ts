import {
  diagnostic,
  networkComponentBounds,
  networkPortAnchor,
  type NetworkEndpoint,
  type NetworkProject,
  type NetworkRoute,
  type Result,
} from '@hyd/domain';
import { networkLayoutBuses, type NetworkDrawingBus } from './network-layout-buses.js';
import { readTreeRoutes } from './network-routing-cache.js';
import type { TreeGeometry } from './network-tree-geometry.js';

export interface DrawingPoint {
  readonly x: number;
  readonly y: number;
}
export interface DrawingObstacle {
  readonly id: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}
export interface DrawingSegment {
  readonly from: DrawingPoint;
  readonly to: DrawingPoint;
}
function congestion(a: DrawingPoint, b: DrawingPoint, occupied: readonly DrawingSegment[]): number {
  let penalty = 0;
  for (const { from: c, to: d } of occupied) {
    if (a.x === b.x && c.x === d.x && a.x === c.x)
      penalty +=
        Math.max(
          0,
          Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)),
        ) * 4;
    else if (a.y === b.y && c.y === d.y && a.y === c.y)
      penalty +=
        Math.max(
          0,
          Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)),
        ) * 4;
    else if (
      a.x === b.x &&
      c.y === d.y &&
      a.x > Math.min(c.x, d.x) &&
      a.x < Math.max(c.x, d.x) &&
      c.y > Math.min(a.y, b.y) &&
      c.y <= Math.max(a.y, b.y)
    )
      penalty += 96;
    else if (
      a.y === b.y &&
      c.x === d.x &&
      c.x > Math.min(a.x, b.x) &&
      c.x <= Math.max(a.x, b.x) &&
      a.y > Math.min(c.y, d.y) &&
      a.y < Math.max(c.y, d.y)
    )
      penalty += 96;
  }
  return penalty;
}
/** Registered maximum body/actuation/port envelopes. Text labels are annotations, not solid obstacles. */
export function networkDrawingObstacles(project: NetworkProject): DrawingObstacle[] {
  return project.layout.components.flatMap((p) => {
    const c = project.design.components.find((c) => c.id === p.componentId);
    const bounds = c && networkComponentBounds(c, p);
    return bounds ? [{ id: p.componentId, ...bounds }] : [];
  });
}
export function networkEndpointPosition(project: NetworkProject, e: NetworkEndpoint): DrawingPoint | null {
  if (e.kind === 'node') {
    const node = project.layout.nodes.find((n) => n.nodeId === e.nodeId);
    return node ? { x: node.x, y: node.y } : null;
  }
  const c = project.design.components.find((c) => c.id === e.componentId),
    p = project.layout.components.find((p) => p.componentId === e.componentId);
  const anchor = c && p ? networkPortAnchor(c, p, e.portId) : null;
  return anchor ? { x: anchor.x, y: anchor.y } : null;
}

const same = (a: DrawingPoint, b: DrawingPoint) => a.x === b.x && a.y === b.y;
function compact(points: readonly DrawingPoint[], mode: 'avoid' | 'manual' = 'avoid'): DrawingPoint[] {
  const out: DrawingPoint[] = [];
  for (const p of points) {
    if (out.length && same(out.at(-1)!, p)) continue;
    while (out.length >= 2) {
      const a = out.at(-2)!,
        b = out.at(-1)!;
      const between = (value: number, start: number, end: number) =>
        value >= Math.min(start, end) && value <= Math.max(start, end);
      const redundant =
        (a.x === b.x && b.x === p.x && (mode === 'avoid' || between(b.y, a.y, p.y))) ||
        (a.y === b.y && b.y === p.y && (mode === 'avoid' || between(b.x, a.x, p.x)));
      if (redundant) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}
const inside = (p: DrawingPoint, r: DrawingObstacle) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
export function drawingSegmentClear(
  a: DrawingPoint,
  b: DrawingPoint,
  obstacles: readonly Omit<DrawingObstacle, 'id'>[],
): boolean {
  if (a.x !== b.x && a.y !== b.y) return false;
  return !obstacles.some((r) =>
    a.x === b.x
      ? a.x > r.left && a.x < r.right && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom
      : a.y > r.top && a.y < r.bottom && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right,
  );
}
/** Bounded Manhattan visibility grid. Deterministic A*, length plus bend cost; no global optimum promise. */
export function orthogonalDrawingPath(
  a: DrawingPoint,
  b: DrawingPoint,
  obstacles: readonly DrawingObstacle[],
  occupied: readonly DrawingSegment[] = [],
): Result<readonly DrawingPoint[]> {
  const failed = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('ROUTE_BLOCKED', '/layout/routes', message)],
  });
  if (obstacles.some((r) => inside(a, r) || inside(b, r)))
    return failed('锚点或油口出口被元件占用，请移动重叠元件；未生成穿越障碍的成功路径。');
  const clear = (p: readonly DrawingPoint[]) => p.slice(1).every((v, i) => drawingSegmentClear(p[i]!, v, obstacles));
  for (const points of [
    [a, b],
    [a, { x: a.x, y: b.y }, b],
    [a, { x: b.x, y: a.y }, b],
  ])
    if (clear(points) && points.slice(1).every((p, i) => congestion(points[i]!, p, occupied) === 0))
      return { ok: true, value: compact(points) };
  // Bounded additional channels separate unrelated parallel edges without inflating symbol clearance.
  const channels = (axis: 'x' | 'y') =>
    [
      ...new Set(
        occupied
          .filter((s) => (axis === 'x' ? s.from.x === s.to.x : s.from.y === s.to.y))
          .flatMap((s) => [s.from[axis] - 10, s.from[axis] + 10]),
      ),
    ]
      .sort((u, v) => Math.abs(u - (a[axis] + b[axis]) / 2) - Math.abs(v - (a[axis] + b[axis]) / 2) || u - v)
      .slice(0, 16);
  const xs = [...new Set([a.x, b.x, ...obstacles.flatMap((r) => [r.left, r.right]), ...channels('x')])].sort(
      (a, b) => a - b,
    ),
    ys = [...new Set([a.y, b.y, ...obstacles.flatMap((r) => [r.top, r.bottom]), ...channels('y')])].sort(
      (a, b) => a - b,
    );
  if (xs.length * ys.length > 24000 || obstacles.length > 160)
    return failed('避障网格超过当前资源预算，请缩小范围或先整理元件。');
  const width = xs.length,
    start = ys.indexOf(a.y) * width + xs.indexOf(a.x),
    end = ys.indexOf(b.y) * width + xs.indexOf(b.x);
  const point = (id: number): DrawingPoint => ({ x: xs[id % width]!, y: ys[Math.floor(id / width)]! });
  type Visit = { state: number; cost: number; score: number };
  const heap: Visit[] = [];
  const push = (v: Visit) => {
    heap.push(v);
    let i = heap.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (heap[p]!.score <= v.score) break;
      heap[i] = heap[p]!;
      i = p;
    }
    heap[i] = v;
  };
  const pop = (): Visit | undefined => {
    const first = heap[0],
      last = heap.pop();
    if (heap.length && last) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1;
        if (c + 1 < heap.length && heap[c + 1]!.score < heap[c]!.score) c++;
        if (heap[c]!.score >= last.score) break;
        heap[i] = heap[c]!;
        i = c;
      }
      heap[i] = last;
    }
    return first;
  };
  const costs = new Map<number, number>([[start * 3, 0]]),
    previous = new Map<number, number>();
  push({ state: start * 3, cost: 0, score: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) });
  let expanded = 0;
  while (heap.length) {
    const v = pop()!;
    if (v.cost !== costs.get(v.state)) continue;
    if (++expanded > 72000) return failed('避障搜索预算已用尽，请缩小范围或增加间距。');
    const id = Math.floor(v.state / 3),
      direction = v.state % 3,
      p = point(id);
    if (id === end) {
      const path: DrawingPoint[] = [];
      let s: number | undefined = v.state;
      while (s !== undefined) {
        path.push(point(Math.floor(s / 3)));
        s = previous.get(s);
      }
      return { ok: true, value: compact(path.reverse()) };
    }
    const x = id % width,
      y = Math.floor(id / width);
    for (const [next, d] of [
      [x > 0 ? id - 1 : -1, 1],
      [x + 1 < width ? id + 1 : -1, 1],
      [y > 0 ? id - width : -1, 2],
      [y + 1 < ys.length ? id + width : -1, 2],
    ]) {
      if (next === undefined || d === undefined || next < 0) continue;
      const q = point(next);
      if (!drawingSegmentClear(p, q, obstacles)) continue;
      const cost =
          v.cost +
          Math.abs(p.x - q.x) +
          Math.abs(p.y - q.y) +
          (direction && direction !== d ? 24 : 0) +
          congestion(p, q, occupied),
        state = next * 3 + d;
      if (cost >= (costs.get(state) ?? Infinity)) continue;
      costs.set(state, cost);
      previous.set(state, v.state);
      push({ state, cost, score: cost + Math.abs(q.x - b.x) + Math.abs(q.y - b.y) });
    }
  }
  return failed('在当前元件与锚点约束下无可用正交通路。');
}
/** Legacy/manual route semantics, used unchanged when obstacle avoidance has not been requested. */
export function basicDrawingRoute(a: DrawingPoint, b: DrawingPoint, route?: NetworkRoute): DrawingPoint[] {
  if (!route || route.mode !== 'manual')
    return Math.abs(a.y - b.y) < 8 ? [a, b] : [a, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b];
  const out: DrawingPoint[] = [a];
  for (const p of [...route.points, b]) {
    const last = out.at(-1)!;
    if (last.x !== p.x && last.y !== p.y) out.push({ x: p.x, y: last.y });
    if (!same(out.at(-1)!, p)) out.push(p);
  }
  return out;
}
/** Move only terminal elbows; a group move translates every saved anchor. This is drawing geometry only. */
export function followManualRouteEndpoints(
  route: Extract<NetworkRoute, { readonly mode: 'manual' }>,
  from: DrawingPoint,
  to: DrawingPoint,
  nextFrom: DrawingPoint,
  nextTo: DrawingPoint,
  groupDelta: DrawingPoint | null,
): NetworkRoute {
  const startDelta = { x: nextFrom.x - from.x, y: nextFrom.y - from.y };
  const endDelta = { x: nextTo.x - to.x, y: nextTo.y - to.y };
  if (!startDelta.x && !startDelta.y && !endDelta.x && !endDelta.y) return route;
  // The command delta avoids equality checks on independently rounded endpoints.
  if (groupDelta)
    return { ...route, points: route.points.map((p) => ({ x: p.x + groupDelta.x, y: p.y + groupDelta.y })) };
  const original = compact(basicDrawingRoute(from, to, route), 'manual');
  if (original.length < 2) return route;
  let anchors: DrawingPoint[];
  if (original.length === 2) {
    // A straight line needs two elbows when its ends move to different parallel runs.
    // Keep its interior anchor as the bridge position, rather than accumulating endpoint copies.
    const horizontal = from.y === to.y;
    const axis = horizontal ? 'x' : 'y';
    const saved = route.points.find(
      (p) => p[axis] > Math.min(from[axis], to[axis]) && p[axis] < Math.max(from[axis], to[axis]),
    );
    const middle = saved?.[axis] ?? (from[axis] + to[axis]) / 2;
    anchors = horizontal
      ? [
          { x: middle, y: nextFrom.y },
          { x: middle, y: nextTo.y },
        ]
      : [
          { x: nextFrom.x, y: middle },
          { x: nextTo.x, y: middle },
        ];
  } else {
    anchors = original.slice(1, -1).map((p) => ({ ...p }));
    if (startDelta.x || startDelta.y) {
      const axis = original[0]!.x === original[1]!.x ? 'x' : 'y';
      for (let i = 0; i < anchors.length && original[i + 1]![axis] === from[axis]; i++)
        anchors[i] = { ...anchors[i]!, [axis]: nextFrom[axis] };
    }
    if (endDelta.x || endDelta.y) {
      const axis = original.at(-1)!.x === original.at(-2)!.x ? 'x' : 'y';
      // Read adjusted points: the ends may share an elbow or a collinear legacy run.
      for (let i = anchors.length - 1; i >= 0 && original[i + 1]![axis] === to[axis]; i--)
        anchors[i] = { ...anchors[i]!, [axis]: nextTo[axis] };
    }
  }
  const moved = compact(basicDrawingRoute(nextFrom, nextTo, { ...route, points: anchors }), 'manual').slice(1, -1);
  const points = moved.length ? moved : [anchors[0]!];
  return { ...route, points };
}
/** Auto avoidance is derived from the saved mode/current layout, shared by canvas and SVG.
 * Only endpoint owners may be crossed on the registered outward port stub. Manual anchors stay exact. */
function routeConnection(
  project: NetworkProject,
  id: string,
  override?: NetworkRoute,
  occupied: readonly DrawingSegment[] = [],
  buses: readonly NetworkDrawingBus[] = [],
): Result<readonly DrawingPoint[]> {
  const edge = project.design.connections.find((e) => e.id === id);
  if (!edge) return { ok: false, diagnostics: [diagnostic('ROUTE_INVALID', '/layout/routes', '连接不存在。')] };
  const a = networkEndpointPosition(project, edge.from),
    b = networkEndpointPosition(project, edge.to),
    route = override ?? project.layout.routes.find((r) => r.connectionId === id);
  if (!a || !b)
    return { ok: false, diagnostics: [diagnostic('ROUTE_INVALID', '/layout/routes', '油口或节点缺少布局。')] };
  if (route?.mode !== 'avoid') return { ok: true, value: basicDrawingRoute(a, b, route) };
  // Match the validated tight-layout router: registered symbol envelopes are the
  // obstacles, with no extra inflation. This also keeps fallback paths usable after a drag.
  const obstacles = networkDrawingObstacles(project);
  for (const p of project.layout.nodes) {
    if ([edge.from, edge.to].some((e) => e.kind === 'node' && e.nodeId === p.nodeId)) continue;
    obstacles.push({ id: 'node:' + p.nodeId, left: p.x - 12, right: p.x + 12, top: p.y - 12, bottom: p.y + 12 });
  }
  function stub(e: NetworkEndpoint, p: DrawingPoint): DrawingPoint {
    if (e.kind === 'node') return p;
    const c = project.design.components.find((c) => c.id === e.componentId),
      r = obstacles.find((r) => r.id === e.componentId),
      placement = project.layout.components.find((p) => p.componentId === e.componentId),
      port = c && placement && networkPortAnchor(c, placement, e.portId);
    if (!r || !port) return p;
    return {
      x: port.dx < 0 ? r.left : port.dx > 0 ? r.right : p.x,
      y: port.dy < 0 ? r.top : port.dy > 0 ? r.bottom : p.y,
    };
  }
  const sa = stub(edge.from, a),
    sb = stub(edge.to, b);
  const others = (e: NetworkEndpoint) => obstacles.filter((r) => e.kind !== 'port' || r.id !== e.componentId);
  if (!drawingSegmentClear(a, sa, others(edge.from)) || !drawingSegmentClear(sb, b, others(edge.to)))
    return {
      ok: false,
      diagnostics: [diagnostic('ROUTE_BLOCKED', '/layout/routes/' + id, '油口的注册出口被其他元件挡住；请调整间距。')],
    };
  const bus = buses.find((bus) => bus.connectionIds.has(id));
  const stationOnly = [edge.from, edge.to].every(
    (end) =>
      end.kind === 'port' &&
      project.design.components.some(
        (c) => c.id === end.componentId && ['pump', 'pressure-source', 'tank', 'relief', 'volume'].includes(c.typeId),
      ),
  );
  if (bus && !stationOnly) {
    const ta = { x: sa.x, y: bus.y },
      tb = { x: sb.x, y: bus.y };
    // Nodes on this same ideal net may sit on the shared bus. Other nodes remain
    // obstacles; visually shared tracks never join different hydraulic nets.
    const channelObstacles = obstacles.filter((o) => ![...bus.nodeIds].some((id) => o.id === 'node:' + id));
    if (drawingSegmentClear(ta, tb, channelObstacles)) {
      const first = orthogonalDrawingPath(sa, ta, channelObstacles, occupied);
      const last = orthogonalDrawingPath(tb, sb, channelObstacles, occupied);
      if (first.ok && last.ok) return { ok: true, value: compact([a, ...first.value, ta, tb, ...last.value, b]) };
    }
  }
  const middle = orthogonalDrawingPath(sa, sb, obstacles, occupied);
  return middle.ok ? { ok: true, value: compact([a, ...middle.value, b]) } : middle;
}
/** One deterministic pass: manual/legacy paths stay exact; shorter automatic links get channels first.
 * Remaining orthogonal paths penalise crossings and coincident tracks, shared by canvas and SVG. */
export const networkTreeGeometry: TreeGeometry = {
  obstacles: networkDrawingObstacles,
  position: networkEndpointPosition,
  clear: drawingSegmentClear,
};
export function networkDrawingRoutes(project: NetworkProject): ReadonlyMap<string, Result<readonly DrawingPoint[]>> {
  const saved = readTreeRoutes(project, networkTreeGeometry);
  if (saved?.size === project.design.connections.length)
    return new Map([...saved].map(([id, points]) => [id, { ok: true as const, value: points }]));
  const result = new Map<string, Result<readonly DrawingPoint[]>>(),
    occupied: (DrawingSegment & { readonly connectionId: string })[] = [];
  const buses = networkLayoutBuses(project);
  const length = (id: string) => {
    const e = project.design.connections.find((e) => e.id === id);
    if (!e) return Infinity;
    const a = networkEndpointPosition(project, e.from),
      b = networkEndpointPosition(project, e.to);
    return a && b ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : Infinity;
  };
  const mode = (id: string) => project.layout.routes.find((r) => r.connectionId === id)?.mode;
  const ordered = [...project.design.connections].sort(
    (a, b) =>
      Number(mode(a.id) === 'avoid') - Number(mode(b.id) === 'avoid') ||
      length(a.id) - length(b.id) ||
      a.id.localeCompare(b.id, 'en'),
  );
  for (const edge of ordered) {
    const bus = buses.find((bus) => bus.connectionIds.has(edge.id));
    const tracks = bus ? occupied.filter((segment) => !bus.connectionIds.has(segment.connectionId)) : occupied;
    const cached = saved?.get(edge.id);
    const route: Result<readonly DrawingPoint[]> = cached
      ? { ok: true, value: cached }
      : routeConnection(project, edge.id, undefined, tracks, buses);
    result.set(edge.id, route);
    if (route.ok)
      for (let i = 1; i < route.value.length; i++) {
        const from = route.value[i - 1],
          to = route.value[i];
        if (from && to) occupied.push({ from, to, connectionId: edge.id });
      }
  }
  return result;
}
export function networkDrawingRoute(
  project: NetworkProject,
  id: string,
  override?: NetworkRoute,
): Result<readonly DrawingPoint[]> {
  if (override || project.layout.routes.find((r) => r.connectionId === id)?.mode !== 'avoid')
    return routeConnection(project, id, override);
  return (
    networkDrawingRoutes(project).get(id) ?? {
      ok: false,
      diagnostics: [diagnostic('ROUTE_INVALID', '/layout/routes', '连接不存在。')],
    }
  );
}
