import { diagnostic, immutable, ContractReader, type Result } from '@hyd/domain';
import {
  planNetworkCatalog,
  networkSelectionPolicy,
  type NetworkCatalogPlan,
  type NetworkSizingPlan,
  type NetworkDutyPlan,
  type NetworkGoalPlan,
  type SizingChange,
  type CalculationRecord,
} from '@hyd/engineering';
import type { NetworkDraftSession } from './network-draft.js';
import type { NetworkToolCommand } from './network-tool-commands.js';
import { previewNetworkSizing } from './network-sizing.js';
import { previewNetworkDuty } from './network-duty.js';
import { previewNetworkGoal } from './network-goal.js';
import {
  prepareNetworkDutyCalculation,
  prepareIndependentDutyCalculation,
  prepareCombinedDutyCalculation,
} from './network-catalog.js';

export const networkToolCalculationOperations = [
  'sizing',
  'duty',
  'goal',
  'catalog',
  'duty-report',
  'duty-independent',
  'duty-combined',
] as const;
export type NetworkToolCalculationOperation = (typeof networkToolCalculationOperations)[number];
export function parseNetworkToolCalculationOperation(input: unknown): Result<NetworkToolCalculationOperation> {
  const operation = networkToolCalculationOperations.find((value) => value === input);
  return operation
    ? { ok: true, value: operation }
    : {
        ok: false,
        diagnostics: [diagnostic('CALCULATION_OPERATION_INVALID', '/calculation/operation', '未知计算操作。')],
      };
}

type Commands = readonly Extract<NetworkToolCommand, { kind: 'parameter' }>[];
export type NetworkToolCalculationResult = {
  readonly applied: false;
  readonly documentSessionId: string;
  readonly revision: number;
  readonly physicsRevision: number;
  readonly commands: Commands;
} & (
  | { readonly operation: 'sizing'; readonly plan: NetworkSizingPlan }
  | { readonly operation: 'duty'; readonly plan: NetworkDutyPlan }
  | { readonly operation: 'goal'; readonly plan: NetworkGoalPlan; readonly alternatives: readonly Commands[] }
  | { readonly operation: 'catalog'; readonly plan: NetworkCatalogPlan }
  | { readonly operation: 'duty-report' | 'duty-independent' | 'duty-combined'; readonly record: CalculationRecord }
);
function commandsFor(changes: readonly SizingChange[]): Commands {
  return changes.map((change) => {
    const [group = '', key = ''] = change.parameter.split('.');
    return { kind: 'parameter', id: change.componentId, group, key, value: change.after };
  });
}
/** Pure analysis adapter. Existing engineering parsers own input validation; no commit or automatic approval. */
export function networkToolCalculate(
  session: NetworkDraftSession,
  operation: NetworkToolCalculationOperation,
  input: unknown,
): Result<NetworkToolCalculationResult> {
  const context = {
    applied: false as const,
    documentSessionId: session.documentSessionId,
    revision: session.revision,
    physicsRevision: session.physicsRevision,
  };
  if (operation === 'duty-report' || operation === 'duty-independent' || operation === 'duty-combined') {
    const reader = new ContractReader();
    const raw =
      operation === 'duty-combined'
        ? null
        : reader.object(
            input,
            '/calculation/input',
            operation === 'duty-report' ? ['duty', 'pendingPhases'] : ['groups'],
          );
    const checked = reader.finish(true);
    if (!checked.ok) return checked;
    const record =
      operation === 'duty-combined'
        ? prepareCombinedDutyCalculation(session, input)
        : operation === 'duty-independent'
          ? prepareIndependentDutyCalculation(session, raw?.groups)
          : prepareNetworkDutyCalculation(session, raw?.duty, raw?.pendingPhases);
    return record.ok
      ? { ok: true, value: immutable({ ...context, operation, record: record.value, commands: [] }) }
      : record;
  }
  if (operation === 'catalog') {
    const result = planNetworkCatalog(session.document, input);
    return result.ok
      ? { ok: true, value: immutable({ ...context, operation, plan: result.value, commands: [] }) }
      : result;
  }
  if (operation === 'sizing') {
    const result = previewNetworkSizing(session, input);
    return result.ok
      ? {
          ok: true,
          value: immutable({
            ...context,
            operation,
            plan: result.value.plan,
            commands: commandsFor(result.value.plan.changes),
          }),
        }
      : result;
  }
  if (operation === 'duty') {
    const result = previewNetworkDuty(session, input);
    return result.ok
      ? {
          ok: true,
          value: immutable({
            ...context,
            operation,
            plan: result.value.plan,
            commands: commandsFor(result.value.plan.changes),
          }),
        }
      : result;
  }
  const result = previewNetworkGoal(session, input);
  return result.ok
    ? {
        ok: true,
        value: immutable({
          ...context,
          operation,
          plan: result.value.plan,
          commands: commandsFor(result.value.plan.changes),
          alternatives: result.value.plan.alternatives.map((candidate) => commandsFor(candidate.changes)),
        }),
      }
    : result;
}

const object = (properties: Readonly<Record<string, unknown>>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const text = (maxLength = 100) => ({ type: 'string', minLength: 1, maxLength });
const number = (minimum = 0, maximum = Number.MAX_VALUE) => ({ type: 'number', minimum, maximum });
const positive = { type: 'number', exclusiveMinimum: 0 };
const efficiency = { ...positive, maximum: 1 };
const id = text();
const action = object(
  {
    componentId: id,
    direction: { enum: ['forward', 'reverse'] },
    speed: {
      ...number(),
      description: 'Magnitude: cylinder m/s, motor rad/s. Zero only for the declared end-stop case.',
    },
    resistingLoad: number(),
    supplyLossPa: number(0, 70e6),
    returnPressurePa: number(0, 70e6),
    mechanicalEfficiency: efficiency,
    volumetricEfficiency: efficiency,
    positionM: number(0, 5),
    rotaryAngleRad: number(0, 2 * Math.PI + 1e-9),
    motorSetting: {
      oneOf: [
        object({ kind: { const: 'command' }, value: number(0, 100) }),
        object({ kind: { const: 'voltage' }, value: number(0, 10) }),
        object({ kind: { enum: ['differential', 'pilot'] }, value: number(0, 70e6) }),
      ],
    },
  },
  [
    'componentId',
    'direction',
    'speed',
    'resistingLoad',
    'supplyLossPa',
    'returnPressurePa',
    'mechanicalEfficiency',
    'volumetricEfficiency',
  ],
);
const phase = object(
  {
    name: text(80),
    valves: array(object({ componentId: id, positionId: { enum: ['extend', 'neutral', 'retract'] } }), 100),
    actions: array(action, 100),
    flowSplit: { const: true },
    filterBypass: object({
      componentId: id,
      ratedDropPa: { ...positive, maximum: 70e6 },
      crackingPressurePa: number(0, 70e6),
      effectiveAreaM2: number(1e-12, 1),
    }),
    dividerEnd: object({ componentId: id, pressurePa: number(0, 70e6) }),
    pumpCommandPercent: number(0, 100),
    pumpPressureControl: object({
      cutoffDifferentialPa: { ...positive, maximum: 70e6 },
      bandPa: { ...positive, maximum: 70e6 },
    }),
    accumulatorOilVolumeM3: number(0, 1),
    accumulatorTargetOilVolumeM3: number(0, 1),
    shutoffs: array(
      {
        oneOf: [
          object({ componentId: id, state: { enum: ['open', 'closed'] } }),
          object({ componentId: id, state: { const: 'partial' }, openingAreaM2: number(1e-12, 1) }),
        ],
      },
      100,
    ),
  },
  ['name', 'valves', 'actions'],
);
const duty = object(
  {
    pumpId: id,
    boundary: { const: true },
    angularSpeedRadPerS: number(0, 5000),
    pumpVolumetricEfficiency: efficiency,
    totalEfficiency: efficiency,
    pressureLimitPa: number(0, 70e6),
    phases: { ...array(phase, 24), minItems: 1 },
    automaticFields: array(text(180), 15000),
  },
  ['pumpId', 'angularSpeedRadPerS', 'pumpVolumetricEfficiency', 'totalEfficiency', 'pressureLimitPa', 'phases'],
);
const pendingPhases = array(
  object({ name: text(80), kind: { enum: ['incomplete', 'excluded'] }, reason: text(1600) }),
  24,
);
const report = { duty: { oneOf: [duty, { type: 'null' }] }, pendingPhases };
/** Discoverable input shapes. Engineering validation additionally checks topology, locks and supported physical cases. */
export const networkToolCalculationSchemas = immutable({
  sizing: object({
    cylinderId: id,
    pumpId: { oneOf: [id, { type: 'null' }] },
    requirements: object({
      forceN: positive,
      speedMPerS: positive,
      pressureBudgetPa: positive,
      strokeM: positive,
      pumpAngularSpeedRadPerS: positive,
      volumetricEfficiency: efficiency,
      totalEfficiency: efficiency,
    }),
  }),
  duty,
  goal: object(
    {
      mode: { enum: ['check', 'solve'] },
      duty,
      variables: array(
        object({ componentId: id, group: text(), key: text(), minimum: number(), maximum: number() }),
        10,
      ),
      selection: {
        oneOf: [
          object({ version: { const: networkSelectionPolicy.version }, mode: { enum: ['automatic', 'fixed'] } }),
          object({
            version: { const: networkSelectionPolicy.version },
            mode: { const: 'range' },
            minimumPa: positive,
            maximumPa: positive,
          }),
        ],
      },
    },
    ['mode', 'duty', 'variables'],
  ),
  catalog: object({
    duty: { oneOf: [duty, { type: 'null' }] },
    pendingPhases: array(
      object({ name: text(80), kind: { enum: ['incomplete', 'excluded'] }, reason: text(1600) }),
      24,
    ),
    region: { type: 'string', maxLength: 80 },
    fluid: { enum: ['unconfirmed', 'mineral', 'HFA'] },
    customization: { enum: ['standard-only', 'allow-custom'] },
    limit: { type: 'integer', minimum: 1, maximum: 2 },
  }),
  'duty-report': object(report),
  'duty-independent': object({ groups: array(object({ pumpId: id, ...report }), 100) }),
  'duty-combined': object({
    pumps: array(
      object(
        {
          pumpId: id,
          speed: { oneOf: [number(0, 5000), { type: 'null' }] },
          etaV: { oneOf: [number(0, 1), { type: 'null' }] },
          etaTotal: { oneOf: [number(0, 1), { type: 'null' }] },
          budget: { oneOf: [number(0, 70e6), { type: 'null' }] },
        },
        ['pumpId'],
      ),
      100,
    ),
    phases: array(phase, 24),
    pendingPhases,
  }),
});
