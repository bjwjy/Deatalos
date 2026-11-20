import { immutable, networkDefinition, type NetworkIdentity, type NetworkProject, type Result } from '@hyd/domain';
import { networkResultView, displayNetworkQuantity, type ResultValue } from './network-results.js';
import type { NetworkDutyCoverage } from './network-duty.js';
import type { DutyGroupCoverage } from './network-duty-groups.js';
import type { CombinedDutyCoverage } from './network-duty-combined.js';

export interface CalculationInput {
  readonly reference: string;
  readonly unit: string;
  readonly value: ResultValue;
  readonly source: string;
}
export interface CalculationStep {
  readonly key: string;
  readonly label: string;
  readonly source: 'preliminary' | 'kernel' | 'derived';
  readonly formula: string;
  readonly inputs: readonly CalculationInput[];
  readonly substitution: string;
  readonly unit: string;
  readonly value: ResultValue;
  readonly display: { readonly unit: string; readonly value: ResultValue; readonly conversion: string };
}
export interface CalculationRecord {
  readonly format: 'HydraulicLearningCalculation';
  readonly version: 1;
  readonly kind: 'preliminary' | 'snapshot';
  readonly title: string;
  readonly document: NetworkProject;
  readonly identity: NetworkIdentity | null;
  readonly context: {
    readonly documentSessionId: string;
    readonly documentRevision: number | null;
    readonly physicsRevision: number;
  } | null;
  readonly assumptions: readonly string[];
  readonly steps: readonly CalculationStep[];
  readonly dutyCoverage?: NetworkDutyCoverage;
  readonly dutyGroups?: readonly DutyGroupCoverage[];
  readonly dutyCombined?: CombinedDutyCoverage;
  readonly dutyConditions?: readonly string[];
  readonly cavityWindow?: {
    readonly inletRows: readonly (readonly string[])[];
    readonly fromS: number;
    readonly toS: number;
    readonly rows: readonly (readonly string[])[];
  };
}
export function calculationSubstitution(inputs: readonly CalculationInput[]): string {
  return inputs
    .map(
      (input) =>
        `${input.reference} = ${input.value.kind === 'known' ? input.value.value : input.value.kind + ':' + input.value.reason} ${input.unit} [${input.source}]`,
    )
    .join('; ');
}

/** A learning projection of the accepted frame. No independent simulation or missing-value repair. */
export function networkLearningRecord(
  document: unknown,
  snapshot: unknown,
  expected: NetworkIdentity,
): Result<CalculationRecord> {
  const projected = networkResultView(document, snapshot, expected);
  if (!projected.ok) return projected;
  const view = projected.value;
  const steps = view.quantities.map((quantity): CalculationStep => {
    const inputs = quantity.inputs.map((reference): CalculationInput => {
      const match = view.quantities.find(
        (q) => q.objectKind === quantity.objectKind && q.objectId === quantity.objectId && q.field === reference,
      );
      if (match)
        return { reference, unit: match.unit, value: match.value, source: match.source + ':' + quantity.objectId };
      const component = view.document.design.components.find((c) => c.id === quantity.objectId);
      const [group, field] = reference.split('.');
      const parameter = group && field ? component?.parameters[group]?.[field] : undefined;
      const definition = component ? networkDefinition(component.definition.id, component.definition.version) : null;
      const spec = group ? definition?.groups[group]?.find((item) => item.key === field) : undefined;
      return {
        reference,
        unit: spec?.unit ?? '未解析单位',
        value:
          parameter === undefined
            ? { kind: 'unknown', reason: 'MISSING_REFERENCE:' + reference }
            : { kind: 'known', value: parameter },
        source: 'saved-parameter:' + quantity.objectId,
      };
    });
    const display = displayNetworkQuantity(quantity);
    return {
      key: `${quantity.objectKind}:${quantity.objectId}:${quantity.field}`,
      label: `${quantity.objectId} · ${quantity.label}`,
      source: quantity.source,
      formula: quantity.source === 'kernel' ? '已接受的内核读数；不展开内核迭代' : quantity.formula,
      inputs,
      substitution:
        quantity.source === 'kernel'
          ? `读取同一快照 ${quantity.objectId}.${quantity.field}`
          : calculationSubstitution(inputs),
      unit: quantity.unit,
      value: quantity.value,
      display: {
        unit: display.unit,
        value: display.value,
        conversion:
          quantity.unit === display.unit ? 'SI原单位' : `${quantity.unit} → ${display.unit}；使用公共显示换算`,
      },
    };
  });
  return {
    ok: true,
    value: immutable({
      format: 'HydraulicLearningCalculation',
      version: 1,
      kind: 'snapshot',
      title: '所选有效快照的基础计算过程',
      document: view.document,
      identity: view.point.identity,
      context: {
        documentSessionId: view.point.identity.documentSessionId,
        documentRevision: null,
        physicsRevision: view.point.identity.physicsRevision,
      },
      assumptions: view.assumptions,
      steps,
    }),
  };
}
