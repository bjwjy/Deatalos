import {
  limits,
  diagnostic,
  type NetworkConnection,
  type NetworkEndpoint,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import {
  branchCrossingCount,
  branchEndpointKey,
  branchPathCost,
  networkBranchConnectionGroups,
} from './network-branch-geometry.js';
import {
  compactTreePath,
  onSegment,
  pointKey,
  samePoint,
  segments,
  type Point,
  type Track,
  type TreeGeometry,
} from './network-tree-geometry.js';
import { networkDrawingRoutes } from './network-routing.js';
import { portTerminal, type HydraulicTreeDrawing } from './network-tree-routing.js';
import { shortestTreeAttachment } from './network-tree-search.js';
import { scoreHydraulicTree } from './network-tree-score.js';
import type { OptimizedNetworkDrawing } from './network-routing-optimization.js';

type Conflict = { p: Point; a: string; b: string };
type Occupant = Track & { edgeId: string };
export function inspectDrawingPaths(
  project: NetworkProject,
  geometry: TreeGeometry,
  paths: ReadonlyMap<string, readonly Point[]>,
  groups: ReadonlyMap<string, string>,
  collectConflicts = true,
) {
  const tracks: Occupant[] = [],
    terminals = new Map<string, Map<string, Set<string>>>();
  for (const edge of project.design.connections) {
    const points = paths.get(edge.id);
    const netId = groups.get(edge.id) ?? edge.id;
    for (const span of segments(points ?? [])) tracks.push({ ...span, netId, edgeId: edge.id });
    for (const end of [edge.from, edge.to]) {
      const p = geometry.position(project, end);
      if (!p) continue;
      const key = pointKey(p),
        terminal = branchEndpointKey(end);
      const owners = terminals.get(key) ?? new Map<string, Set<string>>();
      const nets = owners.get(terminal) ?? new Set<string>();
      nets.add(netId);
      owners.set(terminal, nets);
      terminals.set(key, owners);
    }
  }
  const drawing: HydraulicTreeDrawing = { project, paths, tracks, searches: 0, expanded: 0 };
  const shared = (p: Point, a: string, b: string) =>
    [...(terminals.get(pointKey(p))?.values() ?? [])].some((s) => s.has(a) && s.has(b));
  const conflicts: Conflict[] = [];
  const metrics = scoreHydraulicTree(
    drawing,
    geometry,
    shared,
    collectConflicts ? (p, a, b) => conflicts.push({ p, a, b }) : undefined,
  );
  return { drawing, tracks, metrics, conflicts, shared };
}

function exits(project: NetworkProject, end: NetworkEndpoint, geometry: TreeGeometry, sharedPort: boolean) {
  const t = portTerminal(project, end, geometry, 12);
  if (!t) return [];
  const result = [t.exit];
  if (sharedPort && end.kind === 'port') {
    // A physical pipe and a separate ideal net may share a port but not its drawn lead.
    // Offer tangent departures on either side of this port, never through its inward face.
    const box = geometry.obstacles(project).find((b) => b.id === end.componentId);
    if (box)
      result.push(
        ...(t.p.x === t.exit.x
          ? [
              { x: box.left - 8, y: t.p.y },
              { x: box.right + 8, y: t.p.y },
            ]
          : [
              { x: t.p.x, y: box.top - 8 },
              { x: t.p.x, y: box.bottom + 8 },
            ]),
      );
  }
  return result;
}

function repairEdge(
  project: NetworkProject,
  geometry: TreeGeometry,
  edge: NetworkConnection,
  original: readonly Point[],
  foreign: readonly Occupant[],
  shared: (p: Point, other: string) => boolean,
  templatesOnly = false,
): readonly Point[] | null {
  const a = original[0],
    b = original.at(-1);
  if (!a || !b) return null;
  const boxes = geometry.obstacles(project);
  const obstacles = (end: NetworkEndpoint) => boxes.filter((box) => end.kind !== 'port' || end.componentId !== box.id);
  const first = obstacles(edge.from),
    last = obstacles(edge.to);
  const at = (p: Point, t: Track) => onSegment(p, t.from, t.to);
  // Only real shared terminals may touch another net at the start or finish.
  if (foreign.some((t) => (at(a, t) && !shared(a, t.netId)) || (at(b, t) && !shared(b, t.netId)))) return null;
  let best: readonly Point[] | null = null,
    price = Infinity;
  const start = exits(
    project,
    edge.from,
    geometry,
    foreign.some((t) => shared(a, t.netId)),
  );
  const finish = exits(
    project,
    edge.to,
    geometry,
    foreign.some((t) => shared(b, t.netId)),
  );
  const followsExit = (p: Point, q: Point, choices: readonly Point[]) =>
    choices.some((exit) => samePoint(exit, p) || onSegment(exit, p, q) || onSegment(q, p, exit));
  function consider(raw: readonly Point[]) {
    const points = compactTreePath(raw);
    if (points.some((p) => Math.abs(p.x) > limits.canvasCoordinate || Math.abs(p.y) > limits.canvasCoordinate)) return;
    if (
      points.length < 2 ||
      points.some(
        (p, i) =>
          i > 0 &&
          i + 1 < points.length &&
          (onSegment(points[i - 1]!, p, points[i + 1]!) || onSegment(points[i + 1]!, points[i - 1]!, p)),
      )
    )
      return;
    if (!followsExit(a!, points[1]!, start) || !followsExit(b!, points.at(-2)!, finish)) return;
    const spans = segments(points);
    if (
      !spans.every(({ from, to }, i) =>
        geometry.clear(
          from,
          to,
          spans.length === 1
            ? first.filter((box) => last.includes(box))
            : i === 0
              ? first
              : i === spans.length - 1
                ? last
                : boxes,
        ),
      )
    )
      return;
    const cost = branchPathCost(points, foreign, [], 512);
    if (cost < price) {
      price = cost;
      best = points;
    }
  }
  // First try moving a single interior run; all other elbows stay at their existing positions.
  for (let i = 1; i + 2 < original.length; i++) {
    const p = original[i]!,
      q = original[i + 1]!,
      axis = p.x === q.x ? 'x' : 'y';
    for (const shift of [-8, 8, -16, 16, -28, 28]) {
      const path = [...original];
      path[i] = { ...p, [axis]: p[axis] + shift };
      path[i + 1] = { ...q, [axis]: q[axis] + shift };
      consider(path);
    }
  }

  for (const s of start)
    for (const t of finish) {
      const route = (...middle: Point[]) => consider([a, s, ...middle, t, b]);
      route({ x: s.x, y: t.y });
      route({ x: t.x, y: s.y });
      if (templatesOnly && boxes.length) {
        for (const y of [
          Math.min(...boxes.map((b) => b.top)) - 12,
          Math.max(...boxes.map((b) => b.bottom)) + 12,
          ...original.slice(1, -1).map((p) => p.y),
        ])
          route({ x: s.x, y }, { x: t.x, y });
        for (const x of [
          Math.min(...boxes.map((b) => b.left)) - 12,
          Math.max(...boxes.map((b) => b.right)) + 12,
          ...original.slice(1, -1).map((p) => p.x),
        ])
          route({ x, y: s.y }, { x, y: t.y });
      }
      for (const spacing of [0, -8, 8, -20, 20, -40, 40]) {
        for (const x of [s.x + spacing, t.x + spacing, (s.x + t.x) / 2 + spacing]) route({ x, y: s.y }, { x, y: t.y });
        for (const y of [s.y + spacing, t.y + spacing, (s.y + t.y) / 2 + spacing]) route({ x: s.x, y }, { x: t.x, y });
      }
    }
  if (best || templatesOnly) return best;
  const corners = new Map<string, Point>();
  for (const track of foreign)
    for (const p of [track.from, track.to]) if (!samePoint(p, a) && !samePoint(p, b)) corners.set(pointKey(p), p);
  const blocked = [
    ...boxes,
    ...[...corners.values()].map((p) => ({ left: p.x - 1, right: p.x + 1, top: p.y - 1, bottom: p.y + 1 })),
  ];
  for (const s of start)
    for (const t of finish) {
      if (!geometry.clear(a, s, first) || !geometry.clear(t, b, last)) continue;
      const found = shortestTreeAttachment(s, [{ from: t, to: t }], blocked, foreign, {
        clear: geometry.clear,
        allowedContacts: [a, b],
        maximumGrid: 32000,
        maximumExpanded: 24000,
      });
      if (found.ok) consider([a, ...found.points, b]);
      if (best) return best;
    }
  return best;
}

/** Repair only requested automatic connections implicated in an inter-net contact.
 * Each accepted pass is checked against the entire drawing, including preserved manual paths. */
export function repairFallbackDrawing(
  project: NetworkProject,
  geometry: TreeGeometry,
  editable: ReadonlySet<string>,
): Result<OptimizedNetworkDrawing> {
  const groups = networkBranchConnectionGroups(project);
  const boxes = geometry.obstacles(project);
  for (const [i, a] of boxes.entries()) {
    const b = boxes
      .slice(i + 1)
      .find((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
    if (b)
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'ROUTE_BLOCKED',
            '/layout/components',
            `元件 ${a.id} 与 ${b.id} 的外框重叠。请拉开这两个元件，或使用整图整理。`,
          ),
        ],
      };
  }
  const paths = new Map<string, readonly Point[]>();
  const routes = networkDrawingRoutes(project);
  const fixed = { ...geometry, obstacles: () => boxes };
  const missing: NetworkConnection[] = [];
  for (const edge of project.design.connections) {
    const route = routes.get(edge.id);
    if (!route?.ok) {
      missing.push(edge);
      continue;
    }
    const spans = segments(route.value);
    const clear = spans.every(({ from, to }, i) =>
      geometry.clear(
        from,
        to,
        boxes.filter(
          (box) =>
            !(i === 0 && edge.from.kind === 'port' && edge.from.componentId === box.id) &&
            !(i === spans.length - 1 && edge.to.kind === 'port' && edge.to.componentId === box.id),
        ),
      ),
    );
    if (!clear || spans.length === 0) {
      missing.push(edge);
      continue;
    }
    paths.set(edge.id, route.value);
  }
  for (const edge of missing) {
    const blocked = {
      ok: false as const,
      diagnostics: [
        diagnostic(
          'ROUTE_BLOCKED',
          '/layout/routes/' + edge.id,
          '线路 ' + edge.id + ' 的路径受阻，请调整附近元件或手动线路。',
        ),
      ],
    };
    if (!editable.has(edge.id)) return blocked;
    const from = geometry.position(project, edge.from),
      to = geometry.position(project, edge.to);
    if (!from || !to) return blocked;
    const occupied = inspectDrawingPaths(project, fixed, paths, groups),
      net = groups.get(edge.id) ?? edge.id;
    const next = repairEdge(
      project,
      fixed,
      edge,
      [from, to],
      occupied.tracks.filter((t) => t.netId !== net),
      (p, n) => occupied.shared(p, net, n),
    );
    if (!next) return blocked;
    paths.set(edge.id, next);
  }
  let state = inspectDrawingPaths(project, fixed, paths, groups);
  const originalCrossings = state.metrics.crossings,
    originalLength = state.metrics.length;
  const repairedIds = new Set<string>();
  let passes = 1;
  for (; passes <= 4 && !state.metrics.valid; passes++) {
    const hits = new Map<string, number>();
    for (const { p, a, b } of state.conflicts)
      for (const t of state.tracks) {
        if ((t.netId === a || t.netId === b) && onSegment(p, t.from, t.to) && editable.has(t.edgeId))
          hits.set(t.edgeId, (hits.get(t.edgeId) ?? 0) + 1);
      }
    let tracks = state.tracks,
      changed = false;
    const order = [...hits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [id] of order) {
      const edge = project.design.connections.find((e) => e.id === id)!,
        net = groups.get(id) ?? id,
        original = paths.get(id)!;
      const foreign = tracks.filter((t) => t.netId !== net);
      if (
        !state.conflicts.some(
          (c) =>
            (c.a === net || c.b === net) &&
            segments(original).some((t) => onSegment(c.p, t.from, t.to)) &&
            foreign.some((t) => (t.netId === c.a || t.netId === c.b) && onSegment(c.p, t.from, t.to)),
        )
      )
        continue;
      const next = repairEdge(project, fixed, edge, original, foreign, (p, other) => state.shared(p, net, other));
      if (!next) continue;
      paths.set(id, next);
      repairedIds.add(id);
      tracks = [
        ...tracks.filter((t) => t.edgeId !== id),
        ...segments(next).map((t) => ({ ...t, edgeId: id, netId: net })),
      ];
      changed = true;
    }
    if (!changed) break;
    state = inspectDrawingPaths(project, fixed, paths, groups);
  }
  if (state.metrics.valid) {
    // Reusing a clear lane can remove old crossings exposed when coincident nets were separated.
    // Price a bounded set of template alternatives against the whole drawing before accepting them.
    if (state.metrics.crossings > originalCrossings) {
      const ranked = project.design.connections
        .filter((e) => editable.has(e.id))
        .map((edge) => {
          const net = groups.get(edge.id) ?? edge.id;
          const foreign = state.tracks.filter((t) => t.netId !== net);
          const path = paths.get(edge.id)!;
          const crossings = branchCrossingCount(path, foreign);
          return { edge, net, crossings };
        })
        .filter((e) => Number.isFinite(e.crossings) && e.crossings > 0)
        .sort(
          (a, b) =>
            b.crossings - a.crossings || Number(repairedIds.has(b.edge.id)) - Number(repairedIds.has(a.edge.id)),
        );
      for (const { edge, net } of ranked.slice(0, 6)) {
        if (state.metrics.crossings <= originalCrossings) break;
        const next = repairEdge(
          project,
          fixed,
          edge,
          paths.get(edge.id)!,
          state.tracks.filter((t) => t.netId !== net),
          (p, n) => state.shared(p, net, n),
          true,
        );
        if (!next) continue;
        const trialPaths = new Map(state.drawing.paths).set(edge.id, next);
        const trial = inspectDrawingPaths(project, fixed, trialPaths, groups);
        if (
          trial.metrics.valid &&
          trial.metrics.crossings < state.metrics.crossings &&
          trial.metrics.length <= Math.max(originalLength, state.metrics.length)
        )
          state = trial;
      }
    }
    return {
      ok: true,
      value: { drawing: state.drawing, metrics: state.metrics, method: 'verified-fallback', trials: passes },
    };
  }
  return {
    ok: false,
    diagnostics: [
      diagnostic(
        'ROUTE_BLOCKED',
        '/layout/routes',
        '未找到通过整图检查的走线：异网重叠 ' +
          state.metrics.overlap.toFixed(1) +
          '，异网接触 ' +
          state.metrics.foreignTouches +
          ' 处。请调整元件间距或手动线路。',
      ),
    ],
  };
}
