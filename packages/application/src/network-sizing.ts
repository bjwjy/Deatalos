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
