import {
  networkDefinition,
  networkParameterRule,
  parameterDisplayName,
  physicalPipeParameters,
  type NetworkProject,
} from '@hyd/domain';

export interface NetworkToolParameterRow {
  readonly target: 'component' | 'project' | 'initial' | 'pipe';
  readonly id: string;
  readonly object: string;
  readonly group: string;
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly value: number | null;
  readonly locked?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}
const initialUnits: Readonly<Record<string, string>> = {
  positionM: 'm',
  velocityMPerS: 'm/s',
  capPressurePa: 'Pa',
  rodPressurePa: 'Pa',
  angleRad: 'rad',
  angularSpeedRadPerS: 'rad/s',
  openingAreaM2: 'm²',
  pressurePa: 'Pa',
};
/** Shared discovery/presentation of the existing numerical parameter vocabulary; domain parsing owns limits. */
export function networkToolParameterRows(document: NetworkProject): readonly NetworkToolParameterRow[] {
  const rows: NetworkToolParameterRow[] = [];
  for (const c of document.design.components) {
    const definition = networkDefinition(c.definition.id, c.definition.version);
    for (const [group, specs] of Object.entries(definition?.groups ?? {}))
      for (const spec of specs) {
        const value = c.parameters[group]?.[spec.key];
        if (value !== undefined) {
          const rule = networkParameterRule(c, group, spec.key);
          rows.push({
            target: 'component',
            id: c.id,
            object: c.label,
            group,
            key: spec.key,
            label: parameterDisplayName(spec.key),
            unit: spec.unit,
            value,
            locked: rule?.mode === 'locked',
            minimum: rule?.mode === 'variable' ? rule.minimum : spec.minimum,
            maximum: rule?.mode === 'variable' ? rule.maximum : spec.maximum,
          });
        }
      }
    const initial = document.design.initialConditions.find((i) => i.componentId === c.id);
    for (const [key, value] of Object.entries(initial ?? {})) {
      const unit = initialUnits[key];
      if (unit && (typeof value === 'number' || value === null))
        rows.push({
          target: 'initial',
          id: c.id,
          object: c.label,
          group: 'initial-condition',
          key,
          label: parameterDisplayName(key),
          unit,
          value,
        });
    }
  }
  for (const [key, unit, label] of [
    ['densityKgPerM3', 'kg/m³', '油液密度'],
    ['kinematicViscosityM2PerS', 'm²/s', '油液运动黏度'],
    ['bulkModulusPa', 'Pa', '油液体积弹性模量'],
  ] as const)
    rows.push({
      target: 'project',
      id: document.projectId,
      object: document.title,
      group: 'fluid',
      key,
      label,
      unit,
      value: document.design.fluid[key],
    });
  for (const c of document.design.connections) {
    if (c.kind !== 'pipe') continue;
    for (const spec of physicalPipeParameters) {
      const value = c.parameters[spec.key];
      if (value !== undefined)
        rows.push({
          target: 'pipe',
          id: c.id,
          object: '物理管路 ' + c.id,
          group: 'pipe',
          key: spec.key,
          label: parameterDisplayName(spec.key),
          unit: spec.unit,
          value,
        });
    }
  }
  return rows;
}

export function networkToolParameterChanges(before: NetworkProject, after: NetworkProject) {
  const original = networkToolParameterRows(before);
  return networkToolParameterRows(after).flatMap((row) => {
    const old = original.find(
      (p) => p.target === row.target && p.id === row.id && p.group === row.group && p.key === row.key,
    );
    return old && old.value !== row.value ? [{ ...row, before: old.value, after: row.value }] : [];
  });
}
