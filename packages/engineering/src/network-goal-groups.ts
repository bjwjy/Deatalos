import {
  ContractReader,
  checkJson,
  checkNetworkParameterRules,
  diagnostic,
  parseNetworkProject,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { independentDutyGroups, independentFlowSplitRequest } from './network-duty-groups.js';
import { parseNetworkDutyRequest, type NetworkDutyPlan } from './network-duty.js';
import { goalValue } from './network-goal-selection.js';
import {
  networkGoalSupplySatisfied,
  planNetworkGoal,
  type NetworkGoalCandidate,
  type NetworkGoalPlan,
} from './network-goal.js';
import type { SizingChange } from './network-sizing.js';

interface GroupIdentity {
  readonly pumpId: string;
  readonly pumpLabel: string;
  readonly tankLabel: string;
  readonly actuatorLabel: string;
}
export type IndependentGoalGroup = GroupIdentity &
  (
    | { readonly kind: 'idle' }
    | { readonly kind: 'pending'; readonly reason: string }
    | {
        readonly kind: 'evaluated';
        readonly analysis: NetworkDutyPlan;
        readonly satisfied: boolean;
        readonly note: string;
      }
  );
interface IndependentGoalCandidate {
  readonly groups: readonly IndependentGoalGroup[];
  readonly changes: readonly SizingChange[];
  readonly document: NetworkProject;
}
export interface IndependentGoalPlan {
  readonly status: 'candidate' | 'current-satisfied' | 'not-feasible' | 'pending';
  readonly current: readonly IndependentGoalGroup[];
  readonly alternatives: readonly IndependentGoalCandidate[];
}
type GroupRequest = { readonly pumpId: string } & (
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly reason: string }
  | { readonly kind: 'ready'; readonly goal: unknown }
);

function readGroups(input: unknown, groupCount: number) {
  const json = checkJson(input);
  if (!json.ok) return json;
  const r = new ContractReader();
  const raw = r.object(input, '/groupGoal', ['mode', 'groups']);
  if (raw.mode !== 'check' && raw.mode !== 'solve') r.fail('GOAL_INVALID', '/groupGoal/mode', '请选择核算或选配。');
  const mode = raw.mode === 'check' ? 'check' : 'solve';
  const groups = r.array(raw.groups, '/groupGoal/groups', groupCount).map((entry, i): GroupRequest => {
    const p = '/groupGoal/groups/' + i;
    const group = r.object(entry, p, ['pumpId', 'kind', 'goal', 'reason']);
    const pumpId = r.id(group.pumpId, p + '/pumpId');
    if (group.kind === 'idle') {
      r.object(entry, p, ['pumpId', 'kind']);
      return { pumpId, kind: 'idle' };
    }
    if (group.kind === 'pending') {
      r.object(entry, p, ['pumpId', 'kind', 'reason']);
      return { pumpId, kind: 'pending', reason: r.text(group.reason, p + '/reason', 1, 1600) };
    }
    if (group.kind !== 'ready') r.fail('GOAL_INVALID', p + '/kind', '供油组工况状态无效。');
    r.object(entry, p, ['pumpId', 'kind', 'goal']);
    const goal = r.object(group.goal, p + '/goal', ['duty', 'variables', 'selection']);
    if (mode === 'solve' && goal.selection === undefined)
      r.fail('GOAL_INVALID', p + '/goal/selection', '请为参与供油组选定预算策略。');
    const duty = parseNetworkDutyRequest(goal.duty);
    return {
      pumpId,
      kind: 'ready',
      goal: { ...goal, mode, duty: duty.ok ? independentFlowSplitRequest(duty.value) : goal.duty },
    };
  });
  r.unique(
    groups.map(({ pumpId }) => pumpId),
    '/groupGoal/groups',
  );
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  return { ok: true, value: { mode, groups } } satisfies Result<{ mode: 'check' | 'solve'; groups: GroupRequest[] }>;
}

function currentEligible(plan: NetworkGoalPlan) {
  const { selection, variables, duty } = plan.request;
  return (
    networkGoalSupplySatisfied(plan.current) &&
    (selection?.mode !== 'range' ||
      (duty.pressureLimitPa >= selection.minimumPa && duty.pressureLimitPa <= selection.maximumPa)) &&
    variables.every((variable) => {
      const value = goalValue(plan.current.document, variable);
      return value !== undefined && value >= variable.minimum && value <= variable.maximum;
    })
  );
}

interface Choice {
  readonly view: IndependentGoalGroup;
  readonly candidate?: NetworkGoalCandidate;
}

interface Combination {
  readonly choices: readonly Choice[];
  readonly changeCount: number;
  readonly hasCandidate: boolean;
}

const candidateLimit = 3;

function bestCombinations(options: readonly (readonly Choice[])[]): readonly Combination[] {
  let prefixes: readonly Combination[] = [{ choices: [], changeCount: 0, hasCandidate: false }];
  for (const group of options) {
    const joined = prefixes
      .flatMap((prefix) =>
        group.map((choice) => ({
          choices: [...prefix.choices, choice],
          changeCount: prefix.changeCount + (choice.candidate?.changes.length ?? 0),
          hasCandidate: prefix.hasCandidate || choice.candidate !== undefined,
        })),
      )
      .sort((a, b) => a.changeCount - b.changeCount);
    const changed = joined.filter((item) => item.changeCount > 0).slice(0, candidateLimit);
    const trialOnly = joined.filter((item) => item.hasCandidate && item.changeCount === 0).slice(0, candidateLimit);
    const unchanged = joined.find((item) => !item.hasCandidate);
    // Keeping the best of each category bounds the cross product while allowing
    // a later group to add the first change to an otherwise unchanged project.
    prefixes = [...changed, ...trialOnly, ...(unchanged ? [unchanged] : [])];
  }
  return prefixes.filter((item) => item.hasCandidate).slice(0, candidateLimit);
}

/** Compose only disjoint, individually feasible steady-state candidates. A fixed tank boundary may be shared. */
export function planIndependentNetworkGoal(document: unknown, input: unknown): Result<IndependentGoalPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const project = parsed.value;
  const groups = independentDutyGroups(project);
  if (groups.some((group) => group.sharedReturnPipeId))
    return {
      ok: false,
      diagnostics: [
        diagnostic('GOAL_INPUT_MISSING', '/groupGoal', '两组共用有损回油时须联合校核当前设计，自动选配待核。'),
      ],
    };
  const request = readGroups(input, groups.length);
  if (!request.ok) return request;
  const inputs = new Map(request.value.groups.map((entry) => [entry.pumpId, entry]));
  if (groups.length < 2 || inputs.size !== groups.length || !groups.every((group) => inputs.has(group.pump.id))) {
    return {
      ok: false,
      diagnostics: [
        diagnostic('GOAL_INPUT_MISSING', '/groupGoal', '选配须明确工程中每台泵对应的供油组工况或未参与状态。'),
      ],
    };
  }
  const current: IndependentGoalGroup[] = [];
  const options: Choice[][] = [];
  for (const group of groups) {
    const identity = {
      pumpId: group.pump.id,
      pumpLabel: group.pump.label || group.pump.id,
      tankLabel: group.tank ? group.tank.label || group.tank.id : '',
      actuatorLabel: group.cylinders.map((cylinder) => cylinder.label || cylinder.id).join('、'),
    };
    const source = inputs.get(group.pump.id);
    if (group.result.kind === 'blocked') {
      current.push({ ...identity, kind: 'pending', reason: group.result.reason });
      continue;
    }
    if (source?.kind === 'idle') {
      const idle = { ...identity, kind: 'idle' } satisfies IndependentGoalGroup;
      current.push(idle);
      options.push([{ view: idle }]);
      continue;
    }
    if (source?.kind !== 'ready') {
      current.push({ ...identity, kind: 'pending', reason: source?.reason ?? '本组缺少工况。' });
      continue;
    }
    const result = planNetworkGoal(group.result.project, source.goal);
    if (!result.ok) {
      current.push({ ...identity, kind: 'pending', reason: result.diagnostics.map((d) => d.message).join('；') });
      continue;
    }
    const plan = result.value;
    if (plan.request.duty.pumpId !== group.pump.id) {
      current.push({ ...identity, kind: 'pending', reason: '本组工况与目标泵不匹配。' });
      continue;
    }
    // The existing solver uses persisted pump speed so that application reproduces the preview.
    if (
      Math.abs(plan.request.duty.angularSpeedRadPerS - plan.current.request.angularSpeedRadPerS) >
      1e-9 * plan.current.request.angularSpeedRadPerS
    ) {
      current.push({ ...identity, kind: 'pending', reason: '本组工况转速与工程保存值不同，请统一后再比较。' });
      continue;
    }
    const eligible = currentEligible(plan);
    const shown = {
      ...identity,
      kind: 'evaluated',
      analysis: plan.current,
      satisfied: networkGoalSupplySatisfied(plan.current),
      note:
        request.value.mode === 'check' || eligible
          ? ''
          : plan.alternatives.length
            ? '本组有可行选配。'
            : plan.budgetExhausted
              ? '本组达到有限搜索上限，未找到候选。'
              : '本组在所选预算、锁定和推荐范围内无候选。',
    } satisfies IndependentGoalGroup;
    current.push(shown);
    const choices: Choice[] = plan.alternatives.map((candidate) => ({
      view: { ...identity, kind: 'evaluated', analysis: candidate.analysis, satisfied: true, note: '' },
      candidate,
    }));
    if (eligible) choices.unshift({ view: shown });
    options.push(choices);
  }
  const evaluated = current.some((group) => group.kind === 'evaluated');
  if (!evaluated || current.some((group) => group.kind === 'pending')) {
    return { ok: true, value: { status: 'pending', current, alternatives: [] } };
  }
  const alternatives: IndependentGoalCandidate[] = [];
  if (request.value.mode === 'solve') {
    for (const { choices } of bestCombinations(options)) {
      const changes = choices.flatMap((item) => item.candidate?.changes ?? []);
      const changed = new Set(changes.map((item) => item.componentId));
      const components = new Map(
        choices
          .flatMap((item) => item.candidate?.document.design.components ?? [])
          .filter((part) => changed.has(part.id))
          .map((part) => [part.id, part]),
      );
      const document = parseNetworkProject({
        ...project,
        design: {
          ...project.design,
          components: project.design.components.map((part) => components.get(part.id) ?? part),
        },
      });
      if (!document.ok) return document;
      const rules = checkNetworkParameterRules(project, document.value);
      if (!rules.ok) return rules;
      alternatives.push({ groups: choices.map((item) => item.view), changes, document: document.value });
    }
  }
  const satisfied = current.every((group) => group.kind === 'idle' || (group.kind === 'evaluated' && group.satisfied));
  return {
    ok: true,
    value: {
      status: alternatives.length
        ? 'candidate'
        : satisfied && (request.value.mode === 'check' || options.every((choices) => choices.length))
          ? 'current-satisfied'
          : 'not-feasible',
      current,
      alternatives,
    },
  };
}
