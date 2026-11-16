// Formula port of legacy solve; retains the 1.0.0-experimental equations and branch order.
import type { ValvePositionId } from '@hyd/domain';
import * as Friction from './friction.js';
import { parameter, linkKeys, type LinkKey, type LegacyModel, type Topology } from './legacy-model.js';

interface LegacyWireValue extends Friction.PipeResult {
  readonly flow: number;
  readonly role: LinkKey;
  readonly pressureSide: boolean;
}
export function solveLegacy(
  m: LegacyModel,
  state: { position: number; angle: number },
  mode: ValvePositionId,
  t: Topology,
) {
  const pp = t.pump.params,
    ap = t.act.params,
    vp = t.valve.params;
  const pt = parameter(t.tank.params, 'pressure');
  const stroke = t.act.type === 'cylinder' ? parameter(ap, 'stroke') : 0;
  const Q = (parameter(pp, 'displacement') * parameter(pp, 'rpm') * parameter(pp, 'etaV')) / 1000;
  const loss = (key: LinkKey, q: number) => {
    const p = t.links[key].wire.params;
    return Friction.pipe(
      q,
      parameter(p, 'diameter'),
      parameter(p, 'length'),
      parameter(p, 'roughness'),
      parameter(p, 'K'),
      parameter(m.fluid, 'density'),
      parameter(m.fluid, 'viscosity'),
    );
  };
  const vl = (q: number) => parameter(vp, 'drop') * (q / parameter(vp, 'nominalFlow')) ** 2;
  const reliefP = (q: number) =>
    pt + parameter(t.relief.params, 'setting') + loss('reliefIn', q).dp + loss('reliefOut', q).dp;
  const supplyToA = mode === 'extend';
  const physicalExt = supplyToA !== t.reversed;
  const direction = mode === 'neutral' ? 0 : physicalExt ? 1 : -1;
  const areaA = t.act.type === 'cylinder' ? (Math.PI * (parameter(ap, 'bore') / 1000) ** 2) / 4 : 0;
  const areaB =
    t.act.type === 'cylinder'
      ? (Math.PI * ((parameter(ap, 'bore') / 1000) ** 2 - (parameter(ap, 'rod') / 1000) ** 2)) / 4
      : 0;
  const ai = physicalExt ? areaA : areaB,
    ao = physicalExt ? areaB : areaA;
  const ratio = t.act.type === 'cylinder' ? ao / ai : 1;
  const targetLoad =
    t.act.type === 'cylinder'
      ? physicalExt
        ? parameter(ap, 'loadExt')
        : parameter(ap, 'loadRet')
      : parameter(ap, 'torque');
  const fixedDP =
    t.act.type === 'cylinder'
      ? (targetLoad * 1000) / (parameter(ap, 'eta') * ai) / 1e6
      : (2 * Math.PI * targetLoad) / (parameter(ap, 'displacement') * 1e-6 * parameter(ap, 'etaM')) / 1e6;
  const inKey = supplyToA ? 'A' : 'B',
    outKey = supplyToA ? 'B' : 'A';
  const required = (q: number) => {
    if (mode === 'neutral') return pt + loss('supply', q).dp + vl(q) + loss('return', q).dp;
    const qr = q * ratio;
    const pout = pt + loss('return', qr).dp + vl(qr) + loss(outKey, qr).dp;
    return fixedDP + pout * ratio + loss(inKey, q).dp + vl(q) + loss('supply', q).dp;
  };
  const pos = Math.max(0, Math.min(stroke, state.position || 0));
  const end = t.act.type === 'cylinder' && mode !== 'neutral' && (direction > 0 ? pos >= stroke - 1e-9 : pos <= 1e-9);
  let q = Q,
    p = required(Q);
  let status =
    mode === 'neutral'
      ? '中位卸荷'
      : physicalExt
        ? t.act.type === 'cylinder'
          ? '伸出'
          : '正转'
        : t.act.type === 'cylinder'
          ? '缩回'
          : '反转';
  if (mode === 'neutral' && t.valve.center === 'closed') {
    q = 0;
    p = reliefP(Q);
    status = 'O 型中位 · 全流量溢流';
  } else if (end) {
    q = 0;
    p = reliefP(Q);
    status = '行程终点 · 溢流';
  } else if (required(0) > reliefP(Q)) {
    q = 0;
    p = reliefP(Q);
    status = '负载过大 · 停滞溢流';
  } else if (p > reliefP(0)) {
    let lo = 0,
      hi = Q;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (required(mid) > reliefP(Q - mid)) hi = mid;
      else lo = mid;
    }
    q = (lo + hi) / 2;
    p = required(q);
    status = mode === 'neutral' ? '中位阻力过大 · 部分溢流' : '压力受限 · 部分溢流';
  }
  const qb = Math.max(0, Q - q),
    qr = mode === 'neutral' ? q : q * ratio;
  const suction = loss('suction', Q),
    pS = pt - suction.dp;
  let pA = null,
    pB = null,
    force = 0,
    torque = 0,
    speed = 0,
    rpm = 0;
  if (mode !== 'neutral') {
    const pin = p - loss('supply', q).dp - vl(q) - loss(inKey, q).dp;
    const pout = pt + loss('return', qr).dp + vl(qr) + loss(outKey, qr).dp;
    pA = physicalExt ? pin : pout;
    pB = physicalExt ? pout : pin;
    if (t.act.type === 'cylinder') {
      force = ((pin * ai - pout * ao) * 1e6 * parameter(ap, 'eta')) / 1000;
      speed = ((direction * q) / 60000 / ai) * 1000;
    } else {
      torque = ((pin - pout) * 1e6 * parameter(ap, 'displacement') * 1e-6 * parameter(ap, 'etaM')) / (2 * Math.PI);
      rpm = (direction * 1000 * q * parameter(ap, 'etaV')) / parameter(ap, 'displacement');
    }
  }
  const flows = {
    supply: q,
    reliefIn: qb,
    reliefOut: qb,
    return: qr,
    suction: Q,
    A: mode === 'neutral' ? 0 : supplyToA ? q : -qr,
    B: mode === 'neutral' ? 0 : supplyToA ? -qr : q,
  };
  const wireValues: Record<string, LegacyWireValue> = {};
  for (const key of linkKeys) {
    const l = t.links[key],
      val = loss(key, flows[key]);
    wireValues[l.wire.id] = {
      ...val,
      flow: flows[key] * (l.wire.from === l.a ? 1 : -1),
      role: key,
      pressureSide: ['supply', 'reliefIn'].includes(key) || (['A', 'B'].includes(key) && flows[key] > 0),
    };
  }
  const hydraulicPower = ((p - pS) * Q) / 60,
    shaftPower = hydraulicPower / parameter(pp, 'etaTotal');
  const actuatorPower =
    t.act.type === 'cylinder' ? (force * Math.abs(speed)) / 1000 : (torque * Math.abs(rpm) * 2 * Math.PI) / 60 / 1000;
  const warnings = [];
  if (Object.values(wireValues).some((w) => w.regime === '过渡区估算'))
    warnings.push('部分管线处于过渡流区，摩擦系数使用插值估算。');
  if (suction.v > 1.5) warnings.push('吸油管流速超过 1.5 m/s，请检查管径与泵样本。');
  if (pS < -0.08) warnings.push('估计吸油口表压较低；当前模型未校核气蚀。');
  return {
    status,
    mode,
    direction,
    actuatorType: t.act.type,
    position: pos,
    Q,
    q: mode === 'neutral' ? 0 : q,
    returnFlow: mode === 'neutral' ? 0 : qr,
    bypassFlow: qb,
    pressure: p,
    pS,
    pA,
    pB,
    force,
    torque,
    speed,
    rpm,
    hydraulicPower,
    shaftPower,
    actuatorPower,
    lossPower: Math.max(0, shaftPower - actuatorPower),
    wireValues,
    warnings,
    stroke: stroke || null,
    areaA,
    areaB,
  };
}
