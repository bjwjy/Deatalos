import {
  ContractReader,
  checkJson,
  diagnostic,
  immutable,
  parseNetworkProject,
  networkDefinition,
  networkParameterRule,
  checkNetworkParameterRules,
  type NetworkComponent,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import {
  checkNetworkDuty,
  isDutySupplyDemand,
  parseNetworkDutyRequest,
  type NetworkDutyRequest,
  type NetworkDutyPlan,
} from './network-duty.js';
import type { SizingChange } from './network-sizing.js';
import {
  goalTrialGroups,
  goalValue,
  goalVariableKey as variableKey,
  selectionBudget,
  selectionDisplacement,
} from './network-goal-selection.js';
import { networkSelectionPolicy } from './network-selection-policy.js';

export interface NetworkGoalVariable {
  readonly componentId: string;
  readonly group: string;
  readonly key: string;
  readonly minimum: number;
  readonly maximum: number;
}
export interface NetworkGoalOption extends NetworkGoalVariable {
  readonly label: string;
  readonly unit: string;
  readonly current: number;
  readonly locked: boolean;
}
export interface NetworkGoalRequest {
  readonly mode: 'check' | 'solve';
  readonly duty: NetworkDutyRequest;
  readonly variables: readonly NetworkGoalVariable[];
  readonly selection?: NetworkGoalSelection;
}
type SelectionVersion = typeof networkSelectionPolicy.version;
export type NetworkGoalSelection =
  | { readonly version: SelectionVersion; readonly mode: 'automatic' | 'fixed' }
  | {
      readonly version: SelectionVersion;
      readonly mode: 'range';
      readonly minimumPa: number;
      readonly maximumPa: number;
    };
export interface NetworkGoalCandidate {
  readonly analysis: NetworkDutyPlan;
  readonly document: NetworkProject;
  readonly changes: readonly SizingChange[];
}
export interface NetworkGoalPlan {
  readonly request: NetworkGoalRequest;
  readonly status: 'current-satisfied' | 'candidate' | 'not-feasible';
  readonly current: NetworkDutyPlan;
  readonly candidate: NetworkDutyPlan | null;
  readonly document: NetworkProject;
  readonly changes: readonly SizingChange[];
  readonly alternatives: readonly NetworkGoalCandidate[];
  readonly checked: number;
  readonly budgetExhausted: boolean;
}
const budget = 1024;
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/goal', message)],
});
export function networkGoalParameterSupported(c: NetworkComponent, group: string, key: string): boolean {
  return (
    (c.typeId === 'pump' &&
      ['hydraulic.displacementM3PerRev', 'drive.angularSpeedRadPerS', 'relief.settingDifferentialPa'].includes(
        group + '.' + key,
      )) ||
    (c.typeId === 'cylinder' && group === 'geometry' && ['capAreaM2', 'rodSideAreaM2'].includes(key)) ||
    (c.typeId === 'motor' && group + '.' + key === 'hydraulic.displacementM3PerRev') ||
    (c.typeId === 'relief' && group + '.' + key === 'hydraulic.settingDifferentialPa')
  );
}
export function networkGoalOptions(project: NetworkProject): readonly NetworkGoalOption[] {
  const options: NetworkGoalOption[] = [];
  for (const c of project.design.components) {
    const definition = networkDefinition(c.definition.id, c.definition.version);
    for (const [group, specs] of Object.entries(definition?.groups ?? {}))
      for (const spec of specs) {
        if (!networkGoalParameterSupported(c, group, spec.key)) continue;
        const current = c.parameters[group]?.[spec.key],
          rule = networkParameterRule(c, group, spec.key);
        if (current === undefined) continue;
        options.push({
          componentId: c.id,
          group,
          key: spec.key,
          label: c.label,
          unit: spec.unit,
          current,
          locked: rule?.mode === 'locked',
          minimum: rule?.mode === 'variable' ? rule.minimum : spec.minimum,
          maximum: rule?.mode === 'variable' ? rule.maximum : spec.maximum,
        });
      }
  }
  return options;
}
function readRequest(project: NetworkProject, input: unknown): Result<NetworkGoalRequest> {
  const json = checkJson(input);
  if (!json.ok) return json;
  const r = new ContractReader(),
    raw = r.object(input, '/goal', ['mode', 'duty', 'variables', 'selection']);
  if (raw.mode !== 'check' && raw.mode !== 'solve')
    r.fail('GOAL_INVALID', '/goal/mode', '请选择当前参数校核或有限范围求解。');
  const duty = parseNetworkDutyRequest(raw.duty);
  if (!duty.ok) return duty;
  let selection: NetworkGoalSelection | undefined;
  if (raw.selection !== undefined) {
    const path = '/goal/selection';
    const rule = r.object(raw.selection, path, ['version', 'mode', 'minimumPa', 'maximumPa']);
    const version = networkSelectionPolicy.version;
    if (rule.version !== version)
      r.fail('GOAL_POLICY_UNSUPPORTED', path + '/version', '选配策略版本已变化，请重新预览。');
    if (rule.mode === 'range') {
      const minimumPa = r.number(
        rule.minimumPa,
        path + '/minimumPa',
        Number.MIN_VALUE,
        networkSelectionPolicy.maximumBudgetPa,
      );
      const maximumPa = r.number(
        rule.maximumPa,
        path + '/maximumPa',
        minimumPa,
        networkSelectionPolicy.maximumBudgetPa,
      );
      selection = { version, mode: 'range', minimumPa, maximumPa };
    } else if (rule.mode === 'automatic' || rule.mode === 'fixed') {
      r.object(raw.selection, path, ['version', 'mode']);
      selection = { version, mode: rule.mode };
    } else r.fail('GOAL_INVALID', path + '/mode', '请选择自动、固定或指定范围。');
  }
  const options = networkGoalOptions(project);
  const variables = r.array(raw.variables, '/goal/variables', 10).map((item, i): NetworkGoalVariable => {
    const p = '/goal/variables/' + i,
      v = r.object(item, p, ['componentId', 'group', 'key', 'minimum', 'maximum']);
    const componentId = r.id(v.componentId, p + '/componentId'),
      group = r.text(v.group, p + '/group', 1, 100),
      key = r.text(v.key, p + '/key', 1, 100);
    const option = options.find((o) => o.componentId === componentId && o.group === group && o.key === key);
    if (!option) r.fail('GOAL_VARIABLE_UNSUPPORTED', p, '当前模型参数不支持作为有限求解变量。');
    if (option?.locked) r.fail('PARAMETER_LOCKED', p, '此参数已锁定，请在元件参数窗口由用户解锁。');
    if (selection && key === 'settingDifferentialPa')
      r.fail('GOAL_VARIABLE_UNSUPPORTED', p, '当前缺少额定依据，09 自动选配保持溢流设定。');
    const minimum = r.number(
        v.minimum,
        p + '/minimum',
        option?.minimum ?? -Number.MAX_VALUE,
        option?.maximum ?? Number.MAX_VALUE,
      ),
      maximum = r.number(
        v.maximum,
        p + '/maximum',
        option?.minimum ?? -Number.MAX_VALUE,
        option?.maximum ?? Number.MAX_VALUE,
      );
    if (minimum > maximum) r.fail('PARAMETER_OUT_OF_RANGE', p, '变量下限不能大于上限。');
    return { componentId, group, key, minimum, maximum };
  });
  r.unique(variables.map(variableKey), '/goal/variables');
  return r.finish({
    mode: raw.mode === 'check' ? 'check' : 'solve',
    duty: duty.value,
    variables,
    ...(selection ? { selection } : {}),
  });
}
function replace(project: NetworkProject, values: ReadonlyMap<string, number>): Result<NetworkProject> {
  return parseNetworkProject({
    ...project,
    design: {
      ...project.design,
      components: project.design.components.map((c) => ({
        ...c,
        parameters: Object.fromEntries(
          Object.entries(c.parameters).map(([group, params]) => [
            group,
            Object.fromEntries(
              Object.entries(params).map(([key, value]) => [
                key,
                values.get(variableKey({ componentId: c.id, group, key })) ?? value,
              ]),
            ),
          ]),
        ),
      })),
    },
  });
}
function evaluate(
  project: NetworkProject,
  duty: NetworkDutyRequest,
  pressureLimitPa = duty.pressureLimitPa,
): Result<NetworkDutyPlan> {
  const speed = duty.phases.some((phase) => phase.flowSplit)
    ? duty.angularSpeedRadPerS
    : project.design.components.find((c) => c.id === duty.pumpId)?.parameters.drive?.angularSpeedRadPerS;
  if (speed === undefined || speed <= 0)
    return fail('GOAL_INPUT_MISSING', '当前泵保存转速须为正数；不能猜测实际供油。');
  return checkNetworkDuty(project, {
    ...duty,
    angularSpeedRadPerS: speed,
    pressureLimitPa,
    automaticFields:
      duty.automaticFields?.filter(
        (field) =>
          (field !== '/angularSpeedRadPerS' || speed === duty.angularSpeedRadPerS) &&
          (field !== '/pressureLimitPa' || pressureLimitPa === duty.pressureLimitPa),
      ) ?? [],
  });
}
export function networkGoalSupplySatisfied(plan: NetworkDutyPlan): boolean {
  return (
    plan.constraints.length === 0 &&
    plan.phases.every((phase) =>
      isDutySupplyDemand(phase)
        ? !phase.supplyBalanceIssue &&
          (phase.flowSplit?.kind === 'solved' ||
            (phase.availableFlowM3PerS ?? plan.availableFlowM3PerS) >= phase.flowM3PerS * (1 - 1e-10))
        : (phase.boundaryAssessment?.satisfied ?? (phase.springReturn?.forceMarginN ?? -Infinity) >= 0),
    )
  );
}
/** Preliminary supply-capacity search using the canonical duty equations, never a second simulator. */
export function planNetworkGoal(document: unknown, input: unknown): Result<NetworkGoalPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const request = readRequest(parsed.value, input);
  if (!request.ok) return request;
  if (request.value.mode === 'solve' && request.value.duty.phases.some((phase) => phase.pumpPressureControl))
    return fail('GOAL_INPUT_MISSING', '变量泵压力调节限校核当前设计，排量自动选配待核。');
  if (request.value.mode === 'solve' && request.value.duty.phases.some((phase) => phase.flowSplit))
    return fail('GOAL_INPUT_MISSING', '多缸实际分流仅用于核对当前设计，阀口和泵规格须按分流结果复核。');
  const project = parsed.value,
    req = request.value,
    current = evaluate(project, req.duty);
  if (!current.ok) return current;
  if (
    req.mode === 'solve' &&
    current.value.phases.some((phase) => phase.flowSplit?.kind === 'solved' && phase.flowSplit.workingSegments)
  )
    return fail('GOAL_INPUT_MISSING', '有损工作管限当前设计核算，泵自动选配待核。');
  const changesFor = (candidateDocument: NetworkProject): SizingChange[] => {
    const changes: SizingChange[] = [];
    for (const v of req.variables) {
      const before = goalValue(project, v),
        after = goalValue(candidateDocument, v);
      if (before !== undefined && after !== undefined && before !== after)
        changes.push({ componentId: v.componentId, parameter: v.group + '.' + v.key, before, after });
    }
    return changes;
  };
  const alternatives: NetworkGoalCandidate[] = [];
  const result = (
    status: NetworkGoalPlan['status'],
    candidate: NetworkDutyPlan | null,
    candidateDocument: NetworkProject,
    checked: number,
    budgetExhausted: boolean,
  ): Result<NetworkGoalPlan> => {
    const changes = changesFor(candidateDocument);
    return {
      ok: true,
      value: immutable({
        request: req,
        status,
        current: current.value,
        candidate,
        document: candidateDocument,
        changes,
        alternatives,
        checked,
        budgetExhausted,
      }),
    };
  };
  const currentWithinBounds = req.variables.every((v) => {
    const value = project.design.components.find((c) => c.id === v.componentId)?.parameters[v.group]?.[v.key];
    return value !== undefined && value >= v.minimum && value <= v.maximum;
  });
  if (
    req.mode === 'check' ||
    current.value.phases.every((phase) => !isDutySupplyDemand(phase)) ||
    current.value.phases.some((phase) => phase.springReturn && phase.springReturn.forceMarginN < 0) ||
    (!req.selection && networkGoalSupplySatisfied(current.value) && currentWithinBounds)
  )
    return result(
      networkGoalSupplySatisfied(current.value) ? 'current-satisfied' : 'not-feasible',
      null,
      project,
      1,
      false,
    );
  if (!req.variables.length && !req.selection) return result('not-feasible', null, project, 1, false);
  const pump = project.design.components.find((c) => c.id === req.duty.pumpId);
  if (!pump) return fail('GOAL_INPUT_MISSING', '请指定当前唯一泵。');
  const derivedD = req.variables.find(
    (v) => v.componentId === pump.id && v.group + '.' + v.key === 'hydraulic.displacementM3PerRev',
  );
  const derivedSpeed = !derivedD
    ? req.variables.find((v) => v.componentId === pump.id && v.group + '.' + v.key === 'drive.angularSpeedRadPerS')
    : undefined;
  const free = req.variables
    .filter((v) => v !== derivedD && v !== derivedSpeed)
    .sort((a, b) => variableKey(a).localeCompare(variableKey(b), 'en'));
  const samples = goalTrialGroups(project, free, !!req.selection);
  if (samples.some((a) => !a.length))
    return req.selection
      ? result('not-feasible', null, project, 1, false)
      : fail('GOAL_INPUT_MISSING', '变量没有合法有限采样值。');
  const queue: number[][] = [samples.map(() => 0)],
    visited = new Set([samples.map(() => 0).join(',')]);
  let checked = 0;
  for (let cursor = 0; cursor < queue.length && checked < budget; cursor++) {
    const indices = queue[cursor];
    if (!indices) return fail('GOAL_INTERNAL', '候选索引缺失。');
    const values = new Map<string, number>();
    for (const [i, group] of samples.entries()) {
      const sample = group[indices[i] ?? -1];
      if (!sample) return fail('GOAL_INTERNAL', '候选值缺失。');
      for (const [key, value] of sample) values.set(key, value);
    }
    checked++;
    const trial = replace(project, values);
    if (trial.ok) {
      const initial = evaluate(trial.value, req.duty);
      if (initial.ok) {
        const v = derivedD ?? derivedSpeed;
        let derivationAvailable = true;
        if (v) {
          const d = trial.value.design.components.find((c) => c.id === pump.id)?.parameters.hydraulic
              ?.displacementM3PerRev,
            speed = trial.value.design.components.find((c) => c.id === pump.id)?.parameters.drive?.angularSpeedRadPerS;
          if (d === undefined || speed === undefined || d <= 0) return fail('GOAL_INPUT_MISSING', '当前泵参数缺失。');
          const proposed = derivedD
            ? initial.value.requiredDisplacementM3PerRev
            : (speed * initial.value.requiredDisplacementM3PerRev) / d;
          const selected =
            req.selection && derivedD
              ? selectionDisplacement(v, proposed)
              : Math.max(v.minimum, Math.min(v.maximum, proposed));
          if (selected === undefined) derivationAvailable = false;
          else values.set(variableKey(v), selected);
        }
        const final = derivationAvailable ? replace(project, values) : null;
        if (final?.ok) {
          const guard = checkNetworkParameterRules(project, final.value);
          const limit = req.selection ? selectionBudget(initial.value, req.selection) : req.duty.pressureLimitPa;
          const analysis = evaluate(final.value, req.duty, limit);
          const withinBounds = req.variables.every((selected) => {
            const value = final.value.design.components.find((c) => c.id === selected.componentId)?.parameters[
              selected.group
            ]?.[selected.key];
            return value !== undefined && value >= selected.minimum && value <= selected.maximum;
          });
          if (withinBounds && guard.ok && analysis.ok && networkGoalSupplySatisfied(analysis.value)) {
            if (!req.selection) return result('candidate', analysis.value, final.value, checked, false);
            const changes = changesFor(final.value);
            if (changes.length || limit !== req.duty.pressureLimitPa) {
              const key = JSON.stringify([changes, limit]);
              if (
                !alternatives.some(
                  (item) => JSON.stringify([item.changes, item.analysis.request.pressureLimitPa]) === key,
                )
              )
                alternatives.push({ analysis: analysis.value, document: final.value, changes });
              if (alternatives.length >= 3) break;
            }
          }
        }
      }
    }
    // Breadth first: every one-variable alternative is visited before combinations. Queue size is bounded.
    for (let i = 0; i < samples.length && queue.length < budget * 10; i++)
      if (indices[i] === 0) {
        for (let j = 1; j < (samples[i]?.length ?? 0) && queue.length < budget * 10; j++) {
          const next = [...indices];
          next[i] = j;
          const key = next.join(',');
          if (!visited.has(key)) {
            visited.add(key);
            queue.push(next);
          }
        }
      }
  }
  alternatives.sort((a, b) => a.changes.length - b.changes.length);
  const best = alternatives[0];
  if (best) return result('candidate', best.analysis, best.document, checked, false);
  const inRange =
    req.selection?.mode !== 'range' ||
    (req.duty.pressureLimitPa >= req.selection.minimumPa && req.duty.pressureLimitPa <= req.selection.maximumPa);
  return result(
    req.selection && currentWithinBounds && inRange && networkGoalSupplySatisfied(current.value)
      ? 'current-satisfied'
      : 'not-feasible',
    null,
    project,
    checked,
    checked >= budget,
  );
}
