import { diagnostic, type NetworkEndpoint, type NetworkProject, type Result } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import { pipeParameters, reportReturnPipe, returnPipeLoss } from './network-duty-return-pipes.js';

interface ReturnDevice {
  readonly id: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly law: Result<(flow: number, validate: boolean) => Result<number>>;
}

type Leg =
  | { readonly kind: 'device'; readonly from: string; readonly to: string; readonly device: ReturnDevice }
  | { readonly kind: 'series' | 'parallel'; readonly from: string; readonly to: string; readonly legs: readonly Leg[] };

interface DeviceReading {
  readonly id: string;
  readonly label: string;
  readonly flow: number;
  readonly dropPa: number;
}

export interface PilotReturnResult {
  readonly from: string;
  readonly totalDropPa: number;
  readonly yPressurePa: number;
  readonly yTankId: string;
  readonly yTankPressurePa: number;
  readonly devices: readonly DeviceReading[];
}

const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/pilotReturn', message)],
});
const good = <T>(value: T): Result<T> => ({ ok: true, value });
const key = (endpoint: NetworkEndpoint) =>
  endpoint.kind === 'node' ? 'node:' + endpoint.nodeId : endpoint.componentId + ':' + endpoint.portId;
const other = (leg: Leg, node: string) => (leg.from === node ? leg.to : leg.from);

/** Collapse ideal wires first, then keep physical resistances as individual edges. */
function returnDevices(project: NetworkProject, paths: DutyPhasePaths) {
  const roots = new Map<string, string>();
  const root = (node: string): string => {
    const existing = roots.get(node);
    if (existing !== undefined) return existing;
    roots.set(node, node);
    const queue = [node];
    for (const current of queue)
      for (const arc of paths.graph.get(current) ?? [])
        if (arc.ideal && !roots.has(arc.to)) {
          roots.set(arc.to, node);
          queue.push(arc.to);
        }
    return node;
  };
  const devices: ReturnDevice[] = [];
  for (const connection of project.design.connections) {
    if (connection.kind !== 'pipe') continue;
    const parameters = pipeParameters(project, connection, '回油管');
    devices.push({
      id: connection.id,
      label: '回油管',
      from: key(connection.from),
      to: key(connection.to),
      law: parameters.ok
        ? good((flow, validate) => {
            if (!validate) return good(returnPipeLoss(parameters.value, Math.abs(flow)).pressureDropPa);
            const result = reportReturnPipe(parameters.value, Math.abs(flow), 0);
            return result.ok ? good(result.value.pressureDropPa) : result;
          })
        : parameters,
    });
  }
  for (const component of project.design.components) {
    const { id, typeId, parameters } = component;
    const h = parameters.hydraulic;
    if (typeId !== 'return-filter' && typeId !== 'flow-meter' && typeId !== 'throttle') continue;
    const label = component.label || typeId;
    const name = label + ' [' + id + ']';
    const ratedFlow = h?.filterRatedFlowM3PerS;
    const ratedDrop = h?.filterRatedDropPa;
    const resistance = h?.meterResistancePaSPerM3;
    const opening = project.design.initialConditions.find((initial) => initial.componentId === id);
    if (typeId === 'throttle' && opening?.kind === 'throttle' && opening.openingAreaM2 === 0) continue;
    const conductance =
      opening?.kind === 'throttle' && h?.flowCoefficient !== undefined
        ? h.flowCoefficient * opening.openingAreaM2 * Math.sqrt(2 / project.design.fluid.densityKgPerM3)
        : 0;
    let law: ReturnDevice['law'];
    if (typeId === 'return-filter' && ratedFlow && ratedDrop !== undefined)
      law = good((flow, validate) => {
        if (validate && flow < 0) return fail(name + ' 位置或方向超出支持范围。过滤器限 A→B 回油。');
        if (validate && flow > ratedFlow * (1 + 1e-10)) return fail(name + ' 的回油需求超过保存额定流量。');
        return good(ratedDrop * (flow / ratedFlow) ** 2);
      });
    else if (typeId === 'flow-meter' && resistance !== undefined)
      law = good((flow) => good(resistance * Math.abs(flow)));
    else if (typeId === 'throttle' && conductance > 0) law = good((flow) => good((flow / conductance) ** 2));
    else law = fail(name + ' 缺少有效的回油压降参数。');
    devices.push({ id, label, from: id + ':A', to: id + ':B', law });
  }
  const edges = devices.map((device): Leg => ({
    kind: 'device',
    device,
    from: root(device.from),
    to: root(device.to),
  }));
  return { edges, root, devices };
}

function connected(edges: readonly Leg[], start: string): Set<string> {
  const seen = new Set([start]);
  for (const node of seen)
    for (const edge of edges) if (edge.from === node || edge.to === node) seen.add(other(edge, node));
  return seen;
}

/** Repeated two-terminal reductions preserve the original edges for pressure and flow reports. */
function reduceReturn(legs: Leg[], from: string, to: string): Leg | undefined {
  while (legs.length > 1) {
    const pair = legs.find((leg, i) =>
      legs
        .slice(i + 1)
        .some((next) => other(leg, next.from) === next.to && (leg.from === next.from || leg.to === next.from)),
    );
    if (pair) {
      const parallel = legs.filter(
        (leg) => (leg.from === pair.from || leg.from === pair.to) && other(pair, leg.from) === leg.to,
      );
      const children = parallel.flatMap((leg) => (leg.kind === 'parallel' ? leg.legs : [leg]));
      legs = legs.filter((leg) => !parallel.includes(leg));
      legs.push({ kind: 'parallel', from: pair.from, to: pair.to, legs: children });
      continue;
    }
    const adjacency = new Map<string, Leg[]>();
    for (const leg of legs)
      for (const node of [leg.from, leg.to]) {
        const list = adjacency.get(node) ?? [];
        list.push(leg);
        adjacency.set(node, list);
      }
    const join = [...adjacency].find(([node, incident]) => node !== from && node !== to && incident.length === 2);
    if (!join) return undefined;
    const [node, [first, second]] = join;
    if (!first || !second) return undefined;
    legs = legs.filter((leg) => leg !== first && leg !== second);
    legs.push({ kind: 'series', from: other(first, node), to: other(second, node), legs: [first, second] });
  }
  const result = legs[0];
  return result && (result.from === from || result.to === from) && other(result, from) === to ? result : undefined;
}

function bisect(high: number, target: number, evaluate: (value: number) => number): number {
  let low = 0;
  for (let i = 0; i < 44; i++) {
    const middle = (low + high) / 2;
    const value = evaluate(middle);
    if (!Number.isFinite(value)) return NaN;
    if (value < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function solvePilotReturn(
  project: NetworkProject,
  paths: DutyPhasePaths,
  input: {
    readonly outlet: string;
    readonly tankId: string;
    readonly tankPressurePa: number;
    readonly valveId: string;
    readonly flow: number;
  },
): Result<PilotReturnResult> {
  const tank = input.tankId + ':T';
  const y = input.valveId + ':Y';
  const route = paths.path(input.outlet, tank);
  if (!route) return fail('主回油箱通路断开。');
  const { edges, root, devices } = returnDevices(project, paths);
  const end = root(tank);
  const main = connected(edges, end);
  const entry = [input.outlet, ...route.map((arc) => arc.to)].find((node) => main.has(root(node)));
  if (!entry) return fail('回油入口无法确定。');
  for (const arc of route) {
    if (arc.from === entry) break;
    if (!arc.ideal && arc.component?.typeId !== 'valve' && arc.component?.id !== input.valveId)
      return fail('回油入口前含未建模的串联元件，不能确定 Y 口背压。');
  }
  const start = root(entry);
  const yNode = root(y);
  const tanks = project.design.components.filter((part) => part.typeId === 'tank' && part.id !== input.tankId);
  if (tanks.some((part) => main.has(root(part.id + ':T')) || paths.reachable(part.id + ':T', tank)))
    return fail('独立 Y 泄油箱与主回油路相通，不能按两处固定压力独立核算。');
  let yTankId = input.tankId;
  let yTankPressurePa = input.tankPressurePa;
  const yRegion = connected(edges, yNode);
  if (!main.has(yNode)) {
    const reference = tanks.find((part) => yRegion.has(root(part.id + ':T')));
    const pressure = reference?.parameters.hydraulic?.pressurePa;
    if (!reference || pressure === undefined)
      return fail('Y 口须接缸回油滤芯入口、可解的回油压力节点或独立油箱。其他取压点的先导参考压力待核。');
    if (paths.reachable(y, tank) || paths.reachable(y, input.outlet))
      return fail('Y 泄油支路与其他有流量的油路相通，零流量取压条件待核。');
    const allowed = new Set([y, reference.id + ':T', ...devices.flatMap((part) => [part.from, part.to])]);
    if (
      project.design.connections.some(
        (wire) =>
          wire.kind !== 'signal' &&
          [wire.from, wire.to].some(
            (port) => port.kind === 'port' && yRegion.has(root(key(port))) && !allowed.has(key(port)),
          ),
      )
    )
      return fail('独立 Y 泄油支路接入其他工作油口，零流量边界待核。');
    yTankId = reference.id;
    yTankPressurePa = pressure;
  } else if (tanks.length) return fail('第二油箱须仅用作独立 Y 泄油压力边界。');

  const active = edges.filter((edge) => main.has(edge.from));
  const isolated = main.has(yNode) ? [] : edges.filter((edge) => yRegion.has(edge.from));
  // Reject an unmodeled branch that leaves this network and re-enters at another pressure node.
  for (const [node, arcs] of paths.graph) {
    const origin = root(node);
    if (!main.has(origin)) continue;
    for (const arc of arcs) {
      if (
        arc.ideal ||
        devices.some(
          (part) => (part.from === arc.from && part.to === arc.to) || (part.to === arc.from && part.from === arc.to),
        )
      )
        continue;
      if (main.has(root(arc.to))) return fail('回油支路含未建模元件或跨接工作油口，不能确定分流。');
      const pending = new Set([arc.to]);
      for (const current of pending) {
        const terminal = root(current);
        if (terminal === origin) continue;
        if (main.has(terminal)) return fail('回油旁路含未建模元件，无法确定支路流量。');
        for (const next of paths.graph.get(current) ?? []) pending.add(next.to);
      }
    }
  }
  for (const part of project.design.components) {
    if (part.typeId === 'return-filter' && !main.has(root(part.id + ':A')))
      return fail('过滤器 [' + part.id + '] 须位于可核算的主回油通路。');
    if (part.typeId === 'flow-meter' && !main.has(root(part.id + ':A')) && !yRegion.has(root(part.id + ':A')))
      return fail('流量计 [' + part.id + '] 不在本次可核算的回油通路或取压支路上。');
  }

  const readings: DeviceReading[] = [];
  const pressure = new Map([[end, input.tankPressurePa]]);
  let remaining = 300000;
  const law = (leg: Leg, q: number): number => {
    if (--remaining < 0) return NaN;
    if (leg.kind === 'device') {
      const result = leg.device.law.ok && leg.device.law.value(q, false);
      return result && result.ok ? result.value : NaN;
    }
    if (leg.kind === 'series') return leg.legs.reduce((sum, part) => sum + law(part, q), 0);
    const high = Math.min(...leg.legs.map((part) => law(part, q)));
    return bisect(high, q, (dp) => leg.legs.reduce((sum, part) => sum + flowAt(part, q, dp), 0));
  };
  const flowAt = (leg: Leg, max: number, drop: number): number => {
    if (drop === 0) return 0;
    if (leg.kind === 'parallel') return leg.legs.reduce((sum, part) => sum + flowAt(part, max, drop), 0);
    return bisect(max, drop, (flow) => law(leg, flow));
  };
  const trace = (leg: Leg, upstream: string, q: number, down: number): Result<number> => {
    const downstream = other(leg, upstream);
    let up: number;
    if (leg.kind === 'device') {
      const { device } = leg;
      if (!device.law.ok) return device.law;
      const signed = leg.from === upstream ? q : -q;
      const result = device.law.value(signed, true);
      if (!result.ok) return result;
      readings.push({ id: device.id, label: device.label, flow: signed, dropPa: result.value });
      up = down + result.value;
    } else if (leg.kind === 'series') {
      const ordered = upstream === leg.from ? leg.legs : [...leg.legs].reverse();
      up = down;
      let node = downstream;
      for (const part of [...ordered].reverse()) {
        const result = trace(part, other(part, node), q, up);
        if (!result.ok) return result;
        up = result.value;
        node = other(part, node);
      }
    } else {
      const dp = law(leg, q);
      const flows = leg.legs.map((part) => flowAt(part, q, dp));
      if (
        !Number.isFinite(dp) ||
        flows.some((flow) => !Number.isFinite(flow)) ||
        Math.abs(flows.reduce((sum, flow) => sum + flow, 0) - q) > q * 1e-8
      )
        return fail('回油并联支路压差与流量守恒未收敛，当前工况待核。');
      for (const [i, part] of leg.legs.entries()) {
        const result = trace(part, upstream, flows[i] ?? NaN, down);
        if (!result.ok) return result;
        if (Math.abs(result.value - (down + dp)) > Math.max(1e-6, dp * 1e-8))
          return fail('回油并联支路两端压差不一致，当前工况待核。');
      }
      up = down + dp;
    }
    pressure.set(downstream, down);
    pressure.set(upstream, up);
    return good(up);
  };
  const offPath = active.filter((edge) => edge.from === edge.to);
  let live = active.filter((edge) => edge.from !== edge.to);
  if (start === end) {
    offPath.push(...live);
    live = [];
    for (const node of main) pressure.set(node, input.tankPressurePa);
  }
  const deadEnds: { leg: Leg; node: string }[] = [];
  while (live.length) {
    const counts = new Map<string, number>();
    for (const leg of live) for (const node of [leg.from, leg.to]) counts.set(node, (counts.get(node) ?? 0) + 1);
    const leaf = [...counts].find(([node, count]) => count === 1 && node !== start && node !== end);
    if (!leaf) break;
    const leg = live.find((edge) => edge.from === leaf[0] || edge.to === leaf[0]);
    if (!leg) return fail('回油支路接点无法确定。');
    deadEnds.push({ leg, node: leaf[0] });
    live = live.filter((edge) => edge !== leg);
  }
  for (const leg of [...active, ...isolated]) if (leg.kind === 'device' && !leg.device.law.ok) return leg.device.law;
  if (start !== end) {
    const topology = reduceReturn(live, start, end);
    if (!topology) return fail('回油需有可解的串并联通路，桥式交叉连通或悬空环路待核。');
    const result = trace(topology, start, input.flow, input.tankPressurePa);
    if (!result.ok) return result;
  }
  for (const { leg, node } of deadEnds.reverse()) {
    const down = pressure.get(other(leg, node));
    if (down === undefined) return fail('零流量回油支路缺少已知压力端。');
    const result = trace(leg, node, 0, down);
    if (!result.ok) return result;
  }
  for (const leg of [...offPath, ...isolated]) {
    const down = pressure.get(leg.to) ?? yTankPressurePa;
    const result = trace(leg, leg.from, 0, down);
    if (!result.ok) return result;
  }
  const reference = pressure.get(yNode) ?? (yTankId === input.tankId ? undefined : yTankPressurePa);
  const upstream = pressure.get(start);
  if (reference === undefined || upstream === undefined || !Number.isFinite(upstream) || !Number.isFinite(reference))
    return fail('Y 口或主回油压力超出可解范围。');
  return good({
    from: entry,
    totalDropPa: upstream - input.tankPressurePa,
    yPressurePa: reference,
    yTankId,
    yTankPressurePa,
    devices: readings,
  });
}
