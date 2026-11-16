import { ContractReader } from './reader.js';
import { networkDefinition } from './network-registry.js';
import type {
  NetworkEndpoint,
  NetworkPressureProbe,
  NetworkProject,
  NetworkSnapshot,
  NetworkReading,
} from './network-model.js';

export function readNetworkProbes(r: ContractReader, input: unknown): readonly NetworkPressureProbe[] {
  const probes = r.array(input, '/controlProbes', 60).map((raw, i) => {
    const f = '/controlProbes/' + i,
      o = r.object(raw, f, ['id', 'controllerId', 'number', 'name', 'nodeId', 'port']);
    const number = r.number(o.number, f + '/number', 1, 999999);
    if (!Number.isInteger(number)) r.fail('PROBE_INVALID', f, '压力表编号必须为正整数。');
    const port = o.port === undefined ? undefined : r.object(o.port, f + '/port', ['kind', 'componentId', 'portId']);
    if (port) {
      r.constant(port.kind, 'port', f + '/port/kind');
      if (o.nodeId !== null) r.fail('PROBE_INVALID', f + '/nodeId', '压力表只能关联一个测点。');
    }
    const result: NetworkPressureProbe = {
      id: r.id(o.id, f + '/id'),
      controllerId: o.controllerId === null ? null : r.id(o.controllerId, f + '/controllerId'),
      number,
      name: r.text(o.name, f + '/name', 0, 60),
      nodeId: o.nodeId === null ? null : r.id(o.nodeId, f + '/nodeId'),
      ...(port
        ? {
            port: {
              kind: 'port',
              componentId: r.id(port.componentId, f + '/port/componentId'),
              portId: r.id(port.portId, f + '/port/portId'),
            },
          }
        : {}),
    };
    return result;
  });
  r.unique(
    probes.map((p) => p.id),
    '/controlProbes',
  );
  r.unique(
    probes.map((p) => p.controllerId + ':' + p.number),
    '/controlProbes',
  );
  return probes;
}
export function networkProbeEndpoint(
  project: NetworkProject,
  probe: Pick<NetworkPressureProbe, 'nodeId' | 'port'>,
): NetworkEndpoint | null {
  const port = probe.port;
  if (port) {
    const component = project.design.components.find((c) => c.id === port.componentId);
    return component &&
      networkDefinition(component.definition.id, component.definition.version)?.ports.some(
        (p) => p.id === port.portId && p.domain === 'hydraulic',
      )
      ? port
      : null;
  }
  const nodeId = probe.nodeId;
  return nodeId !== null && project.design.nodes.some((n) => n.id === nodeId) ? { kind: 'node', nodeId } : null;
}
export function networkProbeName(_project: NetworkProject, probe: NetworkPressureProbe): string {
  return probe.name.replace(/^压力探针(\d+)$/, '压力表$1');
}
export function networkControllerColor(slot: number): string {
  const palette = ['#bd4947', '#377dae', '#27836e', '#9357b4', '#a26b21', '#b54685'];
  return palette[slot - 1] ?? `hsl(${(slot * 137.508) % 360} 55% 40%)`;
}
/** Legacy controllers get deterministic free slots; creating their first probe persists the slot. */
export function networkControllerSlot(project: NetworkProject, id: string): number {
  const controllers = project.design.components.filter((c) => c.typeId === 'dynamic-controller');
  const used = new Set(controllers.flatMap((c) => (c.controllerColor === undefined ? [] : [c.controllerColor])));
  for (const c of controllers) {
    let slot = c.controllerColor;
    if (slot === undefined) {
      slot = 1;
      while (used.has(slot)) slot++;
      used.add(slot);
    }
    if (c.id === id) return slot;
  }
  return 1;
}
export function networkProbePressure(
  project: NetworkProject,
  probeId: string,
  point: NetworkSnapshot | null,
): NetworkReading['value'] {
  const probe = project.controlProbes?.find((p) => p.id === probeId);
  const target = probe && networkProbeEndpoint(project, probe);
  if (!target) return { kind: 'unknown', reason: '压力表未连接有效油口或节点' };
  const reading = point?.readings.find(
    ({ quantity, unit, location }) =>
      quantity === 'pressure' &&
      unit === 'Pa' &&
      (target.kind === 'port'
        ? location.kind === 'port' && location.componentId === target.componentId && location.portId === target.portId
        : location.kind === 'node' && location.nodeId === target.nodeId),
  );
  return reading?.value.kind === 'known' && Number.isFinite(reading.value.value)
    ? reading.value
    : { kind: 'unknown', reason: '暂无当前有效测点压力' };
}
