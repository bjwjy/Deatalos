import { diagnostic, type NetworkProject, type Result } from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import type { DutyPhase, DutyBoundaryDemand, NetworkDutyRequest } from './network-duty.js';
import type { StepWriter } from './network-duty-supply-storage.js';

const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/storage-cycle', message)],
});
function result(
  phase: DutyPhase,
  summary: string,
  transfer: 'timed' | 'blocked' | 'pending',
): Result<DutyBoundaryDemand> {
  return {
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: {
        summary,
        study: phase.resetStudy ? 'reset' : 'cycle',
        satisfied: transfer === 'timed',
        transfer,
      },
    },
  };
}
const fmt = (x: number) => Number(x.toPrecision(6));
export function resetPoint(project: NetworkProject, phase: DutyPhase, add: StepWriter): Result<DutyBoundaryDemand> {
  const parts = project.design.components,
    boost = parts.find((c) => c.typeId === 'pressure-intensifier'),
    tank = parts.find((c) => c.typeId === 'tank');
  if (
    !boost ||
    !tank ||
    parts.length !== 2 ||
    phase.actions.length ||
    phase.valves.length ||
    project.design.connections.some((c) => c.kind !== 'ideal')
  )
    return fail('内部复位试验须单只增压器与单油箱，IN、R 卸压且 H 隔离。');
  const paths = dutyPhasePaths(project, phase, false);
  if (!paths.ok) return paths;
  const same = (port: string) => paths.value.idealReachable(boost.id + ':' + port, tank.id + ':T');
  if (
    !same('IN') ||
    !same('R') ||
    same('H') ||
    project.design.connections.some((e) =>
      [e.from, e.to].some((p) => p.kind === 'port' && p.componentId === boost.id && p.portId === 'H'),
    )
  )
    return fail('复位试验 IN、R 须接同一油箱，H 口须隔离。');
  const { sweptM3, flowM3PerS, backPa } = phase.resetStudy ?? {};
  const tankPa = tank.parameters.hydraulic?.pressurePa;
  if (backPa !== undefined) add('measured-back', '测定复位流量时的 R 口背压', '输入', backPa, 'Pa', 1e-6, 'MPa');
  if (tankPa !== undefined) add('reset-tank', 'R 口回箱背压', '油箱表压', tankPa, 'Pa', 1e-6, 'MPa');
  if (sweptM3 !== undefined) add('reset-volume', '剩余复位扫掠容积', '输入', sweptM3, 'm³', 1000, 'L');
  if (flowM3PerS !== undefined)
    add(
      'reset-flow',
      '平均净复位流量',
      '同一背压、H 隔离与复位机构条件下的实测或厂家数据',
      flowM3PerS,
      'm³/s',
      60000,
      'L/min',
    );
  if (sweptM3 === undefined || flowM3PerS === undefined || backPa === undefined)
    return result(
      phase,
      '复位时间待核，缺少' +
        [
          sweptM3 === undefined ? '剩余扫掠容积' : '',
          flowM3PerS === undefined ? '平均净复位流量' : '',
          backPa === undefined ? '测定流量时的 R 口背压' : '',
        ]
          .filter(Boolean)
          .join('、') +
        '。',
      'pending',
    );
  if (tankPa === undefined || Math.abs(tankPa - backPa) > 1)
    return result(phase, '流量的测定背压与实际 R 口不一致，复位时间待核。', 'pending');
  if (flowM3PerS === 0 && sweptM3 > 0) return result(phase, '平均净复位流量为零，无法完成剩余行程。', 'blocked');
  const t = sweptM3 === 0 ? 0 : sweptM3 / flowM3PerS;
  add('reset-time', '增压器内部复位时间', 't = 剩余扫掠容积 / 平均净复位流量', t, 's');
  return result(phase, '给定复位流量下，内部复位时间 ' + fmt(t) + ' s。', 'timed');
}

interface Point {
  h: number;
  oil: number;
  gas: number;
  q: number;
  shaft: number;
  bleed: number;
  bypass: number;
  feed: number;
  pp: number;
}
interface Leg {
  time: number;
  energy: number;
  feed: number;
  bleed: number;
  bypass: number;
}
function integrate(start: Point, end: Point, at: (h: number) => Point): Leg | undefined {
  if (start.h === end.h) return { time: 0, energy: 0, feed: 0, bleed: 0, bypass: 0 };
  const sign = Math.sign(end.oil - start.oil);
  if (sign * start.q <= 0 || sign * end.q <= 0) return undefined;
  let previous: Leg | undefined;
  for (let panels = 8; panels <= 2048; panels *= 2) {
    const sums = { time: 0, energy: 0, feed: 0, bleed: 0, bypass: 0 };
    let a = start;
    for (let i = 1; i <= panels; i++) {
      const b = i === panels ? end : at(start.h + ((end.h - start.h) * i) / panels);
      if (sign * b.q <= 0) return undefined;
      const half = (b.oil - a.oil) / 2;
      sums.time += half * (1 / a.q + 1 / b.q);
      sums.energy += half * (a.shaft / a.q + b.shaft / b.q);
      for (const k of ['feed', 'bleed', 'bypass'] as const) sums[k] += half * (a[k] / a.q + b[k] / b.q);
      a = b;
    }
    const prior = previous;
    if (
      prior &&
      (['time', 'energy', 'feed', 'bleed', 'bypass'] as const).every(
        (k) => Math.abs(sums[k] - prior[k]) <= 1e-7 * Math.abs(sums[k]) + 1e-15,
      )
    )
      return sums;
    previous = sums;
  }
  return undefined;
}

export function pumpStoragePoint(
  project: NetworkProject,
  req: NetworkDutyRequest,
  phase: DutyPhase,
  add: StepWriter,
): Result<DutyBoundaryDemand> {
  const parts = project.design.components;
  const part = (type: string) => parts.find((c) => c.typeId === type);
  const pump = part('pump'),
    tank = part('tank'),
    acc = part('accumulator'),
    check = part('check-valve'),
    unload = part('pilot-unloading-valve'),
    sensor = part('adjustable-pressure-switch'),
    load = part('throttle');
  if (
    !pump ||
    pump.definition.id !== 'teaching:pump' ||
    pump.id !== req.pumpId ||
    !tank ||
    !acc ||
    parts.length !== [pump, tank, acc, check, unload, sensor, load].filter(Boolean).length ||
    project.design.connections.some((e) => e.kind !== 'ideal') ||
    phase.actions.length ||
    phase.valves.length ||
    phase.shutoffs?.length ||
    req.totalEfficiency > req.pumpVolumetricEfficiency
  )
    return fail('定量泵储能须单泵、单油箱、单蓄能器、理想连接及有效泵效率。');
  if (
    ((unload || sensor) && !(unload && sensor && check)) ||
    (!unload && (phase.cycleThermal || phase.switchPrevious)) ||
    (unload && phase.accumulatorTargetOilVolumeM3 !== undefined)
  )
    return fail('自动循环需卸荷阀、止回阀和压力开关，循环终点由阈值确定。');
  const paths = dutyPhasePaths(project, phase, false);
  if (!paths.ok) return paths;
  const net = paths.value.idealReachable,
    t = tank.id + ':T',
    hPort = acc.id + ':H',
    p = pump.id + ':P';
  if (
    !net(t, pump.id + ':S') ||
    net(hPort, t) ||
    net(p, t) ||
    (check ? !net(p, check.id + ':A') || !net(hPort, check.id + ':B') || net(hPort, p) : !net(p, hPort)) ||
    (load && (!net(hPort, load.id + ':A') || !net(t, load.id + ':B'))) ||
    (unload && (!net(unload.id + ':P', p) || !net(unload.id + ':T', t) || !net(unload.id + ':X', hPort))) ||
    (sensor && !net(sensor.id + ':H', hPort))
  )
    return fail('需核对泵吸口、止回 A→B、卸荷 P/T/X、压力开关 H 及泄放节流 A→B 的各自接线。');
  const initial = phase.accumulatorOilVolumeM3,
    g = acc.parameters.gas,
    r = acc.parameters.hydraulic?.portResistancePaSPerM3;
  const offset = project.design.pressureReference.absoluteReferencePa,
    tankPa = tank.parameters.hydraulic?.pressurePa,
    disp = pump.parameters.hydraulic?.displacementM3PerRev,
    leak = pump.parameters.hydraulic?.leakageM3PerSPa;
  if (
    initial === undefined ||
    !g ||
    !g.totalVolumeM3 ||
    !g.prechargeAbsolutePa ||
    !g.polytropicExponent ||
    !g.minimumGasFraction ||
    !r ||
    project.design.pressureReference.kind !== 'gauge' ||
    !offset ||
    tankPa === undefined ||
    !disp ||
    leak === undefined
  )
    return fail('需起始油量、工程绝压基准、气体参数、口部阻力、排量、泵泄漏及油箱压力。');
  const total = g.totalVolumeM3,
    p0 = g.prechargeAbsolutePa,
    n = g.polytropicExponent,
    max = total * (1 - g.minimumGasFraction),
    rho = project.design.fluid.densityKgPerM3;
  const tankPressure = tankPa,
    leakage = leak,
    reference = offset,
    portResistance = r;
  add('specified-oil', '给定起始油量', '工况输入', initial, 'm³', 1000, 'L');
  if (initial <= max && p0 * (total / (total - initial)) ** n <= 20e6)
    add(
      'initial-gas',
      '给定油量对应的气体绝压',
      'pg = p0 (V0/Vg)^n',
      p0 * (total / (total - initial)) ** n,
      'Pa',
      1e-6,
      'MPa',
    );
  const q0 = ((disp * req.angularSpeedRadPerS) / (2 * Math.PI)) * req.pumpVolumetricEfficiency;
  const coeff = (cq: number | undefined, area: number | undefined) => (cq ?? 0) * (area ?? 0) * Math.sqrt(2 / rho);
  const arm = (c: typeof check) =>
    coeff(c?.parameters.hydraulic?.flowCoefficient, c?.parameters.hydraulic?.maximumAreaM2);
  const init = project.design.initialConditions.find((i) => i.componentId === load?.id);
  const bleedC = coeff(load?.parameters.hydraulic?.flowCoefficient, init?.kind === 'throttle' ? init.openingAreaM2 : 0);
  const cc = arm(check),
    uc = arm(unload),
    crack = check?.parameters.hydraulic?.openingDifferentialPa ?? 0,
    rel = pump.parameters.relief;
  const relC = rel?.enabled ? coeff(rel.flowCoefficient, rel.maximumAreaM2) : 0;
  if ((load && init?.kind !== 'throttle') || (check && !cc) || (unload && !uc))
    return fail('止回、卸荷或泄放节流的有效开口及流量系数待核。');
  const pos = (x: number) => Math.sqrt(Math.max(0, x));
  function at(h: number, on: boolean): Point {
    const drain = (pp: number) =>
      leakage * Math.max(0, pp - tankPressure) + relC * pos(pp - tankPressure - (rel?.settingDifferentialPa ?? 0));
    const bypass = (pp: number) => (on ? uc * pos(pp - tankPressure) : 0);
    let pp = h,
      feed = q0 - drain(h);
    if (check) {
      let lo = tankPressure,
        hi = h + crack + (q0 / cc) ** 2;
      for (let j = 0; j < 52; j++) {
        const mid = (lo + hi) / 2;
        if (cc * pos(mid - h - crack) + bypass(mid) + drain(mid) < q0) lo = mid;
        else hi = mid;
      }
      pp = (lo + hi) / 2;
      feed = cc * pos(pp - h - crack);
    }
    const bleed = bleedC * pos(h - tankPressure),
      q = feed - bleed,
      gas = h + reference - portResistance * q;
    return {
      h,
      pp,
      gas,
      oil: total * (1 - (p0 / gas) ** (1 / n)),
      q,
      feed,
      bleed,
      bypass: bypass(pp),
      shaft: ((pp - tankPressure) * q0) / req.totalEfficiency,
    };
  }
  function byOil(v: number, on: boolean) {
    if (v < 0 || v > max + 1e-14 * total) return undefined;
    const gas = p0 * (total / (total - v)) ** n;
    if (gas > 20e6) return undefined;
    let lo = tankPressure,
      hi = 70e6;
    if (at(lo, on).gas > gas || at(hi, on).gas < gas) return undefined;
    for (let j = 0; j < 52; j++) {
      const mid = (lo + hi) / 2;
      if (at(mid, on).gas < gas) lo = mid;
      else hi = mid;
    }
    return at((lo + hi) / 2, on);
  }
  const valid = (a: Point | undefined) =>
    !!a &&
    a.gas > 0 &&
    a.gas <= 20e6 &&
    a.oil >= -1e-13 &&
    a.oil <= max + 1e-13 &&
    a.pp <= Math.min(70e6, req.pressureLimitPa) &&
    a.feed >= 0;
  function show(key: string, label: string, a: Point) {
    add(key + '-oil', label + '油量', '多变气体与 H 口联立', Math.max(0, a.oil), 'm³', 1000, 'L');
    add(key + '-pressure', label + '储油节点表压', 'pH = pg − p参考 + RH × q', a.h, 'Pa', 1e-6, 'MPa');
    add(key + '-gas', label + '气体绝压', 'pg = p0 (V0/Vg)^n', a.gas, 'Pa', 1e-6, 'MPa');
    add(key + '-rate', label + '净充油流量', 'q = 供入 − 泄放', a.q, 'm³/s', 60000, 'L/min');
    add(key + '-bypass', label + '卸荷回箱流量', '卸荷阀 P→T', a.bypass, 'm³/s', 60000, 'L/min');
    add(key + '-power', label + '泵轴功率', '(pP − pT) Q0 / η总', a.shaft, 'W');
  }
  let summary = '';
  const pending = (why: string) => result(phase, summary + why, 'pending'),
    blocked = (why: string) => result(phase, summary + why, 'blocked');
  const trip = sensor?.parameters.hydraulic?.tripPressurePa,
    reset = sensor?.parameters.hydraulic?.resetPressurePa;
  if (
    unload &&
    (unload.parameters.hydraulic?.tripPressurePa === undefined ||
      unload.parameters.hydraulic?.resetPressurePa === undefined ||
      trip === undefined ||
      reset === undefined ||
      reset >= trip ||
      Math.abs(trip - tankPa - unload.parameters.hydraulic.tripPressurePa) > 1 ||
      Math.abs(reset - tankPa - unload.parameters.hydraulic.resetPressurePa) > 1)
  )
    return pending('压力开关与卸荷阀动作、复位阈值或参考压力不一致。');
  const closed = byOil(initial, false),
    opened = unload ? byOil(initial, true) : undefined;
  let on = false;
  if (unload && trip !== undefined && reset !== undefined) {
    const closedStable = !!closed && closed.h < trip,
      openStable = !!opened && opened.h > reset;
    if (closedStable && openStable && phase.switchPrevious === undefined) return pending('回差区需要开关前态。');
    if (!closedStable && !openStable) return pending('切换后无法保持稳定，需阀与管容瞬态模型。');
    on = !closedStable || (openStable && phase.switchPrevious === 'on');
  }
  const start = on ? opened : closed;
  if (!start || !valid(start)) return pending('起点超出气体容积、压力预算或正向供油范围。');
  show('start', '起始', start);
  if (unload) summary += '起始' + (on ? '卸荷阀开启，压力开关已动作。' : '卸荷阀关闭，压力开关已复位。');
  function leg(a: Point, b: Point | undefined, state: boolean, id: string, label: string) {
    if (!b || !valid(b) || !valid(a)) return undefined;
    const v = integrate(a, b, (h) => at(h, state));
    if (!v) return undefined;
    add(id + '-time', label + '时间', 't = ∫ dVo/q净', v.time, 's');
    add(id + '-feed', label + '累计供入油量', '∫ Q供 dt', v.feed, 'm³', 1000, 'L');
    add(id + '-bleed', label + '累计泄放油量', '∫ Q泄 dt', v.bleed, 'm³', 1000, 'L');
    if (unload) add(id + '-returned', label + '累计卸荷回箱油量', '∫ Q卸 dt', v.bypass, 'm³', 1000, 'L');
    add(id + '-work', label + '轴输入能量', '∫ P轴 dt', v.energy, 'J');
    show(id, label, b);
    return v;
  }
  if (!unload || trip === undefined || reset === undefined) {
    const target = phase.accumulatorTargetOilVolumeM3;
    if (target === undefined) return pending('已核起点；定量泵充油时间缺目标油量。');
    const end = byOil(target, false);
    if (!end || !valid(end)) return pending('目标超出储油容积、压力预算或正向供油范围。');
    if (target !== initial && (Math.sign(target - initial) * start.q <= 0 || Math.sign(target - initial) * end.q <= 0))
      return blocked('净流量无法持续沿目标方向供油。');
    const v = leg(start, end, false, 'charge', '到达目标');
    if (!v) return pending('定量泵充油时间积分未收敛。');
    return result(phase, '定量泵至目标油量 ' + fmt(target * 1000) + ' L 用时 ' + fmt(v.time) + ' s。', 'timed');
  }
  const tripped = at(trip, false),
    released = at(reset, true);
  let a = start,
    elapsed = 0;
  for (let event = 0; event < 2; event++) {
    const b = on ? released : tripped,
      id = on ? 'reset' : 'trip',
      label = on ? '复位' : '卸荷动作';
    const v = leg(a, b, on, id, label);
    if (!v) return pending('未到达' + label + '阈值，核对净充放流量、压力预算与气体容积边界。');
    elapsed += v.time;
    add(id + '-at', label + '时刻', '累计分段时间', elapsed, 's');
    summary += label + ' ' + fmt(b.h / 1e6) + ' MPa，时刻 ' + fmt(elapsed) + ' s。';
    on = !on;
    const next = byOil(b.oil, on);
    if (!next || !valid(next) || (on ? next.h <= reset : next.h >= trip))
      return pending('切换后跨越反向阈值，准稳态无法维持。');
    summary += (on ? '卸荷阀开启' : '卸荷阀关闭') + '，止回阀' + (next.feed > 1e-12 ? '正向供油' : '关闭') + '。';
    show(id + '-after', label + '后', next);
    a = next;
  }
  if (phase.cycleThermal) {
    const t = phase.cycleThermal,
      openStart = byOil(tripped.oil, true),
      closedStart = byOil(released.oil, false);
    if (!openStart || !closedStart) return pending('循环起止状态待核。');
    const up = integrate(closedStart, tripped, (h) => at(h, false)),
      down = integrate(openStart, released, (h) => at(h, true));
    if (!up || !down) return pending('周期时间积分待核。');
    const period = up.time + down.time,
      energy = up.energy + down.energy,
      power = energy / period;
    add('period', '稳定循环周期', '复位至动作再至复位', period, 's');
    add('cycle-heat', '每周期输入热量', '整周期轴功全部进入热边界', energy, 'J');
    const { capacity, conductance, ambient, initial: startTemperature, cycles } = t;
    for (const [key, label, v, unit] of [
      ['capacity', '等效热容', capacity, 'J/K'],
      ['conductance', '散热系数', conductance, 'W/K'],
      ['ambient', '环境温度', ambient, '°C'],
      ['initial', '初始温度', startTemperature, '°C'],
      ['cycles', '完整循环次数', cycles, '次'],
    ] as const)
      if (v !== undefined) add('thermal-' + key, label, '本工况热边界', v, unit);
    const missing = [
      ['等效热容', t.capacity],
      ['散热系数', t.conductance],
      ['环境温度', t.ambient],
      ['初始温度', t.initial],
      ['循环次数', t.cycles],
    ].filter(([, v]) => v === undefined);
    if (
      capacity === undefined ||
      conductance === undefined ||
      ambient === undefined ||
      startTemperature === undefined ||
      cycles === undefined
    )
      return pending('循环温升待核，缺少' + missing.map(([k]) => k).join('、') + '。');
    const dt = period * cycles,
      ua = conductance,
      fraction = -Math.expm1((-ua * dt) / capacity);
    const x = (ua * dt) / capacity;
    const rise = (ambient - startTemperature) * fraction + ((power * dt) / capacity) * (x === 0 ? 1 : fraction / x);
    if (!Number.isFinite(rise) || !Number.isFinite(startTemperature + rise)) return pending('温升超出有限数值范围。');
    add('temperature-rise', '循环温升', 'C dT/dt = 周期平均轴功率 − UA(T−Ta)', rise, 'K');
    add('final-temperature', '周期末平均温度', 'T末 = T初 + ΔT', startTemperature + rise, '°C');
    summary += '循环温升 ' + fmt(rise) + ' K。';
  }
  return result(phase, summary, 'timed');
}
