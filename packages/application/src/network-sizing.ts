import { diagnostic, immutable, ContractReader, type NetworkProject, type Result } from '@hyd/domain';
import {
  planNetworkSizing,
  networkLearningRecord,
  type NetworkSizingPlan,
  type CalculationRecord,
} from '@hyd/engineering';
import type { NetworkDraftSession } from './network-draft.js';
import type { NetworkExportCapture } from './network-export.js';
import { csvCell } from './export-csv.js';
import { parseExportArtifact, type ExportArtifact } from './export-artifact.js';

export interface NetworkSizingPreview {
  readonly documentSessionId: string;
  readonly revision: number;
  readonly sourceDocument: NetworkProject;
  readonly plan: NetworkSizingPlan;
}
export function previewNetworkSizing(session: NetworkDraftSession, input: unknown): Result<NetworkSizingPreview> {
  const plan = planNetworkSizing(session.document, input);
  return plan.ok
    ? {
        ok: true,
        value: immutable({
          documentSessionId: session.documentSessionId,
          revision: session.revision,
          sourceDocument: session.document,
          plan: {
            ...plan.value,
            record: {
              ...plan.value.record,
              context: {
                documentSessionId: session.documentSessionId,
                documentRevision: session.revision,
                physicsRevision: session.physicsRevision,
              },
            },
          },
        }),
      }
    : plan;
}
/** Recompute from parsed requirements and compare document/session/revision; never trust an edited candidate. */
export function applyNetworkSizing(session: NetworkDraftSession, preview: NetworkSizingPreview): Result<true> {
  if (
    session.documentSessionId !== preview.documentSessionId ||
    session.revision !== preview.revision ||
    session.document !== preview.sourceDocument
  )
    return { ok: false, diagnostics: [diagnostic('RESPONSE_STALE', '/sizing', '工程或修订已改变，请重新预览初选。')] };
  const current = planNetworkSizing(session.document, preview.plan.request);
  return current.ok ? session.commit(current.value.document, preview.revision, 'physical') : current;
}

/** Bounded BOM CSV through the existing file-artifact contract. Preliminary and actual quantities never share a kind. */
export function exportCalculationCsv(
  record: CalculationRecord,
  snapshotId: string,
  capturedAt: string,
): Result<ExportArtifact> {
  const reader = new ContractReader();
  reader.timestamp(capturedAt, '/calculation/capturedAt');
  const valid = reader.finish(true);
  if (!valid.ok) return valid;
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
  const metadata = (field: string, value: string) =>
    rows.push(['metadata', '', '', '', field, field, '', value, '', '', '', '']);
  metadata('format', record.format);
  metadata('kind', record.kind);
  metadata('title', record.title);
  metadata('document_json', JSON.stringify(record.document));
  metadata('identity_json', JSON.stringify(record.identity));
  metadata('document_context_json', JSON.stringify(record.context));
  metadata('snapshot_id', snapshotId);
  metadata('captured_at', capturedAt);
  metadata(
    'reading_guide_zh',
    'preliminary为声明效率和余量下的初选，不是仿真；kernel/derived来自所列有效快照。value列为显示单位，reference保留原SI值、公式、输入来源、代入和换算。未知值留空并写原因，不补零。',
  );
  for (const text of record.assumptions) rows.push(['assumption', '', '', '', '', '', '', text, '', '', '', '']);
  for (const step of record.steps)
    rows.push([
      'calculation',
      '',
      record.identity?.tick ?? '',
      record.identity?.timeS ?? '',
      step.key,
      step.label,
      step.display.unit,
      step.display.value.kind === 'known' ? step.display.value.value : '',
      step.display.value.kind === 'known' ? '' : step.display.value.kind + ':' + step.display.value.reason,
      step.source,
      record.identity?.controlSequence ?? '',
      JSON.stringify({
        formula: step.formula,
        inputs: step.inputs,
        substitution: step.substitution,
        conversion: step.display.conversion,
        si: { unit: step.unit, value: step.value },
      }),
    ]);
  return parseExportArtifact({
    version: 1,
    snapshotId,
    format: 'csv',
    suggestedName: record.kind === 'preliminary' ? '基础初选与过程.csv' : '所选快照计算过程.csv',
    text: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
  });
}
export function exportNetworkLearningCsv(capture: NetworkExportCapture): Result<ExportArtifact> {
  const record = networkLearningRecord(capture.view.document, capture.view.point, capture.view.point.identity);
  return record.ok ? exportCalculationCsv(record.value, capture.snapshotId, capture.capturedAt) : record;
}

/** The capture has already passed the paged record and identity checks. Report only the retained window up to the selected point. */
export function capturedCalculationRecord(capture: NetworkExportCapture): Result<CalculationRecord> {
  const point = capture.view.point,
    id = point.identity,
    record = networkLearningRecord(capture.view.document, point, id);
  if (!record.ok || !point.readings.some((r) => r.quantity === 'cavity-volume')) return record;
  const ports = new Map<
    string,
    { peak: number; peakAt?: number; first?: number; refill?: number; empty: boolean; gap: boolean; count: number }
  >();
  const samples = capture.samples.filter(
    (s) =>
      s.identity.simulationSessionId === id.simulationSessionId &&
      s.identity.documentSessionId === id.documentSessionId &&
      s.identity.physicsRevision === id.physicsRevision &&
      s.identity.tick <= id.tick &&
      s.identity.requestSequence <= id.requestSequence &&
      s.identity.controlSequence <= id.controlSequence,
  );
  if (!samples.length) return record;
  const ref = capture.view.document.design.pressureReference;
  const offset = ref.kind === 'gauge' ? (ref.absoluteReferencePa ?? 0) : 0;
  const pumps = capture.view.document.design.components.filter((c) => c.typeId === 'pump').map((c) => c.id);
  const inlets = new Map<string, { minimum: number; time: number }>();
  for (const [i, s] of samples.entries()) {
    const p = new Map<string, number>(),
      seen = new Set<string>(),
      gap = i > 0 && s.identity.tick !== samples[i - 1]!.identity.tick + 1;
    for (const r of s.readings)
      if (r.location.kind === 'port' && r.quantity === 'pressure' && r.value.kind === 'known')
        p.set(r.location.componentId + ':' + r.location.portId, r.value.value);
    for (const pump of pumps) {
      const pressure = p.get(pump + ':S');
      if (pressure !== undefined && pressure < (inlets.get(pump)?.minimum ?? Infinity))
        inlets.set(pump, { minimum: pressure, time: s.identity.timeS });
    }
    for (const r of s.readings) {
      if (r.quantity !== 'cavity-volume' || r.location.kind !== 'port') continue;
      const key = r.location.componentId + ':' + r.location.portId;
      const state = ports.get(key) ?? { peak: 0, empty: false, gap: i !== 0, count: 0 };
      ports.set(key, state);
      seen.add(key);
      if (gap || r.value.kind !== 'known') {
        state.gap = true;
        state.empty = false;
      }
      if (r.value.kind !== 'known') continue;
      const v = r.value.value,
        time = s.identity.timeS;
      if (v > 0) {
        state.first ??= time;
        state.empty = true;
        if (v > state.peak) {
          state.peak = v;
          state.peakAt = time;
        }
      } else if (state.empty && p.has(key) && p.get(key)! + offset > 0) {
        state.refill ??= time;
        state.empty = false;
      }
      state.count++;
    }
    for (const [key, state] of ports)
      if (!seen.has(key)) {
        state.gap = true;
        state.empty = false;
      }
  }
  if (!ports.size) return record;
  const time = (v: number | undefined) => (v === undefined ? '—' : Number(v.toPrecision(7)) + ' s');
  const rows = Array.from(ports, ([port, s]) => [
    port,
    s.count === 0
      ? '读数待核'
      : s.first === undefined
        ? '窗口内未采到空穴'
        : s.refill === undefined
          ? '采到空穴，未采到复压'
          : '采到空穴及补油复压',
    [
      '首次有空穴 ' + time(s.first),
      '采样峰值 ' + (s.count ? Number((s.peak * 1e6).toPrecision(7)) + ' mL' : '待核'),
      '峰值时刻 ' + time(s.peakAt),
      '首次复压 ' + time(s.refill),
      s.gap ? '采样不连续，缺段待核' : '有效采样',
    ].join('，'),
  ]);
  return {
    ok: true,
    value: {
      ...record.value,
      cavityWindow: {
        inletRows: pumps.map((id) => {
          const row = inlets.get(id);
          const absolute = ref.kind === 'gauge' && ref.absoluteReferencePa !== null;
          return [
            id + ' S',
            row
              ? Number(((row.minimum + (absolute ? offset : 0)) / 1000).toPrecision(7)) +
                ' kPa' +
                (absolute ? '（绝压）' : '（工程数值，未标定绝压）')
              : '压力读数待核',
            time(row?.time),
          ];
        }),
        fromS: samples[0]!.identity.timeS,
        toS: samples[samples.length - 1]!.identity.timeS,
        rows,
      },
    },
  };
}
