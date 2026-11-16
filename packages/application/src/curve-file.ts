import { checkJson, ContractReader, immutable, diagnostic, type Result, type NetworkIdentity } from '@hyd/domain';
import { parseOfflineCurve, type OfflineCurve } from './offline-curve.js';
import { planNetworkCurve, type CurvePlan, type CurveRequest } from './network-curve-plan.js';
import { networkRecordMaximum } from './network-records.js';
import type { NetworkExportCapture } from './network-export.js';
import { csvCell } from './export-csv.js';
import { parseExportArtifact, exportLimits, utf8Bytes, type ExportArtifact } from './export-artifact.js';

export interface CurveFile {
  readonly format: 'HydraulicCurveSet';
  readonly version: 1;
  readonly snapshotId: string;
  readonly curves: readonly OfflineCurve[];
  readonly explanations: readonly boolean[];
  readonly identityLevel: 'sample' | 'legacy-header';
  readonly identities: readonly { readonly index: number; readonly identity: NetworkIdentity }[];
}
export interface CurveFigureSettings {
  readonly paper: 'A4' | 'A3' | 'A2';
  readonly title: string;
  readonly showExplanation: boolean;
}
const failure = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('CURVE_FILE_INVALID', '/curveFile', message)],
});
export function parseCurveFigureSettings(input: unknown): Result<CurveFigureSettings> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '/figure', ['paper', 'title', 'showExplanation']);
  const paper = o.paper === 'A3' || o.paper === 'A2' ? o.paper : 'A4';
  if (o.paper !== paper) r.fail('CURVE_FIGURE_INVALID', '/figure/paper', '请选择A4、A3或A2。');
  if (typeof o.showExplanation !== 'boolean')
    r.fail('CURVE_FIGURE_INVALID', '/figure/showExplanation', '说明开关须为布尔值。');
  const title = r.text(o.title, '/figure/title', 0, 160);
  if (/[\u0000-\u001f]/.test(title)) r.fail('CURVE_FIGURE_INVALID', '/figure/title', '图名不能包含控制字符。');
  return r.finish(immutable({ paper, title, showExplanation: o.showExplanation === true }));
}
export function parseCurveFile(input: unknown): Result<CurveFile> {
  if (
    input &&
    typeof input === 'object' &&
    Object.values(Object.getOwnPropertyDescriptors(input)).some((d) => !('value' in d))
  )
    return failure('曲线文件不接受访问器。');
  const safe = checkJson(input); // Curve documents are already bounded to 4MB at file/IPC boundaries.
  // A whole multi-curve file can exceed the IPC node count. Check each curve independently below.
  if (!safe.ok && !safe.diagnostics.every((d) => d.code === 'RESOURCE_LIMIT')) return safe;
  if (input && typeof input === 'object' && 'format' in input && input.format === 'HydraulicOfflineCurve') {
    const old = parseOfflineCurve(input);
    return old.ok
      ? {
          ok: true,
          value: immutable({
            format: 'HydraulicCurveSet',
            version: 1,
            snapshotId: old.value.snapshotId,
            curves: [old.value],
            explanations: [false],
            identityLevel: 'legacy-header',
            identities: [],
          }),
        }
      : old;
  }
  const r = new ContractReader(),
    o = r.object(input, '', [
      'format',
      'version',
      'snapshotId',
      'curves',
      'explanations',
      'identityLevel',
      'identities',
    ]);
  r.constant(o.format, 'HydraulicCurveSet', '/format');
  r.constant(o.version, 1, '/version');
  const snapshotId = r.text(o.snapshotId, '/snapshotId', 1, 80);
  if (!/^[-\w]+$/.test(snapshotId)) r.fail('CURVE_FILE_INVALID', '/snapshotId', '快照身份无效。');
  const array = (raw: unknown, field: string, max: number): readonly unknown[] => {
    const values = r.array(raw, field, max);
    const descriptors = Object.getOwnPropertyDescriptors(values),
      result: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      const d = descriptors[String(i)];
      if (!d || !('value' in d)) {
        r.fail('CURVE_FILE_INVALID', field, '数据列表不接受访问器或稀疏项。');
        return [];
      }
      result.push(d.value);
    }
    return result;
  };
  const curves: OfflineCurve[] = [];
  for (const raw of array(o.curves, '/curves', 64)) {
    const curveSafe = checkJson(raw);
    if (!curveSafe.ok) return curveSafe;
    const curve = parseOfflineCurve(raw);
    if (!curve.ok) return curve;
    if (curve.value.snapshotId !== snapshotId) return failure('曲线来源与数据文件身份不一致。');
    curves.push(curve.value);
  }
  if (!curves.length) return failure('文件没有曲线；不自动生成零值。');
  const explanations = array(o.explanations, '/explanations', 64).map((v, i) => {
    if (typeof v !== 'boolean') r.fail('CURVE_FILE_INVALID', '/explanations/' + i, '说明开关无效。');
    return v === true;
  });
  if (explanations.length !== curves.length) return failure('每条曲线须有对应的图面设置。');
  const identityLevel = o.identityLevel === 'legacy-header' ? 'legacy-header' : 'sample';
  if (o.identityLevel !== identityLevel) return failure('逐样本来源级别无效。');
  const identities = array(o.identities, '/identities', networkRecordMaximum).map((raw, i) => {
    const p = '/identities/' + i;
    const safeId = checkJson(raw);
    if (!safeId.ok) {
      for (const d of safeId.diagnostics) r.fail(d.code, d.field, d.message);
      raw = {};
    }
    const item = r.object(raw, p, ['index', 'identity']),
      id = r.object(item.identity, p + '/identity', [
        'documentSessionId',
        'physicsRevision',
        'simulationSessionId',
        'tick',
        'timeS',
        'controlSequence',
        'requestSequence',
      ]);
    const integer = (v: unknown, field: string) => {
      const n = r.number(v, field, 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(n)) r.fail('CURVE_FILE_INVALID', field, '序号须为整数。');
      return n;
    };
    const index = integer(item.index, p + '/index');
    if (index >= networkRecordMaximum) r.fail('CURVE_FILE_INVALID', p + '/index', '样本索引超过容量。');
    return {
      index,
      identity: {
        documentSessionId: r.id(id.documentSessionId, p),
        physicsRevision: integer(id.physicsRevision, p),
        simulationSessionId: r.id(id.simulationSessionId, p),
        tick: integer(id.tick, p),
        timeS: r.number(id.timeS, p, 0, 1e12),
        controlSequence: integer(id.controlSequence, p),
        requestSequence: integer(id.requestSequence, p),
      },
    };
  });
  const identityMap = new Map(identities.map((p) => [p.index, p.identity]));
  if (identityMap.size !== identities.length) return failure('来源样本索引重复。');
  if (identityLevel === 'legacy-header' && identities.length) return failure('旧文件身份级别不能混用逐样本身份。');
  for (const curve of curves) {
    const metadata: unknown = JSON.parse(curve.metadata);
    const m = r.object(metadata, '/metadata', [
      'format',
      'version',
      'snapshotId',
      'capturedAt',
      'sourceIdentity',
      'pointIdentity',
      'solver',
      'clock',
      'record',
      'selection',
      'request',
      'availableTimeS',
      'inputIndices',
      'selectedIndices',
      'mandatoryCount',
      'maximumRelativeError',
      'fidelity',
      'unit',
      'siUnit',
      'selectedSamples',
      'keys',
    ]);
    const point = r.object(m.pointIdentity, '/pointIdentity', [
      'documentSessionId',
      'physicsRevision',
      'simulationSessionId',
      'tick',
      'timeS',
      'controlSequence',
      'requestSequence',
    ]);
    if (identityLevel === 'sample')
      for (const sample of curve.samples) {
        const id = identityMap.get(sample.index);
        if (
          !id ||
          id.tick !== sample.tick ||
          id.timeS !== sample.timeS ||
          id.documentSessionId !== point.documentSessionId ||
          id.physicsRevision !== point.physicsRevision ||
          id.simulationSessionId !== point.simulationSessionId ||
          id.controlSequence > Number(point.controlSequence) ||
          id.requestSequence > Number(point.requestSequence)
        )
          return failure('曲线实际样本与逐样本来源不一致。');
      }
  }
  for (let i = 1; i < identities.length; i++) {
    const a = identities[i - 1],
      b = identities[i];
    if (
      a &&
      b &&
      (a.index >= b.index ||
        a.identity.tick >= b.identity.tick ||
        a.identity.timeS >= b.identity.timeS ||
        a.identity.controlSequence > b.identity.controlSequence ||
        a.identity.requestSequence >= b.identity.requestSequence)
    )
      return failure('逐样本来源顺序无效。');
  }
  return r.finish(
    immutable({ format: 'HydraulicCurveSet', version: 1, snapshotId, curves, explanations, identityLevel, identities }),
  );
}
/** Keep every available sample in the requested window; later import never needs a solver. */
export function fullCurveFromPlan(plan: CurvePlan): Result<OfflineCurve> {
  const raw: unknown = JSON.parse(plan.metadata);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('曲线来源无效。');
  const source: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const metadata = JSON.stringify({
    ...source,
    selectedIndices: plan.samples.map((s) => s.index),
    selectedSamples: plan.samples,
    maximumRelativeError: 0,
    fidelity: 'all available frozen samples in selected window, unreduced; no recovered or fabricated samples',
  });
  return parseOfflineCurve({
    format: 'HydraulicOfflineCurve',
    version: 1,
    snapshotId: source.snapshotId,
    label: plan.label,
    unit: plan.unit,
    siUnit: plan.siUnit,
    metadata,
    samples: plan.samples,
    state: {
      title: plan.request.target.objectId + ' · ' + plan.label,
      paper: 'A4',
      fromS: plan.samples[0]?.timeS,
      toS: plan.samples.at(-1)?.timeS,
      keys: plan.request.keys,
    },
  });
}
export function prepareCurveFile(
  capture: NetworkExportCapture,
  request: CurveRequest,
  figure: CurveFigureSettings,
): Result<CurveFile> {
  const targets =
    request.scope === 'all'
      ? capture.view.quantities
      : capture.view.quantities.filter(
          (q) =>
            q.objectKind === request.target.objectKind &&
            q.objectId === request.target.objectId &&
            q.field === request.target.field,
        );
  if (targets.length > 64) return failure('数据文件最多64条曲线，请选择单条曲线导出。');
  const curves: OfflineCurve[] = [];
  for (const q of targets) {
    const selected =
      q.objectKind === request.target.objectKind &&
      q.objectId === request.target.objectId &&
      q.field === request.target.field;
    const plan = planNetworkCurve(capture, {
      ...request,
      target: { objectKind: q.objectKind, objectId: q.objectId, field: q.field },
      maximumPoints: networkRecordMaximum,
      scope: 'curve',
      keys: selected ? request.keys : [],
    });
    if (!plan.ok) return plan;
    const full = fullCurveFromPlan(plan.value);
    if (!full.ok) return full;
    curves.push({
      ...full.value,
      label: q.objectId + ' · ' + full.value.label,
      state: {
        ...full.value.state,
        paper: figure.paper,
        title: selected ? figure.title : q.objectId + ' · ' + full.value.label,
      },
    });
  }
  const indices = new Set(curves.flatMap((c) => c.samples.map((s) => s.index)));
  return parseCurveFile({
    format: 'HydraulicCurveSet',
    version: 1,
    snapshotId: capture.snapshotId,
    curves,
    explanations: curves.map(() => figure.showExplanation),
    identityLevel: 'sample',
    identities: capture.samples.flatMap((s, index) => (indices.has(index) ? [{ index, identity: s.identity }] : [])),
  });
}
export function curveFileText(file: CurveFile): Result<string> {
  const parsed = parseCurveFile(file);
  if (!parsed.ok) return parsed;
  const text = JSON.stringify(parsed.value);
  return utf8Bytes(text) <= exportLimits.bytes
    ? { ok: true, value: text }
    : failure('曲线数据超过4MB，请缩小范围或改选单条曲线；没有丢弃内容。');
}
export function storedCurveCsv(file: CurveFile, index: number): Result<ExportArtifact> {
  const curve = file.curves[index];
  if (!curve) return failure('所选曲线不存在。');
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
    [
      'metadata',
      '',
      '',
      '',
      'curve_file_json',
      '',
      '',
      JSON.stringify({
        snapshotId: file.snapshotId,
        identityLevel: file.identityLevel,
        metadata: JSON.parse(curve.metadata),
        state: curve.state,
      }),
      '',
      '',
      '',
      '',
    ],
  ];
  for (const p of curve.samples.filter((p) => p.timeS >= curve.state.fromS && p.timeS <= curve.state.toS)) {
    const id = file.identities.find((s) => s.index === p.index)?.identity;
    rows.push([
      'sample',
      curve.label,
      p.tick,
      p.timeS,
      'value',
      curve.label,
      curve.unit,
      p.value === null ? '' : p.value,
      p.reason,
      'imported-frozen-result',
      id?.controlSequence ?? '',
      JSON.stringify({ index: p.index, identity: id ?? null, si: { unit: curve.siUnit, value: p.si } }),
    ]);
  }
  return parseExportArtifact({
    version: 1,
    snapshotId: file.snapshotId,
    format: 'csv',
    suggestedName: '曲线数据.csv',
    text: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
  });
}
