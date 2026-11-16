import { diagnostic, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import { dutyPhasePaths, type DutyPhasePaths } from './network-duty-accessories.js';
import { pilotReliefLaw, type PilotReliefLaw, type PilotReliefSplitPoint } from './network-duty-pilot-relief.js';
import type { DutyPhase } from './network-duty.js';
import {
  findPilotReturnRoute,
  findReturnTopology,
  isReturnTreeAccessory,
  orificeResistance,
  pipeParameters,
  reportReturnAccessory,
  reportReturnPipe,
  returnAccessoryParameters,
  returnPipeLoss,
  returnTreeLimits,
  seriesAccessoryDrop,
  type ReturnAccessoryLaw,
  type ReturnAccessoryResult,
  type ReturnPipeLaw,
  type ReturnPipeResult,
  type PilotReturnRoute,
} from './network-duty-return-pipes.js';
import { solveReturnNetwork, type ReturnDemand } from './network-duty-return-tree.js';
import { findSupplyPipeTopology, reportSupplyPipes, type SupplyPipeResult } from './network-duty-supply-pipes.js';

export { orificeResistance, returnTreeLimits } from './network-duty-return-pipes.js';

export const parallelFlowConditions = [
  '实际分流首版限定量泵、单油箱及两只普通双作用缸，每缸有独立的四通换向阀。各支路供回油通路唯一，公共供油和回油干线按理想油路计算。',
  '采用四通换向阀保存的有效阀口面积、流量系数及串联可调节流阀的保存开口。缸容积效率取 1。其余供油压降和换向阀 T 侧回油背压为给定等效条件，可计入未单独建模的损失，须扣除软件已算的阀口压降。',
  '固定供流按泵排量、核算转速和泵容积效率估计。直动溢流阀按保存设定及有限孔口计流。供油预算只作校核，未当作溢流阀或恒压源。',
  '实际值为这些边界下的稳态估算，按两缸速度各自在目标 ±1% 内判定匹配。零流量表示目标方向未建立通流，未核验静态保载、超越负载、瞬态或液压冲击。',
] as const;

export const sharedReturnFlowConditions = [
  '单台定量泵和单油箱，各普通双作用缸使用独立四通换向阀。按 T 口至油箱的唯一回油路径识别汇合及串联管段。吸油按理想通路，物理供油管与先导式溢流阀回油接法分别按专项条件核对。',
  '各缸支管取本缸实际排油量 (A排/A进)q，各汇合段叠加流入本段的实际回油量。每段按保存的内径、长度、粗糙度、K 和油液参数计算沿程 f(L/D)ρu²/2 与局部 Kρu²/2。K 取相应流态和本段平均流速的系数。由油箱向上游逐段叠加压降得到各阀 T 侧压力。',
  '雷诺数 Re=uD/ν。Re≤2300 的有流量工况用层流 f=64/Re，Re≥4000 用 Colebrook，之间按两端摩擦系数线性插值并标为过渡区估算。过渡和湍流取 ε/D≤0.1。瞬态仿真按其独立模型域检查。',
  '使用保存的换向阀有效阀口和串联节流开口，缸容积效率取 1。缸回油腔压力含阀 T 侧压力和本支路排油阀口压降。无物理供油管的路径可按工况给定等效供油损失。',
  parallelFlowConditions[2],
  '按各缸速度在目标 ±1% 内判定达标。零流量表示目标方向未建立通流。超越负载、静态保载、瞬态及压力冲击另验。',
] as const;

export const multiReturnAccessoryConditions = [
  '回油附件限单定量泵、单油箱及普通双作用缸的唯一回油路径。每类最多一只。清洁滤芯 A→B 和流量计可串联在单缸支路、汇合支路或共用干线，单向节流阀限单缸回油支路并配滤芯。',
  '附件流量取其上游各缸的实际排油量之和。先导式溢流阀的双缸专项沿用共用滤芯接法，滤芯按两缸实际排油量之和计流，T 接共用滤芯入口侧时另加实际溢流量。滤芯按 Δp=Δp额定(Q/Q额定)² 计损，超过额定流量时待核。流量计按所在段实际回油量计算 Δp=RQ，实际通流方向另列。附件压降反馈至分流求解，回油基础压力取油箱压力。',
  '双缸共用滤芯可选一条外接物理旁路，或按工况给定滤芯额定压降、开启压差和有效面积核算内置旁通。按两路压降相等与总回油守恒联立分流，按滤芯支路实际流量校核额定值。内外旁通并用、其他环路和先导溢流混接待核。',
] as const;

export const returnThrottleConditions = [
  '单向节流阀限 T 口下游的单缸支路。A→B 按保存的正开口 A、流量系数 Cq 和油液密度 ρ，用实际排油量计算 Δp=ρQ²/[2(CqA)²]，与滤芯、管路压降及各缸分流联立。',
  'B→A 以 pB−pA 为阀压差。主节流口按实际开口计流；只有超过保存开启压差 Δp启，旁通才按有效压差 Δp−Δp启 及旁通面积计流。两条通路压差相等、流量之和等于本缸实际排油。v3 使用独立旁通面积，v2 沿用最大节流面积。节流口关闭且回油无流时，隔离端压与保压待核；动态开度另验。',
] as const;

export interface ParallelFlowTarget {
  readonly componentId: string;
  readonly label: string;
  readonly targetSpeedMPerS: number;
  readonly targetFlowM3PerS: number;
}

export interface ParallelFlowBranch extends ParallelFlowTarget {
  readonly valveId: string;
  readonly valveAreaM2: number;
  readonly inletAreaM2: number;
  readonly valveInletPressurePa?: number;
  readonly inletPressurePa?: number;
  readonly returnBoundaryPa: number;
  readonly startPa?: number;
  readonly resistance?: number;
  readonly flowM3PerS: number;
  readonly speedMPerS: number;
  readonly returnFlowM3PerS: number;
  readonly returnPressurePa: number;
  readonly returnPipe?: ReturnPipeResult;
  readonly status: 'matched' | 'slow' | 'fast' | 'stopped' | 'end-stop';
  readonly closed: boolean;
}

interface ReturnSegmentResult extends ReturnPipeResult {
  readonly cylinderLabels: readonly string[];
  readonly role: string;
  readonly parentId: string | null;
  readonly depth: number;
}

type ReturnAccessoryPlacement = ReturnAccessoryResult & {
  readonly cylinderLabels: readonly string[];
  readonly location: 'branch' | 'junction' | 'trunk';
};

type RoutedPilotRelief = PilotReliefSplitPoint & {
  readonly returnRoute: 'tank' | 'shared-filter';
  readonly returnBranchSegments?: readonly ReturnPipeResult[];
  readonly earlyMerge?: { readonly valveId: string; readonly pipeIds: readonly string[] };
};

type ParallelFlowOutcome =
  | { readonly kind: 'pending'; readonly targets: readonly ParallelFlowTarget[]; readonly reasons: readonly string[] }
  | {
      readonly kind: 'solved';
      readonly pressurePa: number;
      readonly pumpFlowM3PerS: number;
      readonly reliefFlowM3PerS: number;
      readonly shaftPowerW: number;
      readonly pilotRelief?: RoutedPilotRelief;
      readonly matchesTargets: boolean;
      readonly branches: readonly ParallelFlowBranch[];
      readonly reasons: readonly string[];
      readonly divider?: DividerFlowDetails;
      readonly supplySegments?: readonly SupplyPipeResult[];
      readonly workingSegments?: readonly (ReturnPipeResult & { readonly role: string })[];
      readonly returnSegments?: readonly ReturnSegmentResult[];
      readonly returnAccessories?: readonly ReturnAccessoryPlacement[];
      readonly sharedReturn?: ReturnPipeResult & { readonly tankPressurePa: number };
      readonly intermediateReturn?: ReturnPipeResult;
      readonly intermediateReturns?: readonly (ReturnPipeResult & { readonly cylinderLabels: readonly string[] })[];
    };

export type ParallelFlowResult =
  | Extract<ParallelFlowOutcome, { kind: 'pending' }>
  | (Extract<ParallelFlowOutcome, { kind: 'solved' }> & {
      readonly directReturnComparison?: ParallelFlowOutcome;
    });

export interface DividerFlowDetails {
  readonly label: string;
  readonly mode: 'division' | 'combining' | 'correction';
  readonly commonPressurePa: number;
  readonly aShare: number;
  readonly ports: readonly {
    readonly port: 'A' | 'B';
    readonly label: string;
    readonly pressurePa: number;
    readonly flowM3PerS: number;
    readonly dropPa: number;
    readonly limiting: boolean;
  }[];
  readonly correction?: {
    readonly stoppedLabel: string;
    readonly pressureDifferencePa: number;
    readonly thresholdPa: number;
    readonly flowGateM3PerS: number;
    readonly openingWeight: number;
  };
}

export interface ParallelFlowSupply {
  readonly pump: NetworkComponent;
  readonly tank: NetworkComponent;
  readonly tankPressurePa: number;
  readonly flowM3PerS: number;
  readonly totalEfficiency: number;
  readonly pressureBudgetPa: number;
}

const allowed = new Set(['pump', 'tank', 'cylinder', 'valve', 'throttle', 'volume', 'relief']);

function returnAccessoryMixIssue(parts: readonly NetworkComponent[], cylinderCount: number): string | undefined {
  const types = parts.filter(isReturnTreeAccessory).map((part) => part.typeId);
  if (!types.length) return undefined;
  if (new Set(types).size !== types.length)
    return '回油附件实际分流限一只清洁滤芯、一只流量计及一只单向节流阀。同类多件的组合待核。';
  if (parts.some((part) => part.definition.id === 'teaching:pilot-relief') && (cylinderCount !== 2 || types.length > 2))
    return '先导溢流混接限双缸共用回油过滤器，并可配一只支路流量计或单向节流阀。';
  if (types.includes('one-way-throttle') && !types.includes('return-filter'))
    return '单向节流混接要求单缸回油支路上的单向节流阀配一只回油过滤器。';
  return undefined;
}
const supportedValveDefinitions = new Set(['teaching:directional-2-4', 'teaching:directional-3-4']);
const label = (c: NetworkComponent) => c.label || c.id;
const relativeSpeedTolerance = 0.01;
const pressureMax = 70e6;

type TargetAction = {
  readonly componentId: string | undefined;
  readonly direction: string;
  readonly speed: number | null;
  readonly volumetricEfficiency: number | null;
};

export function parallelFlowTargets(
  project: NetworkProject,
  actions: readonly TargetAction[],
): readonly ParallelFlowTarget[] {
  return actions.flatMap((action) => {
    const c = project.design.components.find(
      (component) => component.id === action.componentId && component.typeId === 'cylinder',
    );
    if (
      !c ||
      (action.direction !== 'forward' && action.direction !== 'reverse') ||
      action.speed === null ||
      !(action.speed > 0) ||
      action.volumetricEfficiency === null ||
      !(action.volumetricEfficiency > 0 && action.volumetricEfficiency <= 1)
    )
      return [];
    const area =
      action.direction === 'forward' ? c.parameters.geometry?.capAreaM2 : c.parameters.geometry?.rodSideAreaM2;
    const flow = area === undefined ? NaN : (area * action.speed) / action.volumetricEfficiency;
    return Number.isFinite(flow)
      ? [{ componentId: c.id, label: label(c), targetSpeedMPerS: action.speed, targetFlowM3PerS: flow }]
      : [];
  });
}

export interface BranchLaw {
  readonly target: ParallelFlowTarget;
  readonly valve: NetworkComponent;
  readonly valveAreaM2: number;
  readonly inletArea: number;
  readonly returnBoundaryPa: number;
  readonly areaRatio: number;
  readonly returnResistance: number;
  readonly startPa: number;
  readonly resistance: number;
  readonly closed: boolean;
}

export const orificeFlow = (pressure: number, branch: { startPa: number; resistance: number; closed?: boolean }) =>
  branch.closed ? 0 : Math.sqrt(Math.max(0, pressure - branch.startPa) / branch.resistance);

const branchFailure = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/branch', message)],
});

/** Find the actuator's own valve and the saved series opening in each direction. */
export function meteredLoadPath(
  project: NetworkProject,
  paths: DutyPhasePaths,
  supply: string,
  returnBoundary: string | ReadonlyMap<string, string>,
  actuator: NetworkComponent,
  forward: boolean,
  usedValves: ReadonlySet<string>,
  supplyRoutes?: ReadonlyMap<string, readonly string[]>,
) {
  const issue = (reason: string) => branchFailure(label(actuator) + '：' + reason);
  const inlet = actuator.id + (forward ? ':A' : ':B');
  const outlet = actuator.id + (forward ? ':B' : ':A');
  const feed = paths.uniquePath(supply, inlet);
  if (!feed) return issue('供油通路断开或有并联旁路，缺少明确的阀口分配条件。');
  const inValves = feed.filter((arc) => arc.component?.typeId === 'valve');
  const valve = inValves[0]?.component;
  const tank = typeof returnBoundary === 'string' ? returnBoundary : valve && returnBoundary.get(valve.id);
  const drain = tank === undefined ? null : paths.uniquePath(outlet, tank);
  if (!drain || tank === undefined) return issue('回油通路断开或有并联旁路，缺少明确的阀口分配条件。');
  const outValves = drain.filter((arc) => arc.component?.typeId === 'valve');
  if (
    !valve ||
    inValves.length !== 1 ||
    outValves.length !== 1 ||
    outValves[0]?.component?.id !== valve.id ||
    inValves[0]?.from !== valve.id + ':P' ||
    outValves[0]?.to !== valve.id + ':T' ||
    !(supplyRoutes?.has(valve.id) || paths.idealReachable(supply, valve.id + ':P')) ||
    !paths.idealReachable(valve.id + ':T', tank) ||
    usedValves.has(valve.id)
  )
    return issue(
      '每个执行器须经独立换向阀供回油，阀 P 侧须接' +
        (supplyRoutes ? '已识别的供油通路' : '理想供油干线') +
        '，阀 T 侧须经理想支路接回油边界。',
    );
  const area = valve.parameters.hydraulic?.maximumAreaM2;
  const coefficient = valve.parameters.hydraulic?.flowCoefficient;
  if (!supportedValveDefinitions.has(valve.definition.id) || !area || !coefficient)
    return issue(label(valve) + ' 缺少本模型可识别的工作位有效阀口面积和流量系数。');
  const rho = project.design.fluid.densityKgPerM3;
  let closed = false;
  const resistanceFor = (route: typeof feed) => {
    let resistance = orificeResistance(rho, coefficient, area);
    for (const arc of route) {
      if (arc.ideal || arc.component?.id === valve.id) continue;
      const throttle = arc.component;
      if (throttle?.typeId !== 'throttle') return null;
      const setting = project.design.initialConditions.find((i) => i.componentId === throttle.id);
      const cq = throttle.parameters.hydraulic?.flowCoefficient;
      if (setting?.kind !== 'throttle' || !cq) return null;
      if (setting.openingAreaM2 === 0) closed = true;
      else resistance += orificeResistance(rho, cq, setting.openingAreaM2);
    }
    return resistance;
  };
  // When supply pipes have a separate pressure balance, only meter the path from P onwards here.
  const feedResistance = resistanceFor(
    supplyRoutes ? feed.slice(feed.findIndex((arc) => arc.component?.id === valve.id)) : feed,
  );
  const returnResistance = resistanceFor(drain);
  if (feedResistance === null || returnResistance === null)
    return issue('存在未建模管路压降或节流阀缺少保存开口，不能确定实际分配。');
  return { ok: true as const, value: { valve, area, feedResistance, returnResistance, closed } };
}

export function cylinderBranchLaws(
  project: NetworkProject,
  phase: DutyPhase,
  paths: DutyPhasePaths,
  p: string,
  returnBoundary: string | ReadonlyMap<string, string>,
  tankPressurePa: number,
  supplyRoutes?: ReadonlyMap<string, readonly string[]>,
): Result<readonly BranchLaw[]> {
  const parts = project.design.components;
  const targets = parallelFlowTargets(project, phase.actions);
  const pending = branchFailure;
  const laws: BranchLaw[] = [];
  const usedValves = new Set<string>();
  for (const action of phase.actions) {
    const target = targets.find((entry) => entry.componentId === action.componentId);
    const c = parts.find((part) => part.id === action.componentId);
    if (!target || !c) return pending('油缸目标或有效面积缺失。');
    const issue = (reason: string) => pending(target.label + '：' + reason);
    if (action.volumetricEfficiency !== 1) return issue('需明确泄漏分配，首版实际分流要求缸容积效率为 1。');
    if (action.returnPressurePa < tankPressurePa) return issue('换向阀 T 侧回油背压低于油箱基准，无法按本模型求分流。');
    const forward = action.direction === 'forward';
    const inletArea = forward ? c.parameters.geometry?.capAreaM2 : c.parameters.geometry?.rodSideAreaM2;
    const outletArea = forward ? c.parameters.geometry?.rodSideAreaM2 : c.parameters.geometry?.capAreaM2;
    if (!inletArea || !outletArea) return issue('缺少双作用缸两腔有效面积。');
    const path = meteredLoadPath(project, paths, p, returnBoundary, c, forward, usedValves, supplyRoutes);
    if (!path.ok) return path;
    const { valve, area, feedResistance, returnResistance, closed } = path.value;
    if (supplyRoutes?.get(valve.id)?.length && action.supplyLossPa !== 0)
      return issue('已按物理供油管联立压降，手填供油损失须为零，避免重复计入。');
    usedValves.add(valve.id);
    const areaRatio = outletArea / inletArea;
    const startPa =
      action.resistingLoad / action.mechanicalEfficiency / inletArea +
      areaRatio * action.returnPressurePa +
      action.supplyLossPa;
    const resistance = feedResistance + returnResistance * areaRatio ** 3;
    if (!Number.isFinite(startPa) || !Number.isFinite(resistance) || !(resistance > 0))
      return issue('负载或开口超出有限数值范围。');
    laws.push({
      target,
      valve,
      valveAreaM2: area,
      inletArea,
      returnBoundaryPa: action.returnPressurePa,
      areaRatio,
      returnResistance,
      startPa,
      resistance,
      closed,
    });
  }

  return { ok: true, value: laws };
}

/** Static edit eligibility only. Direction, flows and pressures are verified in the selected duty phase. */
export function steadyDutyPipeEligible(project: NetworkProject, connectionId: string): boolean {
  const parts = project.design.components;
  const pumps = parts.filter((c) => c.typeId === 'pump');
  const tanks = parts.filter((c) => c.typeId === 'tank');
  const valves = parts.filter((c) => c.typeId === 'valve');
  const [pump] = pumps;
  const [tank] = tanks;
  if (
    pumps.length !== 1 ||
    pump?.definition.id !== 'teaching:pump' ||
    tanks.length !== 1 ||
    !tank ||
    valves.length < 2 ||
    valves.length > returnTreeLimits.cylinders ||
    parts.filter((c) => c.typeId === 'cylinder').length !== valves.length ||
    parts.some((c) => !allowed.has(c.typeId) && !isReturnTreeAccessory(c)) ||
    returnAccessoryMixIssue(parts, valves.length) !== undefined ||
    valves.some((c) => !supportedValveDefinitions.has(c.definition.id))
  )
    return false;
  const phase = dutyPhasePaths(project, { name: '回油干线', valves: [], actions: [] }, false, true);
  if (!phase.ok) return false;
  const paths = phase.value;
  const tankPort = tank.id + ':T';
  const pilot = parts.find((part) => part.definition.id === 'teaching:pilot-relief');
  const supply = findSupplyPipeTopology(project, paths, pump);
  if (!supply.ok || !paths.idealReachable(pump.id + ':S', tankPort)) return false;
  const supplySegment = supply.value?.segments.find(({ id }) => id === connectionId);
  if (supplySegment) return supplySegment.parameters.ok;
  const supplyIds = new Set(supply.value?.segments.map(({ id }) => id));
  const filter = parts.find((part) => part.typeId === 'return-filter');
  const pilotRoute = pilot && filter ? findPilotReturnRoute(project, paths, pilot, filter, tankPort) : undefined;
  const pilotPipes = pilotRoute?.ok && pilotRoute.value.kind === 'shared-filter' ? pilotRoute.value.branches : [];
  const topology = findReturnTopology(project, paths, tankPort, pilotPipes, supplyIds);
  if (!topology.ok) return false;
  const segment = topology.value?.segments.find(({ key }) => key === 'pipe:' + connectionId);
  const branch = topology.value?.dedicatedPilotPipes.find((pipe) => pipe.id === connectionId);
  const bypass = topology.value?.segments.find(
    ({ element }) => element.kind === 'accessory' && element.bypass?.id === connectionId,
  )?.element;
  if (
    (branch || topology.value?.earlyPilotMerge?.pipeIds.includes(connectionId)) &&
    (!pilot ||
      parts.filter((part) => part.typeId === 'relief').length !== 1 ||
      pump.parameters.relief?.enabled === 1 ||
      !paths.uniquePath(pump.id + ':P', pilot.id + ':P')?.every((arc) => arc.ideal))
  )
    return false;
  if (branch) {
    if (!pipeParameters(project, branch, '溢流阀 T 口支管').ok) return false;
  } else if (bypass?.kind === 'accessory') {
    if (!returnAccessoryParameters(project, bypass.component, bypass.forward, bypass.bypass).ok) return false;
  } else if (segment?.element.kind !== 'pipe' || !pipeParameters(project, segment.element.pipe, segment.role).ok)
    return false;
  return supply.value !== null || valves.every((valve) => paths.idealReachable(valve.id + ':P', pump.id + ':P'));
}

export const sharedReturnPipeEligible = steadyDutyPipeEligible;

interface SplitPoint {
  readonly pressurePa: number;
  readonly reliefFlowM3PerS: number;
  readonly pilotRelief?: RoutedPilotRelief;
  readonly returnFlows?: readonly number[];
  readonly branches: readonly { readonly law: BranchLaw; readonly flowM3PerS: number }[];
}

function balance(low: number, high: number, residual: (value: number) => number): number {
  for (let i = 0; i < 64; i++) {
    const mid = low + (high - low) / 2;
    if (mid === low || mid === high) break;
    if (residual(mid) < 0) low = mid;
    else high = mid;
  }
  return low + (high - low) / 2;
}

export function solveParallelCylinderFlow(
  project: NetworkProject,
  phase: DutyPhase,
  supply: ParallelFlowSupply,
): ParallelFlowResult {
  const actual = solveParallelCylinderPoint(project, phase, supply, 'connected');
  if (actual.kind !== 'solved' || actual.pilotRelief?.returnRoute !== 'shared-filter' || actual.pilotRelief.earlyMerge)
    return actual;
  const count = actual.pilotRelief.returnBranchSegments?.length ?? 0;
  const reference = count ? { keepPipes: count - 1 } : 'tank-reference';
  return { ...actual, directReturnComparison: solveParallelCylinderPoint(project, phase, supply, reference) };
}

/** Bounded steady active-set solve for independent directional valve and cylinder branches. */
function solveParallelCylinderPoint(
  project: NetworkProject,
  phase: DutyPhase,
  supply: ParallelFlowSupply,
  connection: 'connected' | 'tank-reference' | { readonly keepPipes: number },
): ParallelFlowOutcome {
  const { pump, tank, tankPressurePa, flowM3PerS: pumpFlow } = supply;
  const targets = parallelFlowTargets(project, phase.actions);
  const pending = (reason: string): ParallelFlowResult => ({ kind: 'pending', targets, reasons: [reason] });
  const parts = project.design.components;
  const count = parts.filter((c) => c.typeId === 'cylinder').length;
  if (
    count < 2 ||
    count > returnTreeLimits.cylinders ||
    phase.actions.length < 2 ||
    phase.actions.length > count ||
    targets.length !== phase.actions.length ||
    parts.filter((c) => c.typeId === 'valve').length !== count
  )
    return pending(
      '实际分流需要 2 至 ' + returnTreeLimits.cylinders + ' 只普通双作用缸同时参与，每缸各用一只四通换向阀。',
    );
  if (pump.definition.id === 'teaching:variable-pump' || !Number.isFinite(pumpFlow) || !(pumpFlow > 0))
    return pending('需要可确认的定量泵和有效供流，变量泵的调节规律未纳入。');
  const unmodeled = parts.filter((c) => !allowed.has(c.typeId) && !isReturnTreeAccessory(c));
  if (unmodeled.length) return pending('缺少分流模型的元件：' + unmodeled.map(label).join('、') + '。');
  const accessoryIssue = returnAccessoryMixIssue(parts, count);
  if (accessoryIssue) return pending(accessoryIssue);
  const checked = dutyPhasePaths(project, phase, false, true);
  if (!checked.ok) return pending(checked.diagnostics.map((d) => d.message).join('；'));
  const paths = checked.value;
  const p = pump.id + ':P',
    t = tank.id + ':T';
  if (!paths.idealReachable(t, pump.id + ':S') || !paths.uniquePath(t, pump.id + ':S') || paths.reachable(p, t))
    return pending('需明确理想吸油路径，且公共供油和油箱之间不能有未建模的卸荷或短接。');
  const connectedIdleCylinder = parts.find(
    (part) =>
      part.typeId === 'cylinder' &&
      !phase.actions.some((action) => action.componentId === part.id) &&
      (paths.reachable(p, part.id + ':A') || paths.reachable(p, part.id + ':B')),
  );
  if (connectedIdleCylinder) return pending(label(connectedIdleCylinder) + ' 接通供油但未列入动作，需求不完整。');
  const externalReliefs = parts.filter((part) => part.typeId === 'relief');
  const pilotValve = externalReliefs.find((part) => part.definition.id === 'teaching:pilot-relief');
  const internal = pump.parameters.relief;
  let pilotLaw: PilotReliefLaw | undefined;
  let pilotReturn: PilotReturnRoute | undefined;
  if (pilotValve) {
    const name = label(pilotValve) + ' [' + pilotValve.id + ']';
    const filter = parts.find((part) => part.typeId === 'return-filter');
    if (count !== 2 || !filter) return pending(name + ' 的先导溢流分配限单泵双缸共用回油滤芯。');
    if (externalReliefs.length !== 1 || internal?.enabled === 1)
      return pending(name + ' 与其他溢流阀并用时，本批先导溢流分配待核。');
    const feed = paths.uniquePath(p, pilotValve.id + ':P');
    if (!feed?.every((arc) => arc.ideal)) return pending(name + ' 的 P 口须经唯一理想通路接供油母线，供油端压力待核。');
    const route = findPilotReturnRoute(project, paths, pilotValve, filter, t);
    if (!route.ok) return pending(route.diagnostics.map((item) => item.message).join('；'));
    pilotReturn = route.value;
    const pilot = pilotReliefLaw(pilotValve, project.design.fluid.densityKgPerM3);
    if (!pilot.ok) return pending(pilot.diagnostics.map((item) => item.message).join('；'));
    pilotLaw = pilot.value;
  }
  const pilotPipes = pilotReturn?.kind === 'shared-filter' ? pilotReturn.branches : [];
  const pilotFilterKey =
    pilotReturn?.kind === 'shared-filter' && connection !== 'tank-reference' ? pilotReturn.filterKey : undefined;
  const supplyTopologyResult = findSupplyPipeTopology(project, paths, pump);
  if (!supplyTopologyResult.ok)
    return { kind: 'pending', targets, reasons: supplyTopologyResult.diagnostics.map((item) => item.message) };
  const supplyTopology = supplyTopologyResult.value;
  const supplyIds = new Set(supplyTopology?.segments.map(({ id }) => id));
  const topologyResult = findReturnTopology(project, paths, t, pilotPipes, supplyIds);
  if (!topologyResult.ok) return pending(topologyResult.diagnostics.map((d) => d.message).join('；'));
  const topology = topologyResult.value;
  const bypass = phase.filterBypass;
  if (bypass) {
    const segment = topology?.segments.find(
      ({ element }) => element.kind === 'accessory' && element.component.id === bypass.componentId,
    );
    if (
      count !== 2 ||
      phase.actions.length !== 2 ||
      pilotValve ||
      !segment ||
      segment.element.kind !== 'accessory' ||
      segment.element.component.typeId !== 'return-filter' ||
      segment.element.bypass ||
      segment.valves.size !== 2
    )
      return pending('内置旁通限双缸同时动作且共用指定滤芯，不支持外接旁路或先导式溢流混接。');
  }
  if ((topology || supplyTopology) && phase.actions.some((a) => Math.abs(a.returnPressurePa - tankPressurePa) > 1e-6))
    return pending('共用回油干线的回油基准须等于油箱压力。请移除手填的回油管段压降，以免重复计入。');
  const boundary = topology ? new Map([...topology.routes.keys()].map((valve) => [valve, valve + ':T'])) : t;
  const result = cylinderBranchLaws(project, phase, paths, p, boundary, tankPressurePa, supplyTopology?.routes);
  if (!result.ok) return pending(result.diagnostics.map((d) => d.message).join('；'));
  const laws = result.value;
  const rho = project.design.fluid.densityKgPerM3;
  const reliefs: { startPa: number; resistance: number }[] = [];
  for (const valve of externalReliefs) {
    if (valve === pilotValve) continue;
    const h = valve.parameters.hydraulic;
    if (
      valve.definition.id !== 'teaching:relief' ||
      !paths.idealReachable(p, valve.id + ':P') ||
      !paths.idealReachable(valve.id + ':T', t) ||
      !h?.maximumAreaM2 ||
      !h.flowCoefficient ||
      h.settingDifferentialPa === undefined
    )
      return pending(label(valve) + ' 缺少可核算的直动溢流条件，须在泵口取压并直回同一油箱。');
    reliefs.push({
      startPa: tankPressurePa + h.settingDifferentialPa,
      resistance: orificeResistance(rho, h.flowCoefficient, h.maximumAreaM2),
    });
  }
  if (internal?.enabled === 1) {
    if (!internal.maximumAreaM2 || !internal.flowCoefficient || internal.settingDifferentialPa === undefined)
      return pending('泵内置溢流缺少设定、面积或流量系数。');
    reliefs.push({
      startPa: tankPressurePa + internal.settingDifferentialPa,
      resistance: orificeResistance(rho, internal.flowCoefficient, internal.maximumAreaM2),
    });
  }
  const reliefFlowAt = (pressure: number) => reliefs.reduce((sum, branch) => sum + orificeFlow(pressure, branch), 0);
  let point: SplitPoint | null = null;
  const segmentLaws: (ReturnPipeLaw | ReturnAccessoryLaw)[] = [];
  const segmentIndices = new Map<string, number>();
  if (topology || supplyTopology) {
    const dedicatedBranches = topology?.dedicatedPilotPipes ?? [];
    const earlyMerge = topology?.earlyPilotMerge;
    const issues: string[] = [];
    for (const segment of topology?.segments ?? []) {
      const { element } = segment;
      const law =
        element.kind === 'pipe'
          ? pipeParameters(project, element.pipe, segment.role)
          : returnAccessoryParameters(
              project,
              element.component,
              element.forward,
              element.bypass,
              bypass?.componentId === element.component.id ? bypass : undefined,
            );
      if (law.ok) {
        segmentIndices.set(segment.key, segmentLaws.length);
        segmentLaws.push(law.value);
      } else {
        issues.push(...law.diagnostics.map((d) => d.message));
      }
    }
    const pilotBranches: { law: ReturnPipeLaw; index: number }[] = [];
    // In the reference, replace the last physical pipe with an ideal connection.
    const includedBranches =
      connection === 'connected'
        ? dedicatedBranches
        : typeof connection === 'object'
          ? dedicatedBranches.slice(0, connection.keepPipes)
          : [];
    for (const [index, pipe] of includedBranches.entries()) {
      const role = '溢流阀 T 口支管' + (includedBranches.length > 1 ? '第 ' + (index + 1) + ' 段' : '');
      const branchLaw = pipeParameters(project, pipe, role);
      if (branchLaw.ok) {
        pilotBranches.push({ law: branchLaw.value, index: segmentLaws.length });
        segmentLaws.push(branchLaw.value);
      } else issues.push(...branchLaw.diagnostics.map((item) => item.message));
    }
    const supplyIndices = new Map<string, number>();
    for (const { id, parameters } of supplyTopology?.segments ?? []) {
      if (parameters.ok) {
        supplyIndices.set(id, segmentLaws.length);
        segmentLaws.push(parameters.value);
      } else issues.push(...parameters.diagnostics.map((item) => item.message));
    }
    if (issues.length) return { kind: 'pending', targets, reasons: issues };
    const active = laws.filter((law) => !law.closed);
    const demands: ReturnDemand[] = [];
    for (const law of active) {
      const segments = [];
      for (const id of topology?.routes.get(law.valve.id) ?? []) {
        const index = segmentIndices.get(id);
        if (index === undefined) return pending('回油段 [' + id + '] 未建立计算索引。');
        segments.push(index);
      }
      const supplySegments: number[] = [];
      for (const id of supplyTopology?.routes.get(law.valve.id) ?? []) {
        const index = supplyIndices.get(id);
        if (index === undefined) return pending('供油管 [' + id + '] 未建立计算索引。');
        supplySegments.push(index);
      }
      demands.push({ ...law, segments, ...(supplySegments.length ? { supplySegments } : {}) });
    }
    demands.push(...reliefs.map((relief) => ({ ...relief, areaRatio: 0, segments: [] })));
    const pilotSegments: number[] = [];
    if (pilotFilterKey !== undefined) {
      const sharedRoute = topology && [...topology.routes.values()].find((route) => route.includes(pilotFilterKey));
      if (!sharedRoute) return pending('溢流阀 T 口未接入两缸共用滤芯通路，先导参考背压待核。');
      const mixedKeys = earlyMerge?.pipeIds.map((id) => 'pipe:' + id) ?? [];
      for (const key of [...mixedKeys, ...sharedRoute.slice(sharedRoute.indexOf(pilotFilterKey))]) {
        const index = segmentIndices.get(key);
        if (index === undefined) return pending('溢流回油段 [' + key + '] 未建立计算索引。');
        pilotSegments.push(index);
      }
    }
    if (pilotLaw)
      demands.push({
        pressureAtFlow: (flow) => tankPressurePa + pilotLaw.differentialAtFlow(flow),
        areaRatio: 1,
        segments: [...pilotSegments, ...pilotBranches.map(({ index }) => index)],
      });
    const losses = segmentLaws.map((law) =>
      'connectionId' in law
        ? (q: number) => returnPipeLoss(law, q).pressureDropPa
        : (q: number) => seriesAccessoryDrop(law, q),
    );
    const actual = solveReturnNetwork(losses, demands, pumpFlow);
    if (actual) {
      const flowByValve = new Map(active.map((law, i) => [law.valve.id, actual.flows[i]]));
      const reliefFlowM3PerS = actual.flows.slice(active.length).reduce((sum, q) => sum + q, 0);
      const pilotJunctionPa = pilotSegments.reduce((pressure, index) => {
        const loss = losses[index];
        const flow = actual.returnFlows[index];
        return loss === undefined || flow === undefined ? NaN : pressure + loss(flow);
      }, tankPressurePa);
      let pilotReturnPa = pilotJunctionPa;
      const returnBranchSegments: ReturnPipeResult[] = [];
      for (const { law, index } of [...pilotBranches].reverse()) {
        const flow = actual.returnFlows[index];
        if (flow === undefined) return pending('溢流阀 T 口支管 [' + law.connectionId + '] 实际流量待核。');
        const branch = reportReturnPipe(law, flow, pilotReturnPa);
        if (!branch.ok) return pending(branch.diagnostics.map((item) => item.message).join('；'));
        pilotReturnPa = branch.value.upstreamPressurePa;
        returnBranchSegments.unshift(branch.value);
      }
      const pilotBoundary = pilotLaw && pilotReturnPa + pilotLaw.differentialAtFlow(reliefFlowM3PerS);
      // Use the relief's pressure equality for a flowing valve, and its
      // opening inequality when idle. This avoids rounding across cracking.
      const pressurePa =
        pilotBoundary === undefined
          ? actual.pressurePa
          : reliefFlowM3PerS > 0
            ? pilotBoundary
            : Math.min(actual.pressurePa, pilotBoundary);
      const pilotRelief = pilotLaw?.atPressure(pressurePa, pilotReturnPa);
      if (
        pilotRelief &&
        (!Number.isFinite(pilotRelief.totalFlowM3PerS) ||
          Math.abs(pilotRelief.totalFlowM3PerS - reliefFlowM3PerS) > pumpFlow * 1e-8 ||
          Math.abs(pressurePa - actual.pressurePa) > Math.max(1, pressurePa) * 1e-8)
      )
        return pending(pilotRelief.label + ' 的先导与主阀回箱流量未能通过联立残差校核。');
      point = {
        pressurePa,
        reliefFlowM3PerS: pilotRelief?.totalFlowM3PerS ?? reliefFlowM3PerS,
        ...(pilotRelief
          ? {
              pilotRelief: {
                ...pilotRelief,
                returnRoute: pilotFilterKey === undefined ? 'tank' : 'shared-filter',
                ...(returnBranchSegments.length ? { returnBranchSegments } : {}),
                ...(earlyMerge ? { earlyMerge } : {}),
              },
            }
          : {}),
        returnFlows: actual.returnFlows,
        branches: laws.map((law) => ({ law, flowM3PerS: law.closed ? 0 : (flowByValve.get(law.valve.id) ?? NaN) })),
      };
    }
  } else {
    const total = (pressure: number) =>
      laws.reduce((sum, branch) => sum + orificeFlow(pressure, branch), reliefFlowAt(pressure));
    if (total(tankPressurePa) <= pumpFlow && total(pressureMax) >= pumpFlow) {
      const pressurePa = balance(tankPressurePa, pressureMax, (p) => total(p) - pumpFlow);
      point = {
        pressurePa,
        reliefFlowM3PerS: reliefFlowAt(pressurePa),
        branches: laws.map((law) => ({ law, flowM3PerS: orificeFlow(pressurePa, law) })),
      };
    }
  }
  if (
    !point ||
    !Number.isFinite(point.pressurePa) ||
    point.pressurePa < tankPressurePa ||
    point.pressurePa > pressureMax
  )
    return pending('在油箱压力至 70 MPa 的模型范围内，支路与溢流未找到可核对的稳态平衡。');
  const { pressurePa, reliefFlowM3PerS } = point;
  const totalFlow = point.branches.reduce((sum, branch) => sum + branch.flowM3PerS, reliefFlowM3PerS);
  if (!Number.isFinite(totalFlow) || Math.abs(totalFlow - pumpFlow) > pumpFlow * 1e-8)
    return pending('在当前数值范围内未能核对泵与支路流量守恒，保留已知目标量。');

  const supplyReports =
    supplyTopology &&
    reportSupplyPipes(
      supplyTopology,
      point.branches.map(({ law, flowM3PerS }) => ({ valveId: law.valve.id, label: law.target.label, flowM3PerS })),
      pressurePa,
    );
  if (supplyReports && !supplyReports.ok)
    return { kind: 'pending', targets, reasons: supplyReports.diagnostics.map((item) => item.message) };

  const branches: ParallelFlowBranch[] = [];
  const segmentResults = new Map<
    string,
    (ReturnPipeResult | ReturnAccessoryResult) & { readonly cylinderLabels: readonly string[] }
  >();
  const returnSegments: ReturnSegmentResult[] = [];
  const returnAccessories: ReturnAccessoryPlacement[] = [];
  for (const segment of [...(topology?.segments ?? [])].sort((a, b) => a.depth - b.depth)) {
    const { key, element, parentId, valves, depth, role } = segment;
    const members = point.branches.filter((branch) => valves.has(branch.law.valve.id));
    const downstreamPa = parentId === null ? tankPressurePa : segmentResults.get(parentId)?.upstreamPressurePa;
    const lawIndex = segmentIndices.get(key);
    const law = lawIndex === undefined ? undefined : segmentLaws[lawIndex];
    const flow = lawIndex === undefined ? undefined : point.returnFlows?.[lawIndex];
    if (!law || downstreamPa === undefined || flow === undefined)
      return pending('回油段 [' + element.id + '] 的参数、流量或下游端压待核。');
    const actual =
      'connectionId' in law
        ? reportReturnPipe(law, flow, downstreamPa)
        : reportReturnAccessory(law, flow, downstreamPa);
    if (!actual.ok) return pending(actual.diagnostics.map((d) => d.message).join('；'));
    const cylinderLabels = members.map(({ law }) => law.target.label);
    segmentResults.set(key, { ...actual.value, cylinderLabels });
    if ('connectionId' in actual.value)
      returnSegments.push({
        ...actual.value,
        cylinderLabels,
        parentId: parentId === null ? null : parentId.slice(parentId.indexOf(':') + 1),
        depth,
        role,
      });
    else
      returnAccessories.push({
        ...actual.value,
        cylinderLabels,
        location: valves.size === topology?.routes.size ? 'trunk' : valves.size === 1 ? 'branch' : 'junction',
      });
  }
  for (const { law: branch, flowM3PerS } of point.branches) {
    const returnFlowM3PerS = flowM3PerS * branch.areaRatio;
    const first = topology?.routes.get(branch.valve.id)?.[0];
    const nearest = first === undefined ? undefined : segmentResults.get(first);
    const branchDrop = nearest ? nearest.upstreamPressurePa - tankPressurePa : 0;
    const returnBoundaryPa = branch.returnBoundaryPa + branchDrop;
    const startPa = branch.startPa + branch.areaRatio * branchDrop;
    const lastSupply = supplyTopology?.routes.get(branch.valve.id)?.at(-1);
    const valveInletPressurePa =
      lastSupply === undefined ? pressurePa : supplyReports?.value.get(lastSupply)?.downstreamPressurePa;
    if (valveInletPressurePa === undefined || valveInletPressurePa < 0)
      return pending(branch.target.label + ' 的阀 P 口压力超出供油侧核算范围。');
    if ((topology || supplyTopology) && !branch.closed) {
      const difference = valveInletPressurePa - (startPa + branch.resistance * flowM3PerS ** 2);
      const residual = flowM3PerS > 0 ? Math.abs(difference) : Math.max(0, difference);
      if (!Number.isFinite(residual) || residual > Math.max(1, pressurePa) * 1e-8)
        return pending(branch.target.label + ' 的阀口与管段压力平衡待核。');
    }
    const speedMPerS = flowM3PerS / branch.inletArea;
    const ratio = speedMPerS / branch.target.targetSpeedMPerS;
    const status =
      flowM3PerS === 0
        ? 'stopped'
        : ratio < 1 - relativeSpeedTolerance
          ? 'slow'
          : ratio > 1 + relativeSpeedTolerance
            ? 'fast'
            : 'matched';
    branches.push({
      ...branch.target,
      valveId: branch.valve.id,
      valveAreaM2: branch.valveAreaM2,
      inletAreaM2: branch.inletArea,
      startPa,
      resistance: branch.resistance,
      returnBoundaryPa,
      ...(supplyTopology ? { valveInletPressurePa } : {}),
      flowM3PerS,
      speedMPerS,
      status,
      closed: branch.closed,
      returnFlowM3PerS,
      returnPressurePa: returnBoundaryPa + branch.returnResistance * returnFlowM3PerS ** 2,
      ...(nearest?.cylinderLabels.length === 1 && 'connectionId' in nearest ? { returnPipe: nearest } : {}),
    });
  }
  const trunk = returnSegments.find((segment) => segment.role === '回油干线');
  const intermediateReturns = returnSegments
    .filter((segment) => segment !== trunk && segment.cylinderLabels.length > 1)
    .sort((a, b) => b.depth - a.depth);
  const reasons: string[] = [];
  const targetFlow = targets.reduce((sum, branch) => sum + branch.targetFlowM3PerS, 0);
  const display = (value: number) => Number((value * 60000).toPrecision(6));
  if (pumpFlow < targetFlow * (1 - 1e-10))
    reasons.push(`总供流不足，泵供流 ${display(pumpFlow)} L/min，目标合计 ${display(targetFlow)} L/min。`);
  if (reliefFlowM3PerS > pumpFlow * 1e-10)
    reasons.push(
      `${point.pilotRelief ? '先导式溢流阀' : '直动溢流'}分走 ${display(reliefFlowM3PerS)} L/min，剩余流量参与缸支路分配。`,
    );
  if (pressurePa > supply.pressureBudgetPa)
    reasons.push(`实际分流点超过试算预算 ${Number((supply.pressureBudgetPa / 1e6).toPrecision(6))} MPa。`);
  if (branches.some((b) => b.status !== 'matched'))
    reasons.push('当前负载、开口和回油背压下，各缸不能同时达到目标速度。');
  const shaftPowerW = ((pressurePa - tankPressurePa) * pumpFlow) / supply.totalEfficiency;
  if (
    !Number.isFinite(shaftPowerW) ||
    branches.some(
      (b) => !Number.isFinite(b.returnPressurePa) || b.returnPressurePa > pressureMax || !Number.isFinite(b.speedMPerS),
    )
  )
    return pending('结果超出有限压力、速度或功率范围。');
  return {
    kind: 'solved',
    pressurePa,
    pumpFlowM3PerS: pumpFlow,
    reliefFlowM3PerS,
    shaftPowerW,
    ...(point.pilotRelief ? { pilotRelief: point.pilotRelief } : {}),
    branches,
    reasons,
    ...(supplyReports ? { supplySegments: [...supplyReports.value.values()] } : {}),
    ...(returnSegments.length ? { returnSegments } : {}),
    ...(returnAccessories.length ? { returnAccessories } : {}),
    ...(trunk ? { sharedReturn: { ...trunk, tankPressurePa } } : {}),
    ...(intermediateReturns.length > 1 || (count > 3 && intermediateReturns.length)
      ? { intermediateReturns }
      : intermediateReturns[0]
        ? { intermediateReturn: intermediateReturns[0] }
        : {}),
    matchesTargets: pressurePa <= supply.pressureBudgetPa && branches.every((b) => b.status === 'matched'),
  };
}
