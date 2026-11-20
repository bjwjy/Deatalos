import {
  compileMotorDisplacementCurve,
  networkDisplacementRange,
  sampleMotorDisplacementCurve,
  type NetworkProject,
} from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import { refinedTransient, samplePeak, type TransientModel } from './network-duty-transient-integration.js';
import type { StepWriter } from './network-duty-supply-storage.js';
const wait = (reason: string) => ({ pending: true, reason });
export function driveFeedback(
  project: NetworkProject,
  id: string,
  v: Readonly<Record<string, number>>,
  add: StepWriter,
) {
  const parts = project.design.components,
    pumps = parts.filter((c) => c.definition.id === 'teaching:variable-pump').sort((a, b) => (a.id < b.id ? -1 : 1)),
    m = parts.find((c) => c.id === id),
    tank = parts.find((c) => c.typeId === 'tank'),
    volume = parts.find((c) => c.typeId === 'volume');
  const paths = dutyPhasePaths(project, { name: '公共母线反馈', valves: [], actions: [] }, false);
  if (
    !m ||
    m.definition.id !== 'teaching:variable-motor' ||
    !tank ||
    !paths.ok ||
    pumps.length < 1 ||
    pumps.length > 2 ||
    parts.length !== pumps.length + 2 + Number(!!volume) ||
    project.design.connections.some((e) => e.kind !== 'ideal')
  )
    return wait('需一或两台压力补偿变量泵直供一只压差控制变量马达，可并一只容腔，吸排油共箱。');
  const net = paths.value.idealReachable,
    P = m.id + ':A',
    T = tank.id + ':T';
  if (
    net(P, T) ||
    !net(m.id + ':B', T) ||
    pumps.some((c) => !net(P, c.id + ':P') || !net(T, c.id + ':S')) ||
    (volume && !net(P, volume.id + ':H'))
  )
    return wait('泵 P 口及马达 A 口须接同一供油母线，马达 B 与泵 S 回同箱。');
  const curve = m.motorDisplacementCurve,
    range = networkDisplacementRange(m);
  if (!curve?.enabled || m.externalMotorControl || !range) return wait('请给马达启用已标定的压差排量曲线。');
  const segments = compileMotorDisplacementCurve(curve, range).segments;
  const h = m.parameters.hydraulic,
    mech = m.parameters.mechanics,
    init = project.design.initialConditions.find((i) => i.componentId === m.id),
    beta = project.design.fluid.bulkModulusPa,
    t = tank.parameters.hydraulic?.pressurePa,
    start = m.parameters.storage?.initialPressurePa,
    j = mech?.inertiaKgM2,
    b = mech?.viscousFrictionNmSPerRad,
    torque = mech?.externalTorqueNm,
    makeup = m.parameters.makeup;
  const ref = project.design.pressureReference;
  if (
    ref.kind !== 'gauge' ||
    ref.absoluteReferencePa === null ||
    start === undefined ||
    !beta ||
    !j ||
    !b ||
    torque === undefined ||
    !h?.displacementM3PerRev ||
    h.leakageM3PerSPa === undefined ||
    t === undefined ||
    init?.kind !== 'motor' ||
    init.angularSpeedRadPerS === null
  )
    return wait('缺马达惯量、阻尼、外载、转速初态、受压初压、油液模量或表压基准。');
  const iv = project.design.initialConditions.find((i) => i.componentId === volume?.id);
  if (
    (volume && (iv?.kind !== 'volume' || iv.pressurePa !== start)) ||
    pumps.some((c) => c.parameters.storage?.initialPressurePa !== start)
  )
    return wait('母线各储油端须具有相容的保存初压。');
  const defs = pumps.map((c, i) => {
    const h = c.parameters.hydraulic,
      s = i === 0 ? '' : '2';
    return {
      id: c.id,
      rev: (c.parameters.drive?.angularSpeedRadPerS ?? NaN) / (2 * Math.PI),
      lo: h?.minimumDisplacementM3PerRev ?? NaN,
      hi: h?.maximumDisplacementM3PerRev ?? NaN,
      d: h?.displacementM3PerRev ?? NaN,
      leak: h?.leakageM3PerSPa ?? NaN,
      cut: v['cut' + s]!,
      band: v['band' + s]!,
      tau: v['tau' + s]!,
    };
  });
  if (
    defs.some(
      (g) =>
        ![g.rev, g.lo, g.hi, g.d, g.leak, g.cut, g.band, g.tau].every(Number.isFinite) ||
        g.rev <= 0 ||
        g.band > g.cut ||
        g.d < g.lo ||
        g.d > g.hi,
    ) ||
    pumps.some((c) => c.parameters.relief?.enabled === 1)
  )
    return wait('逐泵核对转速、初始排量、截压和调节带。内置溢流参与时另核。');
  const vp =
    (m.parameters.storage?.portVolumeM3 ?? 0) +
    (volume?.parameters.hydraulic?.volumeM3 ?? 0) +
    pumps.reduce((s, c) => s + (c.parameters.storage?.portVolumeM3 ?? 0), 0);
  const pi2 = 2 * Math.PI,
    end = v.duration!,
    motorTau = v.motorTau!,
    dm = h.displacementM3PerRev,
    leak = h.leakageM3PerSPa,
    w0 = init.angularSpeedRadPerS,
    offset = ref.absoluteReferencePa;
  if (!(vp > 0) || end > 5) return wait('需要明确供油容积，时域窗口限 5 s。');
  const motorCommand = (dp: number) =>
    sampleMotorDisplacementCurve(segments, Math.max(0, dp))?.displacementM3PerRev ?? NaN;
  const pumpCommand = (g: (typeof defs)[number], dp: number) =>
    g.lo + (g.hi - g.lo) * Math.max(0, Math.min(1, (g.cut - dp) / g.band));
  const pumpFlow = (g: (typeof defs)[number], dp: number, d: number) => g.rev * d - g.leak * dp;
  const model = (): TransientModel => {
    let stable: number | undefined;
    return {
      initial: [start, w0, dm, ...defs.map((g) => g.d)],
      corners: [end],
      project: () => {},
      valid: (y) =>
        y.every(Number.isFinite) &&
        y[0]! + offset > 0 &&
        y[0]! <= 70e6 &&
        (!makeup || Math.min(y[0]!, t) >= (makeup.supplyPressurePa ?? 0) - (makeup.openingDifferentialPa ?? 0)),
      rate: (_time, y) => {
        const dp = y[0]! - t,
          w = y[1]!,
          d = y[2]!,
          qs = defs.reduce((s, g, i) => s + pumpFlow(g, dp, y[i + 3]!), 0);
        return [
          (beta / vp) * (qs - (d * w) / pi2 - leak * dp),
          ((dp * d) / pi2 - torque - b * w) / j,
          (motorCommand(dp) - d) / motorTau,
          ...defs.map((g, i) => (pumpCommand(g, dp) - y[i + 3]!) / g.tau),
        ];
      },
      observe: (time, y, metrics) => {
        const p = y[0]!,
          dp = p - t,
          w = y[1]!,
          d = y[2]!;
        samplePeak(metrics, 'peak', '反馈过程中母线峰压', time, p);
        metrics.set('p', { label: '窗口末母线压力', unit: 'Pa', value: p });
        metrics.set('w', { label: '窗口末马达角速度', unit: 'rad/s', value: w });
        metrics.set('d', { label: '马达实际排量', unit: 'm³/rev', value: d });
        for (const [i, g] of defs.entries())
          metrics.set('d-' + i, { label: g.id + ' 实际排量', unit: 'm³/rev', value: y[3 + i]! });
        const q = defs.reduce((s, g, i) => s + pumpFlow(g, dp, y[i + 3]!), 0),
          mq = (d * w) / pi2 + leak * dp;
        const balanced =
          Math.abs(q - mq) <= Math.max(1e-12, 0.002 * Math.abs(q)) &&
          Math.abs((dp * d) / pi2 - torque - b * w) <= Math.max(0.0001, 0.002 * Math.abs((dp * d) / pi2)) &&
          Math.abs(d - motorCommand(dp)) <= 0.002 * range.max &&
          defs.every((g, i) => Math.abs(y[3 + i]! - pumpCommand(g, dp)) <= 0.002 * g.hi);
        stable = balanced ? (stable ?? time) : undefined;
      },
      finish: (metrics) => {
        if (stable === undefined || end - stable < Math.max(0.005, 3 * motorTau, ...defs.map((g) => 3 * g.tau)))
          return ['窗口末尚未持续满足流量、转矩及排量平衡'];
        metrics.set('settled', { label: '进入并保持平衡时刻', value: stable, unit: 's' });
        return [];
      },
    };
  };
  const result = refinedTransient(model);
  if (!result.ok) return wait(result.reason);
  for (const [key, x] of result.run.values) {
    const scale = x.unit === 'Pa' ? 1e-6 : x.unit === 'm³/rev' ? 1e6 : x.unit === 'rad/s' ? 60 / pi2 : 1;
    add(
      key,
      x.label,
      '闭环联立轨迹',
      x.value,
      x.unit,
      scale,
      x.unit === 'Pa' ? 'MPa' : x.unit === 'm³/rev' ? 'cm³/rev' : x.unit === 'rad/s' ? 'r/min' : x.unit,
    );
  }
  const pressure = result.run.values.get('p')!.value;
  for (const [i, g] of defs.entries()) {
    const q = pumpFlow(g, pressure - t, result.run.values.get('d-' + i)!.value);
    add('q-' + i, g.id + ' 窗口末供流', 'nD−C漏Δp', q, 'm³/s', 60000, 'L/min');
    add('power-' + i, g.id + ' 窗口末液压功率', 'Δp·Q', q * (pressure - t), 'W');
  }
  add('fine', '收敛细步长', '同初态减半重放', result.fine, 's', 1e6, 'μs');
  return {
    pending: result.run.pending.length > 0,
    reason:
      '母线末压 ' +
      Number((pressure / 1e6).toPrecision(6)) +
      ' MPa，马达末速 ' +
      Number(((result.run.values.get('w')!.value * 60) / pi2).toPrecision(6)) +
      ' r/min。' +
      (result.run.pending.join('；') || '流量、转矩及排量均已稳定。'),
  };
}
