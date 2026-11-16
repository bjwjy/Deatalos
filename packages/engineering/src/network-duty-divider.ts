import type { NetworkComponent, NetworkProject } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import {
  orificeResistance,
  parallelFlowTargets,
  type DividerFlowDetails,
  type ParallelFlowBranch,
  type ParallelFlowResult,
  type ParallelFlowSupply,
  type ParallelFlowTarget,
} from './network-duty-flow-split.js';
import type { DutyPhase } from './network-duty.js';

export const dutyDividerTypes: ReadonlySet<string> = new Set(['flow-divider-combiner', 'synchronizing-flow-divider']);
export const dividerDutyConditions = [
  '单定量泵、单油箱、单四通换向阀、单分流集流阀和两只普通双作用缸。分集流阀 P 接换向阀 A，分集流阀 A/B 各接一只缸无杆腔，两缸有杆腔共接换向阀 B。仅经理想油路连接，泵及直动溢流在未溢流区核算。',
  'P→A/B 分流比例施加在两缸进油量；A/B→P 集流比例施加在两缸排油量，按实际面积比反算进油量与缸速。主通道按保存比例及孔口面积求限流支路，另一侧补偿节流。按目标 ±1% 判断缸速。',
  '缸容积效率取 1。回油输入取油箱压力，其余供油压降置零，由保存的换向阀面积计算阀口损失。泵口限压输入仅作预算校核。',
  '同步阀末端纠偏仅核算伸出侧一缸到位、主分流为零且已知停缸无杆腔压力的稳态点。停缸口压力、纠偏阈值和小阀口决定另一缸流量；双缸低流量时的主路与纠偏混合、到位先后和瞬态另验。',
] as const;

const allowed = new Set(['pump', 'tank', 'cylinder', 'valve', 'volume', 'relief', ...dutyDividerTypes]);
const label = (part: NetworkComponent) => part.label || part.id;

interface DividerBranch {
  readonly name: 'A' | 'B';
  readonly target: ParallelFlowTarget;
  readonly cap: number;
  readonly rod: number;
  readonly share: number;
  readonly load: number;
}

export function solveDutyDivider(
  project: NetworkProject,
  phase: DutyPhase,
  paths: DutyPhasePaths,
  divider: NetworkComponent,
  supply: ParallelFlowSupply,
): ParallelFlowResult {
  const movingTargets = parallelFlowTargets(project, phase.actions);
  const stoppedPart = project.design.components.find(
    (part) => part.id === phase.dividerEnd?.componentId && part.typeId === 'cylinder',
  );
  const targets = stoppedPart
    ? [
        ...movingTargets,
        { componentId: stoppedPart.id, label: label(stoppedPart), targetSpeedMPerS: 0, targetFlowM3PerS: 0 },
      ]
    : movingTargets;
  const pending = (reason: string): ParallelFlowResult => ({
    kind: 'pending',
    targets,
    reasons: [label(divider) + ' [' + divider.id + ']：' + reason],
  });
  const { pump, tank, tankPressurePa, flowM3PerS: pumpFlow, totalEfficiency, pressureBudgetPa } = supply;
  if (!Number.isFinite(pumpFlow) || !(pumpFlow > 0)) return pending('缺少有效的定量泵供流。');
  const { components, connections, fluid } = project.design;
  const valves = components.filter((part) => part.typeId === 'valve');
  const valve = valves[0];
  const cylinders = components.filter((part) => part.typeId === 'cylinder');
  const port = (part: NetworkComponent, id: string) => part.id + ':' + id;
  const pumpPort = port(pump, 'P');
  const tankPort = port(tank, 'T');
  const common = port(divider, 'P');
  if (
    pump.definition.id !== 'teaching:pump' ||
    components.filter((part) => part.typeId === 'tank').length !== 1 ||
    components.filter((part) => dutyDividerTypes.has(part.typeId)).length !== 1 ||
    valves.length !== 1 ||
    !valve ||
    !['teaching:directional-2-4', 'teaching:directional-3-4'].includes(valve.definition.id) ||
    cylinders.length !== 2 ||
    targets.length !== 2 ||
    phase.actions.length !== 2 ||
    components.some((part) => !allowed.has(part.typeId)) ||
    connections.some((edge) => edge.kind !== 'ideal')
  )
    return pending('须为单定量泵、单油箱、单四通换向阀、单分集流阀及两只普通双作用缸的理想回路。');
  const ideal = (from: string, to: string) => paths.uniquePath(from, to)?.every((arc) => arc.ideal) === true;
  const groups = [pumpPort, tankPort, common, port(valve, 'B'), port(divider, 'A'), port(divider, 'B')];
  if (
    groups.some((from, index) => groups.slice(index + 1).some((to) => paths.idealReachable(from, to))) ||
    !ideal(pumpPort, port(valve, 'P')) ||
    !ideal(tankPort, port(valve, 'T')) ||
    !ideal(tankPort, port(pump, 'S')) ||
    !ideal(common, port(valve, 'A'))
  )
    return pending('公共 P 口须接换向阀 A，供回油及两工作口必须分开且通路唯一。');
  const forward = phase.actions[0]?.direction === 'forward';
  const position = phase.valves.find((setting) => setting.componentId === valve.id)?.positionId;
  if (
    phase.actions.some((action) => (action.direction === 'forward') !== forward) ||
    position !== (forward ? 'extend' : 'retract')
  )
    return pending('两缸须同向且与换向阀伸出或缩回阀位一致。');

  const h = divider.parameters.hydraulic;
  const vh = valve.parameters.hydraulic;
  const valveArea = vh?.maximumAreaM2;
  const aShare = h?.branchAFlowFraction;
  if (!aShare || !h?.maximumAreaM2 || !h.flowCoefficient || !valveArea || !vh?.flowCoefficient)
    return pending('缺少保存的分流比例、有效面积或流量系数。');
  const resistance = orificeResistance(fluid.densityKgPerM3, h.flowCoefficient, h.maximumAreaM2);
  const commonResistance = orificeResistance(fluid.densityKgPerM3, vh.flowCoefficient, valveArea);
  const branches: DividerBranch[] = [];
  for (const name of ['A', 'B'] as const) {
    const part = cylinders.find((cylinder) => ideal(port(divider, name), port(cylinder, 'A')));
    const target = targets.find((entry) => entry.componentId === part?.id);
    const action = phase.actions.find((entry) => entry.componentId === part?.id);
    const cap = part?.parameters.geometry?.capAreaM2;
    const rod = part?.parameters.geometry?.rodSideAreaM2;
    if (!part || !target || !action || !cap || !rod || !ideal(port(valve, 'B'), port(part, 'B')))
      return pending('A/B 须各自唯一接一只缸的无杆腔，两缸有杆腔汇接换向阀 B。');
    if (
      action.volumetricEfficiency !== 1 ||
      action.supplyLossPa !== 0 ||
      Math.abs(action.returnPressurePa - tankPressurePa) > 1e-6
    )
      return pending('缸容积效率取 1，其余供油压降填 0，回油基准取油箱压力。');
    branches.push({
      name,
      target,
      cap,
      rod,
      share: name === 'A' ? aShare : 1 - aShare,
      load: action.resistingLoad / action.mechanicalEfficiency,
    });
  }

  const stopped = phase.dividerEnd?.componentId;
  const moving = branches.find((branch) => branch.target.componentId !== stopped);
  const resting = branches.find((branch) => branch.target.componentId === stopped);
  const trim = divider.typeId === 'synchronizing-flow-divider';
  const { correctionAreaM2, correctionDifferentialPa, correctionGateM3PerS } = h;
  if (trim && (!correctionAreaM2 || !correctionDifferentialPa || !correctionGateM3PerS))
    return pending('缺少纠偏面积、差压阈值或低流量门槛。');
  const qCommon = forward ? pumpFlow : pumpFlow / branches.reduce((sum, b) => sum + (b.share * b.rod) / b.cap, 0);
  const qReturn = forward
    ? branches.reduce(
        (sum, b) => sum + ((stopped ? (b === moving ? pumpFlow : 0) : qCommon * b.share) * b.rod) / b.cap,
        0,
      )
    : qCommon;
  const returnBoundary = tankPressurePa + commonResistance * qReturn ** 2;
  const demandPressure = (b: DividerBranch) => (b.load + returnBoundary * b.rod) / b.cap;
  let commonPressure = returnBoundary;
  let workPressure = 0;
  let correction: DividerFlowDetails['correction'];
  if (phase.dividerEnd) {
    if (
      !trim ||
      !forward ||
      !moving ||
      !resting ||
      !correctionAreaM2 ||
      !correctionDifferentialPa ||
      !correctionGateM3PerS
    )
      return pending('末端纠偏须选同步阀伸出工况及参与动作的一只到位缸。');
    const pStopped = phase.dividerEnd.pressurePa;
    const pMoving = demandPressure(moving);
    const difference = pStopped - pMoving;
    const weight = Math.min(1, (difference - correctionDifferentialPa) / correctionDifferentialPa);
    if (!(weight > 0) || pStopped < demandPressure(resting))
      return pending('停缸口压力不足以满足纠偏差压门槛或维持伸出端位。');
    commonPressure =
      pMoving + orificeResistance(fluid.densityKgPerM3, h.flowCoefficient, correctionAreaM2) * (pumpFlow / weight) ** 2;
    if (
      pStopped < commonPressure ||
      pStopped - commonPressure > correctionDifferentialPa ||
      pStopped - commonPressure >= commonPressure - pMoving
    )
      return pending('给定停缸口压力下未找到主路零流且纠偏指向未到位缸的固定供流平衡。');
    workPressure = commonPressure;
    correction = {
      stoppedLabel: resting.target.label,
      pressureDifferencePa: difference,
      thresholdPa: correctionDifferentialPa,
      flowGateM3PerS: correctionGateM3PerS,
      openingWeight: weight,
    };
  } else if (forward) {
    commonPressure = Math.max(...branches.map((b) => demandPressure(b) + resistance * (qCommon * b.share) ** 2));
    workPressure = commonPressure;
  } else {
    workPressure = Math.max(
      ...branches.map((b) => (b.load + b.cap * (commonPressure + resistance * (qCommon * b.share) ** 2)) / b.rod),
    );
  }
  const pumpPressure = workPressure + commonResistance * pumpFlow ** 2;
  if (!Number.isFinite(pumpPressure) || pumpPressure > 70e6) return pending('固定供流的工作点超出 70 MPa 核算范围。');
  for (const relief of components.filter((part) => part.typeId === 'relief')) {
    const setting = relief.parameters.hydraulic?.settingDifferentialPa;
    if (
      relief.definition.id !== 'teaching:relief' ||
      !ideal(pumpPort, port(relief, 'P')) ||
      !ideal(port(relief, 'T'), tankPort) ||
      setting === undefined ||
      pumpPressure > tankPressurePa + setting
    )
      return pending('直动溢流接线或设定不能证明阀未开启；分流与溢流耦合待核。');
  }
  const internal = pump.parameters.relief;
  if (
    internal?.enabled === 1 &&
    (internal.settingDifferentialPa === undefined || pumpPressure > tankPressurePa + internal.settingDifferentialPa)
  )
    return pending('泵内溢流开启或设定缺失，实际分流待核。');

  const outcomes = branches.map((b) => {
    const flowM3PerS = correction ? (b === resting ? 0 : pumpFlow) : qCommon * b.share;
    const pressurePa = forward
      ? b === resting && phase.dividerEnd
        ? phase.dividerEnd.pressurePa
        : demandPressure(b)
      : (workPressure * b.rod - b.load) / b.cap;
    const dropPa = forward ? commonPressure - pressurePa : pressurePa - commonPressure;
    const limiting = flowM3PerS > 0 && !correction && Math.abs(dropPa - resistance * flowM3PerS ** 2) <= 1e-6;
    return { branch: b, reading: { port: b.name, label: b.target.label, pressurePa, flowM3PerS, dropPa, limiting } };
  });
  const ports = outcomes.map(({ reading }) => reading);
  if (
    !correction &&
    correctionGateM3PerS &&
    correctionDifferentialPa &&
    qCommon < correctionGateM3PerS &&
    Math.max(...ports.map((p) => p.pressurePa)) - Math.min(...ports.map((p) => p.pressurePa)) > correctionDifferentialPa
  )
    return pending('同时运动时主流低于纠偏门槛且两支路压差越阈，主路与纠偏混合待核。');
  const results = outcomes.map(({ branch: b, reading }): ParallelFlowBranch => {
    const valveFlow = reading.flowM3PerS;
    const inletAreaM2 = forward ? b.cap : b.rod;
    const flowM3PerS = forward ? valveFlow : (valveFlow * b.rod) / b.cap;
    const speedMPerS = flowM3PerS / inletAreaM2;
    const ratio = b === resting ? 1 : speedMPerS / b.target.targetSpeedMPerS;
    return {
      ...b.target,
      valveId: valve.id,
      valveAreaM2: valveArea,
      inletAreaM2,
      flowM3PerS,
      speedMPerS,
      returnBoundaryPa: tankPressurePa,
      returnFlowM3PerS: forward ? (flowM3PerS * b.rod) / b.cap : valveFlow,
      returnPressurePa: forward ? returnBoundary : reading.pressurePa,
      closed: false,
      status: b === resting ? 'end-stop' : ratio < 0.99 ? 'slow' : ratio > 1.01 ? 'fast' : 'matched',
    };
  });
  const reasons = pumpPressure > pressureBudgetPa ? ['该固定供流点所需泵压超出本工况供油预算。'] : [];
  return {
    kind: 'solved',
    pressurePa: pumpPressure,
    pumpFlowM3PerS: pumpFlow,
    reliefFlowM3PerS: 0,
    shaftPowerW: ((pumpPressure - tankPressurePa) * pumpFlow) / totalEfficiency,
    matchesTargets: !reasons.length && results.every((b) => b.status === 'matched' || b.status === 'end-stop'),
    branches: results,
    reasons,
    divider: {
      label: label(divider),
      mode: correction ? 'correction' : forward ? 'division' : 'combining',
      commonPressurePa: commonPressure,
      aShare,
      ports,
      ...(correction ? { correction } : {}),
    },
  };
}
