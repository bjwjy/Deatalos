import type { NetworkProject } from '@hyd/domain';
import type { StepWriter } from './network-duty-supply-storage.js';
type Values = Readonly<Record<string, number>>;
const pending = (reason: string) => ({ reason, pending: true });
const fmt = (v: number) => Number(v.toPrecision(6));
export function elasticStop(p: NetworkProject, id: string, v: Values, write: StepWriter, retract = false) {
  const c = p.design.components.find((c) => c.id === id),
    g = c?.parameters.geometry,
    m = c?.parameters.mechanics,
    mass = m?.massKg,
    beta = p.design.fluid.bulkModulusPa,
    ac = g?.capAreaM2 ?? g?.equalAnnularAreaM2,
    ar = g?.rodSideAreaM2 ?? g?.equalAnnularAreaM2;
  if (!mass || !beta || !ac || !ar) return pending('缺少质量、面积或油液体积模量。');
  const cap = v.capV!,
    rod = v.rodV!,
    k = v.stiffness!,
    d = v.damping!,
    speed = v.speed!;
  const stiffness = k + beta * ((ac * ac) / cap + (ar * ar) / rod),
    damping = d + (m?.loadDampingNsPerM ?? 0) + (m?.pistonDampingNsPerM ?? 0),
    a = damping / (2 * mass),
    omega = Math.sqrt(stiffness / mass);
  const w = Math.sqrt(Math.abs(omega ** 2 - a ** 2));
  const critical = w <= omega * 1e-6;
  const t = speed === 0 ? 0 : critical ? 1 / a : a < omega ? Math.atan2(w, a) / w : Math.log((a + w) / omega) / w;
  function state(time: number) {
    const e = Math.exp(-a * time);
    if (critical) return [speed * time * e, speed * e * (1 - a * time)] as const;
    if (a < omega) {
      const x = (speed * e * Math.sin(w * time)) / w;
      return [x, speed * e * Math.cos(w * time) - a * x] as const;
    }
    const slow = -(omega ** 2) / (a + w),
      fast = -a - w,
      one = Math.exp(slow * time),
      two = Math.exp(fast * time);
    return [(speed * (one - two)) / (2 * w), (speed * (slow * one - fast * two)) / (2 * w)] as const;
  }
  const x = state(t)[0];
  const force = (time: number) => {
    const [x, u] = state(time);
    return k * x + d * u;
  };
  const slope = (time: number) => {
    const [x, u] = state(time);
    return k * u - (d * (stiffness * x + damping * u)) / mass;
  };
  let lo = 0,
    hi = t;
  for (let i = 0; i < 55; i++) {
    const mid = (lo + hi) / 2;
    if (slope(mid) > 0) lo = mid;
    else hi = mid;
  }
  const peakForce = Math.max(force(0), force(t), force((lo + hi) / 2));
  if ((ac * x) / cap > 0.05 || (ar * x) / rod > 0.05) return pending('受压容积变化超过 5%，小变形线性碰撞模型待核。');
  const direction = retract ? -1 : 1,
    end = retract ? '缩回端' : '伸出端';
  const pa = v.capP! - (direction * (beta * ac * x)) / cap,
    pb = v.rodP! + (direction * (beta * ar * x)) / rod;
  if (Math.min(pa, pb, v.capP!, v.rodP!) <= v.vapour!) return pending('首次压缩期间达到蒸气压，封闭液柱模型越界。');
  write('compression', end + '首次最大压缩量', '两腔液压刚度与端部弹性并联', x, 'm', 1000, 'mm');
  write('contact-time', '首次最大压缩时刻', '质量阻尼弹簧解的首次零速', t, 's');
  write('contact-force', '端部峰值接触力', 'max(kx+c·v)', peakForce, 'N');
  write(
    retract ? 'rod-low' : 'rod-peak',
    retract ? '杆腔最低绝压' : '首次压缩杆腔峰值绝压',
    retract ? 'pB0−β·Ar·x/Vr' : 'pB0+β·Ar·x/Vr',
    pb,
    'Pa',
    1e-6,
    'MPa',
  );
  write(
    retract ? 'cap-peak' : 'cap-low',
    retract ? '首次压缩无杆腔峰值绝压' : '无杆腔最低绝压',
    retract ? 'pA0+β·Ac·x/Vc' : 'pA0−β·Ac·x/Vc',
    pa,
    'Pa',
    1e-6,
    'MPa',
  );
  return {
    pending: false,
    reason:
      end +
      '首次压缩 ' +
      fmt(x * 1000) +
      ' mm，峰值接触力 ' +
      fmt(peakForce) +
      (retract ? ' N，无杆腔峰值绝压 ' : ' N，杆腔峰值绝压 ') +
      fmt((retract ? pa : pb) / 1e6) +
      ' MPa。',
  };
}
export function pipelineSurge(p: NetworkProject, id: string, v: Values, write: StepWriter) {
  const line = p.design.connections.find((e) => e.id === id && e.kind === 'pipe');
  const l = line?.kind === 'pipe' ? line.parameters.lengthM : undefined,
    d = line?.kind === 'pipe' ? line.parameters.internalDiameterM : undefined;
  if (!l || !d) return pending('该段缺实际长度或内径。');
  const rho = p.design.fluid.densityKgPerM3,
    c = v.wave!,
    q0 = v.flow!,
    p0 = v.initialPa!,
    pv = v.vapour!,
    end = v.duration!,
    close = v.closure!;
  if (p0 <= pv) return pending('初始油液绝压须高于实测蒸气压。');
  const z = (rho * c) / ((Math.PI * d * d) / 4),
    travel = l / c;
  write('travel', '压力波单程传播时间', 'L/c', travel, 's');
  write('jump', '瞬时全关第一波压升参考', 'ρc·Q/A', z * q0, 'Pa', 1e-6, 'MPa');
  const qValve = (t: number) => (close === 0 ? 0 : q0 * Math.max(0, 1 - t / close));
  function solve(n: number) {
    const dt = travel / n,
      steps = Math.floor(end / dt);
    if (steps < 2 || steps * n > 3500000) return;
    let left = new Float64Array(n + 1).fill(q0),
      right = left.slice(),
      pressure = new Float64Array(n + 1).fill(p0),
      vol = new Float64Array(n + 1),
      peak = p0,
      peakT = 0,
      first = -1,
      rejoin = -1,
      rejoinPeak = 0;
    let nextL = left.slice(),
      nextR = right.slice(),
      nextP = pressure.slice();
    for (let k = 1; k <= steps; k++) {
      const t = k * dt;
      nextP[0] = p0;
      nextR[0] = (p0 - (pressure[1]! - z * left[1]!)) / z;
      nextL[0] = nextR[0]!;
      for (let i = 1; i <= n; i++) {
        const plus = pressure[i - 1]! + z * right[i - 1]!,
          minus = i === n ? 0 : pressure[i + 1]! - z * left[i + 1]!;
        const fixed = qValve(t),
          wet = i === n ? plus - z * fixed : (plus + minus) / 2;
        let pi = wet,
          ql = (plus - wet) / z,
          qr = i === n ? fixed : (wet - minus) / z;
        if (wet < pv || vol[i]! > 0) {
          const qin = (plus - pv) / z,
            qout = i === n ? fixed : (pv - minus) / z,
            stored = vol[i]! + (qout - qin) * dt;
          if (stored > 0) {
            pi = pv;
            ql = qin;
            qr = qout;
            vol[i] = stored;
            if (first < 0) first = t;
          } else if (vol[i]! > 0) {
            const fraction = vol[i]! / ((qin - qout) * dt);
            if (rejoin < 0) rejoin = t - dt + fraction * dt;
            pi = wet + (pv - wet) * fraction;
            ql = (plus - pi) / z;
            qr = i === n ? fixed : (pi - minus) / z;
            vol[i] = 0;
          }
        }
        nextL[i] = ql;
        nextR[i] = qr;
        nextP[i] = pi;
        if (pi > peak + Math.max(1, peak) * 1e-10) {
          peak = pi;
          peakT = t;
        }
      }
      if (rejoin >= 0) for (const value of nextP) rejoinPeak = Math.max(rejoinPeak, value);
      [left, nextL] = [nextL, left];
      [right, nextR] = [nextR, right];
      [pressure, nextP] = [nextP, pressure];
    }
    return { peak, peakT, first, rejoin, rejoinPeak, dt, stop: steps * dt };
  }
  let previous: ReturnType<typeof solve>;
  for (const n of [12, 24, 48, 96, 192]) {
    const r = solve(n);
    if (!r) {
      previous = undefined;
      continue;
    }
    if (
      previous &&
      Math.abs(r.peak - previous.peak) <= 1e4 + 0.01 * r.peak &&
      Math.abs(r.peakT - previous.peakT) <= 2 * previous.dt &&
      r.first < 0 === previous.first < 0 &&
      r.rejoin < 0 === previous.rejoin < 0 &&
      Math.abs(r.first - previous.first) <= 2 * previous.dt &&
      Math.abs(r.rejoin - previous.rejoin) <= 2 * previous.dt &&
      Math.abs(r.rejoinPeak - previous.rejoinPeak) <= 1e4 + 0.01 * r.rejoinPeak
    ) {
      write('cells', '细网格段数', '与半数分段复算', n, '1');
      write('last-sample', '末次网格采样时刻', 'Δt=L/(Nc)', r.stop, 's');
      write('wave-peak', '沿管已算峰值绝压', '特征线网格峰值', r.peak, 'Pa', 1e-6, 'MPa');
      write('wave-peak-time', '首次峰压时刻', '网格追踪', r.peakT, 's');
      if (r.first >= 0) write('cavity', '首次达到蒸气压并形成空穴', '局部液柱分离', r.first, 's');
      if (r.rejoin >= 0) {
        write('rejoin', '首次空穴回填时刻', '局部液柱重新接合', r.rejoin, 's');
        write('rejoin-peak', '首次回填后窗口内全管峰值绝压', '各节点压力最大值', r.rejoinPeak, 'Pa', 1e-6, 'MPa');
      }
      return {
        pending: r.first >= 0 && r.rejoin < 0,
        reason:
          '窗口内沿管峰值绝压 ' +
          fmt(r.peak / 1e6) +
          ' MPa。' +
          (r.first < 0
            ? '未出现液柱分离。'
            : r.rejoin < 0
              ? '已形成空穴，回填超出观察窗。'
              : '首次回填 ' + fmt(r.rejoin) + ' s。'),
      };
    }
    previous = r;
  }
  return pending('观测窗与网格工作量或相邻两档峰值及事件收敛条件未满足，保留第一波参考值。');
}
