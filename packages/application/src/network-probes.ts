import {
  parseNetworkProject,
  diagnostic,
  networkControllerSlot,
  networkComponentPresentationBounds,
  networkProbeEndpoint,
  type NetworkPressureProbe,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
export type NetworkProbeEdit =
  | { readonly kind: 'add-gauge'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: 'add'; readonly controllerId: string; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: 'add-near'; readonly controllerId: string; readonly id: string }
  | { readonly kind: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly kind: 'route';
      readonly id: string;
      readonly points: readonly { readonly x: number; readonly y: number }[];
    }
  | ({ readonly kind: 'configure'; readonly id: string; readonly name: string } & Pick<
      NetworkPressureProbe,
      'nodeId' | 'port'
    >)
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'rename-controller'; readonly id: string; readonly name: string };
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('PROBE_INVALID', '/controlProbes', message)],
});
export function nextNetworkController(project: NetworkProject): { readonly name: string; readonly color: number } {
  const controllers = project.design.components.filter((c) => c.typeId === 'dynamic-controller');
  let n = 1;
  while (controllers.some((c) => c.label === '控制器' + n)) n++;
  let color = 1;
  while (controllers.some((c) => networkControllerSlot(project, c.id) === color)) color++;
  return { name: '控制器' + n, color };
}
/** Probe metadata and drawing changes are one nonphysical session transaction. */
export function planNetworkProbe(input: unknown, edit: NetworkProbeEdit): Result<NetworkProject> {
  const parsed = parseNetworkProject(input);
  if (!parsed.ok) return parsed;
  const project = parsed.value,
    probes = project.controlProbes ?? [],
    positions = project.layout.probes ?? [];
  if (edit.kind === 'add-gauge') {
    const number = Math.max(0, ...probes.filter((p) => p.controllerId === null).map((p) => p.number)) + 1;
    let nameNumber = number;
    while (probes.some((p) => p.name === '压力表' + nameNumber || p.name === '压力探针' + nameNumber)) nameNumber++;
    return parseNetworkProject({
      ...project,
      controlProbes: [
        ...probes,
        { id: edit.id, controllerId: null, number, name: '压力表' + nameNumber, nodeId: null },
      ],
      layout: { ...project.layout, probes: [...positions, { probeId: edit.id, x: edit.x, y: edit.y }] },
    });
  }
  if (edit.kind === 'rename-controller') {
    if (!project.design.components.some((c) => c.id === edit.id && c.typeId === 'dynamic-controller'))
      return fail('控制器已不存在。');
    if (
      !edit.name.trim() ||
      project.design.components.some(
        (c) => c.id !== edit.id && c.typeId === 'dynamic-controller' && c.label === edit.name,
      )
    )
      return fail('控制器名字不能为空或与其他控制器重名。');
    return parseNetworkProject({
      ...project,
      design: {
        ...project.design,
        components: project.design.components.map((c) => (c.id === edit.id ? { ...c, label: edit.name } : c)),
      },
    });
  }
  if (edit.kind === 'add' || edit.kind === 'add-near') {
    const owner = project.design.components.find(
      (c) => c.id === edit.controllerId && c.typeId === 'dynamic-controller',
    );
    if (!owner) return fail('控制器已不存在。');
    let position: { readonly x: number; readonly y: number } | null =
      edit.kind === 'add' ? { x: edit.x, y: edit.y } : null;
    if (edit.kind === 'add-near') {
      const origin = project.layout.components.find((p) => p.componentId === owner.id);
      if (!origin) return fail('控制器缺少绘图位置。');
      const obstacles = project.layout.components.flatMap((p) => {
        const c = project.design.components.find((c) => c.id === p.componentId),
          b = c && networkComponentPresentationBounds(c, p);
        return b ? [b] : [];
      });
      for (let i = 0; i < 120; i++) {
        const side = i % 2 === 0 ? 1 : -1,
          column = Math.floor(i / 2) % 3,
          row = Math.floor(i / 6),
          x = origin.x + side * (230 + column * 300),
          y = origin.y + row * 145;
        if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue;
        if (
          positions.some((p) => Math.abs(p.x - x) < 260 && Math.abs(p.y - y) < 125) ||
          obstacles.some((b) => x + 130 > b.left && x - 130 < b.right && y + 75 > b.top && y - 55 < b.bottom)
        )
          continue;
        position = { x, y };
        break;
      }
      if (!position) return fail('控制器附近没有空位，请长按按钮拖到画布空白位置。');
    }
    if (!position) return fail('压力表缺少绘图位置。');
    const number = Math.max(0, ...probes.filter((p) => p.controllerId === owner.id).map((p) => p.number)) + 1;
    const color = networkControllerSlot(project, owner.id);
    return parseNetworkProject({
      ...project,
      controlProbes: [
        ...probes,
        { id: edit.id, controllerId: owner.id, number, name: '压力探针' + number, nodeId: null },
      ],
      design: {
        ...project.design,
        components: project.design.components.map((c) => (c.id === owner.id ? { ...c, controllerColor: color } : c)),
      },
      layout: { ...project.layout, probes: [...positions, { probeId: edit.id, ...position }] },
    });
  }
  const probe = probes.find((p) => p.id === edit.id);
  if (!probe) return fail('压力表已不存在。');
  if (edit.kind === 'delete') {
    const used = project.design.components.some((c) =>
      c.controller?.steps.some((s) =>
        (s.until.kind === 'all' || s.until.kind === 'any' ? s.until.conditions : [s.until]).some(
          (v) => v.kind === 'probe-pressure' && v.probeId === probe.id,
        ),
      ),
    );
    if (used) return fail('动作条件正在使用这个压力表，请先修改或删除相应条件，再删除压力表。');
    return parseNetworkProject({
      ...project,
      controlProbes: probes.filter((p) => p.id !== probe.id),
      layout: { ...project.layout, probes: positions.filter((p) => p.probeId !== probe.id) },
    });
  }
  if (edit.kind === 'move')
    return parseNetworkProject({
      ...project,
      layout: {
        ...project.layout,
        probes: positions.map((p) => (p.probeId === probe.id ? { ...p, x: edit.x, y: edit.y } : p)),
      },
    });
  if (edit.kind === 'route') {
    if (!networkProbeEndpoint(project, probe)) return fail('压力表未连接有效测点。');
    return parseNetworkProject({
      ...project,
      layout: {
        ...project.layout,
        probes: positions.map((p) => (p.probeId === probe.id ? { ...p, signalPoints: edit.points } : p)),
      },
    });
  }
  if ((edit.nodeId !== null || edit.port) && !networkProbeEndpoint(project, edit))
    return fail('连接目标已不存在，或不是液压油口。');
  const updated: NetworkPressureProbe = {
    id: probe.id,
    controllerId: probe.controllerId,
    number: probe.number,
    name: edit.name,
    nodeId: edit.nodeId,
    ...(edit.port ? { port: edit.port } : {}),
  };
  return parseNetworkProject({
    ...project,
    controlProbes: probes.map((p) => (p.id === probe.id ? updated : p)),
    layout: {
      ...project.layout,
      probes: positions.map((p) =>
        p.probeId === probe.id &&
        (probe.nodeId !== updated.nodeId ||
          probe.port?.componentId !== updated.port?.componentId ||
          probe.port?.portId !== updated.port?.portId)
          ? { probeId: p.probeId, x: p.x, y: p.y }
          : p,
      ),
    },
  });
}
