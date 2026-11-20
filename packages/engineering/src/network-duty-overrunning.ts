import { diagnostic, type NetworkProject, type Result, type NetworkComponent } from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import { orificeResistance } from './network-duty-flow-split.js';
import { pipeParameters, returnPipeLoss, reportReturnPipe } from './network-duty-return-pipes.js';
import type { DutyPhase, DutyBoundaryDemand, NetworkDutyRequest } from './network-duty.js';
import type { StepWriter } from './network-duty-supply-storage.js';

export const loadStudies = {
  braking: '平衡阀阻性负载对照',
  lowering: '平衡阀超越负载下放',
  regeneration: '单缸差动伸出',
  'motor-feedback': '定量马达回馈',
  suction: '单泵有损吸油管',
} as const;
export type LoadStudy = keyof typeof loadStudies;
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/load-study', message)],
});
export function loadStudyChoices(p: NetworkProject): LoadStudy[] {
  const has = (t: string) => p.design.components.some((c) => c.typeId === t);
  if (has('counterbalance') && has('pump') && has('cylinder')) return ['braking', 'lowering'];
  if (has('motor') && has('pressure-source') && has('tank') && !has('pump')) return ['motor-feedback'];
  if (has('pump') && has('cylinder') && !has('valve')) return ['regeneration'];
  if (
    has('pump') &&
    has('tank') &&
    has('throttle') &&
    !has('cylinder') &&
    p.design.connections.some((e) => e.kind === 'pipe')
  )
    return ['suction'];
  return [];
}
export function loadConditions(phases: readonly DutyPhase[]) {
  const modes = phases.map((p) => p.loadStudy);
  return [
    ...(modes.some((m) => m === 'braking' || m === 'lowering')
      ? [
          '单杆缸行程内伸出，下放方向为正。阻性外力取负功、助动外力取正功。缸外载由工况给出，另计保存的机械阻尼；平衡阀 B 接杆腔，A 经换向阀回箱，X 取无杆腔压力。按泵泄漏、溢流、阀口与力平衡求实际速度。',
        ]
      : []),
    ...(modes.includes('regeneration')
      ? ['泵 P、无杆腔与有杆腔理想同压，杆腔排油全部回到无杆腔。按两腔面积差计算净进油与伸出力，计入机械阻尼。']
      : []),
    ...(modes.includes('motor-feedback')
      ? [
          '定量马达正转，低压箱给 A 补油，B 接能持续吸收回流的恒压边界。给定正向轴驱动扭矩，按排量、内泄和黏性摩擦核算稳态回馈；未计惯性变速。',
        ]
      : []),
    ...(modes.includes('suction')
      ? [
          '单定量泵从定压油箱经唯一物理管吸油，泵出口经已知节流口回同箱。取等高、无支路的准稳态管路，最低入口绝压为油箱绝压减管损。与输入的厂家最低入口绝压比较；阈值以下的流量仅为满液试算。空穴体积及复压须使用等效空穴预览的有效记录。',
        ]
      : []),
  ];
}
function bisect(lo: number, hi: number, f: (v: number) => number) {
  for (let i = 0; i < 64; i++) {
    const m = (lo + hi) / 2;
    if (f(m) < 0) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
const fmt = (v: number) => Number(v.toPrecision(6));
export function loadStudyPoint(
  project: NetworkProject,
  request: NetworkDutyRequest,
  phase: DutyPhase,
  add: StepWriter,
): Result<DutyBoundaryDemand> {
  const mode = phase.loadStudy;
  if (
    !mode ||
    !loadStudyChoices(project).includes(mode) ||
    phase.flowSplit ||
    phase.filterBypass ||
    phase.dividerEnd ||
    phase.shutoffs?.length ||
    phase.accumulatorOilVolumeM3 !== undefined ||
    phase.pumpStorage ||
    phase.resetStudy ||
    phase.cycleThermal ||
    phase.pumpPressureControl ||
    phase.pumpCommandPercent !== undefined ||
    phase.switchPrevious ||
    phase.loadSenseMarginPa !== undefined
  )
    return fail('专项接法或工况指令不匹配。');
  const parts = project.design.components,
    part = (t: string) => parts.find((c) => c.typeId === t);
  const tank = part('tank'),
    pump = part('pump'),
    source = part('pressure-source'),
    cyl = part('cylinder'),
    motor = part('motor'),
    valve = part('valve'),
    cb = part('counterbalance'),
    meter = part('throttle'),
    relief = part('relief'),
    volume = part('volume');
  const allowed =
    mode === 'suction'
      ? [tank, pump, meter]
      : mode === 'motor-feedback'
        ? [tank, motor, source]
        : mode === 'regeneration'
          ? [tank, pump, cyl, relief, volume]
          : [tank, pump, cyl, valve, cb, relief, volume];
  const t = tank?.parameters.hydraulic?.pressurePa;
  if (
    !tank ||
    t === undefined ||
    parts.length !== allowed.filter(Boolean).length ||
    project.design.connections.some((e) => e.kind === 'signal' || (mode !== 'suction' && e.kind === 'pipe')) ||
    request.pumpId !== (pump ?? source)?.id ||
    !!request.boundary !== (mode === 'motor-feedback')
  )
    return fail('只支持本专项列出的元件、边界及唯一供回油通路。');
  const graph = dutyPhasePaths(project, phase, false);
  if (!graph.ok) return graph;
  const net = graph.value.idealReachable;
  const port = (c: NetworkComponent, k: string) => c.id + ':' + k;
  const tankT = port(tank, 'T'),
    a = phase.actions[0];
  const feedback = mode === 'motor-feedback',
    suction = mode === 'suction',
    regen = mode === 'regeneration';
  if (
    suction
      ? phase.actions.length || phase.valves.length
      : !a ||
        phase.actions.length !== 1 ||
        a.componentId !== (motor ?? cyl)?.id ||
        a.direction !== 'forward' ||
        a.supplyLossPa !== 0 ||
        a.returnPressurePa !== t ||
        a.mechanicalEfficiency !== 1 ||
        a.volumetricEfficiency !== 1 ||
        a.motorSetting ||
        a.positionM !== undefined ||
        a.rotaryAngleRad !== undefined
  )
    return fail('需要正向行程内动作，效率填 1，额外损失填 0，低压基准取油箱。吸油试验独立进行。');
  const done = (summary: string, satisfied: boolean, pending = false): Result<DutyBoundaryDemand> => ({
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: { summary, satisfied, ...(pending ? { loadPending: true as const } : {}) },
    },
  });
  const pressure = (key: string, title: string, v: number, formula: string) =>
    add(key, title, formula, v, 'Pa', 1e-6, 'MPa');
  const flow = (key: string, title: string, v: number, formula: string) =>
    add(key, title, formula, v, 'm³/s', 60000, 'L/min');
  if (feedback && motor && source && a) {
    const ph = source.parameters.hydraulic?.pressurePa,
      h = motor.parameters.hydraulic,
      m = motor.parameters.mechanics;
    if (
      phase.valves.length ||
      motor.definition.id !== 'teaching:motor' ||
      !net(port(motor, 'A'), tankT) ||
      !net(port(motor, 'B'), port(source, 'P')) ||
      net(tankT, port(source, 'P')) ||
      ph === undefined ||
      ph <= t ||
      !h?.displacementM3PerRev ||
      h.leakageM3PerSPa === undefined ||
      m?.viscousFrictionNmSPerRad === undefined
    )
      return fail('回馈需 A 接低压箱、B 接独立高压接收端，定量马达的排量、内泄与黏性阻尼明确。');
    const makeup = motor.parameters.makeup;
    if (
      makeup &&
      makeup.maximumAreaM2 &&
      makeup.supplyPressurePa !== undefined &&
      makeup.openingDifferentialPa !== undefined &&
      makeup.supplyPressurePa - t > makeup.openingDifferentialPa
    )
      return fail('低压侧内置补油开启，需要计入额外供油边界。');
    const d = h.displacementM3PerRev / (2 * Math.PI),
      dp = ph - t,
      tau = dp * d,
      b = m.viscousFrictionNmSPerRad;
    pressure('low-pressure', 'A 口补油压力', t, '低压箱边界');
    pressure('high-pressure', 'B 口回馈压力', ph, '接收边界');
    add('target-speed', '目标转速', '给定正向目标', a.speed, 'rad/s', 30 / Math.PI, 'r/min');
    add('hydraulic-torque', '液压制动扭矩', 'Δp D/(2π)', tau, 'N·m');
    if (b <= 0 || a.resistingLoad <= tau)
      return done(
        b <= 0 ? '零黏性阻尼下无法从扭矩唯一确定稳态转速。' : '轴驱动扭矩不足以维持指定正向回馈。',
        false,
        b <= 0,
      );
    const w = (a.resistingLoad - tau) / b,
      q = d * w - h.leakageM3PerSPa * dp;
    if (![w, q, dp * q, a.resistingLoad * w].every(Number.isFinite))
      return done('扭矩工况超出有限稳态范围。', false, true);
    add('speed', '稳态转速', 'ω = (T驱 − ΔpD/2π)/b', w, 'rad/s', 30 / Math.PI, 'r/min');
    flow('out', 'B 口净输出流量', q, 'Dω/(2π) − C泄 Δp');
    const recovered = dp * q;
    add('shaft', '外部轴输入功率', 'T驱 ω', a.resistingLoad * w, 'W');
    add('recovered', '两端净液压输出功率', '(pB − pA) Q出', recovered, 'W');
    add('loss', '黏性与内泄耗功', 'bω² + C泄 Δp²', b * w * w + h.leakageM3PerSPa * dp * dp, 'W');
    return done(
      'A→B 理论排油，B 口净输出 ' +
        fmt(q * 60000) +
        ' L/min，稳态 ' +
        fmt((w * 30) / Math.PI) +
        ' r/min，净液压输出 ' +
        fmt(recovered) +
        ' W。' +
        (q > 0 ? '形成回馈。' : '内泄抵消排油，未形成净回馈。') +
        (w >= a.speed ? '达到目标转速。' : '未达到目标转速。'),
      q > 0 && w >= a.speed,
    );
  }
  if (
    !pump ||
    pump.definition.id !== 'teaching:pump' ||
    !pump.parameters.hydraulic?.displacementM3PerRev ||
    pump.parameters.hydraulic.leakageM3PerSPa === undefined ||
    request.totalEfficiency > request.pumpVolumetricEfficiency
  )
    return fail('需单定量泵、有效转速及泵效率。');
  const pp = port(pump, 'P'),
    ss = port(pump, 'S'),
    rho = project.design.fluid.densityKgPerM3,
    q0 =
      ((pump.parameters.hydraulic.displacementM3PerRev * request.angularSpeedRadPerS) / (2 * Math.PI)) *
      request.pumpVolumetricEfficiency,
    leak = pump.parameters.hydraulic.leakageM3PerSPa;
  if (
    net(pp, tankT) ||
    net(pp, ss) ||
    (!suction && !net(ss, tankT)) ||
    (volume && !net(pp, port(volume, 'H'))) ||
    (relief && (!net(pp, port(relief, 'P')) || !net(tankT, port(relief, 'T'))))
  )
    return fail('泵、油箱、供油容腔或溢流支路接线不符。');
  const external = relief?.parameters.hydraulic,
    internal = pump.parameters.relief;
  const spill = (delta: number, setting = 0, area = 0, cq = 0) =>
    area * cq * Math.sqrt((2 * Math.max(0, delta - setting)) / rho);
  const available = (delta: number) =>
    q0 -
    leak * Math.max(0, delta) -
    (internal?.enabled
      ? spill(delta, internal.settingDifferentialPa, internal.maximumAreaM2, internal.flowCoefficient)
      : 0) -
    (external ? spill(delta, external.settingDifferentialPa, external.maximumAreaM2, external.flowCoefficient) : 0);
  if (suction && meter) {
    const route = graph.value.uniquePath(tankT, ss),
      pipes = project.design.connections.filter((e) => e.kind === 'pipe'),
      pipe = pipes[0];
    if (
      !pipe ||
      pipes.length !== 1 ||
      !route?.some((e) => e.physicalPipe?.id === pipe.id) ||
      route.some((e) => !e.ideal && !e.physicalPipe) ||
      !net(pp, port(meter, 'A')) ||
      !net(tankT, port(meter, 'B')) ||
      net(ss, tankT)
    )
      return fail('吸油管须唯一串在油箱 T 和泵 S 之间，P 经单节流阀回同箱。');
    const law = pipeParameters(project, pipe, '吸油管');
    if (!law.ok) return law;
    const init = project.design.initialConditions.find((i) => i.componentId === meter.id);
    if (init?.kind !== 'throttle' || !init.openingAreaM2 || !meter.parameters.hydraulic?.flowCoefficient)
      return fail('节流口有效面积须明确且大于零。');
    const k = orificeResistance(rho, meter.parameters.hydraulic.flowCoefficient, init.openingAreaM2);
    const q = bisect(0, q0, (x) => x - available(k * x * x + returnPipeLoss(law.value, x).pressureDropPa));
    const checked = reportReturnPipe(law.value, q, 0, '吸油管');
    if (!checked.ok) return checked;
    const loss = checked.value,
      inlet = t - loss.pressureDropPa,
      ref = project.design.pressureReference;
    flow('suction-flow', '满液试算吸油流量', q, 'Q吸 = Q泵净出 = Q节流');
    pressure('friction', '吸油管沿程压降', loss.frictionDropPa, 'Darcy–Weisbach');
    pressure('local', '吸油管局部压降', loss.localDropPa, 'Kρv²/2');
    pressure('inlet', '泵 S 口工程压力', inlet, 'p箱 − Δp吸');
    const absolute =
      ref.kind !== 'gauge' || ref.absoluteReferencePa == null ? undefined : inlet + ref.absoluteReferencePa;
    let msg = '吸油管 [' + pipe.id + '] ' + loss.regime + '，满液试算 ' + fmt(q * 60000) + ' L/min。';
    if (absolute === undefined) return done(msg + '缺少工程表压零点的绝压，最低入口绝压待核。', false, true);
    pressure('inlet-abs', '满液试算最低入口绝压', absolute, 'p箱,abs − Δp吸');
    msg += '最低入口绝压试算 ' + fmt(absolute / 1000) + ' kPa。';
    if (absolute <= 0) return done(msg + '满液假设失效，实际吸油量和压力待核。', false, true);
    if (phase.minimumInletPa === undefined) return done(msg + '缺少厂家最低入口绝压，入口裕量待核。', false, true);
    const margin = absolute - phase.minimumInletPa;
    pressure('margin', '泵入口绝压裕量', margin, 'pS,abs − p厂家最低');
    const budget = t + k * q * q <= request.pressureLimitPa;
    return done(
      msg +
        (margin < 0 ? '低于厂家最低入口绝压，实际吸油能力待核。' : '满足厂家最低入口绝压。') +
        (budget ? '' : '泵出口超过压力预算。'),
      margin >= 0 && budget,
      margin < 0,
    );
  }
  if (!cyl || !a || cyl.definition.id !== 'teaching:cylinder') return fail('需普通单杆双作用缸。');
  const geom = cyl.parameters.geometry,
    ac = geom?.capAreaM2,
    ar = geom?.rodSideAreaM2,
    m = cyl.parameters.mechanics;
  if (
    !ac ||
    !ar ||
    ac <= ar ||
    m?.loadDampingNsPerM === undefined ||
    m.pistonDampingNsPerM === undefined ||
    cyl.parameters.hydraulic?.internalLeakageM3PerSPa !== 0
  )
    return fail('需有效缸面积及阻尼，当前缸内泄须为零。');
  const cap = port(cyl, 'A'),
    rod = port(cyl, 'B'),
    force = mode === 'lowering' ? -a.resistingLoad : a.resistingLoad,
    damping = m.loadDampingNsPerM + m.pistonDampingNsPerM;
  let point: (q: number) => { v: number; pa: number; pb: number; supply: number; opening: number };
  if (regen) {
    if (phase.valves.length || !net(pp, cap) || !net(pp, rod))
      return fail('差动伸出需泵 P、缸 A 和缸 B 接同一供油节点。');
    point = (q) => {
      const v = q / (ac - ar),
        p = (force + damping * v) / (ac - ar);
      return { v, pa: p, pb: p, supply: p, opening: 0 };
    };
  } else {
    const ch = cb?.parameters.hydraulic,
      vh = valve?.parameters.hydraulic;
    if (
      !valve ||
      !cb ||
      !['teaching:directional-2-4', 'teaching:directional-3-4'].includes(valve.definition.id) ||
      phase.valves.length !== 1 ||
      phase.valves[0]?.componentId !== valve.id ||
      phase.valves[0].positionId !== 'extend' ||
      !net(pp, port(valve, 'P')) ||
      !net(tankT, port(valve, 'T')) ||
      !net(cap, port(valve, 'A')) ||
      !net(cap, port(cb, 'X')) ||
      !net(rod, port(cb, 'B')) ||
      !net(port(cb, 'A'), port(valve, 'B'))
    )
      return fail('下放限伸出位，杆腔接平衡阀 B，A 经换向回箱，X 接无杆腔。');
    const nodes = [pp, tankT, cap, rod, port(cb, 'A')];
    if (nodes.some((x, i) => nodes.slice(i + 1).some((y) => net(x, y)))) return fail('下放回路存在短接。');
    if (
      !ch?.counterbalanceSettingPa ||
      !ch.regulationBandPa ||
      !ch.pilotRatio ||
      !ch.maximumAreaM2 ||
      !ch.flowCoefficient ||
      !vh?.maximumAreaM2 ||
      !vh.flowCoefficient
    )
      return fail('缺少平衡阀调节带、先导比或阀口参数。');
    const set = ch.counterbalanceSettingPa,
      band = ch.regulationBandPa,
      ratio = ch.pilotRatio,
      k = orificeResistance(rho, ch.flowCoefficient, ch.maximumAreaM2),
      kv = orificeResistance(rho, vh.flowCoefficient, vh.maximumAreaM2);
    point = (q) => {
      const v = q / ac,
        out = v * ar,
        down = t + kv * out * out,
        drive = (force + damping * v) / ac;
      const pilot = (pb: number) => drive + (ar / ac) * pb;
      const opening = (pb: number) => Math.max(0, Math.min(1, (pb - down + ratio * (pilot(pb) - down) - set) / band));
      const onset = ((1 + ratio) * down + set - ratio * drive) / (1 + (ratio * ar) / ac),
        full = onset + band / (1 + (ratio * ar) / ac);
      const pb =
        q === 0
          ? Math.max(down, onset)
          : bisect(down, Math.max(full, down + k * out * out), (p) => opening(p) * Math.sqrt((p - down) / k) - out);
      const pa = pilot(pb);
      return { v, pa, pb, supply: pa + kv * q * q, opening: opening(pb) };
    };
  }
  const residual = (q: number) => q - available(point(q).supply - t);
  if (residual(0) >= 0) return done('泵与溢流平衡时无法建立正向运动，未达到目标缸速。', false);
  const q = bisect(0, q0, residual),
    p = point(q);
  if (
    ![p.v, p.pa, p.pb, p.supply, p.v * force].every(Number.isFinite) ||
    Math.min(p.pa, p.pb) < 0 ||
    p.supply < t ||
    Math.max(p.pa, p.pb, p.supply) > 70e6
  )
    return done('试算需要低压补油、反拖泵或超过 70 MPa，实际运动待核。', false, true);
  pressure('cap', '无杆腔压力', p.pa, '缸力平衡');
  pressure('rod', regen ? '有杆腔压力' : '有杆腔制动背压', p.pb, '缸力平衡与回油通路');
  pressure('pump', '泵出口压力', p.supply, '供油通路');
  flow('pump-flow', '实际泵供流', q, '泵供流减泄漏、溢流');
  flow('cap-flow', '无杆腔进油量', ac * p.v, 'Ac v');
  flow('rod-flow', regen ? '杆腔回送无杆腔流量' : '杆腔经平衡阀回油流量', ar * p.v, 'Ar v');
  if (!regen) add('opening', '平衡阀有效开度', '[(pB−pA)+r(pX−pA)−设定]/调节带', p.opening, '1', 100, '%');
  add('target-speed', '目标伸出速度', '工况目标', a.speed, 'm/s', 1000, 'mm/s');
  add('speed', '实际伸出速度', '按实际净供油和有效进油面积', p.v, 'm/s', 1000, 'mm/s');
  add('external', '外载向油缸输入功率', '−F阻 v', -force * p.v, 'W');
  add('cylinder-power', '油缸液压输入功率', '(p无杆 Ac − p有杆 Ar)v', (p.pa * ac - p.pb * ar) * p.v, 'W');
  add('pump-power', '泵轴输入功率', '(pP−pT)Q有效/η总', ((p.supply - t) * q0) / request.totalEfficiency, 'W');
  const speedOK = p.v >= a.speed * (1 - 1e-8),
    budget = p.supply <= request.pressureLimitPa;
  return done(
    (regen
      ? '杆腔排油汇入无杆腔'
      : mode === 'lowering'
        ? '助动外载下放，平衡阀 B→A 制动'
        : '阻性负载伸出，平衡阀 B→A 排油') +
      '，杆腔压力 ' +
      fmt(p.pb / 1e6) +
      ' MPa，实际缸速 ' +
      fmt(p.v * 1000) +
      ' mm/s，外载输入 ' +
      fmt(-force * p.v) +
      ' W。' +
      (speedOK ? '达到目标缸速。' : '未达到目标缸速。') +
      (budget ? '' : '泵出口超过压力预算。'),
    speedOK && budget,
  );
}

export function suctionPipeEligible(p: NetworkProject, id: string): boolean {
  const { components: parts, connections } = p.design,
    pump = parts.find((c) => c.typeId === 'pump'),
    tank = parts.find((c) => c.typeId === 'tank'),
    meter = parts.find((c) => c.typeId === 'throttle');
  if (!pump || !tank || !meter || parts.length !== 3 || connections.filter((e) => e.kind === 'pipe').length !== 1)
    return false;
  const g = dutyPhasePaths(p, { name: '吸油接线', actions: [], valves: [] }, false);
  if (!g.ok) return false;
  const t = tank.id + ':T',
    s = pump.id + ':S',
    out = pump.id + ':P',
    route = g.value.uniquePath(t, s);
  return (
    !!route?.some((e) => e.physicalPipe?.id === id) &&
    route.every((e) => e.ideal || e.physicalPipe) &&
    g.value.idealReachable(out, meter.id + ':A') &&
    g.value.idealReachable(t, meter.id + ':B') &&
    !g.value.idealReachable(out, t) &&
    !g.value.idealReachable(s, out)
  );
}
