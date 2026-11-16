import { diagnostic, immutable, type NetworkProject, type Result } from '@hyd/domain';
import { planNetworkDuty, type NetworkDutyPlan } from '@hyd/engineering';
import type { NetworkDraftSession } from './network-draft.js';
export interface NetworkDutyPreview {
  readonly documentSessionId: string;
  readonly revision: number;
  readonly sourceDocument: NetworkProject;
  readonly plan: NetworkDutyPlan;
}
export function previewNetworkDuty(session: NetworkDraftSession, input: unknown): Result<NetworkDutyPreview> {
  const plan = planNetworkDuty(session.document, input);
  if (!plan.ok) return plan;
  return {
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
  };
}
export function applyNetworkDuty(session: NetworkDraftSession, preview: NetworkDutyPreview): Result<true> {
  if (
    session.documentSessionId !== preview.documentSessionId ||
    session.revision !== preview.revision ||
    session.document !== preview.sourceDocument
  )
    return { ok: false, diagnostics: [diagnostic('RESPONSE_STALE', '/duty', '工程或修订已改变，请重新预览工况。')] };
  const plan = planNetworkDuty(session.document, preview.plan.request);
  return plan.ok ? session.commit(plan.value.document, preview.revision, 'physical') : plan;
}
