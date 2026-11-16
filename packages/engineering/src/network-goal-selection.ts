import type { NetworkProject } from '@hyd/domain';
import { isDutySupplyDemand, type NetworkDutyPlan } from './network-duty.js';
import type { NetworkGoalVariable, NetworkGoalSelection } from './network-goal.js';
import { networkSelectionPolicy } from './network-selection-policy.js';

export const goalVariableKey = (v: Pick<NetworkGoalVariable, 'componentId' | 'group' | 'key'>) =>
  v.componentId + ':' + v.group + '.' + v.key;
export const goalValue = (project: NetworkProject, variable: NetworkGoalVariable) =>
  project.design.components.find((item) => item.id === variable.componentId)?.parameters[variable.group]?.[
    variable.key
  ];
const within = (variable: NetworkGoalVariable, value: number) => value >= variable.minimum && value <= variable.maximum;

export function selectionBudget(plan: NetworkDutyPlan, selection: NetworkGoalSelection): number {
  const seed = plan.request.pressureLimitPa;
  if (selection.mode === 'fixed') return seed;
  const supply = plan.phases.filter(isDutySupplyDemand);
  if (!supply.length) return seed;
  const demand = Math.max(...supply.map((phase) => phase.pressurePa));
  if (selection.mode === 'range') return Math.min(selection.maximumPa, Math.max(selection.minimumPa, demand));
  const boundedPhases = new Set(plan.reliefLimits.map((limit) => limit.phaseIndex));
  return boundedPhases.size === supply.length
    ? Math.min(networkSelectionPolicy.maximumBudgetPa, Math.max(seed, demand))
    : seed;
}

export function selectionDisplacement(variable: NetworkGoalVariable, required: number): number | undefined {
  return networkSelectionPolicy.displacementM3PerRev.find(
    (value) => within(variable, value) && value >= required * (1 - 1e-12),
  );
}

/** Each cylinder contributes paired geometry samples. A locked/omitted side keeps its saved value. */
export function goalTrialGroups(
  project: NetworkProject,
  variables: readonly NetworkGoalVariable[],
  preferred: boolean,
): readonly (readonly ReadonlyMap<string, number>[])[] {
  const groups = new Map<string, NetworkGoalVariable[]>();
  for (const variable of variables) {
    const component = project.design.components.find((item) => item.id === variable.componentId);
    const key = preferred && component?.typeId === 'cylinder' ? component.id : goalVariableKey(variable);
    const group = groups.get(key) ?? [];
    group.push(variable);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    if (!first) return [];
    const current = group.map((v) => goalValue(project, v));
    const component = project.design.components.find((item) => item.id === first.componentId);
    let proposed: readonly (readonly (number | undefined)[])[];
    if (preferred && component?.typeId === 'cylinder') {
      proposed = networkSelectionPolicy.cylinderPairsMm.map(({ bore, rod }) =>
        group.map((v) => (Math.PI * (bore ** 2 - (v.key === 'rodSideAreaM2' ? rod ** 2 : 0))) / 4e6),
      );
    } else if (preferred && first.key === 'displacementM3PerRev') {
      const start = current[0];
      proposed = [...networkSelectionPolicy.displacementM3PerRev]
        .filter((value) => within(first, value))
        .sort((a, b) => (start ? Math.abs(Math.log(a / start)) - Math.abs(Math.log(b / start)) : a - b))
        .map((value) => [value]);
    } else {
      const value = current[0];
      proposed =
        preferred || value === undefined
          ? [[first.minimum], [first.maximum]]
          : [...[0.5, 2, 0.25, 4, 0.125, 8].map((factor) => [value * factor]), [first.minimum], [first.maximum]];
    }
    const unique = new Map<string, ReadonlyMap<string, number>>();
    for (const row of [current, ...proposed]) {
      const sample = new Map<string, number>();
      for (const [index, variable] of group.entries()) {
        const value = row[index];
        if (value !== undefined && within(variable, value)) sample.set(goalVariableKey(variable), value);
      }
      if (sample.size === group.length) unique.set(JSON.stringify(row), sample);
    }
    return [...unique.values()];
  });
}
