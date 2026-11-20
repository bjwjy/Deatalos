import {
  ContractReader,
  checkJson,
  isNetworkActuatorType,
  type NetworkComponent,
  type NetworkEndpoint,
  type NetworkProject,
} from '@hyd/domain';
import {
  parseNetworkDutyReportRequest,
  reviewNetworkDuty,
  type NetworkDutyCoverage,
  type NetworkDutyRequest,
} from './network-duty.js';
import type { CalculationStep } from './network-learning.js';
import { pipeParameters } from './network-duty-return-pipes.js';
import {
  sharedPumpReturnConditions,
  sharedPumpReturnRoute,
  solveSharedPumpReturn,
  type SharedPumpReturnPhase,
} from './network-duty-shared-pump-return.js';

export interface DutySupplyGroup {
  readonly pump: NetworkComponent;
  readonly tank?: NetworkComponent;
  readonly cylinders: readonly NetworkComponent[];
  readonly componentIds: ReadonlySet<string>;
  readonly sharedReturnPipeId?: string;
  readonly result:
    | { readonly kind: 'ready'; readonly project: NetworkProject }
    | { readonly kind: 'blocked'; readonly reason: string };
}

export interface DutyGroupCoverage {
  readonly pumpId: string;
  readonly pumpLabel: string;
  readonly tankId?: string;
  readonly tankLabel?: string;
  readonly cylinders: readonly { readonly id: string; readonly label: string }[];
  readonly reason?: string;
  readonly coverage: NetworkDutyCoverage;
  readonly sharedReturn?: readonly SharedPumpReturnPhase[];
}

const key = (endpoint: NetworkEndpoint) =>
  endpoint.kind === 'node' ? 'node:' + endpoint.nodeId : 'part:' + endpoint.componentId;
const part = (id: string) => 'part:' + id;
const componentLabel = (c: NetworkComponent) => c.label || c.id;

/** Treat only an ideal net made of tank ports and junction nodes as a fixed pressure boundary. */
export function independentDutyGroups(project: NetworkProject): readonly DutySupplyGroup[] {
  const route = sharedPumpReturnRoute(project);
  if (route) {
    // Collapse fixed tank boundaries only in the ownership projection. The hydraulic calculation
    // uses the original route, tank pressures and physical pipes for each pump.
    const tankIds = new Set(project.design.components.filter((p) => p.typeId === 'tank').map((p) => p.id));
    const endpoint = (end: NetworkEndpoint): NetworkEndpoint =>
      end.kind === 'port' && tankIds.has(end.componentId) ? { ...end, componentId: route.tank.id } : end;
    const groups = partitionSupplyGroups({
      ...project,
      design: {
        ...project.design,
        components: project.design.components.filter((p) => p.typeId !== 'tank' || p.id === route.tank.id),
        connections: project.design.connections.map((edge) => {
          const from = endpoint(edge.from),
            to = endpoint(edge.to);
          return edge.kind === 'pipe' ? { id: edge.id, kind: 'ideal', from, to } : { ...edge, from, to };
        }),
      },
    });
    const first = route.pipes[0];
    if (first && groups.length === 2 && groups.every((g) => g.result.kind === 'ready' && g.cylinders.length === 1))
      return groups.map((group) => ({ ...group, sharedReturnPipeId: first.id }));
  }
  return partitionSupplyGroups(project);
}

function partitionSupplyGroups(project: NetworkProject): readonly DutySupplyGroup[] {
  const { components, connections } = project.design;
  const pumps = components.filter((c) => c.typeId === 'pump');
  const tanks = components.filter((c) => c.typeId === 'tank');
  const links = new Map<string, { key: string; edge: (typeof connections)[number] }[]>();
  const link = (from: string, to: string, edge: (typeof connections)[number]) => {
    const adjacent = links.get(from) ?? [];
    adjacent.push({ key: to, edge });
    links.set(from, adjacent);
  };
  for (const edge of connections) {
    const from = key(edge.from),
      to = key(edge.to);
    link(from, to, edge);
    link(to, from, edge);
  }
  const boundary = new Map<string, Set<string>>();
  for (const tank of tanks) {
    const seen = new Set([part(tank.id)]);
    for (const current of seen) {
      const attached = boundary.get(current) ?? new Set();
      attached.add(tank.id);
      boundary.set(current, attached);
      for (const next of links.get(current) ?? [])
        if (next.edge.kind === 'ideal' && next.key.startsWith('node:')) seen.add(next.key);
    }
  }
  // A physical or signal link between two boundary vertices cannot be discarded.
  const coupledBoundaries = new Set<string>();
  for (const edge of connections) {
    const from = key(edge.from),
      to = key(edge.to);
    if (!boundary.has(from) || !boundary.has(to)) continue;
    if (edge.kind !== 'ideal' || new Set([...(boundary.get(from) ?? []), ...(boundary.get(to) ?? [])]).size > 1) {
      coupledBoundaries.add(from);
      coupledBoundaries.add(to);
    }
  }
  return pumps.map((pump): DutySupplyGroup => {
    const members = new Set([part(pump.id)]);
    const boundaries = new Set<string>();
    for (const current of members)
      for (const next of links.get(current) ?? []) {
        if (boundary.has(next.key)) boundaries.add(next.key);
        else members.add(next.key);
      }
    const componentIds = new Set(components.filter((c) => members.has(part(c.id))).map((c) => c.id));
    const groupPumps = pumps.filter((c) => componentIds.has(c.id));
    const actuators = components.filter((c) => isNetworkActuatorType(c.typeId) && componentIds.has(c.id));
    const cylinders = actuators.filter((c) => c.typeId === 'cylinder');
    const tankIds = new Set([...boundaries].flatMap((id) => [...(boundary.get(id) ?? [])]));
    const tank = tankIds.size === 1 ? tanks.find((c) => tankIds.has(c.id)) : undefined;
    const identity = { pump, componentIds, cylinders, ...(tank ? { tank } : {}) };
    const blocked = (reason: string): DutySupplyGroup => ({ ...identity, result: { kind: 'blocked', reason } });
    if (pumps.length < 2) return blocked('独立供油分组需要至少两台泵。');
    if (groupPumps.length !== 1) return blocked('多台泵在油箱边界之外有连通路径，不能按独立供油拆分。');
    if (!tank || [...boundaries].some((node) => coupledBoundaries.has(node) || boundary.get(node)?.size !== 1))
      return blocked('该组须明确经理想边界连接唯一物理油箱，暂不核算跨油箱转油或回油耦合。');
    if (!cylinders.length || cylinders.length !== actuators.length)
      return blocked('该组须连接普通双作用缸，其他执行器组合待核。');
    const suction = connections.some(
      (edge) =>
        edge.kind === 'ideal' &&
        ((edge.from.kind === 'port' &&
          edge.from.componentId === pump.id &&
          edge.from.portId === 'S' &&
          boundaries.has(key(edge.to))) ||
          (edge.to.kind === 'port' &&
            edge.to.componentId === pump.id &&
            edge.to.portId === 'S' &&
            boundaries.has(key(edge.from)))),
    );
    if (!suction) return blocked('该泵 S 口须经理想油路从本组油箱吸油。');

    const tankNet = [...boundary].filter(([, ids]) => ids.has(tank.id)).map(([id]) => id);
    if (tankNet.some((id) => coupledBoundaries.has(id) || boundary.get(id)?.size !== 1))
      return blocked('本组油箱边界连接其他油箱，不能作为独立的固定压力边界。');
    const included = new Set([...members, ...tankNet]);
    const groupConnections = connections.filter((e) => included.has(key(e.from)) && included.has(key(e.to)));
    const connectionIds = new Set(groupConnections.map((e) => e.id));
    const groupProject: NetworkProject = {
      ...project,
      controlProbes: [],
      design: {
        ...project.design,
        components: components.filter((c) => included.has(part(c.id))),
        nodes: project.design.nodes.filter((n) => included.has('node:' + n.id)),
        connections: groupConnections,
        initialConditions: project.design.initialConditions.filter((item) => componentIds.has(item.componentId)),
      },
      layout: {
        ...project.layout,
        probes: [],
        components: project.layout.components.filter((item) => included.has(part(item.componentId))),
        nodes: project.layout.nodes.filter((item) => included.has('node:' + item.nodeId)),
        routes: project.layout.routes.filter((item) => connectionIds.has(item.connectionId)),
      },
    };
    return { ...identity, result: { kind: 'ready', project: groupProject } };
  });
}

export function sharedPumpReturnPipeEligible(project: NetworkProject, connectionId: string): boolean {
  const pipe = project.design.connections.find((edge) => edge.id === connectionId);
  return (
    pipe?.kind === 'pipe' &&
    independentDutyGroups(project).some((group) => !!group.sharedReturnPipeId) &&
    !!sharedPumpReturnRoute(project)?.pipes.some((p) => p.id === connectionId) &&
    pipeParameters(project, pipe, '共用回油干线').ok
  );
}

export function independentFlowSplitRequest(duty: NetworkDutyRequest): NetworkDutyRequest {
  return {
    ...duty,
    phases: duty.phases.map((phase) => (phase.actions.length > 1 ? { ...phase, flowSplit: true } : phase)),
  };
}

export function reviewIndependentDuty(project: NetworkProject, input: unknown) {
  const bounded = checkJson(input);
  if (!bounded.ok) return bounded;
  const groups = independentDutyGroups(project);
  const r = new ContractReader();
  const requests = r.array(input, '/supplyGroups', groups.length).map((item, i) => {
    const p = '/supplyGroups/' + i;
    const o = r.object(item, p, ['pumpId', 'duty', 'pendingPhases']);
    const pumpId = r.id(o.pumpId, p + '/pumpId');
    if (!groups.some((group) => group.pump.id === pumpId))
      r.fail('DUTY_INVALID', p + '/pumpId', '供油组必须引用工程中的泵。');
    return { pumpId, input: parseNetworkDutyReportRequest(o.duty, o.pendingPhases) };
  });
  r.unique(
    requests.map((item) => item.pumpId),
    '/supplyGroups',
  );
  const validated = r.finish(true);
  if (!validated.ok) return validated;
  const coverage: DutyGroupCoverage[] = [];
  const steps: CalculationStep[] = [];
  const route = groups[0]?.sharedReturnPipeId ? sharedPumpReturnRoute(project) : undefined;
  if (route) {
    const names = new Set<string>();
    const inputs = groups.flatMap((group) => {
      if (group.result.kind !== 'ready' || !group.tank) return [];
      const input = requests.find((item) => item.pumpId === group.pump.id)?.input;
      const duty = input?.ok && input.value.duty?.pumpId === group.pump.id ? input.value.duty : null;
      for (const phase of duty?.phases ?? []) names.add(phase.name);
      if (input?.ok)
        for (const phase of input.value.pendingPhases) if (phase.kind !== 'excluded') names.add(phase.name);
      const issue = input && !input.ok ? input.diagnostics.map((d) => d.message).join('；') : undefined;
      return [
        {
          project: group.result.project,
          pump: group.pump,
          tank: group.tank,
          duty,
          pendingPhases: input?.ok ? input.value.pendingPhases : [],
          ...(issue ? { issue } : {}),
        },
      ];
    });
    const shared = solveSharedPumpReturn(project, route, inputs, names.size ? [...names] : ['共用回油']);
    for (const [index, input] of inputs.entries()) {
      const phases = shared[index] ?? [];
      const group = groups[index];
      if (!group) continue;
      coverage.push({
        pumpId: input.pump.id,
        pumpLabel: componentLabel(input.pump),
        tankId: input.tank.id,
        tankLabel: componentLabel(input.tank),
        cylinders: group.cylinders.map((cylinder) => ({ id: cylinder.id, label: componentLabel(cylinder) })),
        coverage: {
          phases: [],
          componentLimits: [],
          complete: phases.length > 0 && phases.every((phase) => phase.kind === 'solved'),
        },
        sharedReturn: phases,
      });
    }
    return { ok: true as const, value: { coverage, steps, conditions: [...sharedPumpReturnConditions] } };
  }
  const conditions = new Set([
    '按实际接线划分独立供油组。每组由一台泵驱动一只或多只普通双作用缸。同组多缸同时动作时，按保存的阀口与本组供流核算实际分配。',
    '共箱只在同一个物理油箱的理想压力节点处共用边界。各泵吸油和各组回油按该油箱压力与本组输入计算。合流、共用回油管压降耦合及油箱液位变化未计。',
    '各组按本组泵出口压力、流量和轴功率分别列出目标需求，并检查供流、限压和实际溢流条件。部分工况或组缺项时保留其他已核算结果。',
  ]);
  for (const group of groups) {
    const pump = group.pump;
    const label = componentLabel(pump);
    const identity = {
      pumpId: pump.id,
      pumpLabel: label,
      ...(group.tank ? { tankId: group.tank.id, tankLabel: componentLabel(group.tank) } : {}),
      cylinders: group.cylinders.map((cylinder) => ({ id: cylinder.id, label: componentLabel(cylinder) })),
    };
    const request = requests.find((item) => item.pumpId === pump.id)?.input;
    if (
      group.result.kind === 'blocked' ||
      !request?.ok ||
      (request.value.duty && request.value.duty.pumpId !== pump.id)
    ) {
      const reason =
        group.result.kind === 'blocked'
          ? group.result.reason
          : request && !request.ok
            ? request.diagnostics.map((item) => item.message).join('；')
            : '本组没有有效的工况输入或目标泵不匹配。';
      coverage.push({ ...identity, reason, coverage: { phases: [], componentLimits: [], complete: false } });
      continue;
    }
    const { duty, pendingPhases } = request.value;
    const reviewed = reviewNetworkDuty(group.result.project, {
      duty: duty && independentFlowSplitRequest(duty),
      pendingPhases,
    });
    coverage.push({ ...identity, coverage: reviewed.coverage });
    for (const condition of reviewed.conditions ?? []) conditions.add(condition);
    steps.push(
      ...reviewed.steps.map((step) => ({
        ...step,
        key: pump.id + '/' + step.key,
        label: label + ' [' + pump.id + '] / ' + step.label,
      })),
    );
  }
  return { ok: true as const, value: { coverage, steps, conditions: [...conditions] } };
}
