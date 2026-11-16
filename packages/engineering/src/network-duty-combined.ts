import {
  ContractReader,
  checkJson,
  diagnostic,
  networkValvePositions,
  type NetworkComponent,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import {
  cylinderBranchLaws,
  meteredLoadPath,
  orificeFlow,
  orificeResistance,
  parallelFlowTargets,
  type BranchLaw,
  type ParallelFlowTarget,
} from './network-duty-flow-split.js';
import {
  parseNetworkDutyPhases,
  parseNetworkDutyReportRequest,
  type DutyPendingPhase,
  type DutyPhase,
} from './network-duty.js';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import {
  pipeParameters,
  reportReturnPipe,
  returnPipeLoss,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';

const pressureMax = 70e6;
const supported = new Set([
  'pump',
  'tank',
  'cylinder',
  'motor',
  'valve',
  'throttle',
  'volume',
  'relief',
  'check-valve',
  'pilot-unloading-valve',
]);
const label = (component: NetworkComponent) => component.label || component.id;
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/combinedSupply', message)],
});

export const combinedSupplyConditions = [
  '多台定量泵从同一油箱吸油，各经独立 A→B 止回阀接理想母线。普通双作用缸或定量马达各用独立四通阀，采用保存的阀口及给定的 T 侧等效背压。',
  '各泵零压供流按排量、核算转速和输入容积效率估计。压力相关线性泄漏及有限直动溢流另计，输入效率勿再重复扣除这部分泄漏。',
  '每泵零压供流等于入母线流量、压力泄漏和本泵溢流之和。母线流量等于各执行器进油和母线溢流之和。轴功率按本泵压差乘零压供流再除以输入总效率估计，止回阀关闭时仍可有溢流和轴功率。',
  '预算只作校核。缸容积效率取 1，定量马达用输入效率估计转矩与流量，目标速度允差 ±1%。变量调节、动态换向和有损公共干线另验。',
] as const;

const unloadingConditions = [
  '大泵止回阀前接卸荷阀 P，T 直回同一油箱，X 在止回阀后取母线压力。先导压差为母线压力减油箱压力。',
  '各工况按卸荷阀初始关闭、压力上升独立核算。达到动作压差后改算全开孔口。仅当新稳态压差高于复位压差时维持卸荷，否则标明待核。回差区内的历史状态、切换瞬态和有损公共干线另验。',
  '卸荷回箱按大泵出口与油箱压差和保存阀口面积计算。每泵零压供流等于入母线流量与本泵总回箱量之和。总回箱量包括卸荷、局部溢流和压力泄漏。轴功率按各泵出口与油箱的压差乘零压供流，再除以总效率估计。',
] as const;

const lossyBusConditions = [
  '限双定量泵、同一油箱。各泵经独立 A→B 止回阀汇合，再经一段物理母线供普通双作用缸。吸油、回油及下游分配为理想连接。',
  '止回阀取母线入口压力。按母线实际流量、保存管径、长度、粗糙度、K 和油液参数计损。计入下游溢流，上游汇合点附加溢流待核。',
  '零压供流由排量、转速及容积效率估计，等于入母线流量、本泵泄漏和溢流之和。轴功率取泵压差乘零压供流再除以总效率。',
  '采用保存阀口及给定背压，缸容积效率取 1，速度允差 ±1%，预算只作校核。有损吸油、空化、并联管、卸荷混接及瞬态待核。',
] as const;

export function isCombinedSupplyCandidate(project: NetworkProject): boolean {
  const parts = project.design.components;
  const pumps = parts.filter((part) => part.typeId === 'pump');
  const actuators = parts.filter(isLoad);
  if (pumps.length < 2 || !actuators.length) return false;
  // Retain the original two-pump, one-cylinder diagnostic entry even if its check valves are incomplete.
  if (pumps.length === 2 && actuators.length === 1 && actuators[0]?.typeId === 'cylinder') return true;
  const raw = dutyPhasePaths(project, { name: '合流识别', valves: [], actions: [] }, false);
  if (!raw.ok) return false;
  const ideal = raw.value.idealReachable;
  const checks = parts.filter((part) => part.typeId === 'check-valve');
  return parts
    .filter((part) => part.typeId === 'valve')
    .some(
      ({ id }) =>
        pumps.filter((pump) => {
          const p = pump.id + ':P';
          const bus = id + ':P';
          return (
            ideal(p, bus) ||
            checks.some(
              (check) =>
                (ideal(p, check.id + ':A') && raw.value.reachable(check.id + ':B', bus)) ||
                (ideal(p, check.id + ':B') && raw.value.reachable(check.id + ':A', bus)),
            )
          );
        }).length >= 2,
    );
}
const isLoad = (part: NetworkComponent) => part.typeId === 'cylinder' || part.typeId === 'motor';

interface PumpInput {
  readonly speed: number;
  readonly etaV: number;
  readonly etaTotal?: number;
  readonly budget?: number;
}
interface PumpIdentity {
  readonly pumpId: string;
  readonly label: string;
  readonly estimatedSupplyM3PerS?: number;
}
export type CombinedPumpResult =
  | (PumpIdentity & { readonly kind: 'pending'; readonly reason: string })
  | (PumpIdentity & {
      readonly kind: 'solved';
      readonly valveLabel: string;
      readonly open: boolean;
      readonly outletPa: number;
      readonly openingThresholdPa?: number;
      readonly busFlowM3PerS: number;
      readonly localReliefM3PerS: number;
      readonly leakageM3PerS: number;
      readonly unloading?: {
        readonly valveId: string;
        readonly label: string;
        readonly open: boolean;
        readonly flowM3PerS: number;
        readonly pilotDifferentialPa: number;
        readonly tripDifferentialPa: number;
        readonly resetDifferentialPa: number;
      };
      readonly shaftPowerW?: number;
      readonly reason: string;
    });
export type CombinedDutyPhase =
  | {
      readonly kind: 'pending';
      readonly name: string;
      readonly reason: string;
      readonly pumps: readonly CombinedPumpResult[];
      readonly targets: readonly CombinedLoadTarget[];
    }
  | {
      readonly kind: 'solved';
      readonly name: string;
      readonly busPa: number;
      readonly supplyPipe?: ReturnPipeResult;
      readonly busReliefM3PerS: number;
      readonly loads: readonly CombinedLoadResult[];
      readonly targetWindow:
        | { readonly kind: 'compatible'; readonly minimumPa: number; readonly maximumPa: number }
        | { readonly kind: 'incompatible' };
      readonly cylinderFlowM3PerS?: number;
      readonly cylinderSpeedMPerS?: number;
      readonly target?: ParallelFlowTarget;
      readonly matchesTarget: boolean;
      readonly pumps: readonly CombinedPumpResult[];
    };
interface CombinedLoadTarget {
  readonly componentId: string;
  readonly label: string;
  readonly kind: 'cylinder' | 'motor';
  /** m/s for a cylinder, rad/s for a motor. */
  readonly targetSpeed: number;
  readonly targetFlowM3PerS: number;
}
interface CombinedLoadResult extends CombinedLoadTarget {
  readonly flowM3PerS: number;
  readonly speed: number;
  readonly matchesTarget: boolean;
}
export interface CombinedDutyCoverage {
  readonly phases: readonly CombinedDutyPhase[];
  readonly pendingPhases: readonly DutyPendingPhase[];
  readonly hasUnloading?: true;
  readonly hasSupplyPipe?: true;
}

export function combinedDutyConditions(coverage: CombinedDutyCoverage): readonly string[] {
  if (coverage.hasSupplyPipe) return lossyBusConditions;
  return coverage.hasUnloading
    ? [
        ...combinedSupplyConditions.slice(0, 2),
        '两泵入母线流量之和等于缸进油和母线溢流。预算仅用于校核。缸容积效率取 1，目标速度允差 ±1%。',
        ...unloadingConditions,
      ]
    : combinedSupplyConditions;
}

interface OrificeLaw {
  readonly startPa: number;
  readonly resistance: number;
}
interface PumpLaw {
  readonly identity: PumpIdentity;
  readonly input: PumpInput;
  readonly supply: number;
  readonly leakage: number;
  readonly check: NetworkComponent;
  readonly crack: number;
  readonly resistance: number;
  readonly reliefs: readonly OrificeLaw[];
}

interface UnloadingLaw {
  readonly pumpId: string;
  readonly valve: NetworkComponent;
  readonly tripDifferentialPa: number;
  readonly resetDifferentialPa: number;
  readonly orifice: OrificeLaw;
}
interface LoadLaw {
  readonly target: CombinedLoadTarget;
  readonly valve: NetworkComponent;
  readonly startPa: number;
  readonly resistance: number;
  readonly closed: boolean;
}

function loadTargets(project: NetworkProject, phase: DutyPhase): readonly CombinedLoadTarget[] {
  const cylinders = parallelFlowTargets(project, phase.actions);
  return phase.actions.flatMap((action): CombinedLoadTarget[] => {
    const cylinder = cylinders.find((target) => target.componentId === action.componentId);
    if (cylinder) return [{ ...cylinder, kind: 'cylinder', targetSpeed: cylinder.targetSpeedMPerS }];
    const motor = project.design.components.find(
      (part) => part.id === action.componentId && part.definition.id === 'teaching:motor',
    );
    const displacement = motor?.parameters.hydraulic?.displacementM3PerRev;
    if (!motor || !displacement) return [];
    const flow = (displacement * action.speed) / (2 * Math.PI * action.volumetricEfficiency);
    return flow > 0 && Number.isFinite(flow)
      ? [
          {
            componentId: motor.id,
            label: label(motor),
            kind: 'motor',
            targetSpeed: action.speed,
            targetFlowM3PerS: flow,
          },
        ]
      : [];
  });
}

function combinedLoads(
  project: NetworkProject,
  phase: DutyPhase,
  paths: DutyPhasePaths,
  boundary: { readonly bus: string; readonly t: string; readonly tankPressurePa: number },
): Result<readonly LoadLaw[]> {
  const targets = loadTargets(project, phase);
  const laws: LoadLaw[] = [];
  const usedValves = new Set<string>();
  const { bus, t, tankPressurePa } = boundary;
  for (const action of phase.actions) {
    const target = targets.find((item) => item.componentId === action.componentId);
    const part = project.design.components.find((item) => item.id === action.componentId);
    if (!part || !target || action.motorSetting || action.rotaryAngleRad !== undefined)
      return fail('执行器类型或目标超出合流支持范围。');
    let law: Pick<BranchLaw, 'valve' | 'startPa' | 'resistance' | 'closed'>;
    if (target.kind === 'cylinder') {
      const cylinder = cylinderBranchLaws(project, { ...phase, actions: [action] }, paths, bus, t, tankPressurePa);
      if (!cylinder.ok) return cylinder;
      const branch = cylinder.value[0];
      if (!branch) return fail('缺少受控油缸支路。');
      law = branch;
    } else {
      const displacement = part.parameters.hydraulic?.displacementM3PerRev;
      if (!displacement || action.returnPressurePa < tankPressurePa)
        return fail(target.label + ' 的排量或回油压力待核。');
      const path = meteredLoadPath(project, paths, bus, t, part, action.direction === 'forward', usedValves);
      if (!path.ok) return path;
      const { valve, feedResistance, returnResistance, closed } = path.value;
      const startPa =
        (2 * Math.PI * action.resistingLoad) / (displacement * action.mechanicalEfficiency) +
        action.returnPressurePa +
        action.supplyLossPa;
      const resistance = feedResistance + returnResistance;
      if (!Number.isFinite(startPa) || !Number.isFinite(resistance) || !(resistance > 0))
        return fail(target.label + ' 的负载或阀口超出有限数值范围。');
      law = { valve, startPa, resistance, closed };
    }
    if (usedValves.has(law.valve.id)) return fail('每个参与动作的执行器须有独立的换向阀。');
    usedValves.add(law.valve.id);
    laws.push({ ...law, target });
  }
  return { ok: true, value: laws };
}

function topology(project: NetworkProject) {
  const parts = project.design.components;
  const pumps = parts.filter((p) => p.typeId === 'pump');
  const tanks = parts.filter((p) => p.typeId === 'tank');
  const checks = parts.filter((p) => p.typeId === 'check-valve');
  const valves = parts.filter((p) => p.typeId === 'valve');
  const actuators = parts.filter(isLoad);
  const tank = tanks[0],
    valve = valves[0];
  if (
    pumps.length < 2 ||
    tanks.length !== 1 ||
    !tank ||
    !actuators.length ||
    valves.length !== actuators.length ||
    !valve ||
    parts.some((p) => !supported.has(p.typeId))
  )
    return fail('合流要求至少两台定量泵、一个油箱，普通双作用缸或定量马达各用一只四通换向阀。');
  const pipes = project.design.connections.filter((edge) => edge.kind === 'pipe');
  if (checks.length !== pumps.length || project.design.connections.some((edge) => edge.kind === 'signal'))
    return fail('要求每泵各有一只止回阀，缺少止回阀或存在信号连线待核。');
  if (
    pipes.length &&
    (pipes.length !== 1 || pumps.length !== 2 || actuators.some((part) => part.typeId !== 'cylinder'))
  )
    return fail('有损合流限双定量泵、一段供油母线及普通双作用缸，其他物理管及有损吸油或回油待核。');
  if (pumps.some((p) => p.definition.id !== 'teaching:pump')) return fail('变量泵或未登记定量泵的供流规律待核。');
  const tankPressurePa = tank.parameters.hydraulic?.pressurePa;
  if (tankPressurePa === undefined) return fail('油箱压力缺失。');
  const raw = dutyPhasePaths(project, { name: '母线拓扑', valves: [], actions: [] }, false);
  if (!raw.ok) return raw;
  const ideal = raw.value.idealReachable;
  const t = tank.id + ':T',
    bus = valve.id + ':P';
  const busPipe = pipes[0];
  const checkOutlet = busPipe
    ? checks.find((check) => raw.value.uniquePath(check.id + ':B', bus)?.some((arc) => arc.physicalPipe === busPipe))
    : undefined;
  const header = checkOutlet ? checkOutlet.id + ':B' : bus;
  if (busPipe && (!checkOutlet || ideal(header, bus)))
    return fail('供油母线 [' + busPipe.id + '] 须串联在止回阀共同汇合点和各换向阀 P 口之间，旁路和断路待核。');
  const pipeLaw = busPipe ? pipeParameters(project, busPipe, '供油母线') : undefined;
  if (pipeLaw && !pipeLaw.ok) return pipeLaw;
  if (
    ideal(bus, t) ||
    ideal(header, t) ||
    valves.some((v) => !ideal(bus, v.id + ':P') || !ideal(v.id + ':T', t)) ||
    pumps.some((p) => !ideal(p.id + ':S', t))
  )
    return fail('各换向阀 P 口须接同一理想母线，母线与油箱隔离，各泵 S 口和换向阀 T 口须经理想油路回同一油箱。');
  const upstream = pumps.map((p) => p.id + ':P');
  if (
    upstream.some(
      (p, i) => ideal(p, bus) || ideal(p, header) || ideal(p, t) || upstream.slice(i + 1).some((q) => ideal(p, q)),
    )
  )
    return fail('各泵出口必须在各自止回阀前独立，不能直连母线、油箱或另一台泵。');
  const checkByPump = new Map<string, NetworkComponent>();
  for (const pump of pumps) {
    const check = checks.find((c) => ideal(pump.id + ':P', c.id + ':A') && ideal(c.id + ':B', header));
    if (!check || [...checkByPump.values()].some((c) => c.id === check.id))
      return fail(label(pump) + ' 缺少方向明确的独立止回阀：泵 P 接 A，B 接母线。反接或旁路时实际合流待核。');
    checkByPump.set(pump.id, check);
  }
  const density = project.design.fluid.densityKgPerM3;
  const unloaders = parts.filter((p) => p.typeId === 'pilot-unloading-valve');
  const unloader = unloaders[0];
  let unloading: UnloadingLaw | undefined;
  if (
    unloaders.length > 1 ||
    (unloader && (pumps.length !== 2 || actuators.length !== 1 || actuators[0]?.typeId !== 'cylinder'))
  )
    return fail('卸荷组合目前只核算两台泵、一只普通双作用缸和一只外控卸荷阀。');
  if (unloader) {
    if (busPipe) return fail('外控卸荷与有损母线混接需要明确取压侧，当前待核。');
    const port = unloader.id;
    const large = pumps.find((p) => ideal(p.id + ':P', port + ':P'));
    const small = pumps.find((p) => p !== large);
    if (!large || !small || !ideal(port + ':T', t) || !ideal(port + ':X', bus))
      return fail(label(unloader) + ' 接线待核。P 须接大泵止回阀前，T 直回同一油箱，X 接止回阀后的供油母线。');
    const largeDisplacement = large.parameters.hydraulic?.displacementM3PerRev;
    const smallDisplacement = small.parameters.hydraulic?.displacementM3PerRev;
    if (largeDisplacement === undefined || smallDisplacement === undefined || largeDisplacement <= smallDisplacement)
      return fail(label(unloader) + ' 的 P 口须接排量较大的定量泵，当前两泵排量或卸荷泵接向待核。');
    const h = unloader.parameters.hydraulic;
    if (
      unloader.definition.id !== 'teaching:pilot-unloading-valve' ||
      h?.tripPressurePa === undefined ||
      h.resetPressurePa === undefined ||
      h.resetPressurePa >= h.tripPressurePa ||
      !h.maximumAreaM2 ||
      !h.flowCoefficient
    )
      return fail(label(unloader) + ' 的动作压差、复位压差或全开孔口待核。');
    unloading = {
      pumpId: large.id,
      valve: unloader,
      tripDifferentialPa: h.tripPressurePa,
      resetDifferentialPa: h.resetPressurePa,
      orifice: {
        startPa: tankPressurePa,
        resistance: orificeResistance(density, h.flowCoefficient, h.maximumAreaM2),
      },
    };
  }
  const reliefs = new Map<string, OrificeLaw[]>();
  for (const part of parts.filter((p) => p.typeId === 'relief')) {
    const owner = [bus, ...upstream].find((port) => ideal(port, part.id + ':P'));
    const h = part.parameters.hydraulic;
    if (
      !owner ||
      part.definition.id !== 'teaching:relief' ||
      !ideal(part.id + ':T', t) ||
      h?.settingDifferentialPa === undefined ||
      !h.maximumAreaM2 ||
      !h.flowCoefficient
    )
      return fail(label(part) + ' 须为泵出口或母线取压并直回油箱的有限直动溢流阀。');
    const list = reliefs.get(owner) ?? [];
    list.push({
      startPa: tankPressurePa + h.settingDifferentialPa,
      resistance: orificeResistance(density, h.flowCoefficient, h.maximumAreaM2),
    });
    reliefs.set(owner, list);
  }
  return {
    ok: true as const,
    value: { bus, t, tankPressurePa, checkByPump, reliefs, valves, actuators, unloading, supplyPipe: pipeLaw?.value },
  };
}

export function combinedDutyPipeEligible(project: NetworkProject, connectionId: string): boolean {
  const layout = topology(project);
  return layout.ok && layout.value.supplyPipe?.connectionId === connectionId;
}

function solvePhase(
  project: NetworkProject,
  phase: DutyPhase,
  layout: Extract<ReturnType<typeof topology>, { ok: true }>['value'],
  pumps: readonly PumpLaw[],
): Result<CombinedDutyPhase> {
  const { bus, t, tankPressurePa, reliefs, valves, actuators, unloading, supplyPipe } = layout;
  if (
    !phase.actions.length ||
    phase.valves.length !== valves.length ||
    !valves.every((valve) =>
      phase.valves.some(
        (slot) => slot.componentId === valve.id && networkValvePositions(valve).includes(slot.positionId),
      ),
    ) ||
    phase.shutoffs?.length ||
    phase.flowSplit ||
    phase.dividerEnd ||
    phase.pumpCommandPercent !== undefined ||
    phase.pumpPressureControl
  )
    return fail('请明确本工况参与动作和各四通换向阀位置。');
  const graph = dutyPhasePaths(project, phase, false, true);
  if (!graph.ok) return graph;
  if (
    graph.value.reachable(bus, t) ||
    pumps.some(
      (pump) =>
        graph.value.reachable(bus, pump.identity.pumpId + ':P') ||
        graph.value.reachable(pump.identity.pumpId + ':P', t),
    )
  )
    return fail('母线或泵出口存在未建模卸荷、短接或绕过止回阀的回通路径。');
  const unlisted = actuators.find(
    (part) =>
      !phase.actions.some((action) => action.componentId === part.id) &&
      ['A', 'B'].some((port) => graph.value.reachable(bus, part.id + ':' + port)),
  );
  if (unlisted) return fail(label(unlisted) + ' 未纳入本工况但有母线供油通路，请纳入动作或切换至隔离阀位。');
  const load = combinedLoads(project, phase, graph.value, layout);
  if (!load.ok) return load;
  const branches = load.value;
  const loadFlow = (pressure: number) => branches.reduce((sum, branch) => sum + orificeFlow(pressure, branch), 0);
  const local = (pump: PumpLaw, p: number) => pump.reliefs.reduce((sum, relief) => sum + orificeFlow(p, relief), 0);
  const equilibrium = (low: number, high: number, residual: (p: number) => number) => {
    for (let i = 0; i < 64; i++) {
      const mid = low + (high - low) / 2;
      if (residual(mid) < 0) low = mid;
      else high = mid;
    }
    return low + (high - low) / 2;
  };
  const pumpAt = (pump: PumpLaw, busPa: number, bypassOpen: boolean) => {
    const openingThresholdPa = busPa + pump.crack;
    const check = { startPa: openingThresholdPa, resistance: pump.resistance };
    const leakage = (p: number) => pump.leakage * (p - tankPressurePa);
    const bypass = (p: number) =>
      bypassOpen && unloading?.pumpId === pump.identity.pumpId ? orificeFlow(p, unloading.orifice) : 0;
    const residual = (p: number) => orificeFlow(p, check) + local(pump, p) + leakage(p) + bypass(p) - pump.supply;
    const freeOutlet = openingThresholdPa + pump.resistance * pump.supply ** 2;
    const outletPa =
      pump.leakage === 0 && !bypassOpen && pump.reliefs.every((item) => item.startPa >= freeOutlet)
        ? freeOutlet
        : equilibrium(tankPressurePa, freeOutlet, residual);
    return {
      openingThresholdPa,
      outletPa,
      busFlowM3PerS: orificeFlow(outletPa, check),
      leakageM3PerS: leakage(outletPa),
      localReliefM3PerS: local(pump, outletPa),
      bypassFlowM3PerS: bypass(outletPa),
      residual: residual(outletPa),
    };
  };
  const busRelief = (p: number) => (reliefs.get(bus) ?? []).reduce((sum, relief) => sum + orificeFlow(p, relief), 0);
  const demandFlow = (p: number) => loadFlow(p) + busRelief(p);
  const headerAt = (p: number) => (supplyPipe ? p + returnPipeLoss(supplyPipe, demandFlow(p)).pressureDropPa : p);
  const total = pumps.reduce((sum, pump) => sum + pump.supply, 0);
  const residual = (p: number, bypassOpen: boolean) =>
    demandFlow(p) - pumps.reduce((sum, pump) => sum + pumpAt(pump, headerAt(p), bypassOpen).busFlowM3PerS, 0);
  const balance = (bypassOpen: boolean) => {
    const flowError = (p: number) => residual(p, bypassOpen);
    if (flowError(tankPressurePa) > 0 || flowError(pressureMax) < 0)
      return fail('在油箱压力至 70 MPa 内没有可确认的母线流量平衡。');
    const busPa = equilibrium(tankPressurePa, pressureMax, flowError);
    const actual = pumps.map((pump) => ({ pump, ...pumpAt(pump, headerAt(busPa), bypassOpen) }));
    if (
      Math.abs(flowError(busPa)) > total * 1e-8 ||
      actual.some(
        (p) => !Number.isFinite(p.outletPa) || p.outletPa > pressureMax || Math.abs(p.residual) > p.pump.supply * 1e-8,
      )
    )
      return fail('母线或泵出口未在支持的压力范围内达到流量守恒。');
    const isolated = actual.every((p) => p.busFlowM3PerS === 0) && loadFlow(busPa) === 0 && busRelief(busPa) === 0;
    return { ok: true as const, value: { busPa, actual, isolated } };
  };
  // Match the native latch: trip at the rising threshold and reset at or below the falling threshold.
  const pressureTolerance = 1e-6;
  const closed = balance(false);
  const tripPa = unloading && tankPressurePa + unloading.tripDifferentialPa;
  const bypassOpen =
    tripPa !== undefined &&
    tripPa <= pressureMax &&
    (closed.ok
      ? !closed.value.isolated && closed.value.busPa >= tripPa - pressureTolerance
      : residual(tripPa, false) < -total * 1e-8 &&
        pumps.every((pump) => pumpAt(pump, tripPa, false).outletPa <= pressureMax));
  const operating = bypassOpen ? balance(true) : closed;
  if (!operating.ok) {
    if (!bypassOpen) return operating;
    return fail(
      '母线达到卸荷动作压差，但卸荷阀全开试算无有效稳态。' + operating.diagnostics.map((d) => d.message).join(''),
    );
  }
  const { busPa, actual, isolated } = operating.value;
  const pilotDifferentialPa = busPa - tankPressurePa;
  if (unloading && isolated) return fail('两泵止回阀均关闭，母线压力待核，无法确定卸荷阀能否保持。');
  if (bypassOpen && unloading && pilotDifferentialPa <= unloading.resetDifferentialPa + pressureTolerance)
    return fail(
      (closed.ok
        ? '关闭态试算先导压差 ' + Number(((closed.value.busPa - tankPressurePa) / 1e6).toPrecision(6)) + ' MPa，达到'
        : '关闭态试算达到') +
        '动作压差 ' +
        unloading.tripDifferentialPa / 1e6 +
        ' MPa，卸荷后试算先导压差 ' +
        Number((pilotDifferentialPa / 1e6).toPrecision(6)) +
        ' MPa 降至复位压差 ' +
        unloading.resetDifferentialPa / 1e6 +
        ' MPa 或以下，阀会复位，未找到可维持的稳态。',
    );
  const results = actual.map(
    ({
      pump,
      outletPa,
      openingThresholdPa,
      busFlowM3PerS,
      leakageM3PerS,
      localReliefM3PerS,
      bypassFlowM3PerS,
    }): CombinedPumpResult => {
      const open = busFlowM3PerS > 0;
      const stage = unloading?.pumpId === pump.identity.pumpId ? unloading : undefined;
      const limit =
        pump.input.budget === undefined
          ? ' 试算预算待核。'
          : outletPa > pump.input.budget
            ? ' 泵出口压力超过本组试算预算。'
            : '';
      const shaftPowerW =
        pump.input.etaTotal === undefined
          ? undefined
          : ((outletPa - tankPressurePa) * pump.supply) / pump.input.etaTotal;
      const checkReason = open
        ? unloading
          ? ''
          : supplyPipe
            ? '泵出口超过开启门槛。'
            : '泵出口压力超过母线压力与开启压差之和。'
        : supplyPipe
          ? '泵出口未超过开启门槛，止回阀关闭。'
          : '母线背压与开启压差之和高于或等于泵出口压力，止回阀关闭。泵流量经本泵溢流或泄漏回箱。';
      const reason =
        (stage && bypassOpen
          ? open
            ? '卸荷孔口有限，大泵仍部分供油，未形成小泵独供。'
            : '泵出口未达开启门槛，大泵经卸荷阀回箱。'
          : checkReason) + limit;
      return {
        ...pump.identity,
        kind: 'solved',
        valveLabel: label(pump.check),
        open,
        outletPa,
        ...(isolated ? {} : { openingThresholdPa }),
        busFlowM3PerS,
        leakageM3PerS,
        localReliefM3PerS,
        ...(stage
          ? {
              unloading: {
                valveId: stage.valve.id,
                label: label(stage.valve),
                open: bypassOpen,
                flowM3PerS: bypassFlowM3PerS,
                pilotDifferentialPa,
                tripDifferentialPa: stage.tripDifferentialPa,
                resetDifferentialPa: stage.resetDifferentialPa,
              },
            }
          : {}),
        ...(shaftPowerW !== undefined && Number.isFinite(shaftPowerW) ? { shaftPowerW } : {}),
        reason:
          reason +
          (shaftPowerW === undefined
            ? ' 总效率缺失或无效，轴功率待核。'
            : Number.isFinite(shaftPowerW)
              ? ''
              : ' 轴功率超出有限范围。'),
      };
    },
  );
  if (isolated)
    return {
      ok: true,
      value: {
        kind: 'pending',
        name: phase.name,
        reason:
          (pumps.length === 2 ? '两只止回阀关闭' : '所有止回阀关闭') +
          '且母线没有通流，母线压力待核。本泵溢流、泄漏和轴功率仍可确定。',
        pumps: results,
        targets: branches.map((branch) => branch.target),
      },
    };
  const loads = branches.map(({ target, ...law }): CombinedLoadResult => {
    const flowM3PerS = orificeFlow(busPa, law);
    const ratio = flowM3PerS / target.targetFlowM3PerS;
    return { ...target, flowM3PerS, speed: ratio * target.targetSpeed, matchesTarget: Math.abs(ratio - 1) <= 0.01 };
  });
  const pipeReport = supplyPipe && reportReturnPipe(supplyPipe, demandFlow(busPa), busPa, '供油母线');
  if (pipeReport && !pipeReport.ok) return pipeReport;
  const minimumPa = Math.max(
    tankPressurePa,
    ...branches.map((branch) => branch.startPa + branch.resistance * (0.99 * branch.target.targetFlowM3PerS) ** 2),
  );
  const maximumPa = Math.min(
    pressureMax,
    ...branches.map((branch) => branch.startPa + branch.resistance * (1.01 * branch.target.targetFlowM3PerS) ** 2),
  );
  const first = loads[0];
  const matchesTarget =
    loads.every((item) => item.matchesTarget) &&
    actual.every((p) => p.pump.input.budget !== undefined && p.outletPa <= p.pump.input.budget);
  return {
    ok: true,
    value: {
      kind: 'solved',
      name: phase.name,
      busPa,
      ...(pipeReport ? { supplyPipe: pipeReport.value } : {}),
      busReliefM3PerS: busRelief(busPa),
      loads,
      targetWindow:
        minimumPa <= maximumPa && branches.every((item) => !item.closed)
          ? { kind: 'compatible', minimumPa, maximumPa }
          : { kind: 'incompatible' },
      ...(loads.length === 1 && first?.kind === 'cylinder'
        ? {
            cylinderFlowM3PerS: first.flowM3PerS,
            cylinderSpeedMPerS: first.speed,
            target: {
              componentId: first.componentId,
              label: first.label,
              targetSpeedMPerS: first.targetSpeed,
              targetFlowM3PerS: first.targetFlowM3PerS,
            },
          }
        : {}),
      matchesTarget,
      pumps: results,
    },
  };
}

export function reviewCombinedDuty(project: NetworkProject, input: unknown): Result<CombinedDutyCoverage> {
  const bounded = checkJson(input);
  if (!bounded.ok) return bounded;
  const r = new ContractReader();
  const raw = r.object(input, '/combinedSupply', ['pumps', 'phases', 'pendingPhases']);
  const allPumps = project.design.components.filter((p) => p.typeId === 'pump');
  const requests = r.array(raw.pumps, '/combinedSupply/pumps', allPumps.length).map((entry, i) => {
    const p = '/combinedSupply/pumps/' + i;
    const item = r.object(entry, p, ['pumpId', 'speed', 'etaV', 'etaTotal', 'budget']);
    const pumpId = r.id(item.pumpId, p + '/pumpId');
    if (!project.design.components.some((c) => c.id === pumpId && c.typeId === 'pump'))
      r.fail('DUTY_INVALID', p + '/pumpId', '泵输入必须引用实际泵实例。');
    const reader = new ContractReader();
    const speed = reader.number(item.speed, p + '/speed', Number.MIN_VALUE, 5000);
    const etaV = reader.number(item.etaV, p + '/etaV', Number.MIN_VALUE, 1);
    const result = reader.finish<PumpInput>({
      speed,
      etaV,
      ...(typeof item.etaTotal === 'number' && item.etaTotal > 0 && item.etaTotal <= etaV
        ? { etaTotal: item.etaTotal }
        : {}),
      ...(typeof item.budget === 'number' && item.budget > 0 && item.budget <= pressureMax
        ? { budget: item.budget }
        : {}),
    });
    return { pumpId, result };
  });
  r.unique(
    requests.map((p) => p.pumpId),
    '/combinedSupply/pumps',
  );
  const validated = r.finish(true);
  if (!validated.ok) return validated;
  const duty = parseNetworkDutyReportRequest(null, raw.pendingPhases);
  if (!duty.ok) return duty;
  const work = parseNetworkDutyPhases(raw.phases);
  if (!work.ok) return work;
  const layout = topology(project);
  const laws: PumpLaw[] = [];
  const pumpNotes: CombinedPumpResult[] = [];
  for (const pump of allPumps) {
    const identity = { pumpId: pump.id, label: label(pump) };
    if (pump.definition.id !== 'teaching:pump') {
      pumpNotes.push({ ...identity, kind: 'pending', reason: '该泵缺少本模型支持的定量供流规律。' });
      continue;
    }
    const source = requests.find((p) => p.pumpId === pump.id)?.result;
    if (!source?.ok) {
      pumpNotes.push({
        ...identity,
        kind: 'pending',
        reason: '泵转速或容积效率缺失或无效，零压供流待核。',
      });
      continue;
    }
    const displacement = pump.parameters.hydraulic?.displacementM3PerRev;
    const leakage = pump.parameters.hydraulic?.leakageM3PerSPa;
    const supply =
      displacement === undefined
        ? undefined
        : ((displacement * source.value.speed) / (2 * Math.PI)) * source.value.etaV;
    const known =
      supply !== undefined && supply > 0 && Number.isFinite(supply)
        ? { ...identity, estimatedSupplyM3PerS: supply }
        : identity;
    const check = layout.ok ? layout.value.checkByPump.get(pump.id) : undefined;
    const h = check?.parameters.hydraulic;
    if (
      !layout.ok ||
      !check ||
      !h?.maximumAreaM2 ||
      !h.flowCoefficient ||
      h.openingDifferentialPa === undefined ||
      leakage === undefined ||
      supply === undefined ||
      !(supply > 0) ||
      !Number.isFinite(supply)
    ) {
      pumpNotes.push({
        ...known,
        kind: 'pending',
        reason: !layout.ok
          ? layout.diagnostics.map((d) => d.message).join('；')
          : '缺少泵排量、泄漏参数或止回阀有效开口。',
      });
      continue;
    }
    const density = project.design.fluid.densityKgPerM3;
    const reliefs = [...(layout.value.reliefs.get(pump.id + ':P') ?? [])];
    const internal = pump.parameters.relief;
    if (internal?.enabled === 1) {
      if (internal.settingDifferentialPa === undefined || !internal.maximumAreaM2 || !internal.flowCoefficient) {
        pumpNotes.push({ ...known, kind: 'pending', reason: '内置溢流缺少设定或有效孔口。' });
        continue;
      }
      reliefs.push({
        startPa: layout.value.tankPressurePa + internal.settingDifferentialPa,
        resistance: orificeResistance(density, internal.flowCoefficient, internal.maximumAreaM2),
      });
    }
    laws.push({
      identity: known,
      input: source.value,
      supply,
      leakage,
      check,
      crack: h.openingDifferentialPa,
      resistance: orificeResistance(density, h.flowCoefficient, h.maximumAreaM2),
      reliefs,
    });
    pumpNotes.push({ ...known, kind: 'pending', reason: '已确定本泵零压供流，入母线流量和轴功率待共同稳态点。' });
  }
  const pending = (phase: DutyPhase, reason: string): CombinedDutyPhase => ({
    kind: 'pending',
    name: phase.name,
    reason,
    pumps: pumpNotes,
    targets: loadTargets(project, phase),
  });
  const phases = work.value.map((phase): CombinedDutyPhase => {
    if (!layout.ok) return pending(phase, layout.diagnostics.map((d) => d.message).join('；'));
    if (laws.length !== allPumps.length) return pending(phase, '至少一台泵的供流边界不完整，无法唯一分配母线流量。');
    const calculated = solvePhase(project, phase, layout.value, laws);
    return calculated.ok ? calculated.value : pending(phase, calculated.diagnostics.map((d) => d.message).join('；'));
  });
  if (!phases.length)
    phases.push({ kind: 'pending', name: '供油母线', reason: '没有完整的合流工况。', pumps: pumpNotes, targets: [] });
  const hasUnloading = project.design.components.some((part) => part.typeId === 'pilot-unloading-valve');
  const hasSupplyPipe = project.design.connections.some((edge) => edge.kind === 'pipe');
  return {
    ok: true,
    value: {
      phases,
      pendingPhases: duty.value.pendingPhases,
      ...(hasUnloading ? { hasUnloading: true } : {}),
      ...(hasSupplyPipe ? { hasSupplyPipe: true } : {}),
    },
  };
}
