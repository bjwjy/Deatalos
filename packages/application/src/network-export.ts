import {
  csvMetadataDisplayName,
  csvColumnGuide,
  valueReasonDisplay,
  checkJson,
  ContractReader,
  diagnostic,
  immutable,
  parseNetworkProject,
  parseNetworkSnapshot,
  networkStepRunKey,
  type NetworkIdentity,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';
import { displayNetworkQuantity, networkResultView, type NetworkResultView } from '@hyd/engineering';
import {
  readNetworkRecord,
  sameNetworkIdentity,
  type NetworkRecordPage,
  type RecordSelection,
} from './network-records.js';
import { csvCell } from './export-csv.js';
import { parseExportArtifact, type ExportArtifact } from './export-artifact.js';

export interface NetworkExportCapture {
  readonly format: 'HydraulicNetworkExport';
  readonly version: 1;
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly appVersion: string;
  readonly sourceIdentity: NetworkIdentity;
  readonly selection: 'current' | 'history';
  readonly view: NetworkResultView;
  readonly samples: readonly NetworkSnapshot[];
  readonly record: NetworkRecordPage['record'];
}
export interface NetworkRecordPort {
  records(expected: NetworkIdentity, selection: RecordSelection): Promise<Result<unknown>>;
}
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/export', message)],
});
/** Validates each bounded IPC page. No result may be relabelled with a newer identity. */
export function parseNetworkRecordPage(
  input: unknown,
  expected: NetworkIdentity,
  selection: RecordSelection,
): Result<NetworkRecordPage> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', [
      'sourceIdentity',
      'document',
      'point',
      'record',
      'offset',
      'nextOffset',
      'samples',
      'selection',
    ]);
  const project = parseNetworkProject(o.document);
  if (!project.ok) return project;
  const point = parseNetworkSnapshot(project.value, o.point);
  if (!point.ok) return point;
  // The source identity is the accepted CURRENT run, even for an older selected history.
  const source = r.object(o.sourceIdentity, '/sourceIdentity', [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  const sequence = (key: string): number => {
    const value = r.number(source[key], `/sourceIdentity/${key}`, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(value)) r.fail('IDENTITY_INVALID', `/sourceIdentity/${key}`, '身份序号须为安全整数。');
    return value;
  };
  const sourceIdentity = r.finish({
    documentSessionId: r.id(source.documentSessionId, '/sourceIdentity/documentSessionId'),
    physicsRevision: sequence('physicsRevision'),
    simulationSessionId: r.id(source.simulationSessionId, '/sourceIdentity/simulationSessionId'),
    tick: sequence('tick'),
    timeS: r.number(source.timeS, '/sourceIdentity/timeS', 0, 1e12),
    controlSequence: sequence('controlSequence'),
    requestSequence: sequence('requestSequence'),
  });
  if (!sourceIdentity.ok) return sourceIdentity;
  if (!sameNetworkIdentity(sourceIdentity.value, expected)) return fail('RESPONSE_STALE', '分页来源身份已变化。');
  const record = readNetworkRecord(r, o.record);
  r.constant(o.offset, selection.offset, '/offset');
  r.constant(o.selection, selection.simulationSessionId === null ? 'current' : 'history', '/selection');
  const target = point.value.identity;
  if (
    target.documentSessionId !== expected.documentSessionId ||
    target.physicsRevision !== expected.physicsRevision ||
    (selection.simulationSessionId === null
      ? !sameNetworkIdentity(target, expected)
      : target.simulationSessionId !== selection.simulationSessionId)
  )
    return fail('RESPONSE_STALE', '所选结果不属于捕获的工程/运行。');
  const samples: NetworkSnapshot[] = [];
  for (const raw of r.array(o.samples, '/samples', selection.limit)) {
    const s = parseNetworkSnapshot(project.value, raw);
    if (!s.ok) return s;
    if (
      s.value.identity.documentSessionId !== target.documentSessionId ||
      s.value.identity.physicsRevision !== target.physicsRevision ||
      s.value.identity.simulationSessionId !== target.simulationSessionId ||
      s.value.identity.tick > target.tick ||
      s.value.identity.requestSequence > target.requestSequence ||
      s.value.identity.controlSequence > target.controlSequence
    )
      return fail('RESPONSE_STALE', '轨迹样本属于其他会话或未来控制。');
    const previous = samples.at(-1);
    if (
      previous &&
      (s.value.identity.tick <= previous.identity.tick ||
        s.value.identity.controlSequence < previous.identity.controlSequence ||
        s.value.identity.requestSequence <= previous.identity.requestSequence)
    )
      return fail('RECORD_INVALID', '轨迹时间、控制或请求顺序重复/倒退。');
    samples.push(s.value);
  }
  const end = Math.min(record.count, selection.offset + selection.limit);
  r.constant(samples.length, end - selection.offset, '/samples/length');
  if (o.nextOffset !== (end < record.count ? end : null))
    r.fail('RECORD_INVALID', '/nextOffset', '下一页偏移与记录范围不一致。');
  return r.finish({
    sourceIdentity: expected,
    document: project.value,
    point: point.value,
    record,
    samples,
    offset: selection.offset,
    nextOffset: end < record.count ? end : null,
    selection: selection.simulationSessionId === null ? 'current' : 'history',
  });
}
/** Pin a runtime record window (or pause first), then capture. Changes between pages are failures.
 * Only page-size resource overflow can retry the same anchor with a smaller bounded page.
 * External callers must also compare sourceIdentity before presenting a late capture. */
export async function captureNetworkExport(
  port: NetworkRecordPort,
  expected: NetworkIdentity,
  simulationSessionId: string | null,
  context: { readonly snapshotId: string; readonly capturedAt: string; readonly appVersion: string },
): Promise<Result<NetworkExportCapture>> {
  if (
    !/^[\w-]{1,80}$/.test(context.snapshotId) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(context.capturedAt) ||
    !context.appVersion ||
    context.appVersion.length > 80
  )
    return fail('EXPORT_CONTEXT_INVALID', '快照身份/时间/应用版本无效。');
  let offset = 0,
    limit = 20,
    first: NetworkRecordPage | undefined;
  let firstDocument = '',
    firstPoint = '',
    firstRecord = '';
  const samples: NetworkSnapshot[] = [];
  do {
    const selection = { simulationSessionId, offset, limit };
    let reply: Result<unknown>;
    try {
      reply = await port.records(expected, selection);
    } catch (cause: unknown) {
      return fail('EXPORT_READ_FAILED', '记录通信失败：' + String(cause).slice(0, 160));
    }
    const page = reply.ok ? parseNetworkRecordPage(reply.value, expected, selection) : reply;
    if (!page.ok) {
      // The existing JSON budget also bounds large supported multi-component
      // points. Never raise it or trim samples to make a 20-item page fit.
      if (limit > 1 && page.diagnostics.length > 0 && page.diagnostics.every((d) => d.code === 'RESOURCE_LIMIT')) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      return page;
    }
    if (
      first &&
      (firstDocument !== JSON.stringify(page.value.document) ||
        firstPoint !== JSON.stringify(page.value.point) ||
        firstRecord !== JSON.stringify(page.value.record))
    )
      return fail('RESPONSE_STALE', '分页期间工况、控制或记录窗口发生变化。');
    if (!first) {
      first = page.value;
      firstDocument = JSON.stringify(first.document);
      firstPoint = JSON.stringify(first.point);
      firstRecord = JSON.stringify(first.record);
    }
    for (const s of page.value.samples) {
      const previous = samples.at(-1);
      if (
        previous &&
        (s.identity.tick <= previous.identity.tick ||
          s.identity.controlSequence < previous.identity.controlSequence ||
          s.identity.requestSequence <= previous.identity.requestSequence)
      )
        return fail('RECORD_INVALID', '跨页轨迹时间、控制或请求顺序重复/倒退。');
      samples.push(s);
    }
    offset = page.value.nextOffset ?? -1;
  } while (offset >= 0);
  if (!first) return fail('EXPORT_RESULT_UNAVAILABLE', '记录不可用。');
  const view = networkResultView(first.document, first.point, first.point.identity);
  if (!view.ok) return view;
  return {
    ok: true,
    value: immutable({
      format: 'HydraulicNetworkExport',
      version: 1,
      ...context,
      sourceIdentity: expected,
      selection: first.selection,
      view: view.value,
      samples,
      record: first.record,
    }),
  };
}

export function networkCurve(
  capture: NetworkExportCapture,
  objectId: string,
  field: string,
  objectKind?: NetworkResultView['quantities'][number]['objectKind'],
) {
  return Object.freeze(
    capture.samples.map((point) => {
      const view = networkResultView(capture.view.document, point, point.identity);
      const candidates = view.ok
        ? view.value.quantities.filter(
            (q) =>
              q.objectId === objectId && q.field === field && (objectKind === undefined || q.objectKind === objectKind),
          )
        : [];
      const q = candidates.length === 1 ? candidates[0] : undefined;
      return immutable({
        identity: point.identity,
        quantity: q ? displayNetworkQuantity(q) : null,
        reason: q
          ? ''
          : !view.ok
            ? (view.diagnostics[0]?.code ?? 'QUANTITY_UNAVAILABLE')
            : candidates.length > 1
              ? 'QUANTITY_AMBIGUOUS'
              : 'QUANTITY_UNAVAILABLE',
        appliedControls: point.appliedControls,
      });
    }),
  );
}

/** Same F07 artifact/file boundary, new explicit network format. A selected range
 * is labelled; exceeding the existing 4MB limit fails instead of silently trimming. */
export function exportNetworkCsv(
  capture: NetworkExportCapture,
  range = { offset: 0, count: capture.samples.length },
  selection?: { readonly indices: readonly number[]; readonly metadata: string },
): Result<ExportArtifact> {
  if (
    selection &&
    selection.indices.some(
      (i, at) =>
        !Number.isSafeInteger(i) || i < 0 || i >= capture.samples.length || (at > 0 && i <= selection.indices[at - 1]!),
    )
  )
    return fail('RECORD_RANGE_INVALID', '精简样本编号越界、重复或倒序。');
  if (
    ![range.offset, range.count].every(Number.isSafeInteger) ||
    range.offset < 0 ||
    range.count < 0 ||
    range.offset + range.count > capture.samples.length
  )
    return fail('RECORD_RANGE_INVALID', '导出记录范围越界。');
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
  ];
  const meta = (key: string, value: string | number) =>
    rows.push(['metadata', '', '', '', key, csvMetadataDisplayName(key), '', value, '', '', '', '']);
  meta('column_guide_zh', JSON.stringify(csvColumnGuide));
  meta(
    'reading_guide_zh',
    '类别、对象、时间、量值、中文含义与单位按行对应；result为当前所选末步，sample为保留轨迹样本。unknown为未知，not-applicable为不适用；空值不代表零。kernel为内核读数，derived为同源派生量。原始模型、身份与原因码保留以供核查。',
  );
  meta(
    'reason_guide_zh',
    JSON.stringify(
      Object.fromEntries(
        capture.view.quantities
          .filter((q) => q.value.kind !== 'known')
          .map((q) => (q.value.kind !== 'known' ? [q.value.reason, valueReasonDisplay(q.value.reason)] : [])),
      ),
    ),
  );
  meta('format', capture.format);
  meta('version', capture.version);
  meta('snapshot_id', capture.snapshotId);
  meta('captured_at', capture.capturedAt);
  meta('app_version', capture.appVersion);
  meta('selection', capture.selection);
  meta('source_identity_json', JSON.stringify(capture.sourceIdentity));
  meta('point_identity_json', JSON.stringify(capture.view.point.identity));
  meta('solver_json', JSON.stringify(capture.view.point.solver));
  meta(
    'native_step_configuration_json',
    JSON.stringify({
      actualNativeStepS: capture.view.point.clock.nativeStepS,
      advanceIntervalS: capture.view.point.clock.advanceIntervalS,
      recordedChoice: capture.view.document.extensions[networkStepRunKey] ?? null,
    }),
  );
  meta('document_json', JSON.stringify(capture.view.document));
  meta('point_si_json', JSON.stringify(capture.view.point));
  meta('record_json', JSON.stringify(capture.record));
  meta('exported_range_json', JSON.stringify(range));
  if (selection) meta('curve_export_json', selection.metadata);
  meta(
    'record_scope',
    selection
      ? 'explicit reduced sample indices; not the complete retained trajectory'
      : range.count === capture.samples.length
        ? 'all retained samples; not a complete replay certificate'
        : 'explicit sample range; not the complete retained trajectory',
  );
  for (const text of capture.view.assumptions) rows.push(['assumption', '', '', '', '', '', '', text, '', '', '', '']);
  const append = (section: string, view: NetworkResultView) => {
    const id = view.point.identity;
    rows.push([
      section,
      '',
      id.tick,
      id.timeS,
      'identity_controls_json',
      csvMetadataDisplayName('identity_controls_json'),
      '',
      JSON.stringify({ identity: id, appliedControls: view.point.appliedControls, states: view.point.states }),
      '',
      'kernel',
      id.controlSequence,
      '',
    ]);
    for (const q of view.quantities) {
      const display = displayNetworkQuantity(q);
      const edge =
        q.objectKind === 'connection' ? view.document.design.connections.find((c) => c.id === q.objectId) : undefined;
      const model =
        q.objectKind === 'component'
          ? (view.document.design.components.find((c) => c.id === q.objectId)?.model ?? null)
          : edge?.kind === 'pipe'
            ? edge.model
            : null;
      rows.push([
        section,
        q.objectId,
        id.tick,
        id.timeS,
        q.field,
        q.label,
        display.unit,
        display.value.kind === 'known' ? display.value.value : '',
        display.value.kind === 'known' ? '' : display.value.kind + ':' + display.value.reason,
        q.source,
        id.controlSequence,
        JSON.stringify({ objectKind: q.objectKind, formula: q.formula, inputs: q.inputs, si: display.si, model }),
      ]);
    }
  };
  append('result', capture.view);
  for (const point of selection
    ? selection.indices.map((i) => capture.samples[i]!)
    : capture.samples.slice(range.offset, range.offset + range.count)) {
    const view = networkResultView(capture.view.document, point, point.identity);
    if (!view.ok) return view;
    append('sample', view.value);
  }
  return parseExportArtifact({
    version: 1,
    snapshotId: capture.snapshotId,
    format: 'csv',
    suggestedName: '网络结果.csv',
    text: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
  });
}
