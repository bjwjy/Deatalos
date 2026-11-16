import {
  darcyFrictionFactor,
  diagnostic,
  limits,
  type NetworkComponent,
  type NetworkConnection,
  type NetworkEndpoint,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';

type Pipe = Extract<NetworkConnection, { kind: 'pipe' }>;

export interface ReturnPipeLaw {
  readonly connectionId: string;
  readonly lengthM: number;
  readonly diameterM: number;
  readonly densityKgPerM3: number;
  readonly kinematicViscosityM2PerS: number;
  readonly roughnessM: number;
  readonly localLossCoefficient: number;
}

export interface ReturnPipeResult extends ReturnPipeLaw {
  readonly flowM3PerS: number;
  readonly pressureDropPa: number;
  readonly upstreamPressurePa: number;
  readonly downstreamPressurePa: number;
  readonly reynolds: number;
  readonly regime: ReturnType<typeof darcyFrictionFactor>['regime'];
  readonly frictionFactor?: number;
  readonly velocityMPerS: number;
  readonly frictionDropPa: number;
  readonly localDropPa: number;
}

type ReturnElement =
  | { readonly kind: 'pipe'; readonly id: string; readonly pipe: Pipe }
  | {
      readonly kind: 'accessory';
      readonly id: string;
      readonly component: NetworkComponent;
      readonly forward: boolean;
      readonly bypass?: Pipe;
    };

interface ReturnSegment {
  readonly key: string;
  readonly element: ReturnElement;
  readonly parentId: string | null;
  readonly depth: number;
  readonly valves: ReadonlySet<string>;
  readonly role: string;
}

type ReturnTopology = {
  readonly segments: readonly ReturnSegment[];
  readonly routes: ReadonlyMap<string, readonly string[]>;
  readonly dedicatedPilotPipes: readonly Pipe[];
  readonly earlyPilotMerge?: { readonly valveId: string; readonly pipeIds: readonly string[] };
};

export const returnTreeLimits = Object.freeze({
  cylinders: Math.floor((limits.components - 2) / 2),
  connections: limits.connections,
});

const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/sharedReturn', message)],
});

const endpointKey = (endpoint: NetworkEndpoint) =>
  endpoint.kind === 'node' ? 'node:' + endpoint.nodeId : endpoint.componentId + ':' + endpoint.portId;

export type PilotReturnRoute =
  | { readonly kind: 'tank' }
  | { readonly kind: 'shared-filter'; readonly filterKey: string; readonly branches: readonly Pipe[] };

/** Trace the physical pipes on the pilot path before the shared filter. */
export function findPilotReturnRoute(
  project: NetworkProject,
  paths: DutyPhasePaths,
  pilot: NetworkComponent,
  filter: NetworkComponent,
  tankPort: string,
): Result<PilotReturnRoute> {
  const name = (pilot.label || pilot.id) + ' [' + pilot.id + ']';
  const route = paths.uniquePath(pilot.id + ':T', tankPort);
  if (!route) return fail(name + ' 的 T 口至油箱通路不唯一或断开，先导参考背压待核。');
  if (route.every((arc) => arc.ideal)) return { ok: true, value: { kind: 'tank' } };
  const filterArc = route.findIndex((arc) => arc.component?.id === filter.id && arc.from === filter.id + ':A');
  const beforeFilter = route.slice(0, filterArc).filter((arc) => !arc.ideal);
  if (filterArc < 0 || beforeFilter.some((arc) => !arc.physicalPipe))
    return fail(name + ' 的 T 口须直回油箱，或经串联物理管接共用滤芯入口。其他回油接法的先导参考背压待核。');
  const branches: Pipe[] = [];
  for (const [index, branchArc] of beforeFilter.entries()) {
    const branch = project.design.connections.find((edge) => {
      if (edge.kind !== 'pipe') return false;
      const from = endpointKey(edge.from);
      const to = endpointKey(edge.to);
      return (from === branchArc.from && to === branchArc.to) || (from === branchArc.to && to === branchArc.from);
    });
    if (!branch || branch.kind !== 'pipe') return fail(name + ' 的 T 口回油支管第 ' + (index + 1) + ' 段未能识别。');
    branches.push(branch);
  }
  return { ok: true, value: { kind: 'shared-filter', filterKey: 'accessory:' + filter.id, branches } };
}

export const isReturnTreeAccessory = (component: NetworkComponent): boolean =>
  component.typeId === 'flow-meter' || component.typeId === 'return-filter' || component.typeId === 'one-way-throttle';

export const orificeResistance = (density: number, coefficient: number, area: number) =>
  density / (2 * (coefficient * area) ** 2);

export interface DutyFilterBypassSetting {
  readonly componentId: string;
  readonly ratedDropPa: number;
  readonly crackingPressurePa: number;
  readonly effectiveAreaM2: number;
}

interface FilterLoss {
  readonly kind: 'filter';
  readonly ratedFlowM3PerS: number;
  readonly ratedDropPa: number;
  readonly bypassPipe?: ReturnPipeLaw;
  readonly internalBypass?: DutyFilterBypassSetting & { readonly resistance: number };
}

type SeriesAccessoryLoss =
  | FilterLoss
  | { readonly kind: 'meter'; readonly resistancePaSPerM3: number }
  | {
      readonly kind: 'one-way-throttle';
      readonly openingAreaM2: number;
      readonly flowCoefficient: number;
      readonly densityKgPerM3: number;
    }
  | ReverseThrottleLaw;

interface ReverseThrottleLaw {
  readonly kind: 'reverse-throttle';
  readonly openingAreaM2: number;
  readonly bypassAreaM2: number;
  readonly crackingPressurePa: number;
  readonly flowCoefficient: number;
  readonly densityKgPerM3: number;
  readonly meterResistance: number | null;
  readonly bypassResistance: number;
}

interface AccessoryIdentity {
  readonly componentId: string;
  readonly label: string;
  readonly forward: boolean;
}

export type ReturnAccessoryLaw = AccessoryIdentity & SeriesAccessoryLoss;

interface ReverseThrottlePoint {
  readonly pressureDropPa: number;
  readonly meterFlowM3PerS: number;
  readonly bypassFlowM3PerS: number;
  readonly bypassState: 'open' | 'closed';
}

export type ReturnAccessoryResult = AccessoryIdentity & {
  readonly flowM3PerS: number;
  readonly pressureDropPa: number;
  readonly upstreamPressurePa: number;
  readonly downstreamPressurePa: number;
  readonly parallelBypass?: { readonly totalFlowM3PerS: number; readonly pipe: ReturnPipeResult };
  readonly builtInBypass?: {
    readonly totalFlowM3PerS: number;
    readonly flowM3PerS: number;
    readonly state: 'open' | 'closed';
    readonly crackingPressurePa: number;
    readonly effectiveAreaM2: number;
  };
} & (Exclude<SeriesAccessoryLoss, ReverseThrottleLaw> | (ReverseThrottleLaw & ReverseThrottlePoint));

// Invert the parallel orifices by bracketing bypass flow, so subtracting
// nearly equal pressures near cracking cannot erase the bypass flow.
function reverseThrottlePoint(
  law: Pick<ReverseThrottleLaw, 'meterResistance' | 'bypassResistance' | 'crackingPressurePa'>,
  flow: number,
): ReverseThrottlePoint {
  const { meterResistance, bypassResistance, crackingPressurePa } = law;
  if (meterResistance === null)
    return {
      // At zero this is the right limit for the flow solver, not a measured port pressure.
      pressureDropPa: crackingPressurePa + bypassResistance * flow ** 2,
      meterFlowM3PerS: 0,
      bypassFlowM3PerS: flow,
      bypassState: flow > 0 ? 'open' : 'closed',
    };
  const meterAtCrack = Math.sqrt(crackingPressurePa / meterResistance);
  if (flow <= meterAtCrack)
    return {
      pressureDropPa: meterResistance * flow ** 2,
      meterFlowM3PerS: flow,
      bypassFlowM3PerS: 0,
      bypassState: 'closed',
    };

  const ratio = Math.sqrt(bypassResistance / meterResistance);
  let low = 0;
  let high = flow - meterAtCrack;
  if (crackingPressurePa === 0) low = high = flow / (1 + ratio);
  else
    for (let iteration = 0; iteration < 52; iteration++) {
      const mid = low + (high - low) / 2;
      if (mid === low || mid === high) break;
      if (mid + Math.hypot(meterAtCrack, ratio * mid) < flow) low = mid;
      else high = mid;
    }
  const bypassFlowM3PerS = low + (high - low) / 2;
  return {
    pressureDropPa: crackingPressurePa + bypassResistance * bypassFlowM3PerS ** 2,
    meterFlowM3PerS: Math.hypot(meterAtCrack, ratio * bypassFlowM3PerS),
    bypassFlowM3PerS,
    bypassState: 'open',
  };
}

export function returnAccessoryParameters(
  project: NetworkProject,
  component: NetworkComponent,
  forward: boolean,
  bypass?: Pipe,
  internalBypass?: DutyFilterBypassSetting,
): Result<ReturnAccessoryLaw> {
  const { id: componentId, typeId } = component;
  const label = component.label || componentId;
  const name = label + ' [' + componentId + ']';
  const h = component.parameters.hydraulic;
  if (typeId === 'return-filter') {
    if (!forward) return fail(name + ' 仅支持清洁滤芯 A→B 回油，反接待核。');
    const ratedFlowM3PerS = h?.filterRatedFlowM3PerS;
    const ratedDropPa = h?.filterRatedDropPa;
    if (ratedFlowM3PerS === undefined || !(ratedFlowM3PerS > 0) || ratedDropPa === undefined || !(ratedDropPa >= 0))
      return fail(name + ' 缺少有效清洁滤芯额定流量或额定压降。');
    if (
      internalBypass &&
      (bypass || internalBypass.componentId !== componentId || internalBypass.ratedDropPa < ratedDropPa)
    )
      return fail(name + ' 的内置旁通限该滤芯且不可与外接旁路混接，工况额定压降须不小于保存的清洁额定压降。');
    const pipe = bypass ? pipeParameters(project, bypass, '滤芯外接旁路') : undefined;
    if (pipe && !pipe.ok) return pipe;
    return {
      ok: true,
      value: {
        kind: 'filter',
        componentId,
        label,
        forward,
        ratedFlowM3PerS,
        ratedDropPa: internalBypass?.ratedDropPa ?? ratedDropPa,
        ...(internalBypass
          ? {
              internalBypass: {
                ...internalBypass,
                resistance: orificeResistance(project.design.fluid.densityKgPerM3, 1, internalBypass.effectiveAreaM2),
              },
            }
          : {}),
        ...(pipe?.ok ? { bypassPipe: pipe.value } : {}),
      },
    };
  }
  if (typeId === 'one-way-throttle') {
    const initial = project.design.initialConditions.find((item) => item.componentId === componentId);
    if (initial?.kind !== 'throttle') return fail(name + ' 缺少保存的节流开口。');
    const { openingAreaM2 } = initial;
    if (forward && openingAreaM2 === 0) return fail(name + ' 的 A→B 节流口已关闭，隔离支路的保压与实际分流待核。');
    const flowCoefficient = h?.flowCoefficient;
    const maximumAreaM2 = h?.maximumAreaM2;
    const { densityKgPerM3 } = project.design.fluid;
    if (
      !Number.isFinite(openingAreaM2) ||
      openingAreaM2 < 0 ||
      maximumAreaM2 === undefined ||
      !Number.isFinite(maximumAreaM2) ||
      openingAreaM2 > maximumAreaM2 ||
      flowCoefficient === undefined ||
      !Number.isFinite(flowCoefficient) ||
      flowCoefficient <= 0 ||
      !Number.isFinite(densityKgPerM3) ||
      densityKgPerM3 <= 0
    )
      return fail(name + ' 缺少有效节流面积、流量系数或油液密度。请核对保存参数。');
    const meterResistance =
      openingAreaM2 === 0 ? null : orificeResistance(densityKgPerM3, flowCoefficient, openingAreaM2);
    if (meterResistance !== null && (!Number.isFinite(meterResistance) || meterResistance <= 0))
      return fail(name + ' 的节流开口超出可核算数值范围。');
    if (!forward) {
      const crackingPressurePa = h?.reverseOpeningDifferentialPa;
      const bypassAreaM2 = component.definition.version === 3 ? h?.reverseMaximumAreaM2 : maximumAreaM2;
      if (crackingPressurePa === undefined || !Number.isFinite(crackingPressurePa) || crackingPressurePa < 0)
        return fail(name + ' 缺少有效的 B→A 旁通开启压差。');
      if (bypassAreaM2 === undefined || !Number.isFinite(bypassAreaM2) || bypassAreaM2 <= 0)
        return fail(name + ' 缺少有效的 B→A 旁通面积。');
      const bypassResistance = orificeResistance(densityKgPerM3, flowCoefficient, bypassAreaM2);
      if (!Number.isFinite(bypassResistance) || bypassResistance <= 0)
        return fail(name + ' 的 B→A 旁通面积超出可核算数值范围。');
      return {
        ok: true,
        value: {
          kind: 'reverse-throttle',
          componentId,
          label,
          forward,
          openingAreaM2,
          flowCoefficient,
          densityKgPerM3,
          crackingPressurePa,
          bypassAreaM2,
          meterResistance,
          bypassResistance,
        },
      };
    }
    return {
      ok: true,
      value: { kind: 'one-way-throttle', componentId, label, forward, openingAreaM2, flowCoefficient, densityKgPerM3 },
    };
  }
  const resistancePaSPerM3 = h?.meterResistancePaSPerM3;
  if (resistancePaSPerM3 === undefined || !(resistancePaSPerM3 >= 0)) return fail(name + ' 缺少有效保存流阻。');
  return { ok: true, value: { kind: 'meter', componentId, label, forward, resistancePaSPerM3 } };
}

const filterDrop = (law: FilterLoss, flow: number) => law.ratedDropPa * (flow / law.ratedFlowM3PerS) ** 2;

function builtInFilterPoint(law: FilterLoss, flow: number): ReverseThrottlePoint | undefined {
  const bypass = law.internalBypass;
  return (
    bypass &&
    reverseThrottlePoint(
      {
        meterResistance: law.ratedDropPa / law.ratedFlowM3PerS ** 2,
        bypassResistance: bypass.resistance,
        crackingPressurePa: bypass.crackingPressurePa,
      },
      flow,
    )
  );
}

/** The filter and bypass share one pressure drop, with both flows nonnegative. */
function parallelFilterFlow(law: FilterLoss, pipe: ReturnPipeLaw, total: number): number {
  if (law.ratedDropPa === 0) return total;
  let low = 0;
  let high = total;
  for (let i = 0; i < 56; i++) {
    const mid = low + (high - low) / 2;
    if (mid === low || mid === high) break;
    const bypassDrop = returnPipeLoss(pipe, total - mid).pressureDropPa;
    if (!Number.isFinite(bypassDrop)) return NaN;
    if (filterDrop(law, mid) < bypassDrop) low = mid;
    else high = mid;
  }
  return low + (high - low) / 2;
}

export function seriesAccessoryDrop(law: SeriesAccessoryLoss, flowM3PerS: number): number {
  switch (law.kind) {
    case 'filter':
      return (
        builtInFilterPoint(law, flowM3PerS)?.pressureDropPa ??
        filterDrop(law, law.bypassPipe ? parallelFilterFlow(law, law.bypassPipe, flowM3PerS) : flowM3PerS)
      );
    case 'meter':
      return law.resistancePaSPerM3 * flowM3PerS;
    case 'one-way-throttle':
      return orificeResistance(law.densityKgPerM3, law.flowCoefficient, law.openingAreaM2) * flowM3PerS ** 2;
    case 'reverse-throttle':
      return reverseThrottlePoint(law, flowM3PerS).pressureDropPa;
  }
}

export function reportReturnAccessory(
  law: ReturnAccessoryLaw,
  flowM3PerS: number,
  downstreamPressurePa: number,
): Result<ReturnAccessoryResult> {
  const name = law.label + ' [' + law.componentId + ']';
  const internalPoint = law.kind === 'filter' ? builtInFilterPoint(law, flowM3PerS) : undefined;
  const branchFlow =
    internalPoint?.meterFlowM3PerS ??
    (law.kind === 'filter' && law.bypassPipe ? parallelFilterFlow(law, law.bypassPipe, flowM3PerS) : flowM3PerS);
  if (law.kind === 'filter' && branchFlow > law.ratedFlowM3PerS * (1 + 1e-12)) {
    const lpm = (value: number) => Number((value * 60000).toPrecision(6));
    return fail(
      `${name} 的实际回油量超过保存额定流量，清洁滤芯压降待核。试算 ${lpm(branchFlow)} L/min，保存额定 ${lpm(law.ratedFlowM3PerS)} L/min。`,
    );
  }
  if (law.kind === 'reverse-throttle') {
    if (flowM3PerS === 0 && law.meterResistance === null)
      return fail(name + ' 的主节流口关闭，B→A 旁通未形成通流。开启压差只限定压差上界，隔离支路端压与保压待核。');
    const point = reverseThrottlePoint(law, flowM3PerS);
    const upstreamPressurePa = downstreamPressurePa + point.pressureDropPa;
    if (!Number.isFinite(upstreamPressurePa)) return fail(name + ' 的 B→A 端压超出有限数值范围。');
    return { ok: true, value: { ...law, ...point, flowM3PerS, downstreamPressurePa, upstreamPressurePa } };
  }
  const pressureDropPa = law.kind === 'filter' ? filterDrop(law, branchFlow) : seriesAccessoryDrop(law, flowM3PerS);
  if (!Number.isFinite(pressureDropPa)) return fail(name + ' 的压降超出有限数值范围。');
  if (
    internalPoint &&
    (Math.abs(internalPoint.pressureDropPa - pressureDropPa) > Math.max(1, pressureDropPa) * 1e-8 ||
      Math.abs(branchFlow + internalPoint.bypassFlowM3PerS - flowM3PerS) > Math.max(1e-15, flowM3PerS * 1e-8))
  )
    return fail(name + ' 内置旁通压降或流量守恒待核。');
  const bypass =
    law.kind === 'filter' && law.bypassPipe
      ? reportReturnPipe(law.bypassPipe, flowM3PerS - branchFlow, downstreamPressurePa)
      : undefined;
  if (bypass && !bypass.ok) return bypass;
  if (bypass?.ok && Math.abs(bypass.value.pressureDropPa - pressureDropPa) > Math.max(1, pressureDropPa) * 1e-8)
    return fail(name + ' 与外接旁路的压降平衡待核。');
  return {
    ok: true,
    value: {
      ...law,
      flowM3PerS: branchFlow,
      pressureDropPa,
      downstreamPressurePa,
      upstreamPressurePa: downstreamPressurePa + pressureDropPa,
      ...(bypass?.ok ? { parallelBypass: { totalFlowM3PerS: flowM3PerS, pipe: bypass.value } } : {}),
      ...(law.kind === 'filter' && law.internalBypass && internalPoint
        ? {
            builtInBypass: {
              totalFlowM3PerS: flowM3PerS,
              flowM3PerS: internalPoint.bypassFlowM3PerS,
              state: internalPoint.bypassState,
              crackingPressurePa: law.internalBypass.crackingPressurePa,
              effectiveAreaM2: law.internalBypass.effectiveAreaM2,
            },
          }
        : {}),
    },
  };
}

export function pipeParameters(project: NetworkProject, pipe: Pipe, role: string): Result<ReturnPipeLaw> {
  const { lengthM, internalDiameterM: diameterM, localLossCoefficient, roughnessM } = pipe.parameters;
  const { densityKgPerM3, kinematicViscosityM2PerS } = project.design.fluid;
  const name = role + ' [' + pipe.id + ']';
  if (lengthM === undefined || !(lengthM > 0)) return fail(name + ' 的实际长度 L 须大于 0。请保存有效管长。');
  if (diameterM === undefined || !(diameterM > 0)) return fail(name + ' 的实际内径 D 须大于 0。请保存有效内径。');
  if (!(densityKgPerM3 > 0) || !(kinematicViscosityM2PerS > 0)) return fail(name + ' 缺少有效的油液密度或运动黏度。');
  if (roughnessM === undefined || !Number.isFinite(roughnessM) || roughnessM < 0)
    return fail(name + ' 缺少有效绝对粗糙度 ε。光滑管须显式填 0。');
  if (localLossCoefficient === undefined || !Number.isFinite(localLossCoefficient) || localLossCoefficient < 0)
    return fail(name + ' 缺少有效局部阻力系数 K。无局部损失须显式填 0。');
  return {
    ok: true,
    value: {
      connectionId: pipe.id,
      lengthM,
      diameterM,
      densityKgPerM3,
      kinematicViscosityM2PerS,
      roughnessM,
      localLossCoefficient,
    },
  };
}

export function reportFilterOutletReturnPipes(
  project: NetworkProject,
  paths: DutyPhasePaths,
  filterOutlet: string,
  tankPort: string,
  flowM3PerS: number,
  tankPressurePa: number,
): Result<readonly ReturnPipeResult[]> {
  const nonideal = paths.uniquePath(filterOutlet, tankPort)?.filter((arc) => !arc.ideal);
  const unsupported = '滤芯出口串联通路须回到主油箱，未建模的有损元件使 Y 口背压待核。';
  if (!nonideal?.length) return fail(unsupported);
  const result: ReturnPipeResult[] = [];
  let downstreamPressurePa = tankPressurePa;
  // Every segment carries the same discharge. Trace pressures back from the tank.
  for (const segment of nonideal.reverse()) {
    const pipe = project.design.connections.find((edge) => {
      if (edge.kind !== 'pipe') return false;
      const from = endpointKey(edge.from),
        to = endpointKey(edge.to);
      return (from === segment.from && to === segment.to) || (to === segment.from && from === segment.to);
    });
    if (!pipe || pipe.kind !== 'pipe') return fail(unsupported);
    const law = pipeParameters(project, pipe, '滤芯出口回油管');
    if (!law.ok) return law;
    const actual = reportReturnPipe(law.value, flowM3PerS, downstreamPressurePa);
    if (!actual.ok) return actual;
    downstreamPressurePa = actual.value.upstreamPressurePa;
    result.unshift(actual.value);
  }
  return { ok: true, value: result };
}

export function findReturnTopology(
  project: NetworkProject,
  paths: DutyPhasePaths,
  tankPort: string,
  pilotPipes: readonly Pipe[] = [],
  supplyPipeIds: ReadonlySet<string> = new Set(),
): Result<ReturnTopology | null> {
  const pipes = project.design.connections
    .filter((edge) => edge.kind === 'pipe')
    .filter((pipe) => !supplyPipeIds.has(pipe.id));
  const accessories = project.design.components.filter(isReturnTreeAccessory);
  const hasPilotRelief = project.design.components.some((part) => part.definition.id === 'teaching:pilot-relief');
  if (!pipes.length && !accessories.length) return { ok: true, value: null };
  const valvesInProject = project.design.components.filter((part) => part.typeId === 'valve');
  const filter =
    !hasPilotRelief && valvesInProject.length === 2 && accessories.length === 1
      ? accessories.find((part) => part.typeId === 'return-filter')
      : undefined;
  const filterA = filter && filter.id + ':A';
  const filterB = filter && filter.id + ':B';
  const bypasses =
    filterA && filterB && !paths.idealReachable(filterA, filterB)
      ? pipes.filter(({ from, to }) => {
          const a = endpointKey(from);
          const b = endpointKey(to);
          return (
            (paths.idealReachable(filterA, a) && paths.idealReachable(filterB, b)) ||
            (paths.idealReachable(filterA, b) && paths.idealReachable(filterB, a))
          );
        })
      : [];
  if (bypasses.length > 1) return fail('滤芯 [' + filter?.id + '] 的外接旁路限一条物理管，多路并联待核。');
  const bypass = bypasses[0];
  // Collapse just the recognized parallel pair. All other paths must remain unique.
  const bypassEnds = bypass && ([endpointKey(bypass.from), endpointKey(bypass.to)] as const);
  const edgeKey = (a: string, b: string) => JSON.stringify([a, b]);
  const byEndpoints = new Map<string, Pipe>();
  for (const pipe of pipes) {
    const a = endpointKey(pipe.from),
      b = endpointKey(pipe.to);
    byEndpoints.set(edgeKey(a, b), pipe);
    byEndpoints.set(edgeKey(b, a), pipe);
  }

  const routes = new Map<string, readonly string[]>();
  const used = new Map<
    string,
    { element: ReturnElement; parentId: string | null; depth: number; valves: Set<string> }
  >();
  for (const valve of valvesInProject) {
    const route = paths.uniquePath(valve.id + ':T', tankPort, bypassEnds);
    const name = valve.label || valve.id;
    if (!route) return fail(name + ' 的 T 口至油箱须有唯一回油通路。请核对回油环路、旁路或断开。');
    const elements: { key: string; element: ReturnElement }[] = [];
    for (const arc of route) {
      if (arc.ideal) continue;
      if (arc.component && isReturnTreeAccessory(arc.component)) {
        const id = arc.component.id;
        elements.push({
          key: 'accessory:' + id,
          element: {
            kind: 'accessory',
            id,
            component: arc.component,
            forward: arc.from === id + ':A',
            ...(bypass && id === filter?.id ? { bypass } : {}),
          },
        });
        continue;
      }
      const pipe = byEndpoints.get(edgeKey(arc.from, arc.to));
      if (arc.component || !pipe) return fail(name + ' 的回油树含未建模的串联元件。T 口至油箱只允许理想连接与物理管。');
      elements.push({ key: 'pipe:' + pipe.id, element: { kind: 'pipe', id: pipe.id, pipe } });
    }
    routes.set(
      valve.id,
      elements.map(({ key }) => key),
    );
    for (const [index, { key, element }] of elements.entries()) {
      const parentId = elements[index + 1]?.key ?? null;
      const depth = elements.length - index;
      const segment = used.get(key) ?? { element, parentId, depth, valves: new Set<string>() };
      if (segment.parentId !== parentId || segment.depth !== depth)
        return fail('回油段 [' + element.id + '] 的下游通路不唯一，请核对接线。');
      segment.valves.add(valve.id);
      used.set(key, segment);
    }
  }

  const dedicatedPilotPipes: Pipe[] = [];
  const mixedPilotIds: string[] = [];
  let earlyValveId: string | undefined;
  for (const pipe of pilotPipes) {
    const segment = used.get('pipe:' + pipe.id);
    if (!segment && earlyValveId === undefined) {
      dedicatedPilotPipes.push(pipe);
      continue;
    }
    const valveId = segment?.valves.values().next().value;
    if (segment?.valves.size !== 1 || valveId === undefined || (earlyValveId !== undefined && earlyValveId !== valveId))
      return fail('回油管 [' + pipe.id + '] 的滤芯前汇流待核。仅支持一缸先与溢流汇合，另一缸在共用滤芯入口侧汇入。');
    earlyValveId = valveId;
    mixedPilotIds.push(pipe.id);
  }
  const dedicatedPilotIds = new Set(dedicatedPilotPipes.map((pipe) => pipe.id));
  const segments: ReturnSegment[] = [];
  for (const [key, id] of [
    ...pipes
      .filter((pipe) => pipe !== bypass && !dedicatedPilotIds.has(pipe.id))
      .map((pipe) => ['pipe:' + pipe.id, pipe.id] as const),
    ...accessories.map((part) => ['accessory:' + part.id, part.id] as const),
  ]) {
    const usage = used.get(key);
    if (!usage)
      return fail(
        (key.startsWith('pipe:') ? '物理管' : '回油附件') +
          ' [' +
          id +
          '] 未归入任一阀 T 口至油箱的回油通路。请核对断开、旁路或供油侧接线。',
      );
    const { valves, parentId } = usage;
    if (usage.element.kind === 'accessory') {
      const { typeId } = usage.element.component;
      if (usage.element.bypass && valves.size !== routes.size)
        return fail('滤芯 [' + id + '] 与外接旁路须位于两缸共用回油干线，支路并联待核。');
      const pilotFilter = hasPilotRelief && typeId === 'return-filter';
      const singleBranch = typeId === 'one-way-throttle' || (hasPilotRelief && typeId === 'flow-meter');
      if ((pilotFilter && valves.size !== routes.size) || (singleBranch && valves.size !== 1))
        return fail(
          (pilotFilter ? '回油过滤器' : typeId === 'one-way-throttle' ? '单向节流阀' : '流量计') +
            ' [' +
            id +
            '] 须串联在' +
            (pilotFilter ? '两缸共用回油干线' : '单缸回油支路') +
            '。',
        );
    }
    const mixedIndex = mixedPilotIds.indexOf(id);
    const role =
      mixedIndex >= 0
        ? '溢流与单缸排油汇合段第 ' + (mixedIndex + 1) + ' 段'
        : parentId === null && valves.size === routes.size
          ? '回油干线'
          : valves.size === 1
            ? '回油支管'
            : valves.size === 2
              ? '两缸汇合段'
              : valves.size === 4
                ? '四缸再汇合段'
                : valves.size + ' 缸汇合段';
    segments.push({ key, ...usage, role });
  }
  return {
    ok: true,
    value: {
      segments,
      routes,
      dedicatedPilotPipes,
      ...(earlyValveId !== undefined ? { earlyPilotMerge: { valveId: earlyValveId, pipeIds: mixedPilotIds } } : {}),
    },
  };
}

export function returnPipeLoss(pipe: ReturnPipeLaw, flowM3PerS: number) {
  const velocityMPerS = (4 * flowM3PerS) / (Math.PI * pipe.diameterM ** 2);
  const reynolds = (velocityMPerS * pipe.diameterM) / pipe.kinematicViscosityM2PerS;
  const { f, regime } = darcyFrictionFactor(reynolds, pipe.roughnessM / pipe.diameterM);
  const dynamicPressure = (pipe.densityKgPerM3 * velocityMPerS ** 2) / 2;
  const frictionDropPa = f * (pipe.lengthM / pipe.diameterM) * dynamicPressure;
  const localDropPa = pipe.localLossCoefficient * dynamicPressure;
  return {
    reynolds,
    regime,
    frictionFactor: f,
    velocityMPerS,
    frictionDropPa,
    localDropPa,
    pressureDropPa: frictionDropPa + localDropPa,
  };
}

export function reportReturnPipe(
  pipe: ReturnPipeLaw,
  flowM3PerS: number,
  downstreamPressurePa: number,
  role = '回油管',
): Result<ReturnPipeResult> {
  const { frictionFactor, ...loss } = returnPipeLoss(pipe, flowM3PerS);
  const name = role + ' [' + pipe.connectionId + ']';
  if (!Number.isFinite(loss.pressureDropPa)) return fail(name + ' 的压降超出有限数值范围。');
  if ((loss.regime === '湍流' || loss.regime === '过渡区估算') && pipe.roughnessM / pipe.diameterM > 0.1)
    return fail(name + ' 在' + loss.regime + '下的相对粗糙度 ε/D 超出 0.1，当前沿程压降待核。');
  return {
    ok: true,
    value: {
      ...pipe,
      ...loss,
      ...(flowM3PerS > 0 ? { frictionFactor } : {}),
      flowM3PerS,
      downstreamPressurePa,
      upstreamPressurePa: downstreamPressurePa + loss.pressureDropPa,
    },
  };
}
