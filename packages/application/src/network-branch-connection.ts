import {
  ContractReader,
  diagnostic,
  immutable,
  isExternalMotorPressureTap,
  limits,
  parseNetworkProject,
  type NetworkEndpoint,
  type NetworkConnection,
  type NetworkProject,
  type NetworkRoute,
  type Result,
} from '@hyd/domain';
import {
  networkDrawingRoutes,
  networkEndpointPosition,
  networkTreeGeometry,
  type DrawingPoint,
} from './network-routing.js';
import { saveTreeRoutes } from './network-routing-cache.js';
import { basicBranchRoute, branchEndpointKey, branchNet, routeBranch } from './network-branch-geometry.js';
import { orientBranch } from './network-branch-orientation.js';
import {
  compactTreePath,
  distance,
  onSegment,
  pointKey,
  required,
  samePoint,
  segments,
  treeGraph,
  type Point,
} from './network-tree-geometry.js';

export interface NetworkRouteAnchor {
  readonly kind: 'route';
  readonly connectionId: string;
  readonly point: DrawingPoint;
}
export type NetworkConnectionAnchor = NetworkEndpoint | NetworkRouteAnchor;
export interface NetworkBranchConnectionPlan {
  readonly document: NetworkProject;
  readonly connectionId: string;
  readonly nodeIds: readonly string[];
  readonly routing: 'optimized' | 'basic';
  readonly orientationChanges: readonly string[];
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('CONNECTION_INVALID', '/branchConnection', message)],
});

function readAnchor(r: ContractReader, input: unknown, field: string): NetworkConnectionAnchor {
  const o = r.object(input, field, ['kind', 'componentId', 'portId', 'nodeId', 'connectionId', 'point']);
  if (o.kind === 'route') {
    r.object(input, field, ['kind', 'connectionId', 'point']);
    const p = r.object(o.point, field + '/point', ['x', 'y']);
    return {
      kind: 'route',
      connectionId: r.id(o.connectionId, field + '/connectionId'),
      point: {
        x: r.number(p.x, field + '/point/x', -limits.canvasCoordinate, limits.canvasCoordinate),
        y: r.number(p.y, field + '/point/y', -limits.canvasCoordinate, limits.canvasCoordinate),
      },
    };
  }
  if (o.kind === 'node') {
    r.object(input, field, ['kind', 'nodeId']);
    return { kind: 'node', nodeId: r.id(o.nodeId, field + '/nodeId') };
  }
  r.object(input, field, ['kind', 'componentId', 'portId']);
  r.constant(o.kind, 'port', field + '/kind');
  return {
    kind: 'port',
    componentId: r.id(o.componentId, field + '/componentId'),
    portId: r.id(o.portId, field + '/portId'),
  };
}
const routeRecord = (id: string, path: readonly Point[]): NetworkRoute => ({
  connectionId: id,
  mode: 'manual',
  points:
    path.length > 2
      ? path.slice(1, -1)
      : [{ x: (required(path[0]).x + required(path[1]).x) / 2, y: (required(path[0]).y + required(path[1]).y) / 2 }],
});
interface Edit {
  project: NetworkProject;
  paths: Map<string, readonly Point[]>;
  serial: number;
  prefix: string;
  nodeIds: string[];
  sharedDrawing: 'normalized' | 'preserved';
}
function allocate(edit: Edit, kind: 'n' | 'e'): string {
  const used = new Set([
    ...edit.project.design.nodes.map((n) => n.id),
    ...edit.project.design.connections.map((e) => e.id),
  ]);
  let id: string;
  do {
    id = edit.prefix.slice(0, 26) + '_' + kind + '_' + ++edit.serial;
  } while (used.has(id));
  return id;
}
function addNode(edit: Edit, p: Point): NetworkEndpoint {
  const id = allocate(edit, 'n');
  edit.nodeIds.push(id);
  edit.project = {
    ...edit.project,
    design: {
      ...edit.project.design,
      nodes: [...edit.project.design.nodes, { id, kind: 'ideal-hydraulic', label: '' }],
    },
    layout: { ...edit.project.layout, nodes: [...edit.project.layout.nodes, { nodeId: id, x: p.x, y: p.y }] },
  };
  return { kind: 'node', nodeId: id };
}
function endpointFor(project: NetworkProject, anchor: NetworkConnectionAnchor): NetworkEndpoint | null {
  if (anchor.kind !== 'route') return networkEndpointPosition(project, anchor) ? anchor : null;
  const edge = project.design.connections.find((e) => e.id === anchor.connectionId);
  return edge && edge.kind !== 'signal' ? edge.from : null;
}
function anchorChoices(
  project: NetworkProject,
  paths: ReadonlyMap<string, readonly Point[]>,
  anchor: NetworkConnectionAnchor,
): NetworkConnectionAnchor[] {
  if (anchor.kind !== 'route') return [anchor];
  const path = paths.get(anchor.connectionId);
  if (!path || !segments(path).some((s) => onSegment(anchor.point, s.from, s.to))) return [];
  if (project.design.connections.some((edge) => edge.id === anchor.connectionId && edge.kind === 'pipe'))
    return [anchor];
  const positions = compactTreePath(path)
    .slice(1, -1)
    .filter((p) => !samePoint(p, anchor.point))
    .filter((p) => !project.layout.nodes.some((n) => samePoint(n, p)))
    .sort((a, b) => distance(a, anchor.point) - distance(b, anchor.point))
    .slice(0, 4);
  // Legacy/manual elbows may sit inside a valve's maximum moving envelope.
  // Search nearby clear points on the SAME visible host, rather than rejecting
  // its whole hydraulic connection or moving an existing component/junction.
  const boxes = networkTreeGeometry.obstacles(project);
  if (!networkTreeGeometry.clear(anchor.point, anchor.point, boxes)) {
    const clearPoints = segments(path)
      .flatMap((s) =>
        boxes
          .flatMap((box) =>
            s.from.x === s.to.x
              ? [
                  { x: s.from.x, y: box.top - 12 },
                  { x: s.from.x, y: box.bottom + 12 },
                ]
              : [
                  { x: box.left - 12, y: s.from.y },
                  { x: box.right + 12, y: s.from.y },
                ],
          )
          .filter((p) => onSegment(p, s.from, s.to)),
      )
      .filter((p) => networkTreeGeometry.clear(p, p, boxes))
      .filter((p) => !samePoint(p, required(path[0])) && !samePoint(p, required(path.at(-1))))
      .filter((p) => !project.layout.nodes.some((n) => samePoint(n, p)))
      .sort((a, b) => distance(a, anchor.point) - distance(b, anchor.point))
      .slice(0, 4);
    positions.unshift(...clearPoints);
  }
  const nearby = [
    ...new Map(positions.filter((p) => !samePoint(p, anchor.point)).map((p) => [pointKey(p), p])).values(),
  ].slice(0, 4);
  return [anchor, ...nearby.map((point) => ({ ...anchor, point }))];
}

/** Materialize a touched shared drawing tree into existing two-ended edges and real junctions. */
function sharedJunction(edit: Edit, anchor: NetworkRouteAnchor, ids: ReadonlySet<string>): Result<NetworkEndpoint> {
  const edges = edit.project.design.connections.filter((e) => ids.has(e.id));
  if (edges.some((edge) => !edit.paths.has(edge.id))) return fail('共享油路含尚未解析的绘图路径。');
  const endpoints = new Map<string, NetworkEndpoint>();
  for (const e of edges) for (const end of [e.from, e.to]) endpoints.set(branchEndpointKey(end), end);
  const terminals = new Map<string, NetworkEndpoint>();
  for (const end of endpoints.values()) {
    const p = networkEndpointPosition(edit.project, end);
    if (!p) return fail('共享线的真实端点缺少位置。');
    const existing = terminals.get(pointKey(p));
    if (existing && branchEndpointKey(existing) !== branchEndpointKey(end))
      return fail('共享线有重叠真实端点，请先分开位置。');
    terminals.set(pointKey(p), end);
  }
  let joined = terminals.get(pointKey(anchor.point));
  if (!joined) {
    joined = addNode(edit, anchor.point);
    terminals.set(pointKey(anchor.point), joined);
  }
  const tracks = edges.flatMap((e) => segments(edit.paths.get(e.id) ?? []));
  if (tracks.length > 512) return fail('共享线局部整理超出几何预算，工程保持。');
  const tree = treeGraph(
    tracks,
    [...terminals.keys()].map((k) => required(treePoint(k, tracks, anchor.point))),
  );
  for (const [key, adj] of tree.adjacency)
    if (adj.size >= 3 && !terminals.has(key)) {
      const p = required(tree.points.get(key));
      if ([...edit.paths].some(([id, path]) => !ids.has(id) && segments(path).some((s) => onSegment(p, s.from, s.to))))
        return fail('共享分叉与其他油路交叉，不能自动生成真实节点。');
      terminals.set(key, addNode(edit, p));
    }
  const added: NetworkProject['design']['connections'][number][] = [];
  const routes: NetworkRoute[] = [],
    visited = new Set<string>(),
    available = new Set(edges.map((e) => e.id));
  for (const [start, from] of terminals)
    for (const peer of tree.adjacency.get(start) ?? []) {
      if (visited.has([start, peer].sort().join('|'))) continue;
      const points = [required(tree.points.get(start))];
      let previous = start,
        next = peer;
      while (true) {
        visited.add([previous, next].sort().join('|'));
        points.push(required(tree.points.get(next)));
        if (terminals.has(next)) break;
        const after = [...(tree.adjacency.get(next) ?? [])].find((k) => k !== previous);
        if (!after) return fail('共享线不能恢复到真实端点。');
        previous = next;
        next = after;
      }
      const to = required(terminals.get(next));
      if (branchEndpointKey(from) === branchEndpointKey(to)) continue;
      const reused = edges.find((e) => available.has(e.id) && branchEndpointKey(e.from) === branchEndpointKey(from));
      const id = reused?.id ?? allocate(edit, 'e');
      available.delete(id);
      const path = compactTreePath(points);
      added.push({ id, kind: 'ideal', from, to });
      routes.push(routeRecord(id, path));
      edit.paths.set(id, path);
    }
  for (const id of ids) if (!added.some((e) => e.id === id)) edit.paths.delete(id);
  edit.project = {
    ...edit.project,
    design: {
      ...edit.project.design,
      connections: [...edit.project.design.connections.filter((e) => !ids.has(e.id)), ...added],
    },
    layout: {
      ...edit.project.layout,
      routes: [...edit.project.layout.routes.filter((r) => !ids.has(r.connectionId)), ...routes],
    },
  };
  return { ok: true, value: joined };
}
function treePoint(key: string, tracks: readonly { from: Point; to: Point }[], extra: Point): Point | undefined {
  if (pointKey(extra) === key) return extra;
  return tracks.flatMap((t) => [t.from, t.to]).find((p) => pointKey(p) === key);
}
function realize(edit: Edit, anchor: NetworkConnectionAnchor): Result<NetworkEndpoint> {
  if (anchor.kind !== 'route') return { ok: true, value: anchor };
  const edge = edit.project.design.connections.find((e) => e.id === anchor.connectionId),
    path = edit.paths.get(anchor.connectionId);
  if (!edge || edge.kind === 'signal' || !path) return fail('取压点所属油管已改变。');
  const i = segments(path).findIndex((s) => onSegment(anchor.point, s.from, s.to));
  if (i < 0) return fail('接点不在当前可见路径上。');
  for (const end of [edge.from, edge.to])
    if (samePoint(required(networkEndpointPosition(edit.project, end) ?? undefined), anchor.point))
      return edge.kind === 'pipe' ? fail('请选择物理管内部的取压点。') : { ok: true, value: end };
  const ids = edge.kind === 'pipe' ? new Set([edge.id]) : branchNet(edit.project, edge.from);
  if (
    [...edit.paths].some(
      ([id, path]) => !ids.has(id) && segments(path).some((s) => onSegment(anchor.point, s.from, s.to)),
    )
  )
    return fail('接点与另一条油路重合，请先分开图形。');
  const shared = [...ids].filter((id) =>
    segments(edit.paths.get(id) ?? []).some((s) => onSegment(anchor.point, s.from, s.to)),
  );
  if (shared.length > 1) {
    const normalized: Edit = { ...edit, paths: new Map(edit.paths), nodeIds: [...edit.nodeIds] };
    const result = sharedJunction(normalized, anchor, ids);
    if (result.ok) {
      Object.assign(edit, normalized);
      return result;
    }
    // Preserve the real engineering graph when the shared drawing cannot be
    // rebuilt. Splitting only the picked edge keeps every other edge intact.
    edit.sharedDrawing = 'preserved';
  }
  const junction = addNode(edit, anchor.point),
    id = allocate(edit, 'e');
  const left = compactTreePath([...path.slice(0, i + 1), anchor.point]),
    right = compactTreePath([anchor.point, ...path.slice(i + 1)]);
  let split: readonly NetworkConnection[] = [
    { ...edge, to: junction },
    { ...edge, id, from: junction },
  ];
  if (edge.kind === 'pipe') {
    const { lengthM, localLossCoefficient } = edge.parameters;
    const pathLength = (points: readonly Point[]) =>
      segments(points).reduce((total, span) => total + distance(span.from, span.to), 0);
    const before = pathLength(left),
      after = pathLength(right);
    if (lengthM === undefined || localLossCoefficient === undefined || before <= 0 || after <= 0)
      return fail('物理管取压需要有效的管长、管损和内部接点。');
    const fraction = before / (before + after);
    const firstLength = lengthM * fraction,
      firstLoss = localLossCoefficient * fraction;
    if (firstLength <= 0 || lengthM - firstLength <= 0) return fail('拆分后两段物理管均须有正长度。');
    split = [
      {
        ...edge,
        to: junction,
        parameters: { ...edge.parameters, lengthM: firstLength, localLossCoefficient: firstLoss },
      },
      {
        ...edge,
        id,
        from: junction,
        parameters: {
          ...edge.parameters,
          lengthM: lengthM - firstLength,
          localLossCoefficient: localLossCoefficient - firstLoss,
        },
      },
    ];
  }
  edit.project = {
    ...edit.project,
    design: {
      ...edit.project.design,
      connections: edit.project.design.connections.flatMap((e) => (e.id === edge.id ? split : [e])),
    },
    layout: {
      ...edit.project.layout,
      routes: [
        ...edit.project.layout.routes.filter((r) => r.connectionId !== edge.id),
        routeRecord(edge.id, left),
        routeRecord(id, right),
      ],
    },
  };
  edit.paths.set(edge.id, left);
  edit.paths.set(id, right);
  return { ok: true, value: junction };
}

/** Pure atomic physical-edit candidate. Only newly inserted junctions may slide along their host paths. */
export function planNetworkBranchConnection(document: unknown, input: unknown): Result<NetworkBranchConnectionPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const r = new ContractReader(),
    o = r.object(input, '/branchConnection', ['from', 'to', 'idPrefix']);
  const from = readAnchor(r, o.from, '/branchConnection/from'),
    to = readAnchor(r, o.to, '/branchConnection/to'),
    prefix = r.id(o.idPrefix, '/branchConnection/idPrefix');
  const request = r.finish({ from, to, prefix });
  if (!request.ok) return request;
  const project = parsed.value,
    a = endpointFor(project, from),
    b = endpointFor(project, to);
  if (!a || !b) return fail('请选择当前工程的油口、节点或油管。');
  for (const [host, peer] of [
    [from, to],
    [to, from],
  ] as const) {
    if (
      host.kind !== 'route' ||
      !project.design.connections.some((e) => e.id === host.connectionId && e.kind === 'pipe')
    )
      continue;
    if (peer.kind === 'route' || !isExternalMotorPressureTap(project, peer))
      return fail('物理管内部接点仅用于连接变量马达的 X 取压口。');
    if (
      project.design.connections.some((e) =>
        [e.from, e.to].some((end) => branchEndpointKey(end) === branchEndpointKey(peer)),
      )
    )
      return fail('X 口已有取压管，请先断开原接线。');
  }
  const net = branchNet(project, a);
  if (
    branchEndpointKey(a) === branchEndpointKey(b) ||
    [...net].some((id) => {
      const e = project.design.connections.find((e) => e.id === id);
      return e && [e.from, e.to].some((end) => branchEndpointKey(end) === branchEndpointKey(b));
    })
  )
    return fail('两处已经理想连通，无需重复连接。');
  const paths = new Map<string, readonly Point[]>();
  for (const [id, path] of networkDrawingRoutes(project)) {
    if (path.ok) paths.set(id, path.value);
    else if ([from, to].some((end) => end.kind === 'route' && end.connectionId === id)) return path;
  }
  const drawingComplete = paths.size === project.design.connections.length;
  const choicesA = anchorChoices(project, paths, from),
    choicesB = anchorChoices(project, paths, to);
  if (!choicesA.length || !choicesB.length) return fail('接点已失效，请按当前路径重新选择。');
  type Candidate = { plan: NetworkBranchConnectionPlan; cost: number; paths: ReadonlyMap<string, readonly Point[]> };
  let best: Candidate | null = null;
  let basic: Candidate | null = null;
  let failure: Result<never> | null = null;
  for (const ca of choicesA)
    for (const cb of choicesB) {
      const edit: Edit = {
        project,
        paths: new Map(paths),
        serial: 0,
        prefix,
        nodeIds: [],
        sharedDrawing: 'normalized',
      };
      const ea = realize(edit, ca);
      if (!ea.ok) {
        failure = ea;
        continue;
      }
      const eb = realize(edit, cb);
      if (!eb.ok) {
        failure = eb;
        continue;
      }
      const optimized =
        drawingComplete && edit.sharedDrawing === 'normalized'
          ? routeBranch(edit.project, edit.paths, ea.value, eb.value, new Set(edit.nodeIds))
          : null;
      const id = allocate(edit, 'e');
      for (const routing of ['optimized', 'basic'] as const) {
        if (routing === 'basic' && (basic || best)) break;
        const branch =
          routing === 'optimized' ? optimized : basicBranchRoute(edit.project, edit.paths, ea.value, eb.value);
        if (!branch) continue;
        const candidateProject: NetworkProject = {
          ...edit.project,
          design: {
            ...edit.project.design,
            connections: [...edit.project.design.connections, { id, kind: 'ideal', from: ea.value, to: eb.value }],
          },
          layout: { ...edit.project.layout, routes: [...edit.project.layout.routes, routeRecord(id, branch.points)] },
        };
        const candidatePaths = new Map(edit.paths).set(id, branch.points);
        const checked = parseNetworkProject(
          drawingComplete ? saveTreeRoutes(candidateProject, candidatePaths) : candidateProject,
        );
        if (!checked.ok) {
          failure = checked;
          continue;
        }
        const candidate: Candidate = {
          cost: branch.cost,
          paths: candidatePaths,
          plan: { document: checked.value, connectionId: id, nodeIds: edit.nodeIds, routing, orientationChanges: [] },
        };
        if (routing === 'basic') basic = candidate;
        else if (!best || candidate.cost < best.cost) best = candidate;
        break;
      }
    }
  const selected = best ?? basic;
  if (!selected) return failure ?? fail('接线端点重叠或缺少有效几何；请先分开位置。原工程保持。');
  const { plan } = selected;
  const oriented = drawingComplete
    ? orientBranch(plan.document, selected.paths, plan.connectionId, new Set(plan.nodeIds), plan.routing)
    : null;
  if (oriented) {
    const checked = parseNetworkProject(
      saveTreeRoutes(
        {
          ...oriented.project,
          layout: {
            ...oriented.project.layout,
            routes: [
              ...oriented.project.layout.routes.filter((r) => !oriented.affectedConnectionIds.has(r.connectionId)),
              ...[...oriented.affectedConnectionIds].map((id) => routeRecord(id, required(oriented.paths.get(id)))),
            ],
          },
        },
        oriented.paths,
      ),
    );
    if (checked.ok)
      return {
        ok: true,
        value: immutable({
          ...plan,
          document: checked.value,
          routing: 'optimized',
          orientationChanges: [oriented.changedComponentId],
        }),
      };
  }
  return { ok: true, value: immutable(plan) };
}
