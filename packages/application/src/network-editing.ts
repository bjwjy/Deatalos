import {
  checkJson,
  ContractReader,
  diagnostic,
  immutable,
  parseNetworkProject,
  type NetworkEndpoint,
  type NetworkProject,
  type NetworkRotation,
  type Result,
  uniqueValveName,
  directionalValveBaseName,
  networkControllerSlot,
  networkProbeName,
} from '@hyd/domain';
import { followManualRouteEndpoints, networkEndpointPosition } from './network-routing.js';
import { planNetworkProbe } from './network-probes.js';

export type NetworkSelection = {
  readonly kind: 'component' | 'node' | 'connection' | 'probe' | 'text';
  readonly id: string;
};
export interface NetworkClipboard {
  readonly format: 'HydraulicWorkbenchSelection';
  readonly version: 1;
  readonly document: NetworkProject;
  readonly omittedConnections: number;
}
export interface NetworkPasteIds {
  readonly probes?: readonly string[];
  readonly texts?: readonly string[];
  readonly components: readonly string[];
  readonly nodes: readonly string[];
  readonly connections: readonly string[];
}
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/selection', message)],
});
const key = (s: NetworkSelection) => `${s.kind}:${s.id}`;

/** One layout candidate shared by drag preview and commit; the session still owns history and revisions. */
export function networkMoveSelection(
  project: NetworkProject,
  selection: readonly NetworkSelection[],
  delta: { readonly x: number; readonly y: number },
): NetworkProject {
  if (!delta.x && !delta.y) return project;
  const keys = new Set(selection.map(key));
  const movedEndpoint = (e: NetworkEndpoint) =>
    keys.has(e.kind === 'node' ? `node:${e.nodeId}` : `component:${e.componentId}`);
  const moved: NetworkProject = {
    ...project,
    layout: {
      ...project.layout,
      components: project.layout.components.map((p) =>
        keys.has(`component:${p.componentId}`) ? { ...p, x: p.x + delta.x, y: p.y + delta.y } : p,
      ),
      nodes: project.layout.nodes.map((p) =>
        keys.has(`node:${p.nodeId}`) ? { ...p, x: p.x + delta.x, y: p.y + delta.y } : p,
      ),
      ...(project.layout.probes
        ? {
            probes: project.layout.probes.map((p) =>
              keys.has(`probe:${p.probeId}`) ? { ...p, x: p.x + delta.x, y: p.y + delta.y } : p,
            ),
          }
        : {}),
      ...(project.layout.texts
        ? {
            texts: project.layout.texts.map((p) =>
              keys.has(`text:${p.id}`) ? { ...p, x: p.x + delta.x, y: p.y + delta.y } : p,
            ),
          }
        : {}),
    },
  };
  const edges = new Map(project.design.connections.map((edge) => [edge.id, edge]));
  return {
    ...moved,
    layout: {
      ...moved.layout,
      routes: project.layout.routes.map((route) => {
        if (route.mode !== 'manual') return route;
        const edge = edges.get(route.connectionId);
        if (!edge || (!movedEndpoint(edge.from) && !movedEndpoint(edge.to))) return route;
        const from = networkEndpointPosition(project, edge.from),
          to = networkEndpointPosition(project, edge.to),
          nextFrom = networkEndpointPosition(moved, edge.from),
          nextTo = networkEndpointPosition(moved, edge.to);
        return from && to && nextFrom && nextTo
          ? followManualRouteEndpoints(
              route,
              from,
              to,
              nextFrom,
              nextTo,
              movedEndpoint(edge.from) && movedEndpoint(edge.to) ? delta : null,
            )
          : route;
      }),
    },
  };
}

/** One physical candidate for the existing draft transaction, also used by cut. */
export function networkDeleteSelection(
  project: NetworkProject,
  selection: readonly NetworkSelection[],
): NetworkProject {
  const keys = new Set(selection.map(key));
  const removedEndpoint = (e: NetworkEndpoint) =>
    keys.has(e.kind === 'node' ? `node:${e.nodeId}` : `component:${e.componentId}`);
  const connections = project.design.connections.filter(
    (e) => !keys.has(`connection:${e.id}`) && !removedEndpoint(e.from) && !removedEndpoint(e.to),
  );
  return {
    ...project,
    design: {
      ...project.design,
      components: project.design.components.filter((c) => !keys.has(`component:${c.id}`)),
      nodes: project.design.nodes.filter((n) => !keys.has(`node:${n.id}`)),
      connections,
      initialConditions: project.design.initialConditions.filter((c) => !keys.has(`component:${c.componentId}`)),
    },
    ...(project.controlProbes
      ? {
          controlProbes: project.controlProbes.map(({ port, ...p }) => ({
            ...p,
            controllerId: keys.has(`component:${p.controllerId}`) ? null : p.controllerId,
            nodeId: p.nodeId && keys.has(`node:${p.nodeId}`) ? null : p.nodeId,
            ...(port && !keys.has(`component:${port.componentId}`) ? { port } : {}),
          })),
        }
      : {}),
    layout: {
      ...project.layout,
      ...(project.layout.texts ? { texts: project.layout.texts.filter((item) => !keys.has(`text:${item.id}`)) } : {}),
      ...(project.layout.probes
        ? {
            probes: project.layout.probes,
          }
        : {}),
      components: project.layout.components.filter((p) => !keys.has(`component:${p.componentId}`)),
      nodes: project.layout.nodes.filter((p) => !keys.has(`node:${p.nodeId}`)),
      routes: project.layout.routes.filter((r) => connections.some((e) => e.id === r.connectionId)),
    },
  };
}
/** Probe deletion retains its reference checks; physical objects keep their existing cascade. */
export function planNetworkDeleteSelection(
  project: NetworkProject,
  selection: readonly NetworkSelection[],
): Result<NetworkProject> {
  let candidate = networkDeleteSelection(
    project,
    selection.filter((item) => item.kind !== 'probe'),
  );
  for (const item of selection.filter((item) => item.kind === 'probe')) {
    if (!candidate.controlProbes?.some((probe) => probe.id === item.id)) continue;
    const planned = planNetworkProbe(candidate, { kind: 'delete', id: item.id });
    if (!planned.ok) return planned;
    candidate = planned.value;
  }
  return parseNetworkProject(candidate);
}
export function networkRotateSelection(
  project: NetworkProject,
  selection: readonly NetworkSelection[],
  direction: 'clockwise' | 'counterclockwise' = 'clockwise',
): Result<NetworkProject> {
  const ids = new Set(selection.filter((s) => s.kind === 'component').map((s) => s.id));
  if (!ids.size) return fail('SELECTION_EMPTY', '请先选择要旋转的元件。');
  if ([...ids].some((id) => !project.design.components.some((c) => c.id === id)))
    return fail('SELECTION_STALE', '所选元件已改变，请重新选择。');
  const nextRotation = (value: NetworkRotation = 0): NetworkRotation =>
    direction === 'clockwise'
      ? value === 0
        ? 90
        : value === 90
          ? 180
          : value === 180
            ? 270
            : 0
      : value === 0
        ? 270
        : value === 270
          ? 180
          : value === 180
            ? 90
            : 0;
  return parseNetworkProject({
    ...project,
    layout: {
      ...project.layout,
      components: project.layout.components.map((p) => {
        if (!ids.has(p.componentId)) return p;
        const { rotation: _previous, ...position } = p;
        const rotation = nextRotation(p.rotation);
        return rotation === 0 ? position : { ...position, rotation };
      }),
    },
  });
}

/** Reflect in screen-left/right coordinates. R(-angle)F = FR(angle); ports keep their IDs. */
export function networkFlipSelection(
  project: NetworkProject,
  selection: readonly NetworkSelection[],
): Result<NetworkProject> {
  const ids = new Set(selection.filter((s) => s.kind === 'component').map((s) => s.id));
  if (!ids.size) return fail('SELECTION_EMPTY', '请先选择要翻转的元件。');
  if ([...ids].some((id) => !project.design.components.some((c) => c.id === id)))
    return fail('SELECTION_STALE', '所选元件已改变，请重新选择。');
  return parseNetworkProject({
    ...project,
    layout: {
      ...project.layout,
      components: project.layout.components.map((p) => {
        if (!ids.has(p.componentId)) return p;
        const { mirrored: _mirror, rotation: _angle, ...position } = p;
        const rotation: NetworkRotation = p.rotation === 90 ? 270 : p.rotation === 270 ? 90 : (p.rotation ?? 0);
        return {
          ...position,
          ...(p.rotation === undefined && rotation === 0 ? {} : { rotation }),
          ...(p.mirrored ? {} : { mirrored: true as const }),
        };
      }),
    },
  });
}

export function parseNetworkClipboard(input: unknown): Result<NetworkClipboard> {
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const r = new ContractReader(),
    raw = r.object(input, '/clipboard', ['format', 'version', 'document', 'omittedConnections']);
  r.constant(raw.format, 'HydraulicWorkbenchSelection', '/clipboard/format');
  r.constant(raw.version, 1, '/clipboard/version');
  const omittedConnections = r.number(raw.omittedConnections, '/clipboard/omittedConnections', 0, 60);
  if (!Number.isInteger(omittedConnections))
    r.fail('CLIPBOARD_INVALID', '/clipboard/omittedConnections', '连接数量必须是整数。');
  if (r.diagnostics.length) return { ok: false, diagnostics: r.diagnostics };
  const document = parseNetworkProject(raw.document);
  if (!document.ok) return document;
  if (
    !document.value.design.components.length &&
    !document.value.design.nodes.length &&
    !document.value.controlProbes?.length &&
    !document.value.layout.texts?.length
  )
    return fail('CLIPBOARD_EMPTY', '剪贴板没有可放置的元件或节点。');
  return {
    ok: true,
    value: immutable({
      format: 'HydraulicWorkbenchSelection',
      version: 1,
      document: document.value,
      omittedConnections,
    }),
  };
}
export function parseNetworkClipboardText(text: unknown): Result<NetworkClipboard> {
  if (typeof text !== 'string' || text.length > 1048576)
    return fail('CLIPBOARD_LIMIT', '只支持不超过1048576字符的工程选集剪贴板。');
  try {
    return parseNetworkClipboard(JSON.parse(text));
  } catch {
    return fail('CLIPBOARD_INVALID', '剪贴板不是可识别的工程选集；当前工程未改变。');
  }
}
export function captureNetworkSelection(
  project: NetworkProject,
  selection: readonly NetworkSelection[],
): Result<NetworkClipboard> {
  const selected = new Set(selection.map(key));
  for (const s of selection) {
    const found =
      s.kind === 'component'
        ? project.design.components.some((c) => c.id === s.id)
        : s.kind === 'node'
          ? project.design.nodes.some((n) => n.id === s.id)
          : s.kind === 'text'
            ? project.layout.texts?.some((item) => item.id === s.id)
            : s.kind === 'probe'
              ? project.controlProbes?.some((p) => p.id === s.id)
              : project.design.connections.some((e) => e.id === s.id);
    if (!found) return fail('SELECTION_STALE', '选择已过期，请重新选择后复制。');
  }
  const components = project.design.components.filter((c) => selected.has(`component:${c.id}`)),
    nodes = project.design.nodes.filter((n) => selected.has(`node:${n.id}`));
  const texts = (project.layout.texts ?? []).filter((item) => selected.has(`text:${item.id}`));
  const probes = (project.controlProbes ?? [])
    .filter((p) => selected.has(`probe:${p.id}`))
    .map((p, i) => {
      const { port, ...rest } = p;
      return {
        ...rest,
        controllerId: null,
        number: i + 1,
        name: networkProbeName(project, p),
        nodeId: p.nodeId && selected.has(`node:${p.nodeId}`) ? p.nodeId : null,
        ...(port && selected.has(`component:${port.componentId}`) ? { port } : {}),
      };
    });
  if (!components.length && !nodes.length && !texts.length && !probes.length)
    return fail('SELECTION_EMPTY', '复制或剪切需要选择元件/节点；单独选中的线请使用删除操作。');
  if (
    project.controlProbes?.some((p) => components.some((c) => c.id === p.controllerId)) ||
    components.some((c) =>
      c.controller?.steps.some((step) =>
        (step.until.kind === 'all' || step.until.kind === 'any' ? step.until.conditions : [step.until]).some(
          (condition) => condition.kind === 'probe-pressure',
        ),
      ),
    )
  )
    return fail('CLIPBOARD_UNSUPPORTED', '引用压力表的控制器暂不支持复制/剪切；可单独复制压力表。');
  const included = (e: NetworkEndpoint) =>
    selected.has(e.kind === 'node' ? `node:${e.nodeId}` : `component:${e.componentId}`);
  const connections = project.design.connections.filter((e) => included(e.from) && included(e.to));
  const omittedConnections = project.design.connections.filter(
    (e) => (included(e.from) || included(e.to) || selected.has(`connection:${e.id}`)) && !connections.includes(e),
  ).length;
  return parseNetworkClipboard({
    format: 'HydraulicWorkbenchSelection',
    version: 1,
    omittedConnections,
    document: {
      ...project,
      controlProbes: probes,
      design: {
        ...project.design,
        components,
        nodes,
        connections,
        initialConditions: project.design.initialConditions.filter((i) =>
          components.some((c) => c.id === i.componentId),
        ),
      },
      layout: {
        probes: (project.layout.probes ?? [])
          .filter((p) => probes.some((g) => g.id === p.probeId))
          .map((p) => {
            const gauge = probes.find((g) => g.id === p.probeId);
            const { signalPoints, ...position } = p;
            return gauge?.nodeId || gauge?.port ? p : position;
          }),
        ...(project.layout.texts ? { texts } : {}),
        components: project.layout.components.filter((p) => components.some((c) => c.id === p.componentId)),
        nodes: project.layout.nodes.filter((p) => nodes.some((n) => n.id === p.nodeId)),
        routes: project.layout.routes.filter((r) => connections.some((e) => e.id === r.connectionId)),
      },
      extensions: {},
    },
  });
}
/** Fresh identities are supplied by the outer adapter. No clipboard/runtime/global state lives here. */
export function planNetworkPaste(
  target: NetworkProject,
  clipboard: NetworkClipboard,
  point: { readonly x: number; readonly y: number },
  ids: NetworkPasteIds,
): Result<{ readonly document: NetworkProject; readonly selection: readonly NetworkSelection[] }> {
  const source = clipboard.document;
  if (
    ids.components.length !== source.design.components.length ||
    (ids.probes?.length ?? 0) !== (source.controlProbes?.length ?? 0) ||
    (ids.texts?.length ?? 0) !== (source.layout.texts?.length ?? 0) ||
    ids.nodes.length !== source.design.nodes.length ||
    ids.connections.length !== source.design.connections.length
  )
    return fail('CLIPBOARD_IDS_INVALID', '粘贴身份数量与选集不一致。');
  const textIds = ids.texts ?? [];
  const probeIds = ids.probes ?? [];
  const allIds = [...ids.components, ...ids.nodes, ...ids.connections, ...textIds, ...probeIds];
  if (
    new Set(allIds).size !== allIds.length ||
    allIds.some((id) =>
      [
        ...target.design.components,
        ...target.design.nodes,
        ...target.design.connections,
        ...(target.layout.texts ?? []),
        ...(target.controlProbes ?? []),
      ].some((e) => e.id === id),
    )
  )
    return fail('CLIPBOARD_IDS_INVALID', '粘贴必须为所有对象分配新的唯一身份。');
  const components = new Map<string, string>(),
    nodes = new Map<string, string>(),
    edges = new Map<string, string>();
  source.design.components.forEach((c, i) => {
    const id = ids.components[i];
    if (id) components.set(c.id, id);
  });
  source.design.nodes.forEach((n, i) => {
    const id = ids.nodes[i];
    if (id) nodes.set(n.id, id);
  });
  source.design.connections.forEach((e, i) => {
    const id = ids.connections[i];
    if (id) edges.set(e.id, id);
  });
  if (
    components.size !== ids.components.length ||
    nodes.size !== ids.nodes.length ||
    edges.size !== ids.connections.length
  )
    return fail('CLIPBOARD_IDS_INVALID', '粘贴身份不能为空。');
  const positions = [
    ...source.layout.components,
    ...source.layout.nodes,
    ...(source.layout.texts ?? []),
    ...(source.layout.probes ?? []),
  ];
  const dx = point.x - (Math.min(...positions.map((p) => p.x)) + Math.max(...positions.map((p) => p.x))) / 2;
  const dy = point.y - (Math.min(...positions.map((p) => p.y)) + Math.max(...positions.map((p) => p.y))) / 2;
  const endpoint = (e: NetworkEndpoint) =>
    e.kind === 'node' ? { ...e, nodeId: nodes.get(e.nodeId) } : { ...e, componentId: components.get(e.componentId) };
  const occupied = target.design.components.map((item) => item.label);
  const occupiedColors = new Set(
    target.design.components
      .filter((c) => c.typeId === 'dynamic-controller')
      .map((c) => networkControllerSlot(target, c.id)),
  );
  const copies = source.design.components.map((item) => {
    let label = item.typeId === 'valve' ? uniqueValveName(directionalValveBaseName(item), occupied) : item.label;
    let controllerColor: number | undefined;
    if (item.typeId === 'dynamic-controller') {
      controllerColor = 1;
      while (occupiedColors.has(controllerColor)) controllerColor++;
      occupiedColors.add(controllerColor);
      if (occupied.includes(label)) {
        let n = 1;
        while (occupied.includes('控制器' + n)) n++;
        label = '控制器' + n;
      }
    }
    occupied.push(label);
    return {
      ...item,
      label,
      id: components.get(item.id),
      ...(controllerColor === undefined ? {} : { controllerColor }),
    };
  });
  const gaugeNumbers = new Set(
    (target.controlProbes ?? []).filter((p) => p.controllerId === null).map((p) => p.number),
  );
  const gaugeNames = new Set((target.controlProbes ?? []).map((p) => p.name));
  const gaugeCopies = (source.controlProbes ?? []).map((p, i) => {
    let number = 1;
    while (gaugeNumbers.has(number)) number++;
    gaugeNumbers.add(number);
    let name = p.name;
    for (let index = 2; gaugeNames.has(name); index++) {
      const suffix = `（${index}）`;
      name = p.name.slice(0, 60 - suffix.length) + suffix;
    }
    gaugeNames.add(name);
    const { port, ...rest } = p;
    return {
      ...rest,
      id: probeIds[i],
      controllerId: null,
      number,
      name,
      nodeId: p.nodeId ? (nodes.get(p.nodeId) ?? null) : null,
      ...(port ? { port: endpoint(port) } : {}),
    };
  });
  const gaugeIdMap = new Map((source.controlProbes ?? []).map((p, i) => [p.id, probeIds[i]]));
  const parsed = parseNetworkProject({
    ...target,
    controlProbes: [...(target.controlProbes ?? []), ...gaugeCopies],
    design: {
      ...target.design,
      components: [...target.design.components, ...copies],
      nodes: [...target.design.nodes, ...source.design.nodes.map((n) => ({ ...n, id: nodes.get(n.id) }))],
      connections: [
        ...target.design.connections,
        ...source.design.connections.map((e) => ({
          ...e,
          id: edges.get(e.id),
          from: endpoint(e.from),
          to: endpoint(e.to),
        })),
      ],
      initialConditions: [
        ...target.design.initialConditions,
        ...source.design.initialConditions.map((i) => ({ ...i, componentId: components.get(i.componentId) })),
      ],
    },
    layout: {
      ...target.layout,
      probes: [
        ...(target.layout.probes ?? []),
        ...(source.layout.probes ?? []).map((p) => ({
          ...p,
          probeId: gaugeIdMap.get(p.probeId),
          x: p.x + dx,
          y: p.y + dy,
          ...(p.signalPoints ? { signalPoints: p.signalPoints.map((s) => ({ x: s.x + dx, y: s.y + dy })) } : {}),
        })),
      ],
      ...(source.layout.texts?.length
        ? {
            texts: [
              ...(target.layout.texts ?? []),
              ...source.layout.texts.map((item, i) => ({ ...item, id: textIds[i], x: item.x + dx, y: item.y + dy })),
            ],
          }
        : {}),
      components: [
        ...target.layout.components,
        ...source.layout.components.map((p) => ({
          ...p,
          componentId: components.get(p.componentId),
          x: p.x + dx,
          y: p.y + dy,
        })),
      ],
      nodes: [
        ...target.layout.nodes,
        ...source.layout.nodes.map((p) => ({ ...p, nodeId: nodes.get(p.nodeId), x: p.x + dx, y: p.y + dy })),
      ],
      routes: [
        ...target.layout.routes,
        ...source.layout.routes.map((r) => ({
          ...r,
          connectionId: edges.get(r.connectionId),
          ...(r.mode === 'manual' ? { points: r.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}),
        })),
      ],
    },
  });
  if (!parsed.ok) return parsed;
  const selection: NetworkSelection[] = [
    ...probeIds.map((id) => ({ kind: 'probe' as const, id })),
    ...textIds.map((id) => ({ kind: 'text' as const, id })),
    ...ids.components.map((id) => ({ kind: 'component' as const, id })),
    ...ids.nodes.map((id) => ({ kind: 'node' as const, id })),
  ];
  return { ok: true, value: { document: parsed.value, selection } };
}

export type NetworkClipboardRequest =
  { readonly action: 'read' } | { readonly action: 'write'; readonly selection: NetworkClipboard };
export function parseNetworkClipboardRequest(input: unknown): Result<NetworkClipboardRequest> {
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const r = new ContractReader(),
    raw = r.object(input, '/clipboard', ['action', 'selection']);
  if (raw.action === 'read') {
    r.object(input, '/clipboard', ['action']);
    return r.diagnostics.length ? { ok: false, diagnostics: r.diagnostics } : { ok: true, value: { action: 'read' } };
  }
  if (raw.action !== 'write') return fail('CLIPBOARD_INVALID', '剪贴板操作只支持read/write。');
  if (r.diagnostics.length) return { ok: false, diagnostics: r.diagnostics };
  const selection = parseNetworkClipboard(raw.selection);
  return selection.ok ? { ok: true, value: { action: 'write', selection: selection.value } } : selection;
}
