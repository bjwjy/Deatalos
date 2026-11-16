import {
  diagnostic,
  networkDisplacementRange,
  networkValvePositions,
  type NetworkComponent,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import { dutyCylinderTravel } from './network-duty-cylinders.js';
import { cylinderBranchLaws, orificeFlow, orificeResistance } from './network-duty-flow-split.js';
import type { DutyPhase, NetworkDutyRequest } from './network-duty.js';

export interface DutyPumpPressureControl {
  readonly cutoffDifferentialPa: number;
  readonly bandPa: number;
}

export interface DutyPumpPressurePoint extends DutyPumpPressureControl {
  readonly state: 'maximum' | 'regulating' | 'minimum';
  readonly displacementM3PerRev: number;
  readonly minimumDisplacementM3PerRev: number;
  readonly maximumDisplacementM3PerRev: number;
  readonly pressurePa: number;
  readonly differentialPa: number;
  readonly pumpFlowM3PerS: number;
  readonly deliveryFlowM3PerS: number;
  readonly cylinderFlowM3PerS: number;
  readonly leakageM3PerS: number;
  readonly reliefFlowM3PerS: number;
  readonly reliefOpen?: boolean;
  readonly cylinderSpeedMPerS: number;
  readonly targetSpeedMPerS: number;
  readonly shaftPowerW: number;
  readonly matchesSpeed: boolean;
  readonly aboveCutoff: boolean;
}

export const pumpPressureDutyConditions = [
  '变量泵稳态压力控制使用工况输入的截压压差和调节带。泵压差低于截压减调节带时取最大排量，超过截压时取最小排量，中间按压差线性减排量。压力取泵 P 与 S 的差，预算只校核泵出口压力。',
  '限一台变量泵、一个油箱及一只行程内普通双作用缸，经理想油路和独立四通换向阀连接。按保存阀口、阻性负载和理想吸油联立工作点。缸容积效率取 1，回油基准取油箱压力，手填供油压降为零。',
  '理论供流按排量、转速与输入容积效率估计，再扣除保存的压力相关泄漏和直接回箱的直动溢流。输入容积效率勿重复扣除已建模泄漏。轴功率按泵压差乘扣泄漏前供流再除以总效率。目标缸速允差 ±1%。',
  '调节曲线仅用于计算书的稳态核算。控制器与手动排量指令、动态恒压、负载敏感、多源并供及空化另验。',
] as const;

const componentsInScope = new Set(['pump', 'tank', 'valve', 'cylinder', 'volume', 'relief']);
const pressureMax = 70e6;

export function solveDutyPumpPressure(
  project: NetworkProject,
  pump: NetworkComponent,
  tank: NetworkComponent,
  tankPa: number,
  phase: DutyPhase,
  request: NetworkDutyRequest,
  setting: DutyPumpPressureControl,
): Result<DutyPumpPressurePoint> {
  const fail = (reason: string, code = 'DUTY_UNSUPPORTED'): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic(code, '/duty/pumpPressureControl', phase.name + '：' + reason)],
  });
  const { cutoffDifferentialPa: cutoff, bandPa: band } = setting;
  const range = networkDisplacementRange(pump);
  if (pump.definition.id !== 'teaching:variable-pump' || !range || range.max <= range.min)
    return fail('压力调节要求变量泵及不同的最小、最大排量。');
  if (cutoff < band || tankPa + cutoff > pressureMax)
    return fail('调节带须大于零且不超过截压压差，截压对应的泵出口须在 70 MPa 支持范围内。');
  if (phase.pumpCommandPercent !== undefined) return fail('同一工况不能同时使用压力调节和手动排量指令。');
  const { components, connections, initialConditions, fluid } = project.design;
  const valves = components.filter((part) => part.typeId === 'valve');
  const cylinders = components.filter((part) => part.typeId === 'cylinder');
  const [action] = phase.actions;
  const [valve] = valves;
  const [cylinder] = cylinders;
  const [slot] = phase.valves;
  if (
    components.filter((part) => part.typeId === 'tank').length !== 1 ||
    valves.length !== 1 ||
    cylinders.length !== 1 ||
    !valve ||
    !cylinder ||
    components.some((part) => !componentsInScope.has(part.typeId)) ||
    connections.some((edge) => edge.kind !== 'ideal') ||
    phase.actions.length !== 1 ||
    action?.componentId !== cylinder.id ||
    phase.valves.length !== 1 ||
    slot?.componentId !== valve.id ||
    !networkValvePositions(valve).includes(slot.positionId) ||
    phase.flowSplit ||
    phase.shutoffs?.length ||
    action.motorSetting ||
    action.rotaryAngleRad !== undefined
  )
    return fail('压力调节限单变量泵、单油箱、一只普通双作用缸及明确的独立四通阀位，混接或有损管路待核。');
  if (
    action.volumetricEfficiency !== 1 ||
    action.supplyLossPa !== 0 ||
    Math.abs(action.returnPressurePa - tankPa) > 1e-6
  )
    return fail('请将缸容积效率设为 1，回油基准取油箱压力，手填供油压降设为零。');
  const initial = initialConditions.find((item) => item.componentId === cylinder.id);
  const travel = dutyCylinderTravel(
    cylinder,
    action.positionM ?? (initial?.kind === 'cylinder' ? initial.positionM : undefined),
    phase.name,
  );
  if (!travel.ok) return travel;
  const graph = dutyPhasePaths(project, phase, false, true);
  if (!graph.ok) return graph;
  const paths = graph.value;
  const p = pump.id + ':P',
    t = tank.id + ':T';
  if (!paths.uniquePath(t, pump.id + ':S')?.every((arc) => arc.ideal) || paths.reachable(p, t))
    return fail('须有唯一理想吸油路径，供油与油箱之间不能有未建模短接或卸荷。');
  const laws = cylinderBranchLaws(project, phase, paths, p, t, tankPa);
  if (!laws.ok) return laws;
  const [load] = laws.value;
  if (!load || load.startPa < tankPa) return fail('无法建立单缸阻性负载平衡，供油起动压力不得低于油箱压力。');

  const externalReliefs = components.filter((part) => part.typeId === 'relief');
  const [external] = externalReliefs;
  const internal = pump.parameters.relief?.enabled === 1 ? pump.parameters.relief : undefined;
  if (externalReliefs.length > 1 || (external && internal))
    return fail('压力调节限一只外置或内置直动溢流阀，并用时实际分流待核。');
  if (
    external &&
    (external.definition.id !== 'teaching:relief' ||
      !paths.uniquePath(p, external.id + ':P')?.every((arc) => arc.ideal) ||
      !paths.uniquePath(external.id + ':T', t)?.every((arc) => arc.ideal))
  )
    return fail('外置溢流阀须在泵出口取压并直接回同一油箱。');
  const h = external?.parameters.hydraulic ?? internal;
  const leakage = pump.parameters.hydraulic?.leakageM3PerSPa;
  if (
    leakage === undefined ||
    ((external || internal) && (!h?.maximumAreaM2 || !h.flowCoefficient || h.settingDifferentialPa === undefined))
  )
    return fail('泵压力泄漏参数或直动溢流阀设定、开口待核。');
  const relief =
    h?.maximumAreaM2 && h.flowCoefficient && h.settingDifferentialPa !== undefined
      ? {
          startPa: tankPa + h.settingDifferentialPa,
          resistance: orificeResistance(fluid.densityKgPerM3, h.flowCoefficient, h.maximumAreaM2),
        }
      : undefined;
  const rpmFactor = (request.angularSpeedRadPerS / (2 * Math.PI)) * request.pumpVolumetricEfficiency;
  if (range.min === 0 && leakage === 0 && tankPa + cutoff < Math.min(load.startPa, relief?.startPa ?? Infinity))
    return fail('泵达到零排量，油缸无通流。截压到首个支路开启之间压力不唯一，实际端压待核。', 'DUTY_TARGET_BLOCKED');
  const pointAt = (pressurePa: number) => {
    const differentialPa = pressurePa - tankPa;
    const share = Math.max(0, Math.min(1, (cutoff - differentialPa) / band));
    const displacementM3PerRev = range.min + (range.max - range.min) * share;
    const pumpFlowM3PerS = rpmFactor * displacementM3PerRev;
    const cylinderFlowM3PerS = orificeFlow(pressurePa, load);
    const reliefFlowM3PerS = relief ? orificeFlow(pressurePa, relief) : 0;
    const leakageM3PerS = leakage * differentialPa;
    return {
      pressurePa,
      differentialPa,
      displacementM3PerRev,
      pumpFlowM3PerS,
      cylinderFlowM3PerS,
      reliefFlowM3PerS,
      leakageM3PerS,
      share,
      residual: cylinderFlowM3PerS + reliefFlowM3PerS + leakageM3PerS - pumpFlowM3PerS,
    };
  };
  let low = tankPa,
    high = pressureMax;
  if (!(pointAt(low).residual <= 0 && pointAt(high).residual >= 0))
    return fail('在油箱压力至 70 MPa 内没有满足流量守恒的稳态点，检查最小排量及回箱能力。');
  for (let i = 0; i < 64; i++) {
    const p = low + (high - low) / 2;
    if (p === low || p === high) break;
    if (pointAt(p).residual < 0) low = p;
    else high = p;
  }
  const { residual, share, ...point } = pointAt(low + (high - low) / 2);
  const cylinderSpeedMPerS = point.cylinderFlowM3PerS / load.inletArea;
  const shaftPowerW = (point.differentialPa * point.pumpFlowM3PerS) / request.totalEfficiency;
  if (
    !Number.isFinite(shaftPowerW) ||
    !Number.isFinite(cylinderSpeedMPerS) ||
    !(Math.abs(residual) <= range.max * rpmFactor * 1e-8)
  )
    return fail('稳态点未通过流量守恒或功率范围校核。');
  return {
    ok: true,
    value: {
      ...setting,
      ...point,
      deliveryFlowM3PerS: point.pumpFlowM3PerS - point.leakageM3PerS,
      state: share === 1 ? 'maximum' : share === 0 ? 'minimum' : 'regulating',
      minimumDisplacementM3PerRev: range.min,
      maximumDisplacementM3PerRev: range.max,
      ...(relief ? { reliefOpen: point.reliefFlowM3PerS > 0 } : {}),
      cylinderSpeedMPerS,
      targetSpeedMPerS: action.speed,
      shaftPowerW,
      matchesSpeed: Math.abs(cylinderSpeedMPerS / action.speed - 1) <= 0.01,
      aboveCutoff: point.differentialPa > cutoff + 1e-6,
    },
  };
}
