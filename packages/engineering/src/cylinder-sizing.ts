import { checkJson, ContractReader, diagnostic, fromSI, specs, toSI, type Result } from '@hyd/domain';
import { sizeLegacy } from './size-legacy.js';

export interface SizingRequirements {
  readonly forceN: number;
  readonly speedMPerS: number;
  readonly pressureBudgetPa: number;
  readonly strokeM: number;
  readonly pumpAngularSpeedRadPerS?: number;
  readonly volumetricEfficiency?: number;
  readonly totalEfficiency?: number;
}
export interface Sizing {
  readonly boreM: number;
  readonly rodM: number;
  readonly strokeM: number;
  readonly theoreticalBoreM: number;
  readonly requiredFlowM3PerS: number;
  readonly requiredDisplacementM3PerRev: number;
  readonly pumpDisplacementM3PerRev: number;
  readonly actualFlowM3PerS: number;
  readonly actualSpeedMPerS: number;
  readonly shaftPowerW: number;
  readonly pressureBudgetPa: number;
  readonly forceN: number;
  readonly totalEfficiency: number;
  readonly assumptions: readonly string[];
}
function defaultPump(key: string): number {
  const spec = specs('pump').find((s) => s.key === key);
  if (!spec) throw new Error(`Pump specification missing: ${key}`);
  return toSI(spec.quantity, spec.defaultValue);
}
/** Pure preliminary sizing; returns a candidate, never applies it to a document. */
export function sizeCylinder(input: unknown): Result<Sizing> {
  const budget = checkJson(input);
  if (!budget.ok) return budget;
  const r = new ContractReader();
  const raw = r.object(input, '/requirements', [
    'forceN',
    'speedMPerS',
    'pressureBudgetPa',
    'strokeM',
    'pumpAngularSpeedRadPerS',
    'volumetricEfficiency',
    'totalEfficiency',
  ]);
  const positive = (key: string) => r.number(raw[key], `/requirements/${key}`, Number.MIN_VALUE, Number.MAX_VALUE);
  const force = positive('forceN'),
    speed = positive('speedMPerS');
  const pressure = positive('pressureBudgetPa'),
    stroke = positive('strokeM');
  const angular =
    raw.pumpAngularSpeedRadPerS === undefined
      ? defaultPump('angularSpeedRadPerS')
      : positive('pumpAngularSpeedRadPerS');
  const etaV =
    raw.volumetricEfficiency === undefined
      ? defaultPump('volumetricEfficiency')
      : r.number(raw.volumetricEfficiency, '/requirements/volumetricEfficiency', Number.MIN_VALUE, 1);
  const etaTotal =
    raw.totalEfficiency === undefined
      ? defaultPump('totalEfficiency')
      : r.number(raw.totalEfficiency, '/requirements/totalEfficiency', Number.MIN_VALUE, etaV);
  if (pressure <= 1.5e6) r.fail('PARAMETER_INVALID', '/requirements/pressureBudgetPa', '初选压力预算须大于 1.5 MPa。');
  if (etaTotal > etaV) r.fail('PARAMETER_INVALID', '/requirements/totalEfficiency', '总效率不能大于容积效率。');
  const parsed = r.finish({ force, speed, pressure, stroke, angular, etaV, etaTotal });
  if (!parsed.ok) return parsed;
  try {
    const s = sizeLegacy(
      fromSI('force', force),
      fromSI('linearSpeed', speed),
      fromSI('pressure', pressure),
      fromSI('length', stroke),
      fromSI('angularSpeed', angular),
      etaV,
      etaTotal,
    );
    if (!Object.values(s).every(Number.isFinite))
      return {
        ok: false,
        diagnostics: [diagnostic('SIZING_FAILED', '/requirements', '初选发生数值溢出，不能返回候选。')],
      };
    return r.finish({
      boreM: toSI('length', s.bore),
      rodM: toSI('length', s.rod),
      strokeM: toSI('length', s.stroke),
      theoreticalBoreM: toSI('length', s.theoretical),
      requiredFlowM3PerS: toSI('flow', s.Q),
      requiredDisplacementM3PerRev: toSI('displacement', s.displacement),
      pumpDisplacementM3PerRev: toSI('displacement', s.pump),
      actualFlowM3PerS: toSI('flow', s.actualQ),
      actualSpeedMPerS: toSI('linearSpeed', s.actualSpeed),
      shaftPowerW: toSI('power', s.power),
      pressureBudgetPa: toSI('pressure', s.pressure),
      forceN: toSI('force', s.force),
      totalEfficiency: s.etaTotal,
      assumptions: [
        '供油压降余量 1 MPa',
        '回油背压 0.5 MPa',
        '缸机械效率 0.95',
        '杆/缸径比 0.6；杆径按 mm 取整',
        '离散演示规格；无强度、失稳、气蚀或厂家适配校核',
      ],
    });
  } catch (cause) {
    // Own the legacy sizing exception boundary. Valid requirements can exceed its candidate series.
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'SIZING_UNSUPPORTED',
          '/requirements',
          cause instanceof Error ? cause.message : '旧初选候选范围不足。',
        ),
      ],
    };
  }
}
