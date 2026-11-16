import { checkJson, ContractReader, diagnostic, immutable, type Result } from '@hyd/domain';
import { networkResultView, displayNetworkQuantity } from '@hyd/engineering';
import { type NetworkExportCapture, exportNetworkCsv } from './network-export.js';
import { networkRecordMaximum } from './network-records.js';
import { csvCell } from './export-csv.js';
import { parseExportArtifact, type ExportArtifact } from './export-artifact.js';

export interface CurveRequest {
  readonly target: { readonly objectKind: string; readonly objectId: string; readonly field: string };
  readonly fromS: number;
  readonly toS: number;
  readonly maximumPoints: number;
  readonly relativeTolerance: number;
  readonly samplesPerFile: number;
  readonly scope: 'curve' | 'all';
  readonly keys: readonly {
    readonly sampleIndex: number;
    readonly label: string;
    readonly offsetX: number;
    readonly offsetY: number;
  }[];
}
export interface CurveSample {
  readonly index: number;
  readonly timeS: number;
  readonly tick: number;
  readonly value: number | null;
  readonly si: number | null;
  readonly reason: string;
}
export interface CurvePlan {
  readonly request: CurveRequest;
  readonly indices: readonly number[];
  readonly segments: readonly (readonly number[])[];
  readonly samples: readonly CurveSample[];
  readonly label: string;
  readonly unit: string;
  readonly siUnit: string;
  readonly mandatoryCount: number;
  readonly maximumError: number;
  readonly metadata: string;
}
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/curve', message)],
});
export function parseCurveRequest(input: unknown): Result<CurveRequest> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader();
  const o = r.object(input, '', [
    'target',
    'fromS',
    'toS',
    'maximumPoints',
    'relativeTolerance',
    'samplesPerFile',
    'scope',
    'keys',
  ]);
  const t = r.object(o.target, '/target', ['objectKind', 'objectId', 'field']);
  const integer = (v: unknown, field: string, min: number, max: number) => {
    const n = r.number(v, field, min, max);
    if (!Number.isSafeInteger(n)) r.fail('CURVE_INPUT_INVALID', field, '点数和样本编号须为整数。');
    return n;
  };
  const scope = o.scope === 'curve' || o.scope === 'all' ? o.scope : null;
  if (!scope) return fail('CURVE_INPUT_INVALID', '请选择单条曲线或全部量值。');
  const keys = r.array(o.keys, '/keys', 16).map((raw, i) => {
    const k = r.object(raw, `/keys/${i}`, ['sampleIndex', 'label', 'offsetX', 'offsetY']);
    const label = r.text(k.label, `/keys/${i}/label`, 0, 80);
    if (/[\u0000-\u001f]/.test(label)) r.fail('CURVE_INPUT_INVALID', `/keys/${i}/label`, '标注不能包含控制字符。');
    return {
      sampleIndex: integer(k.sampleIndex, `/keys/${i}/sampleIndex`, 0, networkRecordMaximum - 1),
      label,
      offsetX: r.number(k.offsetX, `/keys/${i}/offsetX`, -300, 300),
      offsetY: r.number(k.offsetY, `/keys/${i}/offsetY`, -300, 300),
    };
  });
  r.unique(
    keys.map((k) => String(k.sampleIndex)),
    '/keys',
  );
  return r.finish({
    target: {
      objectKind: r.text(t.objectKind, '/target/objectKind', 1, 40),
      objectId: r.id(t.objectId, '/target/objectId'),
      field: r.text(t.field, '/target/field', 1, 80),
    },
    fromS: r.number(o.fromS, '/fromS', 0, 1e12),
    toS: r.number(o.toS, '/toS', 0, 1e12),
    maximumPoints: integer(o.maximumPoints, '/maximumPoints', 2, networkRecordMaximum),
    relativeTolerance: r.number(o.relativeTolerance, '/relativeTolerance', 0, 1),
    samplesPerFile: integer(o.samplesPerFile, '/samplesPerFile', 2, 2000),
    scope,
    keys,
  });
}

export interface ReductionSeries {
  readonly values: readonly (number | null)[];
  readonly reasons: readonly string[];
}
export interface Reduction {
  readonly indices: readonly number[];
  readonly mandatoryCount: number;
  readonly maximumError: number;
}
/** Vertical-error RDP at actual sample times. All extrema, gaps and control edges are mandatory.
 * This reduces a frozen record; it never changes integration steps or creates new samples. */
export function reduceCurveSamples(
  times: readonly number[],
  series: readonly ReductionSeries[],
  mandatory: readonly number[],
  tolerance: number,
  maximumPoints: number,
): Result<Reduction> {
  const n = times.length;
  if (
    !n ||
    n > networkRecordMaximum ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 1 ||
    !Number.isInteger(maximumPoints) ||
    maximumPoints < 2 ||
    maximumPoints > networkRecordMaximum ||
    times.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= times[i - 1]!)) ||
    !series.length ||
    series.some(
      (s) => s.values.length !== n || s.reasons.length !== n || s.values.some((v) => v !== null && !Number.isFinite(v)),
    ) ||
    mandatory.some((i) => !Number.isInteger(i) || i < 0 || i >= n)
  )
    return fail('CURVE_INPUT_INVALID', '精简输入的时间、量值或预算无效。');
  const keep = new Set([0, n - 1, ...mandatory]);
  const spans = series.map((s) => {
    const known = s.values.filter((v): v is number => v !== null);
    for (let i = 1; i < n; i++) {
      if ((s.values[i] === null) !== (s.values[i - 1] === null) || s.reasons[i] !== s.reasons[i - 1]) {
        keep.add(i - 1);
        keep.add(i);
      }
    }
    let lastSign = 0,
      plateauStart = 0;
    for (let i = 1; i < n; i++) {
      const a = s.values[i - 1],
        b = s.values[i];
      if (a === null || b === null || a === undefined || b === undefined) {
        lastSign = 0;
        continue;
      }
      const sign = Math.sign(b - a);
      if (sign && lastSign && sign !== lastSign) {
        keep.add(plateauStart);
        keep.add(i - 1);
      }
      if (sign) {
        lastSign = sign;
        plateauStart = i;
      }
    }
    return known.length ? Math.max(...known) - Math.min(...known) : 0;
  });
  const mandatoryCount = keep.size;
  const anchors = [...keep].sort((a, b) => a - b);
  const pending: [number, number][] = [];
  for (let i = 1; i < anchors.length; i++) pending.push([anchors[i - 1]!, anchors[i]!]);
  let maximumError = 0;
  while (pending.length) {
    const pair = pending.pop();
    if (!pair) break;
    const [a, b] = pair;
    let worst = 0,
      at = -1;
    for (let i = a + 1; i < b; i++)
      for (let q = 0; q < series.length; q++) {
        const s = series[q]!,
          va = s.values[a],
          vb = s.values[b],
          vi = s.values[i];
        if (va === null || vb === null || vi === null || va === undefined || vb === undefined || vi === undefined)
          continue;
        const error = Math.abs(vi - (va + ((vb - va) * (times[i]! - times[a]!)) / (times[b]! - times[a]!)));
        const span = spans[q]!;
        const relative = span ? error / span : error === 0 ? 0 : Infinity;
        if (relative > worst) {
          worst = relative;
          at = i;
        }
      }
    if (worst > tolerance && at >= 0) {
      keep.add(at);
      pending.push([a, at], [at, b]);
    } else maximumError = Math.max(maximumError, worst);
  }
  if (keep.size > maximumPoints)
    return fail(
      'CURVE_POINT_BUDGET',
      `本算法的保真方案需要 ${keep.size} 点（强制保留 ${mandatoryCount} 点），当前上限 ${maximumPoints}；请增加点数、缩小时间范围或调整误差。`,
    );
  return { ok: true, value: immutable({ indices: [...keep].sort((a, b) => a - b), mandatoryCount, maximumError }) };
}

export function planNetworkCurve(capture: NetworkExportCapture, input: unknown): Result<CurvePlan> {
  const parsed = parseCurveRequest(input);
  if (!parsed.ok) return parsed;
  const request = parsed.value,
    first = capture.samples[0],
    last = capture.samples.at(-1);
  if (!first || !last) return fail('CURVE_RECORD_EMPTY', '没有可用的保留样本；请先运行并捕获记录。');
  if (request.fromS > request.toS || request.fromS < first.identity.timeS || request.toS > last.identity.timeS)
    return fail(
      'CURVE_RANGE_UNAVAILABLE',
      `可用时间为 ${first.identity.timeS}–${last.identity.timeS} s；已丢弃的样本不能恢复。`,
    );
  const indices = capture.samples.flatMap((s, i) =>
    s.identity.timeS >= request.fromS && s.identity.timeS <= request.toS ? [i] : [],
  );
  if (!indices.length) return fail('CURVE_RANGE_EMPTY', '所选时间范围内没有真实样本。');
  const target = capture.view.quantities.find(
    (q) =>
      q.objectKind === request.target.objectKind &&
      q.objectId === request.target.objectId &&
      q.field === request.target.field,
  );
  if (!target) return fail('CURVE_QUANTITY_UNAVAILABLE', '所选量值不属于冻结结果。');
  const targetDisplay = displayNetworkQuantity(target);
  const quantities = request.scope === 'all' ? capture.view.quantities : [target];
  const series: { values: (number | null)[]; reasons: string[] }[] = quantities.map(() => ({
    values: [],
    reasons: [],
  }));
  const samples: CurveSample[] = [];
  for (const index of indices) {
    const point = capture.samples[index]!;
    const view = networkResultView(capture.view.document, point, point.identity);
    if (!view.ok) return view;
    for (let i = 0; i < quantities.length; i++) {
      const wanted = quantities[i]!;
      const q = view.value.quantities.find(
        (v) => v.objectKind === wanted.objectKind && v.objectId === wanted.objectId && v.field === wanted.field,
      );
      series[i]!.values.push(q?.value.kind === 'known' ? q.value.value : null);
      series[i]!.reasons.push(
        q ? (q.value.kind === 'known' ? '' : q.value.kind + ':' + q.value.reason) : 'QUANTITY_UNAVAILABLE',
      );
    }
    const q = view.value.quantities.find(
      (v) => v.objectKind === target.objectKind && v.objectId === target.objectId && v.field === target.field,
    );
    const display = q ? displayNetworkQuantity(q) : null;
    samples.push({
      index,
      timeS: point.identity.timeS,
      tick: point.identity.tick,
      value: display?.value.kind === 'known' ? display.value.value : null,
      si: q?.value.kind === 'known' ? q.value.value : null,
      reason: q ? (q.value.kind === 'known' ? '' : q.value.kind + ':' + q.value.reason) : 'QUANTITY_UNAVAILABLE',
    });
  }
  const mandatory: number[] = [];
  for (const key of request.keys) {
    const at = indices.indexOf(key.sampleIndex);
    if (at < 0 || samples[at]?.value === null)
      return fail('CURVE_KEY_UNAVAILABLE', '关键点必须是所选范围内的真实已知样本。');
    mandatory.push(at);
  }
  for (let i = 1; i < indices.length; i++)
    if (
      capture.samples[indices[i]!]!.identity.controlSequence !==
      capture.samples[indices[i - 1]!]!.identity.controlSequence
    )
      mandatory.push(i - 1, i);
  const reduced = reduceCurveSamples(
    samples.map((s) => s.timeS),
    series,
    mandatory,
    request.relativeTolerance,
    request.maximumPoints,
  );
  if (!reduced.ok) return reduced;
  const selected = reduced.value.indices.map((i) => indices[i]!);
  const retained = new Set(selected);
  const segments: number[][] = [];
  for (let i = 0; i < selected.length; i += request.samplesPerFile)
    segments.push(selected.slice(i, i + request.samplesPerFile));
  if (segments.length > 100) return fail('CURVE_SEGMENT_BUDGET', '分段超过100份，请增加每份点数或缩小范围。');
  const metadata = JSON.stringify({
    format: 'HydraulicCurveExport',
    version: 1,
    snapshotId: capture.snapshotId,
    capturedAt: capture.capturedAt,
    sourceIdentity: capture.sourceIdentity,
    pointIdentity: capture.view.point.identity,
    solver: capture.view.point.solver,
    clock: capture.view.point.clock,
    record: capture.record,
    selection: capture.selection,
    request,
    availableTimeS: [first.identity.timeS, last.identity.timeS],
    inputIndices: indices,
    selectedIndices: selected,
    mandatoryCount: reduced.value.mandatoryCount,
    maximumRelativeError: reduced.value.maximumError,
    fidelity:
      'vertical interpolation error at retained sample times, normalized by each quantity span; extrema/gaps/control edges/keys retained; no replay certificate',
    unit: targetDisplay.unit,
    siUnit: target.unit,
    selectedSamples: samples.filter((s) => retained.has(s.index)),
    keys: request.keys.map((k) => ({
      ...k,
      sample: samples.find((s) => s.index === k.sampleIndex),
      identity: capture.samples[k.sampleIndex]!.identity,
    })),
  });
  return {
    ok: true,
    value: immutable({
      request,
      indices: selected,
      segments,
      samples,
      label: target.label,
      unit: targetDisplay.unit,
      siUnit: target.unit,
      mandatoryCount: reduced.value.mandatoryCount,
      maximumError: reduced.value.maximumError,
      metadata,
    }),
  };
}

export function exportCurveSegment(
  capture: NetworkExportCapture,
  plan: CurvePlan,
  part: number,
): Result<ExportArtifact> {
  const indices = plan.segments[part];
  if (!Number.isInteger(part) || !indices) return fail('CURVE_SEGMENT_INVALID', '分段编号无效。');
  const metadata = JSON.stringify({
    curve: JSON.parse(plan.metadata),
    part: part + 1,
    parts: plan.segments.length,
    sampleIndices: indices,
  });
  if (plan.request.scope === 'all') {
    const result = exportNetworkCsv(capture, undefined, { indices, metadata });
    return result.ok ? { ok: true, value: { ...result.value, suggestedName: `全部量值-${part + 1}.csv` } } : result;
  }
  const rows: (string | number)[][] = [
    [
      'section',
      'object_id',
      'tick',
      'time_s',
      'field',
      'label',
      'unit',
      'value',
      'reason',
      'source',
      'control_sequence',
      'reference',
    ],
    ['metadata', '', '', '', 'curve_export_json', '', '', metadata, '', '', '', ''],
  ];
  for (const index of indices) {
    const sample = plan.samples.find((s) => s.index === index);
    if (!sample) return fail('CURVE_SEGMENT_INVALID', '分段引用了范围外样本。');
    const point = capture.samples[index]!;
    rows.push([
      'sample',
      plan.request.target.objectId,
      sample.tick,
      sample.timeS,
      plan.request.target.field,
      plan.label,
      plan.unit,
      sample.value === null ? '' : sample.value,
      sample.reason,
      'frozen-result',
      point.identity.controlSequence,
      JSON.stringify({
        identity: point.identity,
        si: { unit: plan.siUnit, value: sample.si },
        appliedControls: point.appliedControls,
      }),
    ]);
  }
  return parseExportArtifact({
    version: 1,
    snapshotId: capture.snapshotId,
    format: 'csv',
    suggestedName: `曲线数据-${part + 1}.csv`,
    text: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
  });
}
