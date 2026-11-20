import { servicePoint, serviceStudies } from './network-duty-calibrated.js';
import { transientConditions, transientPoint } from './network-duty-transient.js';
import { loadConditions, loadStudyPoint } from './network-duty-overrunning.js';
import { storageLine } from './network-duty-storage-line.js';
import { pumpStoragePoint, resetPoint } from './network-duty-storage-cycle.js';
import { sourceControlMode, sourceControlConditions, sourceControlPoint } from './network-duty-source-control.js';
import { diagnostic, immutable, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import { dutyPhasePaths, type DutyPhasePaths } from './network-duty-accessories.js';
import { orificeResistance } from './network-duty-flow-split.js';
import type { DutyPhase, DutyBoundaryDemand, NetworkDutyPlan, NetworkDutyRequest } from './network-duty.js';
import type { CalculationStep } from './network-learning.js';

export function boundaryDutyConditions(project: NetworkProject, request: NetworkDutyRequest): readonly string[] {
  if (request.phases.every((p) => p.service))
    return [...new Set(request.phases.flatMap((p) => (p.service ? [serviceStudies[p.service.mode].condition] : [])))];
  if (request.phases.some((p) => p.transient)) return transientConditions(project);
  if (request.phases.some((p) => p.loadStudy)) return loadConditions(request.phases);
  if (request.phases.some((p) => p.resetStudy))
    return [
      '增压器 IN 与 R 充分卸压至同一油箱，H 隔离。按该背压和负载下实测或厂家给出的平均净复位流量与剩余扫掠容积估算复位时间，未计换向延时。',
    ];
  if (request.phases.some((p) => p.pumpStorage))
    return [
      '定量泵恒速，泵容积效率作用于理论流量，另计保存的压差泄漏及内置溢流。采用准稳态阀口与气体多变模型；忽略油液压缩、阀响应延迟及压力冲击。',
      '卸荷阀由 X−T 压差控制，压力开关监测同一储油节点，动作与复位阈值按各自压力基准核对。循环温升采用整周期平均轴功率全部进入所给热容，按恒定环境温度与散热系数估算。',
    ];
  if (project.design.components.some((part) => part.typeId === 'accumulator'))
    return [
      '蓄能器按指定油量核算。气体使用绝压、多变指数和保存的气体容积下限。储能为相对预充空态的气体压缩功。按实际接线列瞬时流量。隔离保压需明确截止状态及泄漏支路；理想密封按零泄漏估算。',
      ...(request.phases.some((phase) => phase.accumulatorTargetOilVolumeM3 !== undefined)
        ? [
            '充放油时间限恒压边界经直连、一段物理管或一只给定开口的节流阀接单只气囊式蓄能器 H。边界在整个工况保持压力，可供油并吸收回流。初始与目标油量均由本工况给出，口部采用保存的线性阻力。',
            '按气体压力随油量变化积分计算时间。正流量为充油，负流量为放油。若目标恰好等于平衡油量，只能渐近接近。空囊目标列到达前的流量，到达空囊后排油截止。',
            '保存的多变指数视为恒定。真实供回油能力、温度变化、阀切换、附加管路与冲击另验。',
          ]
        : ['瞬时流量对应本行指定油量。充放油时间需另填目标油量，循环温度另验。']),
    ];
  const source =
    '单四通换向阀连接一只普通双作用缸并回同一油箱。按保存阀口、阻性负载和力平衡求供流、缸速及液压功率。恒压源为理想边界，实际源额定流量和动态响应另验。';
  return project.design.components.some((part) => part.typeId === 'pressure-intensifier')
    ? [
        source,
        '增压器 IN 接恒压源，H 给换向阀供油，R 回同一油箱。按伸出和换向回程分别联立负载、增压通路和补油旁路。回程指油缸换向，增压器两条通路均由 IN 向 H。',
      ]
    : [source];
}

const number = (value: number) => Number(value.toPrecision(6));
const lpm = (value: number) => number(value * 60000) + ' L/min';
const mp = (value: number) => number(value / 1e6) + ' MPa';
const liters = (value: number) => number(value * 1000) + ' L';
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/supply-storage', message)],
});

export type StepWriter = (
  id: string,
  label: string,
  formula: string,
  value: number,
  unit: string,
  scale?: number,
  display?: string,
) => void;
const ideal = (paths: DutyPhasePaths, from: string, to: string) =>
  paths.uniquePath(from, to)?.every((arc) => arc.ideal) === true;

// Integrate dV/|q| using log|pSource−pg| as the coordinate. This removes the
// equilibrium pole from the integrand while retaining the growing time interval.
function transferDuration(
  startGap: number,
  endGap: number,
  sourcePa: number,
  precharge: number,
  total: number,
  exponent: number,
  rate: (gap: number) => number,
): number | undefined {
  const first = Math.log(Math.abs(startGap));
  const last = Math.log(Math.abs(endGap));
  const sign = Math.sign(startGap);
  let previous = 0;
  for (let panels = 8; panels <= 4096; panels *= 2) {
    let sum = 0;
    for (let i = 0; i <= panels; i++) {
      const gap = sign * Math.exp(first + ((last - first) * i) / panels);
      const gasPa = sourcePa - gap;
      const gasVolume = total * (precharge / gasPa) ** (1 / exponent);
      sum += (i === 0 || i === panels ? 1 : i % 2 === 0 ? 2 : 4) * (gasVolume / gasPa) * Math.abs(gap / rate(gap));
    }
    const seconds = (Math.abs(last - first) * sum) / (3 * panels * exponent);
    if (seconds > 0 && Number.isFinite(seconds) && Math.abs(seconds - previous) <= seconds * 1e-8) return seconds;
    previous = seconds;
  }
  return undefined;
}

function storagePoint(
  project: NetworkProject,
  phase: DutyPhase,
  storage: NetworkComponent,
  source: NetworkComponent | undefined,
  add: StepWriter,
): Result<DutyBoundaryDemand> {
  const oil = phase.accumulatorOilVolumeM3;
  const {
    totalVolumeM3: total,
    prechargeAbsolutePa: precharge,
    polytropicExponent: exponent,
    minimumGasFraction: minimum,
  } = storage.parameters.gas ?? {};
  const resistance = storage.parameters.hydraulic?.portResistancePaSPerM3;
  const reference = project.design.pressureReference;
  const offset = reference.absoluteReferencePa;
  if (
    oil === undefined ||
    !total ||
    !precharge ||
    !exponent ||
    !minimum ||
    !resistance ||
    reference.kind !== 'gauge' ||
    !offset ||
    phase.actions.length ||
    phase.valves.length
  )
    return fail(phase.name + '：需明确油量、预充绝压、气体参数和工程表压零点。储能状态须单独核算。');
  const gas = total - oil;
  if (gas < total * minimum - 1e-14 * total) return fail(phase.name + '：指定油量超过保存的最小气体容积边界。');
  const gasPressure = (gasVolume: number) => precharge * Math.exp(exponent * Math.log(total / gasVolume));
  const absolute = gasPressure(gas);
  if (!Number.isFinite(absolute) || absolute > 20e6) return fail(phase.name + '：气体压力超出模型 20 MPa 绝压边界。');
  const delta = exponent - 1;
  const gasEnergy = (gasVolume: number) => {
    const logRatio = Math.log(total / gasVolume);
    return precharge * total * (delta === 0 ? logRatio : Math.expm1(delta * logRatio) / delta);
  };
  const energy = gasEnergy(gas);
  const target = phase.accumulatorTargetOilVolumeM3;
  add('precharge', '预充绝压', '保存气体预充', precharge, 'Pa', 1e-6, 'MPa');
  add('total', '预充空态的气体容积', '保存公称容积', total, 'm³', 1000, 'L');
  add('exponent', '气体多变指数', '保存多变指数', exponent, '1');
  add('oil', target === undefined ? '指定油量' : '起始油量', '工况油量', oil, 'm³', 1000, 'L');
  add('gas', '剩余气体体积', 'Vg = V0 − Vo', gas, 'm³', 1000, 'L');
  add('absolute', '气体绝压', 'pg = p0 × (V0 / Vg)^n', absolute, 'Pa', 1e-6, 'MPa');
  add(
    'energy',
    '相对预充空态的储能',
    delta === 0 ? 'E = p0 × V0 × ln(V0 / Vg)' : 'E = p0 × V0 × [(V0 / Vg)^(n−1) − 1] / (n−1)',
    energy,
    'J',
  );
  let summary = '气体绝压 ' + mp(absolute) + '，油量 ' + number(oil * 1000) + ' L，储能 ' + number(energy) + ' J。';
  let satisfied = true;
  let sourcePa: number | undefined;
  let rate = (gap: number) => gap / resistance;
  let sealed = false;
  let checkRate: (q: number) => Result<unknown> = () => ({ ok: true, value: true });
  const pending = (reason: string): Result<DutyBoundaryDemand> => ({
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: { summary: summary + ' ' + reason, satisfied: false, transfer: 'pending' },
    },
  });
  if (source) {
    const line = storageLine(project, phase, source, storage, resistance);
    if (!line.ok) return pending(line.diagnostics.map((d) => d.message).join('；'));
    const pressure = source.parameters.hydraulic?.pressurePa;
    if (pressure === undefined || pressure + offset <= 0) return pending('边界压力或绝压基准待核。');
    sourcePa = pressure + offset;
    rate = line.value.rate;
    sealed = line.value.sealed;
    checkRate = line.value.check;
    summary += line.value.label + '。';
    const rawFlow = rate(sourcePa - absolute);
    const flow = oil === 0 ? Math.max(0, rawFlow) : rawFlow;
    const beyond = flow > 0 && gas <= total * minimum + 1e-14 * total;
    satisfied = !beyond;
    const domain = checkRate(flow);
    if (!domain.ok) return pending(domain.diagnostics.map((d) => d.message).join('；'));
    add('source-pressure', '压力边界表压', '保存边界压力', pressure, 'Pa', 1e-6, 'MPa');
    if (!sealed)
      add(
        'line-drop',
        '起点串联通路压降',
        '|p边界 − pH|',
        oil === 0 && rawFlow < 0 ? 0 : Math.abs(sourcePa - absolute - resistance * flow),
        'Pa',
        1e-6,
        'MPa',
      );
    add(
      'terminal',
      'H 口边界表压',
      'pg,abs − p参考 + RH × qH（空囊截止时取连接边界）',
      oil === 0 && rawFlow < 0 && !sealed ? pressure : absolute - offset + resistance * flow,
      'Pa',
      1e-6,
      'MPa',
    );
    add('reference', '工程表压零点的绝压', '工程压力基准', offset, 'Pa', 1e-6, 'MPa');
    add('port-resistance', '蓄能器口部阻力', '保存口部阻力', resistance, 'Pa·s/m³');
    if (beyond) summary += '已到最小气体容积边界，继续充油待核。';
    else {
      add('rate', 'H 口瞬时流量（正为充油）', 'qH = (pH,abs − pg) / RH，空囊禁止放油', flow, 'm³/s', 60000, 'L/min');
      summary += '瞬时' + (flow > 0 ? '充油 ' + lpm(flow) : flow < 0 ? '放油 ' + lpm(-flow) : '无充放油') + '。';
    }
  }
  if (target !== undefined) {
    add('target-oil', '目标油量', '工况目标', target, 'm³', 1000, 'L');
    const outcome = (transfer: NonNullable<DutyBoundaryDemand['boundaryAssessment']['transfer']>, message: string) => ({
      ok: true as const,
      value: {
        name: phase.name,
        boundaryAssessment: { summary: summary + ' ' + message, satisfied: transfer === 'timed', transfer },
      },
    });
    if (sourcePa === undefined) return outcome('pending', '充放油时间待核，需恒压边界 P 直连 H。');
    const targetGas = total - target;
    if (targetGas < total * minimum - 1e-14 * total)
      return outcome('pending', '目标油量超过保存的最小气体容积边界，充放油时间待核。');
    const targetPa = gasPressure(targetGas);
    if (!Number.isFinite(targetPa) || targetPa > 20e6)
      return outcome('pending', '目标气体压力超出 20 MPa 绝压边界，充放油时间待核。');
    const oilChange = target - oil;
    let seconds = 0;
    if (oilChange !== 0) {
      const direction = Math.sign(oilChange);
      const startGap = sourcePa - absolute;
      const endGap = sourcePa - targetPa;
      const gapTolerance = 32 * Number.EPSILON * Math.max(sourcePa, absolute, targetPa);
      if (sealed) return outcome('blocked', '隔离支路零流量，按理想密封保压，目标油量不可达。');
      const domain = checkRate(rate(endGap));
      if (!domain.ok) return outcome('pending', domain.diagnostics.map((d) => d.message).join('；'));
      if (direction * startGap <= gapTolerance)
        return outcome('blocked', '起始压差不足以沿目标方向充放油，目标不可达。');
      if (Math.abs(endGap) <= gapTolerance)
        return outcome('blocked', '目标油量对应平衡压力，只能渐近接近，无有限到达时间。');
      if (direction * endGap < 0) return outcome('blocked', '目标越过平衡油量，压差先降为零，目标不可达。');
      const duration = transferDuration(startGap, endGap, sourcePa, precharge, total, exponent, rate);
      if (duration === undefined) return outcome('pending', '时间积分未通过数值收敛校核，充放油时间待核。');
      seconds = duration;
      add('target-rate', '到达目标前的 H 口流量', 'qH = (pH,abs − pg,目标) / RH', rate(endGap), 'm³/s', 60000, 'L/min');
    }
    add('target-absolute', '目标气体绝压', 'pg = p0 × (V0 / Vg)^n', targetPa, 'Pa', 1e-6, 'MPa');
    add('oil-change', '油量变化（正为充油）', 'ΔVo = Vo,目标 − Vo,起始', oilChange, 'm³', 1000, 'L');
    add('energy-change', '气体压缩功变化', 'ΔE = E目标 − E起始', gasEnergy(targetGas) - energy, 'J');
    add('duration', '到达目标油量时间', 't = ∫ |dVo / qH(Vo)|，按实际串联通路逐点联立', seconds, 's');
    return outcome(
      'timed',
      oilChange === 0
        ? '起始油量等于目标油量，已到目标，用时 0 s。'
        : `${oilChange > 0 ? '充油' : '放油'} ${liters(Math.abs(oilChange))} 至 ${liters(target)}，到达时间 ${number(seconds)} s，目标气体绝压 ${mp(targetPa)}。${target === 0 ? '到达空囊后排油截止。' : ''}`,
    );
  }
  return {
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: { summary, satisfied },
    },
  };
}

function actuatorPoint(
  project: NetworkProject,
  phase: DutyPhase,
  source: NetworkComponent,
  cylinder: NetworkComponent,
  valve: NetworkComponent,
  tank: NetworkComponent,
  intensifier: NetworkComponent | undefined,
  add: StepWriter,
): Result<DutyBoundaryDemand> {
  const action = phase.actions[0];
  const pressure = source.parameters.hydraulic?.pressurePa;
  const returnPressure = tank.parameters.hydraulic?.pressurePa;
  const area = valve.parameters.hydraulic?.maximumAreaM2;
  const cq = valve.parameters.hydraulic?.flowCoefficient;
  if (
    !action ||
    phase.actions.length !== 1 ||
    action.componentId !== cylinder.id ||
    !area ||
    !cq ||
    pressure === undefined ||
    returnPressure === undefined ||
    phase.valves.length !== 1 ||
    !['teaching:directional-2-4', 'teaching:directional-3-4'].includes(valve.definition.id) ||
    action.volumetricEfficiency !== 1 ||
    action.supplyLossPa !== 0 ||
    Math.abs(action.returnPressurePa - returnPressure) > 1e-6
  )
    return fail(phase.name + '：须明确单缸、四通换向阀及有效阀口，缸容积效率取 1、回油基准取油箱、其余供油压降填 0。');
  const forward = action.direction === 'forward';
  const cap = cylinder.parameters.geometry?.capAreaM2;
  const rod = cylinder.parameters.geometry?.rodSideAreaM2;
  if (!cap || !rod) return fail(phase.name + '：缺少双作用缸两腔面积。');
  const inletArea = forward ? cap : rod;
  const ratio = (forward ? rod : cap) / inletArea;
  const sourcePort = source.id + ':P';
  const supply = intensifier ? intensifier.id + ':H' : sourcePort;
  const t = tank.id + ':T';
  const cA = cylinder.id + ':A',
    cB = cylinder.id + ':B';
  const paths = dutyPhasePaths(project, phase, false);
  if (!paths.ok) return paths;
  const graph = paths.value;
  const nets = [...new Set([sourcePort, supply, t, cA, cB])];
  if (
    nets.some((p, i) => nets.slice(i + 1).some((q) => graph.idealReachable(p, q))) ||
    !ideal(graph, supply, valve.id + ':P') ||
    !ideal(graph, valve.id + ':T', t) ||
    !ideal(graph, valve.id + ':A', cA) ||
    !ideal(graph, valve.id + ':B', cB) ||
    (intensifier && (!ideal(graph, sourcePort, intensifier.id + ':IN') || !ideal(graph, intensifier.id + ':R', t))) ||
    !graph.reachable(supply, forward ? cA : cB) ||
    !graph.reachable(forward ? cB : cA, t) ||
    graph.reachable(supply, t)
  )
    return fail(phase.name + '：供回油或 IN/H/R 接线与工况阀位不符，或存在并联旁路。');

  const staticPressure = action.resistingLoad / (inletArea * action.mechanicalEfficiency) + ratio * returnPressure;
  if (!Number.isFinite(staticPressure) || staticPressure > 70e6)
    return fail(phase.name + '：静载开启压力超出 70 MPa 核算范围。');
  const k = orificeResistance(project.design.fluid.densityKgPerM3, cq, area);
  add('static', '静载开启压力', 'p静载 = F / (A进 × η机械) + pT × A出 / A进', staticPressure, 'Pa', 1e-6, 'MPa');
  add('metering', '换向阀单侧孔口阻力', 'K = ρ / [2(Cq × A阀)²]', k, 'Pa·s²/m⁶');
  const equivalent = k * (1 + ratio ** 3);
  add('equivalent-metering', '供回油折算阻力', 'K等效 = K × [1 + (A出 / A进)³]', equivalent, 'Pa·s²/m⁶');
  const work = (flow: number) => staticPressure + equivalent * flow ** 2;
  let flow = Math.sqrt(Math.max(0, pressure - staticPressure) / equivalent);
  let supplyFlow = flow;
  let workingPressure = pressure;
  if (intensifier) {
    const {
      intensificationRatio: r,
      boostResistancePaSPerM3: boostR,
      bypassResistancePaSPerM3: bypassR,
      bypassCrackingPa: crack,
    } = intensifier.parameters.hydraulic ?? {};
    if (!r || !boostR || !bypassR || crack === undefined || pressure < returnPressure)
      return fail(phase.name + '：增压比、通路阻力或 IN/R 压差缺失或超出范围。');
    const boostHead = returnPressure + r * (pressure - returnPressure);
    const fillHead = pressure - crack;
    const at = (pH: number) => ({
      boost: Math.max(0, boostHead - pH) / boostR,
      bypass: Math.max(0, fillHead - pH) / bypassR,
    });
    const open = at(staticPressure);
    let low = 0,
      high = open.boost + open.bypass;
    for (let i = 0; i < 64; i++) {
      const mid = low + (high - low) / 2;
      const branches = at(work(mid));
      if (mid < branches.boost + branches.bypass) low = mid;
      else high = mid;
    }
    flow = low + (high - low) / 2;
    workingPressure = flow === 0 ? Math.max(boostHead, fillHead) : work(flow);
    const { boost, bypass } = at(workingPressure);
    supplyFlow = r * boost + bypass;
    add('ratio', '保存增压比', 'IN/R 与 H/R 理想差压比', r, '1');
    add('boost', 'IN→H 增压通路流量', 'Qb = max[0, r(pIN − pR) − (pH − pR)] / Rb', boost, 'm³/s', 60000, 'L/min');
    add('bypass', 'IN→H 补油旁路流量', 'Qf = max(0, pIN − pH − Δp开启) / Rf', bypass, 'm³/s', 60000, 'L/min');
    add('return', 'R 口回箱流量', 'QR = (r − 1) × Qb', (r - 1) * boost, 'm³/s', 60000, 'L/min');
    add('high', flow > 0 ? 'H 口供油压力' : 'H 口零流压力上限', '增压器与负载交点', workingPressure, 'Pa', 1e-6, 'MPa');
  }
  if (
    ![workingPressure, supplyFlow, flow].every(Number.isFinite) ||
    workingPressure > 70e6 ||
    pressure < returnPressure
  )
    return fail(phase.name + '：联立工作点超出压力或流量范围。');
  const speed = flow / inletArea;
  const satisfied = speed >= action.speed * (1 - 1e-8);
  add('pressure', '恒压源压力', '保存供压', pressure, 'Pa', 1e-6, 'MPa');
  add(
    'source-flow',
    '恒压源供流',
    intensifier ? 'QIN = r × Qb + Qf' : 'Q = √[max(0, pS − p静载) / K等效]',
    supplyFlow,
    'm³/s',
    60000,
    'L/min',
  );
  add(
    'actuator-flow',
    '油缸实际进油量',
    intensifier ? 'QH = Qb + Qf' : '油缸与源流量相同',
    flow,
    'm³/s',
    60000,
    'L/min',
  );
  add('actuator-return', '油缸排油量', 'Q出 = Q进 × A出 / A进', flow * ratio, 'm³/s', 60000, 'L/min');
  if (flow > 0) {
    add('chamber-in', '进油腔压力', 'p进 = p供 − K × Q进²', workingPressure - k * flow ** 2, 'Pa', 1e-6, 'MPa');
    add(
      'chamber-out',
      '排油腔压力',
      'p出 = pT + K × Q出²',
      returnPressure + k * (flow * ratio) ** 2,
      'Pa',
      1e-6,
      'MPa',
    );
  }
  add('speed', '油缸实际速度', 'v = Q / A进', speed, 'm/s', 1000, 'mm/s');
  add('target', '工况目标速度', '给定速度', action.speed, 'm/s', 1000, 'mm/s');
  add('power', '供油液压功率', 'P = (pS − pT) × QIN', (pressure - returnPressure) * supplyFlow, 'W');
  const summary =
    '源压 ' +
    mp(pressure) +
    '，源供流 ' +
    lpm(supplyFlow) +
    '，油缸进油 ' +
    lpm(flow) +
    '，实际缸速 ' +
    number(speed * 1000) +
    ' mm/s，目标 ' +
    number(action.speed * 1000) +
    ' mm/s。' +
    (satisfied ? '供流达到目标速度要求。' : '供流不足以达到目标速度。');
  return { ok: true, value: { name: phase.name, boundaryAssessment: { summary, satisfied } } };
}

export function checkBoundaryDuty(
  project: NetworkProject,
  request: NetworkDutyRequest,
  offset: number,
): Result<NetworkDutyPlan> {
  const { components, connections } = project.design;
  const parts = (type: string) => components.filter((part) => part.typeId === type);
  const [source] = parts('pressure-source');
  const [storage] = parts('accumulator');
  const [valve] = parts('valve');
  const [tank] = parts('tank');
  const [cylinder] = parts('cylinder');
  const [intensifier] = parts('pressure-intensifier');
  const mode = sourceControlMode(project, request);
  if (mode && request.phases.some((p) => p.pumpStorage || p.resetStudy || p.loadStudy || p.transient))
    return fail('储能与自动动作须单独核算，不能与其他供源控制混用。');
  const pump = parts('pump')[0];
  const selected = request.phases.some((p) => p.pumpStorage) ? pump : (source ?? storage ?? intensifier);
  const scope = storage ? [source, storage] : [source, cylinder, valve, tank, intensifier];
  if (
    !mode &&
    !request.phases.every((p) => p.loadStudy || p.transient || p.service) &&
    (!selected ||
      request.pumpId !== selected.id ||
      (!storage &&
        !request.phases.every((p) => p.resetStudy) &&
        (components.length !== scope.filter(Boolean).length || connections.some((edge) => edge.kind !== 'ideal'))) ||
      (storage && !source && !tank && components.length !== 1))
  )
    return fail('限独立恒压供油、单级增压回路或单只蓄能器储能状态，采用唯一理想连接。');
  const phases: DutyBoundaryDemand[] = [];
  const steps: CalculationStep[] = [];
  for (const [index, phase] of request.phases.entries()) {
    if (
      !mode &&
      (phase.flowSplit ||
        phase.pumpCommandPercent !== undefined ||
        phase.dividerEnd ||
        (phase.shutoffs?.length && (!storage || source || pump)) ||
        phase.filterBypass ||
        phase.pumpPressureControl ||
        phase.loadSenseMarginPa !== undefined ||
        (phase.switchPrevious !== undefined && !phase.pumpStorage) ||
        phase.actions.some(
          (action) => action.positionM !== undefined || action.rotaryAngleRad !== undefined || action.motorSetting,
        ))
    )
      return fail(phase.name + '：本边界不支持混合工况指令。');
    const add: StepWriter = (id, label, formula, value, unit, scale = 1, display = unit) =>
      steps.push({
        key: 'phase' + (index + offset) + ':' + id,
        label: phase.name + ' · ' + label,
        source: 'preliminary',
        formula,
        value: { kind: 'known', value },
        inputs: [],
        substitution: '',
        unit,
        display: { unit: display, value: { kind: 'known', value: value * scale }, conversion: '显示值=SI值×' + scale },
      });
    const point = phase.service
      ? servicePoint(project, phase, phase.service, add)
      : phase.transient
        ? transientPoint(project, request, phase, add)
        : phase.loadStudy
          ? loadStudyPoint(project, request, phase, add)
          : mode
            ? sourceControlPoint(project, request, phase, mode, add)
            : phase.pumpStorage
              ? pumpStoragePoint(project, request, phase, add)
              : phase.resetStudy
                ? resetPoint(project, phase, add)
                : storage
                  ? storagePoint(project, phase, storage, source ?? tank, add)
                  : source && cylinder && valve && tank && phase.accumulatorOilVolumeM3 === undefined
                    ? actuatorPoint(project, phase, source, cylinder, valve, tank, intensifier, add)
                    : fail(phase.name + '：缺少恒压源、普通双作用缸、四通阀或油箱。');
    if (!point.ok) return point;
    phases.push(point.value);
  }
  return {
    ok: true,
    value: immutable({
      request,
      phases,
      requiredDisplacementM3PerRev: 0,
      availableFlowM3PerS: 0,
      changes: [],
      document: project,
      constraints: [],
      reliefLimits: [],
      record: {
        format: 'HydraulicLearningCalculation',
        version: 1,
        kind: 'preliminary',
        title: request.phases.some((p) => p.service)
          ? '标定专项核算'
          : request.phases.some((p) => p.transient)
            ? '瞬态峰值与事件核算'
            : request.phases.some((p) => p.loadStudy)
              ? '负载功率方向与吸油低压'
              : (mode ?? '供压、储能与增压工况'),
        document: project,
        identity: null,
        context: null,
        steps,
        dutyConditions: mode ? sourceControlConditions(mode) : boundaryDutyConditions(project, request),
        assumptions: [
          ...(request.phases.some((p) => p.service)
            ? boundaryDutyConditions(project, request)
            : request.phases.some((p) => p.transient)
              ? transientConditions(project)
              : mode
                ? sourceControlConditions(mode)
                : ['工况输入采用工程压力基准，蓄能器气体换算为绝压。']),
          JSON.stringify(request.phases),
        ],
      },
    }),
  };
}
