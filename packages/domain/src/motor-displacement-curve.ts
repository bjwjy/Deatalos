import { ContractReader } from './reader.js';

export const motorCurvePressureMaxPa = 70e6;
export const motorCurvePressureGapPa = 1e4;
export const motorCurvePointLimit = 24;
export const motorCurveReachMin = 0.15;
export const motorCurveReachMax = 0.49;
export const motorCurveSlopeLimit = 0.01 / motorCurvePressureGapPa / motorCurveReachMin;
const defaultReach = 1 / 3;
// Avoid degenerate Bezier spans caused by sub-pascal rounding at the axes.
const minimumExtensionPa = 1;

export interface MotorCurveTangent {
  readonly slopeM3PerRevPa: number;
  readonly leftReach: number;
  readonly rightReach: number;
}
export interface MotorCurvePoint {
  readonly pressurePa: number;
  readonly displacementM3PerRev: number;
  readonly tangent?: MotorCurveTangent;
}
export interface MotorDisplacementCurve {
  readonly version: 1;
  readonly enabled: boolean;
  readonly pressureLimitPa: number;
  readonly points: readonly MotorCurvePoint[];
}
interface DisplacementRange {
  readonly min: number;
  readonly max: number;
}
type Cubic = readonly [number, number, number, number];
export interface MotorCurveSegment {
  readonly pressure: Cubic;
  readonly displacement: Cubic;
}

export function readMotorDisplacementCurve(
  r: ContractReader,
  value: unknown,
  field: string,
  range: DisplacementRange,
): MotorDisplacementCurve {
  const raw = r.object(value, field, ['version', 'enabled', 'pressureLimitPa', 'points']);
  r.constant(raw.version, 1, field + '/version', 'VERSION_UNSUPPORTED');
  if (typeof raw.enabled !== 'boolean') r.fail('PARAMETER_INVALID', field + '/enabled', '曲线启用状态必须为布尔值。');
  const pressureLimitPa = r.number(
    raw.pressureLimitPa,
    field + '/pressureLimitPa',
    motorCurvePressureGapPa,
    motorCurvePressureMaxPa,
  );
  const points = r.array(raw.points, field + '/points', motorCurvePointLimit).map((entry, i): MotorCurvePoint => {
    const f = field + '/points/' + i;
    const point = r.object(entry, f, ['pressurePa', 'displacementM3PerRev', 'tangent']);
    const pressurePa = r.number(point.pressurePa, f + '/pressurePa', 0, pressureLimitPa);
    const displacementM3PerRev = r.number(
      point.displacementM3PerRev,
      f + '/displacementM3PerRev',
      range.min,
      range.max,
    );
    if (point.tangent === undefined) return { pressurePa, displacementM3PerRev };
    const t = r.object(point.tangent, f + '/tangent', ['slopeM3PerRevPa', 'leftReach', 'rightReach']);
    return {
      pressurePa,
      displacementM3PerRev,
      tangent: {
        slopeM3PerRevPa: r.number(
          t.slopeM3PerRevPa,
          f + '/tangent/slopeM3PerRevPa',
          -motorCurveSlopeLimit,
          motorCurveSlopeLimit,
        ),
        leftReach: r.number(t.leftReach, f + '/tangent/leftReach', motorCurveReachMin, motorCurveReachMax),
        rightReach: r.number(t.rightReach, f + '/tangent/rightReach', motorCurveReachMin, motorCurveReachMax),
      },
    };
  });
  if (points.length < 2) r.fail('PARAMETER_INVALID', field + '/points', '排量曲线至少需要两个点。');
  let previous: MotorCurvePoint | undefined;
  for (const point of points) {
    if (previous && point.pressurePa - previous.pressurePa < motorCurvePressureGapPa - 1e-8)
      r.fail('PARAMETER_INVALID', field + '/points', '各点压差须递增，相邻点至少间隔 0.01 MPa。');
    previous = point;
  }
  return { version: 1, enabled: raw.enabled === true, pressureLimitPa, points };
}

export function defaultMotorDisplacementCurve(range: DisplacementRange): MotorDisplacementCurve {
  const span = range.max - range.min;
  return {
    version: 1,
    enabled: false,
    pressureLimitPa: 2e6,
    points: [
      { pressurePa: 0.2e6, displacementM3PerRev: range.min + span / 6 },
      { pressurePa: 0.6e6, displacementM3PerRev: range.min + span / 6 },
      { pressurePa: 1.05e6, displacementM3PerRev: range.min + span / 2 },
      { pressurePa: 1.4e6, displacementM3PerRev: range.max },
    ],
  };
}
export function defaultExternalMotorDisplacementCurve(
  range: DisplacementRange,
  pressure: { readonly lowPa: number; readonly highPa: number },
): MotorDisplacementCurve {
  const high = Math.max(motorCurvePressureGapPa, pressure.highPa);
  const low = Math.max(0, Math.min(high - motorCurvePressureGapPa, pressure.lowPa));
  const displacementAt = (p: number) =>
    range.min + (range.max - range.min) * clamp((p - pressure.lowPa) / (pressure.highPa - pressure.lowPa), 0, 1);
  const d0 = displacementAt(low),
    d1 = displacementAt(high);
  const tangent = { slopeM3PerRevPa: (d1 - d0) / (high - low), leftReach: defaultReach, rightReach: defaultReach };
  return {
    version: 1,
    enabled: false,
    pressureLimitPa: high,
    points: [
      { pressurePa: low, displacementM3PerRev: d0, tangent },
      { pressurePa: high, displacementM3PerRev: d1, tangent },
    ],
  };
}

const clamp = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(value, upper));
const automaticReach = (rate: number, slope: number) => {
  // 14 cm³/rev per MPa, expressed in SI.
  const reduction = clamp((Math.abs(rate) - Math.sign(rate) * slope) / 14e-12, 0, 1);
  return defaultReach - reduction * (defaultReach - motorCurveReachMin);
};

function fitTangent(
  point: MotorCurvePoint,
  previous: MotorCurvePoint | undefined,
  next: MotorCurvePoint | undefined,
  pressureLimitPa: number,
  range: DisplacementRange,
): MotorCurveTangent {
  const { pressurePa: p, displacementM3PerRev: d } = point;
  const leftSpan = p - (previous?.pressurePa ?? 0);
  const rightSpan = (next?.pressurePa ?? pressureLimitPa) - p;
  const incoming = previous ? (d - previous.displacementM3PerRev) / leftSpan : 0;
  const outgoing = next ? (next.displacementM3PerRev - d) / rightSpan : 0;
  const smallerRate = Math.min(Math.abs(incoming), Math.abs(outgoing));
  const automaticSlope =
    incoming * outgoing > 0
      ? clamp(
          (incoming * leftSpan + outgoing * rightSpan) / (leftSpan + rightSpan),
          -1.5 * smallerRate,
          1.5 * smallerRate,
        )
      : 0;
  const leftReach = point.tangent?.leftReach ?? automaticReach(incoming, automaticSlope);
  const rightReach = point.tangent?.rightReach ?? automaticReach(outgoing, automaticSlope);
  const left = leftReach * leftSpan,
    right = rightReach * rightSpan;
  // Both control displacements must remain inside the physical range.
  const lower = Math.max(left ? (d - range.max) / left : -Infinity, right ? (range.min - d) / right : -Infinity);
  const upper = Math.min(left ? (d - range.min) / left : Infinity, right ? (range.max - d) / right : Infinity);
  const slopeM3PerRevPa =
    p < minimumExtensionPa || pressureLimitPa - p < minimumExtensionPa
      ? 0
      : clamp(point.tangent?.slopeM3PerRevPa ?? automaticSlope, lower, upper);
  return { slopeM3PerRevPa, leftReach, rightReach };
}

export function compileMotorDisplacementCurve(curve: MotorDisplacementCurve, range: DisplacementRange) {
  const { points, pressureLimitPa } = curve;
  const tangents = points.map((point, i) => fitTangent(point, points[i - 1], points[i + 1], pressureLimitPa, range));
  const knots = points.map((point, i) => ({ point, tangent: tangents[i] ?? flatTangent }));
  const first = knots[0],
    last = knots.at(-1);
  if (first && first.point.pressurePa >= minimumExtensionPa)
    knots.unshift({ point: { ...first.point, pressurePa: 0 }, tangent: flatTangent });
  if (last && pressureLimitPa - last.point.pressurePa >= minimumExtensionPa)
    knots.push({ point: { ...last.point, pressurePa: pressureLimitPa }, tangent: flatTangent });
  const segments = knots.flatMap(({ point: start, tangent: left }, i): MotorCurveSegment[] => {
    const end = knots[i + 1];
    if (!end) return [];
    const p0 = start.pressurePa,
      p3 = end.point.pressurePa;
    const d0 = start.displacementM3PerRev,
      d3 = end.point.displacementM3PerRev;
    const a = (p3 - p0) * left.rightReach,
      b = (p3 - p0) * end.tangent.leftReach;
    return [
      {
        pressure: [p0, p0 + a, p3 - b, p3],
        displacement: [
          d0,
          clamp(d0 + a * left.slopeM3PerRevPa, range.min, range.max),
          clamp(d3 - b * end.tangent.slopeM3PerRevPa, range.min, range.max),
          d3,
        ],
      },
    ];
  });
  return { tangents, segments };
}

const flatTangent: MotorCurveTangent = { slopeM3PerRevPa: 0, leftReach: defaultReach, rightReach: defaultReach };
const cubic = ([a, b, c, d]: Cubic, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
const derivative = ([a, b, c, d]: Cubic, t: number) => {
  const u = 1 - t;
  return u * u * (b - a) + 2 * u * t * (c - b) + t * t * (d - c);
};
export function sampleMotorDisplacementCurve(segments: readonly MotorCurveSegment[], pressurePa: number) {
  const last = segments.at(-1);
  if (!last || !Number.isFinite(pressurePa)) return undefined;
  const first = segments[0];
  if (!first) return undefined;
  const p = clamp(Math.abs(pressurePa), first.pressure[0], last.pressure[3]);
  const segment = segments.find(({ pressure }) => p <= pressure[3]);
  if (!segment) return undefined;
  const { pressure, displacement } = segment;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(pressure, mid) < p) lo = mid;
    else hi = mid;
  }
  const t = p === pressure[0] ? 0 : p === pressure[3] ? 1 : (lo + hi) / 2;
  return {
    displacementM3PerRev: clamp(cubic(displacement, t), Math.min(...displacement), Math.max(...displacement)),
    slopeM3PerRevPa: derivative(displacement, t) / derivative(pressure, t),
  };
}
