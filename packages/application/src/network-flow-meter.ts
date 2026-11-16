import {
  ContractReader,
  diagnostic,
  networkDrawingScale,
  networkPortAnchor,
  parseNetworkProject,
  type NetworkProject,
  type NetworkRotation,
  type NetworkRoute,
  type Result,
} from '@hyd/domain';
import { networkDrawingRoutes, type DrawingPoint } from './network-routing.js';
import { compactTreePath } from './network-tree-geometry.js';

interface MeterTarget {
  readonly connectionId: string;
  readonly path: readonly DrawingPoint[];
  readonly segment: number;
  readonly center: DrawingPoint;
  readonly rotation: NetworkRotation;
  readonly distance: number;
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('FLOW_METER_INSERT_INVALID', '/flowMeter', message)],
});
function route(connectionId: string, path: readonly DrawingPoint[]): NetworkRoute {
  const first = path[0],
    last = path.at(-1);
  if (!first || !last || path.length < 2) throw new Error('Meter split requires two route endpoints');
  return {
    connectionId,
    mode: 'manual',
    points: path.length > 2 ? path.slice(1, -1) : [{ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }],
  };
}

/** A single document candidate owns both placement and topology. Drawing proportions never determine pipe length. */
export function planNetworkFlowMeterInsertion(
  input: unknown,
  request: unknown,
): Result<{ readonly document: NetworkProject; readonly inserted: boolean }> {
  const parsed = parseNetworkProject(input);
  if (!parsed.ok) return parsed;
  const r = new ContractReader();
  const o = r.object(request, '/flowMeter', ['componentId', 'connectionId', 'tolerance']);
  const componentId = r.id(o.componentId, '/flowMeter/componentId');
  const newConnectionId = r.id(o.connectionId, '/flowMeter/connectionId');
  const tolerance = r.number(o.tolerance, '/flowMeter/tolerance', 1, 100);
  const valid = r.finish(true);
  if (!valid.ok) return valid;
  const project = parsed.value;
  const component = project.design.components.find((c) => c.id === componentId && c.typeId === 'flow-meter');
  const placement = project.layout.components.find((p) => p.componentId === componentId);
  if (!component || !placement) return fail('流量计或绘图位置已不存在。');
  const unchanged = { ok: true, value: { document: project, inserted: false } } as const;
  if (
    project.design.connections.some((e) =>
      [e.from, e.to].some((p) => p.kind === 'port' && p.componentId === componentId),
    )
  )
    return unchanged;
  // An unconnected meter must not make automatic routes move away before the drop is tested.
  const background: NetworkProject = {
    ...project,
    design: { ...project.design, components: project.design.components.filter((c) => c.id !== componentId) },
    layout: { ...project.layout, components: project.layout.components.filter((p) => p.componentId !== componentId) },
  };
  const halfWidth = 45 * networkDrawingScale(component, placement);
  const targets: MeterTarget[] = [];
  for (const [connectionId, result] of networkDrawingRoutes(background)) {
    if (!result.ok) continue;
    const path = compactTreePath(result.value);
    for (const [segment, from] of path.entries()) {
      const to = path[segment + 1];
      if (!to || (from.x !== to.x && from.y !== to.y)) continue;
      const horizontal = from.y === to.y;
      const start = horizontal ? from.x : from.y;
      const end = horizontal ? to.x : to.y;
      const margin = halfWidth + 12;
      if (Math.abs(end - start) < 2 * margin) continue;
      const along = Math.max(
        Math.min(start, end) + margin,
        Math.min(horizontal ? placement.x : placement.y, Math.max(start, end) - margin),
      );
      const center = horizontal ? { x: along, y: from.y } : { x: from.x, y: along };
      const distance = Math.hypot(center.x - placement.x, center.y - placement.y);
      if (distance > tolerance) continue;
      targets.push({
        connectionId,
        path,
        segment,
        center,
        distance,
        rotation: horizontal ? (end > start ? 0 : 180) : end > start ? 90 : 270,
      });
    }
  }
  targets.sort((a, b) => a.distance - b.distance);
  const target = targets[0];
  if (!target) return unchanged;
  if (
    targets.some(
      (t, i) => i > 0 && t.connectionId !== target.connectionId && Math.abs(t.distance - target.distance) < 1,
    )
  )
    return fail('这里有多条重叠或交叉管线，请放到一条独立直线段上。');
  if (project.design.connections.some((e) => e.id === newConnectionId)) return fail('新管线编号已使用，未插入流量计。');
  const edge = project.design.connections.find((e) => e.id === target.connectionId);
  if (!edge) return fail('目标管线已不存在。');
  const { mirrored: _previousMirror, ...plainPlacement } = placement;
  const position = { ...plainPlacement, ...target.center, rotation: target.rotation };
  const a = networkPortAnchor(component, position, 'A');
  const b = networkPortAnchor(component, position, 'B');
  if (!a || !b) return fail('流量计缺少双油口几何。');
  const firstPort = { kind: 'port', componentId, portId: 'A' } as const;
  const secondPort = { kind: 'port', componentId, portId: 'B' } as const;
  // Two equal physical lengths preserve total L and K; the meter adds only its declared resistance.
  if (
    edge.kind === 'pipe' &&
    (edge.parameters.lengthM === undefined || edge.parameters.localLossCoefficient === undefined)
  )
    return fail('物理管缺少实际长度或局部阻力参数，未拆分管线。');
  const physical =
    edge.kind === 'pipe' && edge.parameters.lengthM !== undefined && edge.parameters.localLossCoefficient !== undefined
      ? {
          parameters: {
            ...edge.parameters,
            lengthM: edge.parameters.lengthM / 2,
            localLossCoefficient: edge.parameters.localLossCoefficient / 2,
          },
        }
      : {};
  const candidate = parseNetworkProject({
    ...project,
    design: {
      ...project.design,
      connections: [
        ...project.design.connections.map((e) => (e.id === edge.id ? { ...e, ...physical, to: firstPort } : e)),
        { ...edge, ...physical, id: newConnectionId, from: secondPort },
      ],
    },
    layout: {
      ...project.layout,
      components: project.layout.components.map((p) => (p.componentId === componentId ? position : p)),
      routes: [
        ...project.layout.routes.filter((p) => p.connectionId !== edge.id),
        route(edge.id, [...target.path.slice(0, target.segment + 1), a]),
        route(newConnectionId, [b, ...target.path.slice(target.segment + 1)]),
      ],
    },
  });
  return candidate.ok ? { ok: true, value: { document: candidate.value, inserted: true } } : candidate;
}
