import {
  diagnostic,
  networkDisplacementRange,
  networkValvePositions,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import { dutyCylinderTravel } from './network-duty-cylinders.js';
import { cylinderBranchLaws, orificeFlow, orificeResistance } from './network-duty-flow-split.js';
import type { DutyPhase, DutyBoundaryDemand, NetworkDutyRequest } from './network-duty.js';
import type { StepWriter } from './network-duty-supply-storage.js';

type Mode = '双缸负载敏感' | '双恒压源逻辑阀' | '定量泵与恒压源并供';
export function sourceControlMode(project: NetworkProject, request?: NetworkDutyRequest): Mode | undefined {
  const parts = project.design.components;
  if (request?.phases.some((p) => p.loadSenseMarginPa !== undefined)) return '双缸负载敏感';
  const sources = parts.filter((c) => c.typeId === 'pressure-source');
  if (sources.length === 2 && parts.some((c) => ['shuttle-valve', 'two-pressure-valve'].includes(c.typeId)))
    return '双恒压源逻辑阀';
  if (
    sources.length === 1 &&
    parts.some((c) => c.typeId === 'cylinder') &&
    parts.some((c) => c.typeId === 'check-valve') &&
    parts.some((c) => c.typeId === 'pump')
  )
    return '定量泵与恒压源并供';
  return undefined;
}
export function sourceControlConditions(mode: Mode) {
  const common =
    '各缸位于行程内，按实际阀位、保存阀口和阻性负载求流量与速度，速度目标允差 ±1%。回油基准取同一油箱。压力开关仅旁接母线测压，回差区沿用明确前态。动态反馈和切换时刻另核。';
  return [
    mode === '双缸负载敏感'
      ? '理想最高负载选择器取两个参与动作缸的进油腔压力。泵调节至出口高于最高负载一个给定裕量，排量受上下限约束。计入保存的泵泄漏和直动溢流；排量已饱和时按供流守恒重新求压力。'
      : mode === '双恒压源逻辑阀'
        ? 'A、B 接独立的给定恒压边界，C 接换向阀 P。沿用保存的选通压差和有限孔口。双压阀按较低入口压力决定启用程度。恒压边界可持续维持给定压力，按相对回油箱的压差报告输出液压功率。'
        : '定量泵直供母线，恒压源经已知开启压差、面积和流量系数的止回阀并供。按同一母线压力联立泵泄漏、直动溢流、源支路及缸流量。泵列轴功率，恒压源列相对回油箱的输出液压功率。',
    common,
  ];
}
const ceiling = 70e6;
const clip = (x: number) => Math.max(0, Math.min(1, x));
function equilibrium(low: number, high: number, error: (p: number) => number) {
  if (!Number.isFinite(error(low)) || !Number.isFinite(error(high)) || error(low) > 1e-15 || error(high) < -1e-15)
    return undefined;
  for (let i = 0; i < 72; i++) {
    const mid = low + (high - low) / 2;
    if (error(mid) < 0) low = mid;
    else high = mid;
  }
  return (high + low) / 2;
}
export function sourceControlPoint(
  project: NetworkProject,
  request: NetworkDutyRequest,
  phase: DutyPhase,
  mode: Mode,
  add: StepWriter,
): Result<DutyBoundaryDemand> {
  const fail = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/source-control', phase.name + '：' + message)],
  });
  const { components, connections, fluid, initialConditions } = project.design;
  const of = (type: string) => components.filter((c) => c.typeId === type);
  const [pump] = of('pump'),
    [tank] = of('tank'),
    sources = of('pressure-source'),
    valves = of('valve'),
    cylinders = of('cylinder');
  const logic = components.filter((c) => ['shuttle-valve', 'two-pressure-valve'].includes(c.typeId)),
    [selector] = logic,
    checks = of('check-valve'),
    [check] = checks;
  const ls = mode === '双缸负载敏感',
    dual = mode === '双恒压源逻辑阀';
  const allowed = new Set([
    'tank',
    'cylinder',
    'valve',
    'volume',
    'adjustable-pressure-switch',
    ...(dual
      ? ['pressure-source', 'shuttle-valve', 'two-pressure-valve']
      : ['pump', 'relief', ...(ls ? [] : ['pressure-source', 'check-valve'])]),
  ]);
  if (
    components.some((c) => !allowed.has(c.typeId)) ||
    connections.some((c) => c.kind !== 'ideal') ||
    of('tank').length !== 1 ||
    cylinders.length !== (ls ? 2 : 1) ||
    valves.length !== cylinders.length ||
    of('pump').length !== (dual ? 0 : 1) ||
    sources.length !== (ls ? 0 : dual ? 2 : 1) ||
    logic.length !== (dual ? 1 : 0) ||
    checks.length !== (ls || dual ? 0 : 1) ||
    of('adjustable-pressure-switch').length > 1 ||
    phase.actions.length !== cylinders.length ||
    phase.valves.length !== valves.length ||
    !valves.every((v) =>
      phase.valves.some((s) => s.componentId === v.id && networkValvePositions(v).includes(s.positionId)),
    ) ||
    !cylinders.every((c) => phase.actions.some((a) => a.componentId === c.id)) ||
    request.boundary !== (dual ? true : undefined) ||
    (dual ? !sources.some((c) => c.id === request.pumpId) : request.pumpId !== pump?.id)
  )
    return fail('请核对本工况各独立源、参与油缸及换向阀。仅支持指定理想管网，开关 OUT 不能接入反馈。');
  if (
    phase.pumpCommandPercent !== undefined ||
    phase.pumpPressureControl ||
    phase.filterBypass ||
    phase.dividerEnd ||
    phase.shutoffs?.length ||
    phase.accumulatorOilVolumeM3 !== undefined ||
    phase.accumulatorTargetOilVolumeM3 !== undefined ||
    (!ls && phase.flowSplit)
  )
    return fail('本工况有互斥的控制或分流设定。');
  const tankPa = tank?.parameters.hydraulic?.pressurePa;
  const valve = valves[0];
  if (!tank || tankPa === undefined || !valve || (!dual && request.totalEfficiency > request.pumpVolumetricEfficiency))
    return fail('回油压力或泵效率待核。');
  for (const a of phase.actions) {
    const c = cylinders.find((c) => c.id === a.componentId)!;
    const initial = initialConditions.find((s) => s.componentId === c.id);
    const travel = dutyCylinderTravel(
      c,
      a.positionM ?? (initial?.kind === 'cylinder' ? initial.positionM : undefined),
      phase.name,
    );
    if (!travel.ok) return travel;
    if (
      a.supplyLossPa !== 0 ||
      Math.abs(a.returnPressurePa - tankPa) > 1e-6 ||
      a.volumetricEfficiency !== 1 ||
      a.motorSetting ||
      a.rotaryAngleRad !== undefined
    )
      return fail('手填供油损失须为零，回油基准取油箱压力，缸容积效率取 1。');
  }
  const graph = dutyPhasePaths(project, phase, false, true);
  if (!graph.ok) return graph;
  const paths = graph.value,
    bus = valve.id + ':P',
    ret = tank.id + ':T',
    ideal = paths.idealReachable;
  if (
    paths.reachable(bus, ret) ||
    valves.some((v) => !ideal(v.id + ':P', bus) || !ideal(v.id + ':T', ret)) ||
    (pump && (!ideal(pump.id + ':S', ret) || !ideal(pump.id + ':P', bus)))
  )
    return fail('母线、泵吸油或回箱接线不唯一，或供回油短接。');
  // Every actuator chamber must belong to its own work line. A tee to another
  // source or cylinder would add flows absent from the two branch equations.
  const chamberPorts = cylinders.flatMap((c) => [c.id + ':A', c.id + ':B']);
  const boundaries = [bus, ret, ...sources.map((s) => s.id + ':P')];
  if (chamberPorts.some((port, i) => [...chamberPorts.slice(i + 1), ...boundaries].some((other) => ideal(port, other))))
    return fail('缸工作口跨接其他缸腔、母线或压力边界，支路流量无法独立确定。');
  const laws = cylinderBranchLaws(project, phase, paths, bus, ret, tankPa);
  if (!laws.ok) return laws;
  const loads = laws.value;
  if (loads.some((l) => l.closed)) return fail('存在关闭或隔离的负载取压支路。');
  const total = (p: number) => loads.reduce((v, l) => v + orificeFlow(p, l), 0);
  const n = (v: number) => Number(v.toPrecision(6)),
    mp = (v: number) => n(v / 1e6) + ' MPa',
    flow = (v: number) => n(v * 60000) + ' L/min';
  const notes: string[] = [mode];
  let pressure: number | undefined;
  const flowStep = (id: string, label: string, q: number) => add(id, label, '实际稳态流量', q, 'm³/s', 60000, 'L/min');
  const power = (id: string, label: string, w: number) => add(id, label, '压差与流量的功率平衡', w, 'W');
  const tapPressure = (p: number, l: (typeof loads)[number]) =>
    Math.min(p, l.startPa + l.areaRatio ** 3 * l.returnResistance * orificeFlow(p, l) ** 2);
  const highest = (p: number) => Math.max(...loads.map((l) => tapPressure(p, l)));
  const external = of('relief');
  const lossLaws: { startPa: number; resistance: number }[] = [];
  if (
    external.some((v) => v.definition.id !== 'teaching:relief' || !ideal(v.id + ':P', bus) || !ideal(v.id + ':T', ret))
  )
    return fail('外部溢流须为泵出口取压并直回同箱的直动阀。');
  for (const h of [
    ...external.map((v) => v.parameters.hydraulic),
    ...(pump?.parameters.relief?.enabled === 1 ? [pump.parameters.relief] : []),
  ]) {
    if (!h?.maximumAreaM2 || !h.flowCoefficient || h.settingDifferentialPa === undefined)
      return fail('直动溢流设定或有效开口待核。');
    lossLaws.push({
      startPa: tankPa + h.settingDifferentialPa,
      resistance: orificeResistance(fluid.densityKgPerM3, h.flowCoefficient, h.maximumAreaM2),
    });
  }
  const reliefAt = (p: number) => lossLaws.reduce((q, law) => q + orificeFlow(p, law), 0);
  if (dual && selector) {
    const src = (port: string) => sources.find((s) => ideal(s.id + ':P', selector.id + ':' + port));
    const a = src('A'),
      b = src('B'),
      h = selector.parameters.hydraulic,
      pa = a?.parameters.hydraulic?.pressurePa,
      pb = b?.parameters.hydraulic?.pressurePa;
    if (
      !a ||
      !b ||
      a === b ||
      pa === undefined ||
      pb === undefined ||
      !ideal(selector.id + ':C', bus) ||
      sources.some((s) => paths.reachable(s.id + ':P', bus) || paths.reachable(s.id + ':P', ret)) ||
      ideal(a.id + ':P', b.id + ':P')
    )
      return fail('A、B 须分别唯一连接独立恒压源，C 接母线，两源不能相通或旁路。');
    if (!h?.maximumAreaM2 || !h.flowCoefficient || !h.transitionPressurePa)
      return fail('逻辑阀过渡压差或有效阀口待核。');
    const R = orificeResistance(fluid.densityKgPerM3, h.flowCoefficient, h.maximumAreaM2);
    const share = clip(0.5 + (pa - pb) / (2 * h.transitionPressurePa));
    const isAnd = selector.typeId === 'two-pressure-valve';
    if (isAnd && (h.minimumInletPressurePa === undefined || !h.activationBandPa))
      return fail('双压阀启用门槛或开启带待核。');
    const opening = isAnd ? clip((Math.min(pa, pb) - h.minimumInletPressurePa!) / h.activationBandPa!) : 1;
    const qa = (p: number) => opening * share * Math.sqrt(Math.max(0, pa - p) / R);
    const qb = (p: number) => opening * (1 - share) * Math.sqrt(Math.max(0, pb - p) / R);
    pressure = equilibrium(tankPa, ceiling, (p) => total(p) - qa(p) - qb(p));
    if (pressure === undefined) return fail('负载流量与两个给定源的供流无法平衡。');
    const qA = qa(pressure),
      qB = qb(pressure);
    if (Math.abs(total(pressure) - qA - qB) > 1e-12) return fail('两源通流未达到流量守恒。');
    for (const [id, q, p, port] of [
      [a.id, qA, pa, 'A'],
      [b.id, qB, pb, 'B'],
    ] as const) {
      flowStep('source-' + port, id + ' ' + port + ' 口供流', q);
      power('power-' + port, id + ' 输出液压功率', (p - tankPa) * q);
      notes.push(port + ' 口 [' + id + '] ' + mp(p) + '，供流 ' + flow(q) + '。');
    }
    if (qA + qB === 0) {
      return {
        ok: true,
        value: {
          name: phase.name,
          boundaryAssessment: {
            satisfied: false,
            ...(of('adjustable-pressure-switch').length ? { controlPending: true as const } : {}),
            summary:
              notes.join(' ') +
              (opening === 0 ? ' 双压阀低压入口未达到启用门槛。' : ' 两源未建立正向通流。') +
              ' 缸速 0，目标未达标。封闭侧压力待核。' +
              (of('adjustable-pressure-switch').length ? ' 母线测压及开关状态待核。' : ''),
          },
        },
      };
    }
  } else if (pump) {
    const variable = networkDisplacementRange(pump);
    const h = pump.parameters.hydraulic;
    if (
      !h ||
      h.leakageM3PerSPa === undefined ||
      (ls ? pump.definition.id !== 'teaching:variable-pump' : pump.definition.id !== 'teaching:pump')
    )
      return fail('泵型或泄漏特性不符合工况要求。');
    const factor = (request.angularSpeedRadPerS * request.pumpVolumetricEfficiency) / (2 * Math.PI);
    const leakage = h.leakageM3PerSPa,
      demand = (p: number) => total(p) + leakage * (p - tankPa) + reliefAt(p);
    let displacement = h.displacementM3PerRev;
    let sourceFlow: (pressure: number) => number = () => 0;
    if (ls) {
      const margin = phase.loadSenseMarginPa;
      if (!margin || !variable || variable.min >= variable.max) return fail('须给出负载敏感压差裕量和有效排量范围。');
      const desired = equilibrium(tankPa, ceiling, (p) => p - highest(p) - margin);
      if (desired === undefined || demand(desired) > factor * variable.max) {
        displacement = variable.max;
        notes.push('最大排量饱和，供流不足以维持设定裕量。');
      } else if (demand(desired) < factor * variable.min) {
        displacement = variable.min;
        notes.push('已到最小排量。');
      } else {
        pressure = desired;
        displacement = demand(desired) / factor;
        notes.push('裕量调节。');
      }
    } else {
      const s = sources[0],
        ps = s?.parameters.hydraulic?.pressurePa,
        hc = check?.parameters.hydraulic;
      if (
        !s ||
        ps === undefined ||
        !check ||
        !hc?.maximumAreaM2 ||
        !hc.flowCoefficient ||
        hc.openingDifferentialPa === undefined ||
        !ideal(s.id + ':P', check.id + ':A') ||
        !ideal(check.id + ':B', bus) ||
        paths.reachable(bus, s.id + ':P') ||
        ideal(s.id + ':P', ret)
      )
        return fail('恒压源 P 须经独立 A→B 止回阀接泵母线，止回开启压差和有限阀口须明确。');
      const R = orificeResistance(fluid.densityKgPerM3, hc.flowCoefficient, hc.maximumAreaM2),
        start = ps - hc.openingDifferentialPa;
      sourceFlow = (p) => Math.sqrt(Math.max(0, start - p) / R);
    }
    if (displacement === undefined) return fail('缺少定量供流的排量依据。');
    const gross = factor * displacement;
    if (pressure === undefined) pressure = equilibrium(tankPa, ceiling, (p) => demand(p) - gross - sourceFlow(p));
    if (pressure === undefined || Math.abs(demand(pressure) - gross - sourceFlow(pressure)) > 1e-12)
      return fail('给定供流与负载在油箱压力至 70 MPa 内没有可确认的平衡点。');
    const p = pressure,
      loss = leakage * (p - tankPa),
      qPump = gross - loss;
    if (qPump < -1e-14) return fail('外源导致泵口反向吸收流量，倒灌特性待核。');
    add('displacement', '实际泵排量', '零压供流除以有效转速', displacement, 'm³/rev', 1e6, 'cm³/rev');
    flowStep('pump-flow', pump.id + ' 出口供流', qPump);
    flowStep('leakage', '泵泄漏', loss);
    flowStep('relief', '直动溢流回箱', reliefAt(p));
    power('pump-power', pump.id + ' 轴功率', ((p - tankPa) * gross) / request.totalEfficiency);
    notes.push('泵出口 ' + mp(p) + '，实际排量 ' + n(displacement * 1e6) + ' cm³/rev，供流 ' + flow(qPump) + '。');
    if (ls) {
      const max = highest(p),
        ids = loads.filter((l) => Math.abs(tapPressure(p, l) - max) < 1e-5).map((l) => l.target.componentId);
      notes.push('最高负载取压 [' + ids.join('、') + '] ' + mp(max) + '，实际裕量 ' + mp(p - max) + '。');
      add('load-pressure', '最高负载取压', '两缸进油腔压力取高', max, 'Pa', 1e-6, 'MPa');
      add('margin', '实际压差裕量', '泵出口压力减最高负载取压', p - max, 'Pa', 1e-6, 'MPa');
    } else {
      const s = sources[0]!,
        qs = sourceFlow(p);
      flowStep('boundary-flow', s.id + ' 实际供流', qs);
      power('boundary-power', s.id + ' 输出液压功率', (s.parameters.hydraulic!.pressurePa! - tankPa) * qs);
      notes.push('恒压源止回阀' + (qs > 0 ? '开启' : '关闭') + '，供流 ' + flow(qs) + '。');
    }
  } else return fail('实际源或逻辑阀缺失。');
  const busPa = pressure;
  if (busPa === undefined) return fail('母线压力待核。');
  add('bus-pressure', '供油母线压力', '节点流量守恒', busPa, 'Pa', 1e-6, 'MPa');
  let satisfied = true;
  for (const l of loads) {
    const q = orificeFlow(busPa, l),
      speed = q / l.inletArea,
      ok = Math.abs(speed / l.target.targetSpeedMPerS - 1) <= 0.01;
    satisfied &&= ok;
    flowStep(l.target.componentId + '-flow', l.target.label + ' 实际进油', q);
    add(l.target.componentId + '-speed', l.target.label + ' 缸速', 'v=Q/A', speed, 'm/s', 1000, 'mm/s');
    notes.push(
      l.target.label +
        ' ' +
        flow(q) +
        '，实际 / 目标 ' +
        n(speed * 1000) +
        ' / ' +
        n(l.target.targetSpeedMPerS * 1000) +
        ' mm/s，' +
        (ok ? '达标' : '未达标') +
        '。',
    );
  }
  if (!dual && busPa > request.pressureLimitPa) {
    satisfied = false;
    notes.push('泵出口压力超过试算预算。');
  }
  const sw = of('adjustable-pressure-switch')[0];
  let controlPending = false;
  if (sw) {
    const trip = sw.parameters.hydraulic?.tripPressurePa,
      reset = sw.parameters.hydraulic?.resetPressurePa;
    if (!ideal(sw.id + ':H', bus) || trip === undefined || reset === undefined || reset >= trip) {
      controlPending = true;
      notes.push('压力开关 H 口取压或动作、复位阈值待核。');
    } else {
      const state = busPa >= trip ? 'on' : busPa <= reset ? 'off' : phase.switchPrevious;
      controlPending = state === undefined;
      notes.push(
        '压力开关 H 口 ' +
          mp(busPa) +
          '，动作 ' +
          mp(trip) +
          '，复位 ' +
          mp(reset) +
          '。' +
          (state === undefined
            ? '回差区缺少前态，开关状态待核。'
            : (busPa < trip && busPa > reset ? '回差区保持前态，' : '') +
              (state === 'on' ? '开关已动作。' : '开关已复位。')),
      );
    }
  } else if (phase.switchPrevious !== undefined) return fail('工况指定了压力开关前态，但没有压力开关。');
  return {
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: { satisfied, summary: notes.join(' '), ...(controlPending ? { controlPending: true } : {}) },
    },
  };
}
