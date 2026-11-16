import {
  ContractReader,
  checkJson,
  checkNetworkParameterRules,
  parseNetworkProject,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { reviewCombinedDuty, type CombinedDutyCoverage } from './network-duty-combined.js';
import { networkGoalOptions } from './network-goal.js';
import { networkSelectionPolicy } from './network-selection-policy.js';
import type { SizingChange } from './network-sizing.js';

export interface CombinedGoalPlan {
  readonly status: 'candidate' | 'current-satisfied' | 'not-feasible' | 'pending';
  readonly current: CombinedDutyCoverage;
  readonly reason: string;
  readonly alternatives: readonly {
    readonly analysis: CombinedDutyCoverage;
    readonly document: NetworkProject;
    readonly changes: readonly SizingChange[];
  }[];
}

interface PumpChoices {
  readonly id: string;
  readonly saved: number;
  readonly flowPerDisplacement: number;
  readonly values: readonly number[];
}
interface Trial {
  readonly values: readonly number[];
  readonly flow: number;
  readonly changes: number;
}
const trialLimit = 96;
const beamWidth = 24;

function complete(coverage: CombinedDutyCoverage): boolean {
  return (
    coverage.phases.length > 0 &&
    coverage.phases.every(
      (phase) =>
        phase.kind === 'solved' &&
        phase.matchesTarget &&
        phase.pumps.every((pump) => pump.kind === 'solved' && pump.shaftPowerW !== undefined),
    )
  );
}

/** Nominal flow ranks a bounded set of trials. Only the common-bus solver may accept one. */
function trialPumps(pumps: readonly PumpChoices[], targets: readonly number[]): readonly Trial[] {
  const savedTail = Array.from({ length: pumps.length + 1 }, () => 0);
  const lowTail = [...savedTail];
  const highTail = [...savedTail];
  for (let i = pumps.length - 1; i >= 0; i--) {
    const pump = pumps[i];
    if (!pump || !pump.values.length) return [];
    savedTail[i] = (savedTail[i + 1] ?? 0) + pump.saved * pump.flowPerDisplacement;
    lowTail[i] = (lowTail[i + 1] ?? 0) + Math.min(...pump.values) * pump.flowPerDisplacement;
    highTail[i] = (highTail[i + 1] ?? 0) + Math.max(...pump.values) * pump.flowPerDisplacement;
  }
  const trials = new Map<string, Trial>();
  for (const target of targets) {
    let beam: readonly Trial[] = [{ values: [], flow: 0, changes: 0 }];
    for (const [index, pump] of pumps.entries()) {
      const low = lowTail[index + 1] ?? 0;
      const high = highTail[index + 1] ?? 0;
      const saved = savedTail[index + 1] ?? 0;
      const intervalDistance = (flow: number) => Math.max(0, flow + low - target, target - flow - high);
      beam = beam
        .flatMap((trial) =>
          pump.values.map((value) => ({
            values: [...trial.values, value],
            flow: trial.flow + value * pump.flowPerDisplacement,
            changes: trial.changes + (value === pump.saved ? 0 : 1),
          })),
        )
        .sort(
          (a, b) =>
            intervalDistance(a.flow) - intervalDistance(b.flow) ||
            Math.abs(a.flow + saved - target) - Math.abs(b.flow + saved - target) ||
            a.changes - b.changes,
        )
        .slice(0, beamWidth);
    }
    for (const trial of beam) if (trial.changes) trials.set(trial.values.join(','), trial);
  }
  const distance = (trial: Trial) => Math.min(...targets.map((target) => Math.abs(trial.flow - target) / target));
  return [...trials.values()].sort((a, b) => distance(a) - distance(b) || a.changes - b.changes).slice(0, trialLimit);
}

function combinedGoalInput(project: NetworkProject, input: unknown) {
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const r = new ContractReader();
  const raw = r.object(input, '/combinedGoal', ['mode', 'duty', 'variables']);
  if (raw.mode !== 'check' && raw.mode !== 'solve')
    r.fail('GOAL_INVALID', '/combinedGoal/mode', '请选择校核或自动选配。');
  const options = networkGoalOptions(project);
  const variables = r
    .array(raw.variables, '/combinedGoal/variables', project.design.components.length)
    .map((entry, i) => {
      const p = '/combinedGoal/variables/' + i;
      const variable = r.object(entry, p, ['componentId', 'minimum', 'maximum']);
      const id = r.id(variable.componentId, p + '/componentId');
      const pump = project.design.components.find((part) => part.id === id && part.typeId === 'pump');
      const option =
        pump &&
        options.find(
          (item) => item.componentId === id && item.group === 'hydraulic' && item.key === 'displacementM3PerRev',
        );
      if (!option || option.locked) r.fail('GOAL_VARIABLE_UNSUPPORTED', p, '合流选配只允许调整未锁定的定量泵排量。');
      const low = option?.minimum ?? Number.MIN_VALUE;
      const high = option?.maximum ?? Number.MAX_VALUE;
      const minimum = r.number(variable.minimum, p + '/minimum', low, high);
      const maximum = r.number(variable.maximum, p + '/maximum', minimum, high);
      return { id, minimum, maximum };
    });
  r.unique(
    variables.map((variable) => variable.id),
    '/combinedGoal/variables',
  );
  const duty = r.object(raw.duty, '/combinedSupply', ['pumps', 'phases', 'pendingPhases']);
  const pumpInputs = r
    .array(duty.pumps, '/combinedSupply/pumps', project.design.components.length)
    .map((entry) => r.object(entry, '/combinedSupply/pumps', ['pumpId', 'speed', 'etaV', 'etaTotal', 'budget']));
  const valid = r.finish(true);
  if (!valid.ok) return valid;
  return { ok: true as const, value: { mode: raw.mode, duty, variables, pumpInputs } };
}

export function planCombinedNetworkGoal(document: unknown, input: unknown): Result<CombinedGoalPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const project = parsed.value;
  const request = combinedGoalInput(project, input);
  if (!request.ok) return request;
  const { mode, duty, variables, pumpInputs } = request.value;
  const reviewed = reviewCombinedDuty(project, duty);
  if (!reviewed.ok) return reviewed;
  const current = reviewed.value;
  const result = (
    status: CombinedGoalPlan['status'],
    reason: string,
    alternatives: CombinedGoalPlan['alternatives'] = [],
  ): Result<CombinedGoalPlan> => ({ ok: true, value: { status, current, reason, alternatives } });
  const solved = current.phases.filter((phase) => phase.kind === 'solved');
  if (solved.length !== current.phases.length || current.pendingPhases.some((phase) => phase.kind === 'incomplete'))
    return result('pending', '有参与工况或泵的边界待核，见各工况详情。');
  if (mode === 'check')
    return complete(current)
      ? result('current-satisfied', '当前设计满足所选合流工况。')
      : result('not-feasible', '当前设计的速度、转速或各泵条件有缺口。');
  if (current.hasUnloading)
    return result('pending', '含卸荷切换的接法请先校核当前设计，合流自动选配适用于无卸荷的定量泵。');
  if (current.hasSupplyPipe) return result('pending', '有损供油母线请先联合校核当前设计，自动选配待核。');
  if (solved.some((phase) => phase.targetWindow.kind === 'incompatible'))
    return result('not-feasible', '存在工况的各执行器没有共同目标母线压力，只调整泵排量无法让各支路同时达标。');
  const first = solved[0];
  if (!first) return result('pending', '缺少完整的合流工况。');
  const pumps: PumpChoices[] = [];
  for (const source of first.pumps) {
    const pump = project.design.components.find((part) => part.id === source.pumpId);
    const saved = pump?.parameters.hydraulic?.displacementM3PerRev;
    const speed = pump?.parameters.drive?.angularSpeedRadPerS;
    const entered = pumpInputs.find((item) => item.pumpId === source.pumpId);
    const estimated = source.estimatedSupplyM3PerS;
    if (
      !saved ||
      !speed ||
      !estimated ||
      typeof entered?.speed !== 'number' ||
      Math.abs(entered.speed - speed) > 1e-9 * speed ||
      typeof entered.budget !== 'number' ||
      entered.budget <= 0 ||
      entered.budget > 70e6 ||
      source.kind !== 'solved' ||
      source.shaftPowerW === undefined
    ) {
      return result('pending', source.label + ' 须使用工程保存转速，并填写有效的总效率与压力预算。');
    }
    const variable = variables.find((item) => item.id === source.pumpId);
    const values = variable
      ? [...new Set([saved, ...networkSelectionPolicy.displacementM3PerRev])].filter(
          (value) => value >= variable.minimum && value <= variable.maximum,
        )
      : [saved];
    if (!values.length) return result('not-feasible', source.label + ' 在指定范围内没有推荐排量。');
    pumps.push({ id: source.pumpId, saved, flowPerDisplacement: estimated / saved, values });
  }
  const targets = [
    ...new Set(
      solved.flatMap((phase) => {
        const target = phase.loads.reduce((sum, load) => sum + load.targetFlowM3PerS, 0);
        const losses = phase.pumps.reduce(
          (sum, pump) => (pump.kind === 'solved' ? sum + pump.leakageM3PerS + pump.localReliefM3PerS : sum),
          phase.busReliefM3PerS,
        );
        return [target, target + losses];
      }),
    ),
  ].filter((value) => value > 0 && Number.isFinite(value));
  const alternatives: CombinedGoalPlan['alternatives'][number][] = [];
  for (const trial of trialPumps(pumps, targets)) {
    const changes = pumps.flatMap(({ id, saved }, index): SizingChange[] => {
      const after = trial.values[index];
      return after !== undefined && after !== saved
        ? [{ componentId: id, parameter: 'hydraulic.displacementM3PerRev', before: saved, after }]
        : [];
    });
    const values = new Map(changes.map((change) => [change.componentId, change.after]));
    const candidate = parseNetworkProject({
      ...project,
      design: {
        ...project.design,
        components: project.design.components.map((part) => {
          const displacement = values.get(part.id);
          return displacement === undefined
            ? part
            : {
                ...part,
                parameters: {
                  ...part.parameters,
                  hydraulic: { ...part.parameters.hydraulic, displacementM3PerRev: displacement },
                },
              };
        }),
      },
    });
    if (!candidate.ok || !checkNetworkParameterRules(project, candidate.value).ok) continue;
    const analysis = reviewCombinedDuty(candidate.value, duty);
    if (analysis.ok && complete(analysis.value))
      alternatives.push({ document: candidate.value, analysis: analysis.value, changes });
    if (alternatives.length === 3) break;
  }
  if (alternatives.length)
    return result('candidate', '找到 ' + alternatives.length + ' 套通过合流工况复核的方案。', alternatives);
  if (complete(current) && pumps.every((pump) => pump.values.includes(pump.saved)))
    return result('current-satisfied', '当前设计满足所选工况及排量范围。');
  return result('not-feasible', '在所选范围、推荐排量和有限试算中未找到覆盖全部工况的方案。');
}
