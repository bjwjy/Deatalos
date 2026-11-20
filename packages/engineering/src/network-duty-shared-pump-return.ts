import { type NetworkComponent, type NetworkProject } from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import {
  cylinderBranchLaws,
  orificeFlow,
  orificeResistance,
  parallelFlowTargets,
  type BranchLaw,
  type ParallelFlowTarget,
} from './network-duty-flow-split.js';
import {
  physicalSeries,
  seriesParameters,
  seriesReport,
  seriesDrop,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';
import type { DutyPendingPhase, NetworkDutyRequest } from './network-duty.js';

const limitPa = 70e6;
type SharedRoute = NonNullable<ReturnType<typeof sharedPumpReturnRoute>>;
const label = (part: NetworkComponent) => part.label || part.id;
const staticPhase = { name: '共用回油', valves: [], actions: [] };
const supported = new Set(['pump', 'tank', 'cylinder', 'valve', 'volume', 'relief', 'throttle']);

export const sharedPumpReturnConditions = [
  '两台定量泵各驱动一只行程内普通双作用缸，各配独立四通换向阀。两阀 T 口在串联有损回油干线上游汇合，各泵理想吸油、供油相互隔离，各泵按吸油箱压力计算泄漏和功率，各直动溢流取自身回箱压力。',
  '同名工况须同时提供两组动作。两缸按各自实际排油量之和求干线沿程和局部压降，将汇合点压力反馈至两组。使用保存阀口，缸容积效率取 1，手填供油损失为零，回油基准填油箱压力。',
  '各泵零压供流由排量、转速与容积效率估计，另计保存的压力泄漏和有限孔口直动溢流。速度允差 ±1%。预算用于校核。缺共同边界时保留独立成立的输入和目标。吸油损失、空化、回油附件、油箱液位随时间变化和瞬态待核。',
] as const;

/** The original project keeps its physical pipe. The idealized copy is used only to identify group ownership. */
export function sharedPumpReturnRoute(project: NetworkProject) {
  const { components, connections } = project.design;
  const pumps = components.filter((part) => part.typeId === 'pump');
  const tanks = components.filter((part) => part.typeId === 'tank');
  const valves = components.filter((part) => part.typeId === 'valve');
  const pipes = connections.filter((edge) => edge.kind === 'pipe');

  if (
    pumps.length !== 2 ||
    pumps.some((pump) => pump.definition.id !== 'teaching:pump') ||
    !tanks.length ||
    tanks.length > 2 ||
    valves.length !== 2 ||
    !pipes.length ||
    components.filter((part) => part.typeId === 'cylinder').length !== 2 ||
    components.some((part) => !supported.has(part.typeId)) ||
    connections.some((edge) => edge.kind === 'signal')
  )
    return undefined;
  const graph = dutyPhasePaths(project, staticPhase, false);
  if (!graph.ok) return undefined;
  const paths = graph.value;
  if (tanks.some((a, i) => tanks.slice(i + 1).some((b) => paths.idealReachable(a.id + ':T', b.id + ':T'))))
    return undefined;
  const tankAt = (port: string) => tanks.find((tank) => paths.idealReachable(port, tank.id + ':T'));
  const first = valves[0];
  if (!first || !pumps.every((p) => tankAt(p.id + ':S'))) return undefined;
  const sink = tanks.find((t) => physicalSeries(paths, first.id + ':T', t.id + ':T')?.length === pipes.length);
  if (!sink || tanks.some((t) => t !== sink && physicalSeries(paths, first.id + ':T', t.id + ':T') !== undefined))
    return undefined;
  const series = physicalSeries(paths, first.id + ':T', sink.id + ':T');
  if (!series?.length || !valves.every((v) => paths.idealReachable(v.id + ':T', first.id + ':T'))) return undefined;
  if (components.some((p) => p.typeId === 'relief' && !tankAt(p.id + ':T'))) return undefined;
  return { pipes: series, tank: sink, tankAt };
}

type SharedIdentity = {
  readonly name: string;
  readonly target?: ParallelFlowTarget;
  readonly estimatedSupplyM3PerS?: number;
};
export type SharedPumpReturnPhase = SharedIdentity &
  (
    | { readonly kind: 'pending'; readonly reason: string }
    | {
        readonly kind: 'solved';
        readonly pipe: ReturnPipeResult;
        readonly segments: readonly ReturnPipeResult[];
        readonly suctionTank: string;
        readonly suctionPa: number;
        readonly pumpPa: number;
        readonly shaftPowerW: number;
        readonly cylinderFlowM3PerS: number;
        readonly speedMPerS: number;
        readonly returnFlowM3PerS: number;
        readonly chamberPa: number;
        readonly reliefFlowM3PerS: number;
        readonly leakageM3PerS: number;
        readonly reason: string;
      }
  );

interface GroupInput {
  readonly project: NetworkProject;
  readonly pump: NetworkComponent;
  readonly tank: NetworkComponent;
  readonly duty: NetworkDutyRequest | null;
  readonly pendingPhases: readonly DutyPendingPhase[];
  readonly issue?: string;
}

interface PointLaw {
  readonly branch: BranchLaw;
  readonly suctionPa: number;
  readonly suctionTank: string;
  readonly supply: number;
  readonly leakage: number;
  readonly reliefs: readonly { readonly startPa: number; readonly resistance: number }[];
  readonly duty: NetworkDutyRequest;
}

type Prepared =
  | { readonly identity: SharedIdentity; readonly kind: 'pending'; readonly reason: string }
  | { readonly identity: SharedIdentity; readonly kind: 'ready'; readonly law: PointLaw };

function prepareGroup(input: GroupInput, name: string, tankPa: number, route: SharedRoute): Prepared {
  const { duty, project, pump, tank } = input;
  const phase = duty?.phases.find((item) => item.name === name);
  const target = phase && parallelFlowTargets(project, phase.actions)[0];
  const displacement = pump.parameters.hydraulic?.displacementM3PerRev;
  const supply =
    duty && displacement !== undefined
      ? ((displacement * duty.angularSpeedRadPerS) / (2 * Math.PI)) * duty.pumpVolumetricEfficiency
      : undefined;
  const identity = {
    name,
    ...(target ? { target } : {}),
    ...(supply !== undefined && supply > 0 && Number.isFinite(supply) ? { estimatedSupplyM3PerS: supply } : {}),
  };
  const pending = (reason: string): Prepared => ({ identity, kind: 'pending', reason });
  if (!phase || !duty)
    return pending(
      input.issue ?? input.pendingPhases.find((item) => item.name === name)?.reason ?? '缺少本组同名动作或有效泵输入。',
    );
  const { estimatedSupplyM3PerS } = identity;
  const suction = route.tankAt(pump.id + ':S');
  const suctionPa = suction?.parameters.hydraulic?.pressurePa;
  if (!suction || suctionPa === undefined) return pending('本泵吸油箱及入口压力待核。');
  const leakage = pump.parameters.hydraulic?.leakageM3PerSPa;
  if (!estimatedSupplyM3PerS || leakage === undefined || duty.totalEfficiency > duty.pumpVolumetricEfficiency)
    return pending('泵供流、泄漏或总效率待核。');
  const [action] = phase.actions;
  if (
    phase.actions.length !== 1 ||
    !action ||
    phase.valves.length !== 1 ||
    phase.flowSplit ||
    phase.dividerEnd ||
    phase.shutoffs?.length ||
    phase.pumpCommandPercent !== undefined ||
    phase.pumpPressureControl
  )
    return pending('共用有损回油要求每组一个油缸动作及对应的换向阀工作位。');
  if (Math.abs(action.returnPressurePa - tankPa) > 1e-6 || action.supplyLossPa !== 0)
    return pending('回油基准须取油箱压力，手填供油损失须为零，避免重复计入阀管损失。');
  const graph = dutyPhasePaths(project, phase, false, true);
  if (!graph.ok) return pending(graph.diagnostics.map((d) => d.message).join('；'));
  const paths = graph.value;
  const p = pump.id + ':P';
  const t = tank.id + ':T';
  if (paths.reachable(p, t)) return pending('供回油短接或未建模卸荷，不能确定本组实际流量。');
  const branches = cylinderBranchLaws(project, phase, paths, p, t, tankPa);
  if (!branches.ok) return pending(branches.diagnostics.map((d) => d.message).join('；'));
  const [branch] = branches.value;
  if (!branch) return pending('本组换向阀及缸有效面积待核。');
  const reliefs: { startPa: number; resistance: number }[] = [];
  for (const part of project.design.components.filter((part) => part.typeId === 'relief')) {
    const h = part.parameters.hydraulic;
    if (
      part.definition.id !== 'teaching:relief' ||
      !h?.maximumAreaM2 ||
      !h.flowCoefficient ||
      h.settingDifferentialPa === undefined ||
      !paths.idealReachable(p, part.id + ':P') ||
      !paths.idealReachable(part.id + ':T', t)
    )
      return pending(label(part) + ' 只支持从本泵出口取压并直接回油箱的直动溢流。');
    reliefs.push({
      startPa: (route.tankAt(part.id + ':T')?.parameters.hydraulic?.pressurePa ?? NaN) + h.settingDifferentialPa,
      resistance: orificeResistance(project.design.fluid.densityKgPerM3, h.flowCoefficient, h.maximumAreaM2),
    });
  }
  const internal = pump.parameters.relief;
  if (internal?.enabled === 1) {
    if (!internal.maximumAreaM2 || !internal.flowCoefficient || internal.settingDifferentialPa === undefined)
      return pending('泵内置溢流缺设定或有效孔口。');
    reliefs.push({
      startPa: suctionPa + internal.settingDifferentialPa,
      resistance: orificeResistance(
        project.design.fluid.densityKgPerM3,
        internal.flowCoefficient,
        internal.maximumAreaM2,
      ),
    });
  }
  if (branch.closed && !reliefs.length && leakage === 0)
    return pending('工作支路关闭且没有可确认的泄漏或溢流回箱，定量泵无法平衡。');
  return {
    identity,
    kind: 'ready',
    law: { branch, suctionPa, suctionTank: suction.id, supply: estimatedSupplyM3PerS, leakage, reliefs, duty },
  };
}

function root(low: number, high: number, residual: (value: number) => number): number {
  for (let i = 0; i < 64; i++) {
    const mid = low + (high - low) / 2;
    if (mid === low || mid === high) break;
    if (residual(mid) < 0) low = mid;
    else high = mid;
  }
  return low + (high - low) / 2;
}

function pumpAt(law: PointLaw, headerPa: number, tankPa: number) {
  const branch = { ...law.branch, startPa: law.branch.startPa + law.branch.areaRatio * (headerPa - tankPa) };
  const relief = (p: number) => law.reliefs.reduce((q, item) => q + orificeFlow(p, item), 0);
  const leakage = (p: number) => law.leakage * Math.max(0, p - law.suctionPa);
  const upperPa = Math.min(
    branch.closed ? Infinity : branch.startPa + branch.resistance * law.supply ** 2,
    law.leakage > 0 ? law.suctionPa + law.supply / law.leakage : Infinity,
    ...law.reliefs.map((item) => item.startPa + item.resistance * law.supply ** 2),
  );
  const error = (p: number) => orificeFlow(p, branch) + relief(p) + leakage(p) - law.supply;
  const pumpPa = root(0, upperPa, error);
  const flow = orificeFlow(pumpPa, branch);
  return {
    pumpPa,
    flow,
    returnFlow: flow * branch.areaRatio,
    relief: relief(pumpPa),
    leakage: leakage(pumpPa),
    error: error(pumpPa),
  };
}

export function solveSharedPumpReturn(
  project: NetworkProject,
  route: SharedRoute,
  groups: readonly GroupInput[],
  names: readonly string[],
): readonly (readonly SharedPumpReturnPhase[])[] {
  const tankPa = groups[0]?.tank.parameters.hydraulic?.pressurePa;
  if (tankPa === undefined)
    return groups.map(() => names.map((name) => ({ kind: 'pending', name, reason: '缺少已保存油箱压力。' })));
  const pipeLaw = seriesParameters(project, route.pipes, '共用回油干线');
  const phases = names.map((name): readonly SharedPumpReturnPhase[] => {
    const prepared = groups.map((group) => prepareGroup(group, name, tankPa, route));
    const pending = (reason: string) =>
      prepared.map((entry): SharedPumpReturnPhase => ({
        ...entry.identity,
        kind: 'pending',
        reason: entry.kind === 'pending' ? entry.reason : reason,
      }));
    if (!pipeLaw.ok) return pending(pipeLaw.diagnostics.map((d) => d.message).join('；'));
    const ready = prepared.filter((entry) => entry.kind === 'ready');
    if (ready.length !== 2) return pending('另一组同名工况缺少有效动作或泵条件，共用回油量与背压待核。');
    const law = pipeLaw.value;
    const flowAt = (headerPa: number) =>
      ready.reduce((sum, entry) => sum + pumpAt(entry.law, headerPa, tankPa).returnFlow, 0);
    const dropAt = (headerPa: number) => seriesDrop(law, flowAt(headerPa));
    if (!Number.isFinite(dropAt(tankPa)) || limitPa - tankPa < dropAt(limitPa))
      return pending('在油箱压力至 70 MPa 内未能确定共用回油背压。');
    const headerPa = root(tankPa, limitPa, (p) => p - tankPa - dropAt(p));
    const points = ready.map(({ law }) => {
      const point = pumpAt(law, headerPa, tankPa);
      return { ...point, chamberPa: headerPa + law.branch.returnResistance * point.returnFlow ** 2 };
    });
    const total = points.reduce((sum, point) => sum + point.returnFlow, 0);
    const result = seriesReport(law, total, tankPa, '共用回油干线');
    if (!result.ok) return pending(result.diagnostics.map((d) => d.message).join('；'));
    const [first] = result.value;
    if (!first) return pending('未找到有损回油段。');
    if (
      !Number.isFinite(total) ||
      Math.abs(first.upstreamPressurePa - headerPa) > Math.max(1, headerPa) * 1e-8 ||
      points.some(
        (point, i) =>
          !Number.isFinite(point.pumpPa) ||
          point.pumpPa > limitPa ||
          !Number.isFinite(point.chamberPa) ||
          point.chamberPa > limitPa ||
          Math.abs(point.error) > (ready[i]?.law.supply ?? 0) * 1e-8,
      )
    )
      return pending('在支持压力范围内未能核对各泵及共用回油流量守恒。');
    return ready.map(({ identity, law: group }, i): SharedPumpReturnPhase => {
      const point = points[i];
      if (!point) return { ...identity, kind: 'pending', reason: '本组稳态点待核。' };
      const { branch, duty } = group;
      const speedMPerS = point.flow / branch.inletArea;
      if (point.pumpPa < group.suctionPa - 1e-6)
        return { ...identity, kind: 'pending', reason: '泵出口低于吸油箱压力，倒灌及反向功率待核。' };
      const shaftPowerW = ((point.pumpPa - group.suctionPa) * group.supply) / duty.totalEfficiency;
      if (!Number.isFinite(shaftPowerW)) return { ...identity, kind: 'pending', reason: '轴功率超出支持范围。' };
      const verdict =
        point.flow === 0
          ? '未建立通流，保压待核。'
          : Math.abs(speedMPerS / branch.target.targetSpeedMPerS - 1) <= 0.01
            ? '缸速达标。'
            : '实际缸速未达目标。';
      return {
        ...identity,
        kind: 'solved',
        pipe: first,
        segments: result.value,
        suctionTank: group.suctionTank,
        suctionPa: group.suctionPa,
        pumpPa: point.pumpPa,
        shaftPowerW,
        cylinderFlowM3PerS: point.flow,
        speedMPerS,
        returnFlowM3PerS: point.returnFlow,
        chamberPa: point.chamberPa,
        reliefFlowM3PerS: point.relief,
        leakageM3PerS: point.leakage,
        reason: verdict + (point.pumpPa > duty.pressureLimitPa ? '泵出口超出本组预算。' : ''),
      };
    });
  });
  return groups.map((_, i) =>
    phases.flatMap((phase) => {
      const result = phase[i];
      return result ? [result] : [];
    }),
  );
}
