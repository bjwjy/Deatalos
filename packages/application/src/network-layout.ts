import {
  checkJson,
  ContractReader,
  diagnostic,
  immutable,
  parseNetworkProject,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import type { NetworkDraftSession } from './network-draft.js';
import { networkDrawingRoutes, networkTreeGeometry } from './network-routing.js';
import { planNetworkComponentPositions, planNetworkJunctionPositions } from './network-layout-placement.js';
import { optimizeNetworkDrawing, type OptimizedNetworkDrawing } from './network-routing-optimization.js';
import {
  hasCurrentArrangement,
  readTreeRoutes,
  saveTreeRoutes,
  networkTreeRouteCacheKey,
} from './network-routing-cache.js';
import { canonical } from './content.js';
import { arrangeIndependentCircuits } from './network-independent-layout.js';
import type { Point } from './network-tree-geometry.js';

export type NetworkLayoutRequest =
  | { readonly kind: 'arrangement' }
  | {
      readonly kind: 'layout';
      readonly componentIds: readonly string[] | null;
      readonly lockedIds: readonly string[];
      readonly routing?: 'preserve' | 'avoid';
      readonly junctions?: 'preserve' | 'follow';
    }
  | { readonly kind: 'routing'; readonly connectionIds: readonly string[] | null };
export interface NetworkLayoutPlan {
  readonly request: NetworkLayoutRequest;
  readonly document: NetworkProject;
  readonly changedIds: readonly string[];
  readonly analysis?: Pick<OptimizedNetworkDrawing, 'metrics' | 'method' | 'trials'>;
}
export interface NetworkLayoutPreview {
  readonly documentSessionId: string;
  readonly revision: number;
  readonly sourceDocument: NetworkProject;
  readonly plan: NetworkLayoutPlan;
}
/** The outer adapter returns untrusted structured-clone data, parsed below. */
export interface NetworkLayoutPlanner {
  plan(document: NetworkProject, request: NetworkLayoutRequest): Promise<Result<unknown>>;
}
// Only previews minted here can reuse their verified plan at commit. Legacy or
// fabricated preview objects still take the original full planning path.
const preparedPlans = new WeakMap<NetworkLayoutPreview, NetworkLayoutPlan>();
function readRequest(input: unknown): Result<NetworkLayoutRequest> {
  const json = checkJson(input);
  if (!json.ok) return json;
  const r = new ContractReader(),
    o = r.object(input, '/layoutOperation', [
      'kind',
      'componentIds',
      'lockedIds',
      'connectionIds',
      'routing',
      'junctions',
    ]);
  const ids = (v: unknown, p: string) => {
    const a = r.array(v, p, 1000).map((v, i) => r.id(v, p + '/' + i));
    r.unique(a, p);
    return a;
  };
  if (o.kind === 'arrangement') {
    r.object(input, '/layoutOperation', ['kind']);
    return r.finish({ kind: 'arrangement' });
  }
  if (o.kind === 'layout') {
    r.object(input, '/layoutOperation', ['kind', 'componentIds', 'lockedIds', 'routing', 'junctions']);
    if (o.routing !== undefined && o.routing !== 'preserve' && o.routing !== 'avoid')
      return fail('自动连线整理方式不受支持。');
    if (o.junctions !== undefined && o.junctions !== 'preserve' && o.junctions !== 'follow')
      return fail('分支节点整理方式不受支持。');
    if (o.junctions === 'follow' && o.componentIds !== null)
      return fail('分支节点跟随仅用于全图整理；指定范围请保留节点位置。');
    return r.finish({
      kind: 'layout',
      componentIds: o.componentIds === null ? null : ids(o.componentIds, '/componentIds'),
      lockedIds: ids(o.lockedIds, '/lockedIds'),
      ...(o.routing === undefined ? {} : { routing: o.routing }),
      ...(o.junctions === undefined ? {} : { junctions: o.junctions }),
    });
  }
  r.object(input, '/layoutOperation', ['kind', 'connectionIds']);
  r.constant(o.kind, 'routing', '/layoutOperation/kind');
  return r.finish({
    kind: 'routing',
    connectionIds: o.connectionIds === null ? null : ids(o.connectionIds, '/connectionIds'),
  });
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('LAYOUT_UNSUPPORTED', '/layoutOperation', message)],
});
/** Entire layout/routing plan is previewed before a single layout-only transaction. */
export function planNetworkLayout(document: unknown, input: unknown): Result<NetworkLayoutPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const request = readRequest(input);
  if (!request.ok) return request;
  const project = parsed.value,
    req = request.value;
  if (req.kind === 'arrangement' && hasCurrentArrangement(project, networkTreeGeometry))
    return { ok: true, value: immutable({ request: req, document: project, changedIds: [] }) };
  if (req.kind === 'arrangement') {
    const grouped = arrangeIndependentCircuits(
      project,
      (part) => planNetworkLayout(part, req),
      (part) => planNetworkLayout(part, { kind: 'routing', connectionIds: null }),
    );
    if (grouped) return grouped.ok ? drawingPlan(project, req, grouped.value.project, grouped.value.paths) : grouped;
  }
  if (req.kind === 'routing') {
    const ids = req.connectionIds ?? project.design.connections.map((e) => e.id);
    if (ids.some((id) => !project.design.connections.some((e) => e.id === id))) return fail('范围含不存在的连接。');
    const routes = project.layout.routes.map((r) =>
      ids.includes(r.connectionId) && r.mode !== 'manual'
        ? { connectionId: r.connectionId, mode: 'avoid' as const }
        : r,
    );
    const candidate = { ...project, layout: { ...project.layout, routes } };
    if (
      req.connectionIds === null &&
      project.design.connections.every((e) => e.kind === 'ideal') &&
      routes.every((r) => r.mode === 'avoid')
    ) {
      const optimized = optimizeNetworkDrawing(candidate, networkTreeGeometry, 'routing');
      if (optimized.ok) return optimizedPlan(project, req, optimized.value);
    }
    const drawing = networkDrawingRoutes(candidate);
    for (const id of ids) {
      const r = routes.find((r) => r.connectionId === id);
      if (r?.mode === 'manual') continue;
      const path = drawing.get(id);
      if (!path) return fail('管线缺少绘图候选。');
      if (!path.ok) return path;
    }
    return {
      ok: true,
      value: immutable({
        request: req,
        document: candidate,
        changedIds: ids.filter((id) => project.layout.routes.find((r) => r.connectionId === id)?.mode === 'auto'),
      }),
    };
  }
  // Explicit whole-drawing arrangement rebuilds drawing paths, including manual ones, in one undo.
  // Routing-only and legacy selective layout keep their existing protection rules.
  const placementRequest: Extract<NetworkLayoutRequest, { kind: 'layout' }> =
    req.kind === 'arrangement'
      ? { kind: 'layout', componentIds: null, lockedIds: [], junctions: 'follow', routing: 'avoid' }
      : req;
  const ids = placementRequest.componentIds ?? project.design.components.map((c) => c.id);
  if ([...ids, ...placementRequest.lockedIds].some((id) => !project.design.components.some((c) => c.id === id)))
    return fail('范围或锁定列表含不存在的元件。');
  const moving = new Set(ids.filter((id) => !placementRequest.lockedIds.includes(id)));
  if (!moving.size) return fail('请选择至少一个未锁定元件。');
  const source =
    req.kind === 'arrangement'
      ? {
          ...project,
          layout: {
            ...project.layout,
            routes: project.layout.routes.map((r) => ({ connectionId: r.connectionId, mode: 'auto' as const })),
          },
        }
      : project;
  const placement = planNetworkComponentPositions(
    source,
    moving,
    placementRequest.junctions ?? 'preserve',
    req.kind === 'arrangement' ? 'compact' : 'legacy',
  );
  if (!placement.ok) return placement;
  const positions = placement.value;
  const candidate = parseNetworkProject({
    ...source,
    layout: {
      ...source.layout,
      components: project.layout.components.map((p) =>
        positions.has(p.componentId) ? { ...p, ...positions.get(p.componentId) } : p,
      ),
    },
  });
  if (!candidate.ok) return candidate;
  const working =
    placementRequest.junctions === 'follow'
      ? parseNetworkProject({
          ...candidate.value,
          layout: { ...candidate.value.layout, nodes: planNetworkJunctionPositions(candidate.value) },
        })
      : candidate;
  if (!working.ok) return working;
  if (req.kind === 'arrangement') {
    const ready = {
      ...working.value,
      layout: {
        ...working.value.layout,
        routes: working.value.layout.routes.map((r) => ({ connectionId: r.connectionId, mode: 'avoid' as const })),
      },
    };
    const optimized = optimizeNetworkDrawing(ready, networkTreeGeometry, 'arrangement');
    if (optimized.ok) return optimizedPlan(project, req, optimized.value);
  }
  const changedIds = [...moving].filter((id) => {
    const before = project.layout.components.find((p) => p.componentId === id),
      after = working.value.layout.components.find((p) => p.componentId === id);
    return before?.x !== after?.x || before?.y !== after?.y;
  });
  for (const before of project.layout.nodes) {
    const after = working.value.layout.nodes.find((n) => n.nodeId === before.nodeId);
    if (after && (after.x !== before.x || after.y !== before.y)) changedIds.push(before.nodeId);
  }
  if (placementRequest.routing === 'avoid') {
    const routed = planNetworkLayout(working.value, {
      kind: 'routing',
      connectionIds: project.design.connections
        .filter(
          (e) =>
            placementRequest.componentIds === null ||
            [e.from, e.to].some((end) => end.kind === 'port' && moving.has(end.componentId)),
        )
        .map((e) => e.id),
    });
    if (!routed.ok) return routed;
    return {
      ok: true,
      value: immutable({
        request: req,
        document: routed.value.document,
        changedIds: [
          ...new Set([
            ...changedIds,
            ...(req.kind === 'arrangement' ? [] : routed.value.changedIds),
            ...(req.kind === 'arrangement'
              ? project.layout.routes.filter((r) => r.mode !== 'avoid').map((r) => r.connectionId)
              : []),
          ]),
        ],
      }),
    };
  }
  return { ok: true, value: immutable({ request: req, document: working.value, changedIds }) };
}
function optimizedPlan(
  before: NetworkProject,
  request: NetworkLayoutRequest,
  result: OptimizedNetworkDrawing,
): Result<NetworkLayoutPlan> {
  return drawingPlan(before, request, result.drawing.project, result.drawing.paths, {
    metrics: result.metrics,
    method: result.method,
    trials: result.trials,
  });
}
function drawingPlan(
  before: NetworkProject,
  request: NetworkLayoutRequest,
  project: NetworkProject,
  paths: ReadonlyMap<string, readonly Point[]>,
  analysis?: NetworkLayoutPlan['analysis'],
): Result<NetworkLayoutPlan> {
  const parsed = parseNetworkProject(
    saveTreeRoutes(project, paths, request.kind === 'arrangement' ? 'arrangement' : undefined),
  );
  if (!parsed.ok) return parsed;
  const document = parsed.value,
    changedIds: string[] = [],
    oldPaths = readTreeRoutes(before, networkTreeGeometry);
  for (const p of document.layout.components) {
    const old = before.layout.components.find((c) => c.componentId === p.componentId);
    if (old?.x !== p.x || old?.y !== p.y || (old.rotation ?? 0) !== (p.rotation ?? 0) || old.mirrored !== p.mirrored)
      changedIds.push(p.componentId);
  }
  for (const p of document.layout.nodes) {
    const old = before.layout.nodes.find((n) => n.nodeId === p.nodeId);
    if (old?.x !== p.x || old?.y !== p.y) changedIds.push(p.nodeId);
  }
  for (const [id, path] of paths) if (JSON.stringify(oldPaths?.get(id)) !== JSON.stringify(path)) changedIds.push(id);
  return {
    ok: true,
    value: immutable({
      request,
      document,
      changedIds,
      ...(analysis ? { analysis } : {}),
    }),
  };
}
export function previewNetworkLayout(session: NetworkDraftSession, input: unknown): Result<NetworkLayoutPreview> {
  const plan = planNetworkLayout(session.document, input);
  return plan.ok ? preparedPreview(session, plan.value) : plan;
}
function preparedPreview(session: NetworkDraftSession, plan: NetworkLayoutPlan): Result<NetworkLayoutPreview> {
  const preview = immutable({
    documentSessionId: session.documentSessionId,
    revision: session.revision,
    sourceDocument: session.document,
    plan,
  });
  preparedPlans.set(preview, plan);
  return { ok: true, value: preview };
}
function readPreparedPlan(
  input: unknown,
  source: NetworkProject,
  expected: NetworkLayoutRequest,
): Result<NetworkLayoutPlan> {
  const json = checkJson(input);
  if (!json.ok) return json;
  const r = new ContractReader(),
    o = r.object(input, '/layoutPlan', ['request', 'document', 'changedIds', 'analysis']);
  const request = readRequest(o.request),
    document = parseNetworkProject(o.document);
  if (!request.ok) return request;
  if (!document.ok) return document;
  const changedIds = r
    .array(o.changedIds, '/layoutPlan/changedIds', 10000)
    .map((id, index) => r.id(id, '/layoutPlan/changedIds/' + index));
  // IDs are scoped by object kind. A component and a connection may share an
  // ID, so the existing planner's changed-object list can legitimately repeat it.
  const checked = r.finish({ request: request.value, document: document.value, changedIds });
  if (!checked.ok) return checked;
  const value = checked.value;
  const content = (project: NetworkProject) =>
    canonical({
      ...project,
      layout: null,
      extensions: Object.fromEntries(
        Object.entries(project.extensions).filter(([key]) => key !== networkTreeRouteCacheKey),
      ),
    });
  if (canonical(value.request) !== canonical(expected) || content(value.document) !== content(source))
    return fail('后台布局回复与请求不一致，或改变了设计/工程资料；未应用。');
  if (
    canonical(value.document.layout.viewport ?? null) !== canonical(source.layout.viewport ?? null) ||
    canonical(value.document.layout.texts ?? []) !== canonical(source.layout.texts ?? []) ||
    canonical(value.document.layout.probes ?? []) !== canonical(source.layout.probes ?? [])
  )
    return fail('后台布局回复改变了视图、文本或探针布局；未应用。');
  const ids = new Set([
    ...source.design.components.map((c) => c.id),
    ...source.design.nodes.map((n) => n.id),
    ...source.design.connections.map((e) => e.id),
  ]);
  if (changedIds.some((id) => !ids.has(id))) return fail('后台布局回复包含不存在的对象。');
  if (expected.kind === 'routing') {
    if (
      canonical(value.document.layout.components) !== canonical(source.layout.components) ||
      canonical(value.document.layout.nodes) !== canonical(source.layout.nodes)
    )
      return fail('自动理线不能移动元件或分支节点。');
    for (const route of source.layout.routes)
      if (
        (route.mode === 'manual' || (expected.connectionIds && !expected.connectionIds.includes(route.connectionId))) &&
        canonical(value.document.layout.routes.find((item) => item.connectionId === route.connectionId)) !==
          canonical(route)
      )
        return fail('自动理线回复改变了手动路径或范围外路径。');
  } else if (expected.kind === 'layout') {
    for (const position of source.layout.components)
      if (
        (expected.lockedIds.includes(position.componentId) ||
          (expected.componentIds && !expected.componentIds.includes(position.componentId))) &&
        canonical(value.document.layout.components.find((item) => item.componentId === position.componentId)) !==
          canonical(position)
      )
        return fail('布局回复移动了锁定或范围外元件。');
    if (expected.routing !== 'avoid' && canonical(value.document.layout.routes) !== canonical(source.layout.routes))
      return fail('保留路径的布局回复改变了路径。');
    if (expected.junctions !== 'follow' && canonical(value.document.layout.nodes) !== canonical(source.layout.nodes))
      return fail('保留分支节点的布局回复移动了节点。');
  }
  // Analysis is optional planner diagnostics; commit consumes only this parsed
  // layout payload. It never accepts physics or arbitrary worker-owned state.
  return { ok: true, value: immutable(value) };
}
export async function previewNetworkLayoutAsync(
  session: NetworkDraftSession,
  input: unknown,
  planner: NetworkLayoutPlanner,
): Promise<Result<NetworkLayoutPreview>> {
  const request = readRequest(input);
  if (!request.ok) return request;
  const source = session.document,
    revision = session.revision;
  const reply = await planner.plan(source, request.value);
  if (session.document !== source || session.revision !== revision)
    return {
      ok: false,
      diagnostics: [diagnostic('RESPONSE_STALE', '/layoutOperation', '计算期间工程已改变，未应用旧布局。')],
    };
  if (!reply.ok) return reply;
  const plan = readPreparedPlan(reply.value, source, request.value);
  return plan.ok ? preparedPreview(session, plan.value) : plan;
}
export function applyNetworkLayout(session: NetworkDraftSession, preview: NetworkLayoutPreview): Result<true> {
  if (
    preview.documentSessionId !== session.documentSessionId ||
    preview.revision !== session.revision ||
    preview.sourceDocument !== session.document
  )
    return {
      ok: false,
      diagnostics: [diagnostic('RESPONSE_STALE', '/layoutOperation', '工程或修订已改变，请重新预览。')],
    };
  const prepared = preparedPlans.get(preview);
  const plan: Result<NetworkLayoutPlan> = prepared
    ? { ok: true, value: prepared }
    : planNetworkLayout(session.document, preview.plan.request);
  preparedPlans.delete(preview);
  return plan.ok ? session.commit(plan.value.document, preview.revision, 'layout') : plan;
}
