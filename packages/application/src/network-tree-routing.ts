import { connectionGraph } from '@hyd/engine';
import { diagnostic, networkPortAnchor, type NetworkEndpoint, type NetworkProject, type Result } from '@hyd/domain';
import { shortestTreeAttachment, type TreeSearchPolicy } from './network-tree-search.js';
import {
  compactTreePath,
  distance,
  onSegment,
  pointKey,
  projected,
  required,
  samePoint,
  segments,
  treeGraph,
  treePath,
  type Point,
  type Track,
  type TreeGeometry,
  type Box,
} from './network-tree-geometry.js';

export interface HydraulicTreeDrawing {
  readonly project: NetworkProject;
  readonly paths: ReadonlyMap<string, readonly Point[]>;
  readonly tracks: readonly Track[];
  readonly searches: number;
  readonly expanded: number;
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('ROUTE_BLOCKED', '/layout/routes', message)],
});

/** Foreign corners and T contacts block attachment; an ordinary straight crossing remains legal. */
function foreignObstacles(tracks: readonly Track[]): Box[] {
  const points = new Map(
    tracks.flatMap(
      ({ from, to, netId }) =>
        [
          [netId + ':' + pointKey(from), { p: from, netId }],
          [netId + ':' + pointKey(to), { p: to, netId }],
        ] as const,
    ),
  );
  return [...points.values()]
    .filter(({ p, netId }) => {
      const directions = new Set<string>();
      for (const t of tracks.filter((t) => t.netId === netId && onSegment(p, t.from, t.to)))
        for (const q of [t.from, t.to]) {
          if (q.x < p.x) directions.add('L');
          if (q.x > p.x) directions.add('R');
          if (q.y < p.y) directions.add('U');
          if (q.y > p.y) directions.add('D');
        }
      const order = [...directions].sort().join('');
      return order !== 'LR' && order !== 'DU';
    })
    .map(({ p: { x, y } }) => ({ left: x - 1, right: x + 1, top: y - 1, bottom: y + 1 }));
}
type Terminal = { readonly end: NetworkEndpoint; readonly p: Point; readonly exit: Point };
export function portTerminal(
  project: NetworkProject,
  end: NetworkEndpoint,
  geometry: TreeGeometry,
  minimumLead = 0,
): Terminal | null {
  const p = geometry.position(project, end);
  if (!p) return null;
  if (end.kind === 'node') return { end, p, exit: p };
  const c = project.design.components.find((c) => c.id === end.componentId),
    at = project.layout.components.find((at) => at.componentId === end.componentId),
    anchor = c && at && networkPortAnchor(c, at, end.portId),
    box = geometry.obstacles(project).find((b) => b.id === end.componentId);
  if (!anchor || !box) return null;
  const lead = (edge: number, port: number, sign: number) =>
    minimumLead > 0 && (edge - port) * sign < minimumLead ? port + sign * minimumLead : edge;
  return {
    end,
    p,
    exit: {
      x: anchor.dx < 0 ? lead(box.left, p.x, -1) : anchor.dx > 0 ? lead(box.right, p.x, 1) : p.x,
      y: anchor.dy < 0 ? lead(box.top, p.y, -1) : anchor.dy > 0 ? lead(box.bottom, p.y, 1) : p.y,
    },
  };
}

/** Obstacle-aware Prim heuristic with multi-goal A* to the entire same-net tree.
 * Nets come only from ideal connections; no search crosses a component pressure boundary.
 * Existing engineering edges are preserved, each recovers its unique path through this tree.
 * Search budgets bound one run; no global-minimum guarantee. */
export function routeHydraulicTrees(
  project: NetworkProject,
  geometry: TreeGeometry,
  options: {
    readonly reverse?: boolean;
    readonly junctions: 'preserve' | 'follow';
    readonly searchPolicy?: TreeSearchPolicy;
    readonly buses?: readonly { readonly connectionIds: ReadonlySet<string>; readonly y: number }[];
    readonly busPortLead?: number;
  },
): Result<HydraulicTreeDrawing> {
  if (
    project.design.connections.some((e) => e.kind !== 'ideal') ||
    project.layout.routes.some((r) => r.mode === 'manual')
  )
    return fail('同网树布线仅处理自动理想连接；物理管和手动路径由原布线流程保留。');
  if (project.design.components.length > 160 || project.design.nodes.length > 256)
    return fail('同网树布线超过资源预算。');
  const graph = connectionGraph(project);
  if (!graph.ok) return graph;
  const boxes = geometry.obstacles(project),
    types = new Map(project.design.components.map((c) => [c.id, c.typeId]));
  const nets = graph.value.nets.map((net) => ({
    ...net,
    ends: net.terminals
      .filter((t) => t.kind === 'component')
      .map((t) => ({ kind: 'port' as const, componentId: t.ownerId, portId: t.portId })),
  }));
  nets.sort((a, b) => (options.reverse ? -1 : 1) * (a.ends.length - b.ends.length) || a.id.localeCompare(b.id));
  const paths = new Map<string, readonly Point[]>(),
    nodes = new Map(project.layout.nodes.map((n) => [n.nodeId, n])),
    occupied: Track[] = [];
  let searches = 0,
    expanded = 0;
  for (const net of nets) {
    if (!net.connectionIds.length) continue;
    const bus = options.buses?.find((b) => net.connectionIds.some((id) => b.connectionIds.has(id)));
    const terminals: Terminal[] = [];
    for (const end of net.ends) {
      const lead = bus && types.get(end.componentId) === 'valve' ? options.busPortLead : undefined;
      const terminal = portTerminal(project, end, geometry, lead);
      if (!terminal) return fail('油口缺少注册几何。');
      terminals.push(terminal);
    }
    if (!terminals.length) return fail('同网缺少物理油口：' + net.id);
    const priority = (t: Terminal) =>
      t.end.kind === 'port'
        ? types.get(t.end.componentId) === 'tank'
          ? 0
          : types.get(t.end.componentId) === 'pump'
            ? 1
            : 2
        : 3;
    terminals.sort(
      (a, b) =>
        priority(a) - priority(b) ||
        a.p.x - b.p.x ||
        a.p.y - b.p.y ||
        JSON.stringify(a.end).localeCompare(JSON.stringify(b.end)),
    );
    const root = required(terminals[0]),
      pending = terminals.slice(1),
      tracks = segments([root.p, root.exit]).filter(({ from, to }) => !samePoint(from, to));
    const blocked = [...boxes, ...foreignObstacles(occupied)];
    for (const t of terminals)
      if (
        !geometry.clear(
          t.p,
          t.exit,
          boxes.filter((b) => t.end.kind !== 'port' || b.id !== t.end.componentId),
        )
      )
        return fail('油口出口被遮挡：' + JSON.stringify(t.end));
    if (bus) {
      const left = { x: Math.min(...terminals.map((t) => t.exit.x)), y: bus.y },
        right = { x: Math.max(...terminals.map((t) => t.exit.x)), y: bus.y };
      if (!geometry.clear(left, right, blocked)) return fail('共用主干受阻：' + net.id);
      const tap = { x: root.exit.x, y: bus.y };
      searches++;
      const link = shortestTreeAttachment(root.exit, [{ from: tap, to: tap }], blocked, occupied, {
        clear: geometry.clear,
        ...options.searchPolicy,
      });
      expanded += link.expanded ?? 0;
      if (!link.ok) return fail('主干入口受阻：' + net.id);
      tracks.push(...segments(link.points));
      if (!samePoint(left, right)) tracks.push({ from: left, to: right });
    }
    const attach = (items: Terminal[]): boolean => {
      while (items.length) {
        const targetTracks = tracks.length ? tracks : [{ from: root.exit, to: root.exit }];
        const candidates = items
          .map((t) => ({
            t,
            lower: Math.min(...targetTracks.map((line) => distance(t.exit, projected(t.exit, line)))),
          }))
          .sort((a, b) => a.lower - b.lower);
        let selected: { t: Terminal; points: readonly Point[]; cost: number } | null = null;
        for (const { t, lower } of candidates) {
          if (selected && lower >= selected.cost) break;
          searches++;
          const result = shortestTreeAttachment(t.exit, targetTracks, blocked, occupied, {
            clear: geometry.clear,
            direction: samePoint(t.p, t.exit) ? 0 : t.p.x === t.exit.x ? 2 : 1,
            ...options.searchPolicy,
          });
          expanded += result.expanded ?? 0;
          if (!result.ok) continue;
          const cost = result.cost + distance(t.p, t.exit),
            points = compactTreePath([t.p, ...result.points]);
          if (!selected || cost < selected.cost) selected = { t, points, cost };
        }
        if (!selected) return false;
        tracks.push(...segments(selected.points));
        items.splice(items.indexOf(selected.t), 1);
      }
      return true;
    };
    if (!attach(pending)) return fail('找不到同网接力路径：' + net.id);
    if (options.junctions === 'preserve') {
      const pendingNodes: Terminal[] = [];
      for (const nodeId of net.nodeIds) {
        const node = nodes.get(nodeId);
        if (!node) return fail('节点缺少布局：' + nodeId);
        if (!tracks.some((t) => onSegment(node, t.from, t.to)))
          pendingNodes.push({ end: { kind: 'node', nodeId }, p: node, exit: node });
      }
      if (!attach(pendingNodes)) return fail('保留节点的位置无法接入同网：' + net.id);
    } else {
      for (const nodeId of net.nodeIds) {
        const before = nodes.get(nodeId);
        if (!before) return fail('节点缺少布局：' + nodeId);
        const possible = tracks
          .map((line) => projected(before, line))
          .filter((q) => !terminals.some(({ p }) => samePoint(p, q)) && geometry.clear(q, q, boxes));
        possible.sort((a, b) => distance(before, a) - distance(before, b) || a.x - b.x || a.y - b.y);
        const p = possible[0];
        if (!p) return fail('节点没有可用的同网位置：' + nodeId);
        nodes.set(nodeId, { ...before, ...p });
      }
    }
    const tree = treeGraph(tracks, [...terminals.map((t) => t.p), ...net.nodeIds.map((id) => required(nodes.get(id)))]);
    const endpointKey = (end: NetworkEndpoint): string | null => {
      const p = end.kind === 'port' ? geometry.position(project, end) : nodes.get(end.nodeId);
      return p ? pointKey(p) : null;
    };
    for (const id of net.connectionIds) {
      const edge = required(project.design.connections.find((e) => e.id === id)),
        a = endpointKey(edge.from),
        b = endpointKey(edge.to);
      const points = a && b ? treePath(tree, a, b) : null;
      if (!points || points.length < 2) return fail('同网路径断开或退化：' + id);
      paths.set(id, points);
    }
    for (const [id, links] of tree.adjacency)
      for (const peer of links)
        if (id < peer)
          occupied.push({ netId: net.id, from: required(tree.points.get(id)), to: required(tree.points.get(peer)) });
  }
  return {
    ok: true,
    value: {
      project: {
        ...project,
        layout: { ...project.layout, nodes: project.layout.nodes.map((n) => required(nodes.get(n.nodeId))) },
      },
      paths,
      tracks: occupied,
      searches,
      expanded,
    },
  };
}
