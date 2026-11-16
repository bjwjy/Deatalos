import { diagnostic, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import {
  orificeResistance,
  pipeParameters,
  reportReturnPipe,
  returnPipeLoss,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';
import type { DutyPhase } from './network-duty.js';
import type { ParallelFlowResult, ParallelFlowSupply } from './network-duty-flow-split.js';

const workValves = new Set([
  'teaching:directional-2-4',
  'teaching:directional-3-4',
  'teaching:valve-o',
  'teaching:valve-m',
]);
const workTypes = new Set(['pump', 'tank', 'valve', 'cylinder', 'volume', 'relief']);
type Arc = NonNullable<ReturnType<DutyPhasePaths['path']>>[number];

export const workingLineConditions = [
  '单定量泵、单箱及单普通双作用缸，各工作口可串接一条物理管，主供回油和吸油采用理想连接。按保存阀口和实际流量计管损。基础回油压力取油箱压力，手填供油损失取零，缸容积效率取 1。',
  '二位及三位四通阀取保存有效面积。O/M 型阀工作位按阀芯圆周与扣重叠后的行程换算面积，M 型卸荷口在该工作位须闭合。',
  '以给定转速及泵容积效率估计固定供流，可计一只直接回箱的直动溢流阀。以实际缸速与目标 ±1% 及泵出口压力预算判定。',
] as const;

export const springAccessoryConditions = [
  '单作用缸弹簧回程限一只清洁滤芯或流量计串联在唯一回油路。给定回油压力取油箱压力，换向阀、附件和保存的黏性阻尼由软件计入。外部阻性负载须扣除保存的黏性阻尼。',
  '按当前行程位置的弹簧力求局部稳态速度，不推算全行程时间。回油侧要求缸容积效率为 1，滤芯限 A→B 且不超过保存额定流量。',
] as const;

export function springAccessoryPoint(
  project: NetworkProject,
  route: readonly Arc[],
  accessory: NetworkComponent,
  cylinder: NetworkComponent,
  input: {
    readonly area: number;
    readonly springForce: number;
    readonly resistingForce: number;
    readonly targetSpeed: number;
    readonly tankPa: number;
  },
) {
  const name = (accessory.label || accessory.id) + ' [' + accessory.id + ']';
  const fail = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/spring-accessory', `${name}：${message}`)],
  });
  const pass = route.find((arc) => arc.component?.id === accessory.id);
  const valves = route.filter((arc) => arc.component?.typeId === 'valve');
  const [valveArc] = valves;
  if (
    !pass ||
    valves.length !== 1 ||
    !valveArc?.component ||
    valveArc.to !== valveArc.component.id + ':T' ||
    route.some((arc) => !arc.ideal && arc !== pass && arc !== valveArc)
  )
    return fail('回程限换向阀、该附件与理想管路组成的唯一回油通路。');
  const valve = valveArc.component.parameters.hydraulic;
  const damping = cylinder.parameters.mechanics?.loadDampingNsPerM;
  if (!valve?.maximumAreaM2 || !valve.flowCoefficient || damping === undefined)
    return fail('缺少换向阀有效阀口或保存的缸阻尼。');
  const { area, springForce, resistingForce, targetSpeed, tankPa } = input;
  const h = accessory.parameters.hydraulic;
  const filter = accessory.typeId === 'return-filter';
  const ratedFlow = h?.filterRatedFlowM3PerS;
  const ratedDrop = h?.filterRatedDropPa;
  const meterR = h?.meterResistancePaSPerM3;
  if (filter && (pass.from !== accessory.id + ':A' || !ratedFlow || ratedDrop === undefined))
    return fail('清洁滤芯须正向 A→B，且保存额定流量与压降。');
  if (!filter && meterR === undefined) return fail('缺少流量计保存流阻。');
  const valveK = orificeResistance(project.design.fluid.densityKgPerM3, valve.flowCoefficient, valve.maximumAreaM2);
  const accessoryK = filter && ratedFlow && ratedDrop !== undefined ? ratedDrop / ratedFlow ** 2 : 0;
  const linear = (filter ? 0 : (meterR ?? 0)) + damping / area ** 2;
  const quadratic = valveK + accessoryK;
  const head = (springForce - resistingForce) / area - tankPa;
  const flow = head <= 0 ? 0 : (2 * head) / (linear + Math.sqrt(linear ** 2 + 4 * quadratic * head));
  const targetFlow = area * targetSpeed;
  if (!Number.isFinite(flow) || (filter && ratedFlow && Math.max(flow, targetFlow) > ratedFlow * (1 + 1e-12)))
    return fail('目标或实际回油量超出保存滤芯额定流量或计算范围。');
  const dropAt = (q: number) => (filter ? accessoryK * q ** 2 : (meterR ?? 0) * q);
  const valveDropPa = valveK * flow ** 2;
  const accessoryDropPa = dropAt(flow);
  const targetBackPressurePa = tankPa + valveK * targetFlow ** 2 + dropAt(targetFlow);
  const actualBackPressurePa = tankPa + valveDropPa + accessoryDropPa;
  return {
    ok: true as const,
    value: {
      label: name,
      flow,
      speed: flow / area,
      valveDropPa,
      accessoryDropPa,
      damping,
      actualBackPressurePa,
      targetBackPressurePa,
      margin: springForce - resistingForce - targetBackPressurePa * area - damping * targetSpeed,
    },
  };
}

function workingValveArea(valve: NetworkComponent): number | undefined {
  if (valve.definition.id !== 'teaching:valve-o' && valve.definition.id !== 'teaching:valve-m')
    return valve.parameters.hydraulic?.maximumAreaM2;
  // Match the saturated work stroke and full-circumference metering edge in Hopsan43Valve.
  const { commandTravelM, maximumTravelM, overlapM, diameterM } = valve.parameters.spool ?? {};
  if (!commandTravelM || !maximumTravelM || overlapM === undefined || !diameterM) return undefined;
  const travel = Math.min(commandTravelM, maximumTravelM);
  if (valve.definition.id === 'teaching:valve-m') {
    const center = valve.parameters.center?.openingFraction;
    if (!center || travel / center < maximumTravelM) return undefined;
  }
  return Math.PI * diameterM * Math.max(0, travel - overlapM);
}

export function hasWorkingPipe(paths: DutyPhasePaths, valve: NetworkComponent, cylinder: NetworkComponent): boolean {
  return ['A', 'B'].some((port) =>
    ['A', 'B'].some((chamber) =>
      paths.path(valve.id + ':' + port, cylinder.id + ':' + chamber)?.some((arc) => arc.physicalPipe),
    ),
  );
}

/** One fixed-flow source, one work branch and at most one finite direct relief. */
export function solveWorkingLines(
  project: NetworkProject,
  phase: DutyPhase,
  paths: DutyPhasePaths,
  valve: NetworkComponent,
  cylinder: NetworkComponent,
  supply: ParallelFlowSupply,
): Result<Extract<ParallelFlowResult, { kind: 'solved' }>> {
  const fail = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/work-lines', `${phase.name}：${message}`)],
  });
  const { pump, tank, tankPressurePa: tankPa, flowM3PerS: pumpFlow, totalEfficiency, pressureBudgetPa } = supply;
  const [action] = phase.actions;
  const parts = project.design.components;
  if (
    !action ||
    phase.actions.length !== 1 ||
    !workValves.has(valve.definition.id) ||
    pump.definition.id !== 'teaching:pump' ||
    parts.some((part) => !workTypes.has(part.typeId)) ||
    parts.filter((part) => part.typeId === 'cylinder').length !== 1 ||
    parts.filter((part) => part.typeId === 'tank').length !== 1
  )
    return fail('有损工作管限单定量泵、单箱、带有效面积的二位或三位四通阀及单普通双作用缸，其他混接待核。');
  if (
    action.volumetricEfficiency !== 1 ||
    action.supplyLossPa !== 0 ||
    Math.abs(action.returnPressurePa - tankPa) > 1e-6
  )
    return fail('工作管按两腔扫掠流量计损，要求缸容积效率为 1、回油基准取油箱压力、手填供油损失为零。');
  const forward = action.direction === 'forward';
  const geometry = cylinder.parameters.geometry;
  const inletArea = forward ? geometry?.capAreaM2 : geometry?.rodSideAreaM2;
  const outletArea = forward ? geometry?.rodSideAreaM2 : geometry?.capAreaM2;
  const valveArea = workingValveArea(valve);
  const coefficient = valve.parameters.hydraulic?.flowCoefficient;
  if (!inletArea || !outletArea || !valveArea || !coefficient || !(pumpFlow > 0))
    return fail('缺少有效缸面积、阀口、流量系数或泵供流，M 型工作位带卸荷待核。');
  const pumpPort = pump.id + ':P',
    tankPort = tank.id + ':T';
  const feed = paths.uniquePath(pumpPort, cylinder.id + (forward ? ':A' : ':B'));
  const drain = paths.uniquePath(cylinder.id + (forward ? ':B' : ':A'), tankPort);
  const suction = paths.uniquePath(tankPort, pump.id + ':S');
  const feedValve = feed?.findIndex((arc) => arc.component?.id === valve.id && arc.from === valve.id + ':P') ?? -1;
  const drainValve = drain?.findIndex((arc) => arc.component?.id === valve.id && arc.to === valve.id + ':T') ?? -1;
  if (
    !feed ||
    !drain ||
    feedValve < 0 ||
    drainValve < 0 ||
    !suction?.every((arc) => arc.ideal) ||
    feed.slice(0, feedValve).some((arc) => !arc.ideal) ||
    drain.slice(drainValve + 1).some((arc) => !arc.ideal)
  )
    return fail('须有唯一理想吸油、主供油与主回油，工作阀位须与缸动作一致。');
  const workPipe = (route: readonly Arc[]) => route.flatMap((arc) => (arc.physicalPipe ? [arc.physicalPipe] : []));
  const feedWork = feed.slice(feedValve + 1),
    drainWork = drain.slice(0, drainValve);
  const feedPipes = workPipe(feedWork),
    drainPipes = workPipe(drainWork);
  if (
    [...feedWork, ...drainWork].some((arc) => !arc.ideal && !arc.physicalPipe) ||
    feedPipes.length > 1 ||
    drainPipes.length > 1 ||
    project.design.connections.filter((edge) => edge.kind === 'pipe').length !== feedPipes.length + drainPipes.length
  )
    return fail('每个工作口限一条物理管，额外有损或并联支路待核。');
  const [feedPipe] = feedPipes,
    [drainPipe] = drainPipes;
  const feedLaw = feedPipe && pipeParameters(project, feedPipe, '换向阀至油缸进油工作管');
  if (feedLaw && !feedLaw.ok) return feedLaw;
  const drainLaw = drainPipe && pipeParameters(project, drainPipe, '油缸至换向阀排油工作管');
  if (drainLaw && !drainLaw.ok) return drainLaw;
  const density = project.design.fluid.densityKgPerM3;
  const valveK = orificeResistance(density, coefficient, valveArea);
  const ratio = outletArea / inletArea;
  const at = (q: number) => {
    const r = q * ratio;
    const valveReturnPa = tankPa + valveK * r ** 2;
    const returnPressurePa = valveReturnPa + (drainLaw?.ok ? returnPipeLoss(drainLaw.value, r).pressureDropPa : 0);
    const chamberPa = action.resistingLoad / action.mechanicalEfficiency / inletArea + ratio * returnPressurePa;
    const pressurePa =
      chamberPa + valveK * q ** 2 + (feedLaw?.ok ? returnPipeLoss(feedLaw.value, q).pressureDropPa : 0);
    return { pressurePa, returnPressurePa, chamberPa, valveReturnPa, returnFlow: r };
  };
  const reliefs = parts.filter((part) => part.typeId === 'relief');
  const [external] = reliefs;
  const internal = pump.parameters.relief?.enabled === 1 ? pump.parameters.relief : undefined;
  if (
    reliefs.length > 1 ||
    (external && internal) ||
    (external &&
      (external.definition.id !== 'teaching:relief' ||
        !paths.uniquePath(pumpPort, external.id + ':P')?.every((arc) => arc.ideal) ||
        !paths.uniquePath(external.id + ':T', tankPort)?.every((arc) => arc.ideal)))
  )
    return fail('有损工作管限一只在泵口取压并直接回箱的直动溢流阀。');
  const h = external ? external.parameters.hydraulic : internal;
  let reliefAt = (_pressure: number) => 0;
  if (external || internal) {
    if (!h?.maximumAreaM2 || !h.flowCoefficient || h.settingDifferentialPa === undefined)
      return fail('直动溢流阀缺少有效开口、流量系数或开启压差。');
    const start = tankPa + h.settingDifferentialPa;
    const k = orificeResistance(density, h.flowCoefficient, h.maximumAreaM2);
    reliefAt = (pressure) => Math.sqrt(Math.max(0, pressure - start) / k);
  }
  const full = at(pumpFlow);
  if (!Number.isFinite(full.pressurePa)) return fail('工作管压降超出支持的流态或数值范围。');
  let flow = pumpFlow;
  let pressure = full.pressurePa;
  if (reliefAt(full.pressurePa) > 0) {
    if (
      reliefAt(at(0).pressurePa) >= pumpFlow &&
      h?.settingDifferentialPa !== undefined &&
      h.maximumAreaM2 &&
      h.flowCoefficient
    ) {
      flow = 0;
      pressure =
        tankPa +
        h.settingDifferentialPa +
        orificeResistance(density, h.flowCoefficient, h.maximumAreaM2) * pumpFlow ** 2;
    } else {
      let low = 0,
        high = pumpFlow;
      for (let i = 0; i < 64; i++) {
        const mid = (low + high) / 2;
        if (mid + reliefAt(at(mid).pressurePa) < pumpFlow) low = mid;
        else high = mid;
      }
      flow = (low + high) / 2;
      pressure = at(flow).pressurePa;
    }
  }
  const point = at(flow);
  const reliefFlow = reliefAt(pressure);
  if (!Number.isFinite(pressure) || pressure > 70e6 || Math.abs(flow + reliefFlow - pumpFlow) > pumpFlow * 1e-8)
    return fail('在 70 MPa 范围内未能核对泵、油缸与溢流的流量平衡。');
  const segments: (ReturnPipeResult & { readonly role: string })[] = [];
  if (feedLaw?.ok) {
    const row = reportReturnPipe(feedLaw.value, flow, flow === 0 ? pressure : point.chamberPa);
    if (!row.ok) return row;
    segments.push({ ...row.value, role: '进油工作管' });
  }
  if (drainLaw?.ok) {
    const row = reportReturnPipe(drainLaw.value, point.returnFlow, point.valveReturnPa);
    if (!row.ok) return row;
    segments.push({ ...row.value, role: '排油工作管' });
  }
  const speed = flow / inletArea;
  const status =
    flow === 0
      ? 'stopped'
      : Math.abs(speed / action.speed - 1) <= 0.01
        ? 'matched'
        : speed < action.speed
          ? 'slow'
          : 'fast';
  return {
    ok: true,
    value: {
      kind: 'solved',
      pressurePa: pressure,
      pumpFlowM3PerS: pumpFlow,
      reliefFlowM3PerS: reliefFlow,
      shaftPowerW: ((pressure - tankPa) * pumpFlow) / totalEfficiency,
      workingSegments: segments,
      matchesTargets: status === 'matched' && pressure <= pressureBudgetPa,
      reasons: [
        ...(flow === 0 ? ['泵供流经溢流回箱，油缸未建立通流。静态保载另验。'] : []),
        ...(pressure > pressureBudgetPa ? ['实际泵出口压力超过本工况预算。'] : []),
      ],
      branches: [
        {
          componentId: cylinder.id,
          label: cylinder.label || cylinder.id,
          targetSpeedMPerS: action.speed,
          targetFlowM3PerS: action.speed * inletArea,
          valveId: valve.id,
          valveAreaM2: valveArea,
          inletAreaM2: inletArea,
          valveInletPressurePa: pressure,
          returnBoundaryPa: tankPa,
          flowM3PerS: flow,
          speedMPerS: speed,
          returnFlowM3PerS: point.returnFlow,
          returnPressurePa: point.returnPressurePa,
          inletPressurePa: flow === 0 ? pressure : point.chamberPa,
          status,
          closed: flow === 0,
        },
      ],
    },
  };
}
