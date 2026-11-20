/** Fixed-step midpoint integration of the declared lumped model. Each candidate
 * is replayed from the same initial state; event corners are integration boundaries. */
export type MetricUnit = 'Pa' | 's' | 'm' | 'm/s' | 'm³/rev' | 'rad/s';
export interface TransientMetric {
  label: string;
  unit: MetricUnit;
  value: number;
}
export type Metrics = Map<string, TransientMetric>;
export interface TransientRun {
  values: Metrics;
  pending: string[];
}
export interface TransientModel {
  initial: readonly number[];
  corners: readonly number[];
  rate: (time: number, y: readonly number[]) => number[];
  project: (y: number[]) => void;
  valid: (y: readonly number[]) => boolean;
  observe: (time: number, y: readonly number[], values: Metrics) => void;
  finish: (values: Metrics) => string[];
}
export function samplePeak(values: Metrics, key: string, label: string, time: number, pressure: number) {
  const last = values.get(key);
  if (last && pressure <= last.value) return;
  values.set(key, { label, unit: 'Pa', value: pressure });
  values.set(key + '-time', { label: label + '时刻', unit: 's', value: time });
}
function solve(model: TransientModel, h: number): TransientRun | undefined {
  const y = [...model.initial],
    values: Metrics = new Map();
  let time = 0;
  if (!model.valid(y)) return undefined;
  model.observe(0, y, values);
  for (const end of model.corners) {
    const from = time,
      count = Math.ceil((end - from) / h);
    if (count <= 0) continue;
    const dt = (end - from) / count;
    for (let j = 1; j <= count; j++) {
      const startRate = model.rate(time, y),
        mid = y.map((v, i) => v + (dt * startRate[i]!) / 2);
      // Project contact on the completed step. Zeroing the intermediate velocity would strand the piston just short of its stop.
      if (!model.valid(mid)) return undefined;
      const rate = model.rate(time + dt / 2, mid);
      for (let i = 0; i < y.length; i++) y[i] = y[i]! + dt * rate[i]!;
      model.project(y);
      if (!model.valid(y)) return undefined;
      time = j === count ? end : from + j * dt;
      model.observe(time, y, values);
    }
  }
  return { values, pending: model.finish(values) };
}
const limits: Record<MetricUnit, number> = {
  Pa: 10000,
  s: 0.00025,
  m: 0.00005,
  'm/s': 0.0005,
  'rad/s': 0.01,
  'm³/rev': 1e-9,
};
function agrees(a: TransientRun, b: TransientRun) {
  if (a.values.size !== b.values.size || a.pending.join() !== b.pending.join()) return false;
  for (const [key, x] of a.values) {
    const y = b.values.get(key);
    if (!y || !Number.isFinite(y.value) || !Number.isFinite(x.value)) return false;
    const tol = limits[x.unit] + (x.unit === 's' ? 0 : 0.005 * Math.abs(y.value));
    if (Math.abs(x.value - y.value) > tol) return false;
  }
  return true;
}
export function refinedTransient(create: () => TransientModel) {
  let previous: TransientRun | undefined,
    everValid = false;
  for (const h of [0.0002, 0.0001, 0.00005, 0.000025, 0.0000125, 0.00000625]) {
    const model = create();
    if (model.corners[model.corners.length - 1]! / h > 320000) break;
    const current = solve(model, h);
    if (current && previous && agrees(previous, current))
      return { ok: true as const, run: current, coarse: h * 2, fine: h };
    if (current) everValid = true;
    previous = current;
  }
  return {
    ok: false as const,
    domainError: !everValid,
    reason: everValid
      ? '逐档减半未达到峰值、事件时刻或运动量的收敛容差。'
      : '轨迹出现低压越界、超出 70 MPa 或数值无效。',
  };
}
