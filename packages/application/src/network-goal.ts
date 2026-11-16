import {
  ContractReader,
  diagnostic,
  immutable,
  networkDefinition,
  networkPhysicalDesign,
  parseNetworkProject,
  type NetworkProject,
  type Result,
  type NetworkParameterRule,
} from '@hyd/domain';
import {
  planIndependentNetworkGoal,
  planCombinedNetworkGoal,
  planNetworkGoal,
  type IndependentGoalPlan,
  type CombinedGoalPlan,
  type NetworkGoalPlan,
} from '@hyd/engineering';
import type { NetworkDraftSession } from './network-draft.js';
import { canonical } from './content.js';

interface GoalAnchor {
  readonly documentSessionId: string;
  readonly revision: number;
  readonly sourceDocument: NetworkProject;
}
export interface NetworkGoalPreview extends GoalAnchor {
  readonly plan: NetworkGoalPlan;
}
interface IndependentGoalPreview extends GoalAnchor {
  readonly kind: 'independent';
  readonly input: unknown;
  readonly plan: IndependentGoalPlan;
}
interface CombinedGoalPreview extends GoalAnchor {
  readonly kind: 'combined';
  readonly input: unknown;
  readonly plan: CombinedGoalPlan;
}
export type NetworkGoalCandidatePreview = NetworkGoalPreview | IndependentGoalPreview | CombinedGoalPreview;
/** Local user action only. It changes edit constraints, never a parameter value or an AI proposal. */
export function planNetworkParameterLock(document: unknown, input: unknown): Result<NetworkProject> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const r = new ContractReader(),
    raw = r.object(input, '/parameterLock', ['componentId', 'group', 'key', 'locked']);
  const componentId = r.id(raw.componentId, '/parameterLock/componentId'),
    group = r.text(raw.group, '/parameterLock/group', 1, 100),
    key = r.text(raw.key, '/parameterLock/key', 1, 100);
  if (typeof raw.locked !== 'boolean') r.fail('PARAMETER_RULE_INVALID', '/parameterLock/locked', '锁定状态必须明确。');
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  const component = parsed.value.design.components.find((c) => c.id === componentId);
  if (!component)
    return { ok: false, diagnostics: [diagnostic('SELECTION_STALE', '/parameterLock', '元件已改变，请重新选择。')] };
  if (
    !networkDefinition(component.definition.id, component.definition.version)?.groups[group]?.some(
      (spec) => spec.key === key,
    )
  )
    return {
      ok: false,
      diagnostics: [diagnostic('PARAMETER_RULE_INVALID', '/parameterLock', '约束须引用当前定义中的模型参数。')],
    };
  const rules: NetworkParameterRule[] = (component.parameterRules ?? []).filter(
    (rule) => rule.group !== group || rule.key !== key,
  );
  if (raw.locked === true) rules.push({ group, key, mode: 'locked' });
  return parseNetworkProject({
    ...parsed.value,
    design: {
      ...parsed.value.design,
      components: parsed.value.design.components.map((c) => {
        if (c.id !== componentId) return c;
        const { parameterRules: _previous, ...rest } = c;
        return rules.length ? { ...rest, parameterRules: rules } : rest;
      }),
    },
  });
}
export function previewNetworkGoal(session: NetworkDraftSession, input: unknown): Result<NetworkGoalPreview> {
  const plan = planNetworkGoal(session.document, input);
  if (!plan.ok) return plan;
  const context = {
    documentSessionId: session.documentSessionId,
    documentRevision: session.revision,
    physicsRevision: session.physicsRevision,
  };
  return {
    ok: true,
    value: immutable({
      documentSessionId: session.documentSessionId,
      revision: session.revision,
      sourceDocument: session.document,
      plan: {
        ...plan.value,
        current: { ...plan.value.current, record: { ...plan.value.current.record, context } },
        alternatives: plan.value.alternatives.map((candidate, index) => ({
          ...candidate,
          analysis: {
            ...candidate.analysis,
            record: {
              ...candidate.analysis.record,
              title: `${candidate.analysis.record.title} · 方案 ${index + 1} · 未应用`,
              context,
            },
          },
        })),
        candidate: plan.value.candidate
          ? { ...plan.value.candidate, record: { ...plan.value.candidate.record, context } }
          : null,
      },
    }),
  };
}
export function previewIndependentNetworkGoal(
  session: NetworkDraftSession,
  input: unknown,
): Result<IndependentGoalPreview> {
  const plan = planIndependentNetworkGoal(session.document, input);
  if (!plan.ok) return plan;
  const capturedInput: unknown = JSON.parse(JSON.stringify(input));
  return {
    ok: true,
    value: immutable({
      kind: 'independent',
      documentSessionId: session.documentSessionId,
      revision: session.revision,
      sourceDocument: session.document,
      input: capturedInput,
      plan: plan.value,
    }),
  };
}
export function previewCombinedNetworkGoal(session: NetworkDraftSession, input: unknown): Result<CombinedGoalPreview> {
  const plan = planCombinedNetworkGoal(session.document, input);
  if (!plan.ok) return plan;
  const capturedInput: unknown = JSON.parse(JSON.stringify(input));
  return {
    ok: true,
    value: immutable({
      kind: 'combined',
      documentSessionId: session.documentSessionId,
      revision: session.revision,
      sourceDocument: session.document,
      input: capturedInput,
      plan: plan.value,
    }),
  };
}
export function applyNetworkGoal(
  session: NetworkDraftSession,
  preview: NetworkGoalCandidatePreview,
  index = 0,
): Result<true> {
  if (
    session.documentSessionId !== preview.documentSessionId ||
    session.revision !== preview.revision ||
    session.document !== preview.sourceDocument
  )
    return { ok: false, diagnostics: [diagnostic('RESPONSE_STALE', '/goal', '工程或修订已改变，请重新校核/求解。')] };
  if ('kind' in preview) {
    const current =
      preview.kind === 'combined'
        ? planCombinedNetworkGoal(session.document, preview.input)
        : planIndependentNetworkGoal(session.document, preview.input);
    if (!current.ok) return current;
    const selected = current.value.alternatives[index];
    if (selected?.changes.length) return session.commit(selected.document, preview.revision, 'physical');
    return { ok: false, diagnostics: [diagnostic('GOAL_NO_CANDIDATE', '/goal', '当前没有需要应用的完整供油组方案。')] };
  }
  const current = planNetworkGoal(session.document, preview.plan.request);
  if (!current.ok) return current;
  const selected = current.value.request.selection
    ? current.value.alternatives[index]
    : index === 0
      ? current.value
      : undefined;
  if (current.value.status !== 'candidate' || !selected?.changes.length)
    return { ok: false, diagnostics: [diagnostic('GOAL_NO_CANDIDATE', '/goal', '当前没有需要应用的可行参数候选。')] };
  return session.commit(selected.document, preview.revision, 'physical');
}
/** Locks/ranges alone are saved metadata; the session remains the sole revision/history owner. */
export function networkParameterRulesOnlyEdit(before: NetworkProject, after: NetworkProject): boolean {
  return canonical(networkPhysicalDesign(before)) === canonical(networkPhysicalDesign(after));
}
