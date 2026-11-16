import { parseCurveRequest, type CurveRequest } from './network-curve-plan.js';
import {
  networkToolSettingSchema,
  parseNetworkToolSettingChanges,
  type NetworkToolSettingChange,
} from './network-tool-interface.js';
import {
  checkJson,
  ContractReader,
  diagnostic,
  readPosition,
  motorCurveSlopeLimit,
  motorCurveReachMin,
  motorCurveReachMax,
  type NetworkControl,
  type NetworkIdentity,
  type Result,
} from '@hyd/domain';
import { legacyNetworkRecordCapacity, networkRecordMaximum, readNetworkIdentity } from './network-records.js';
import type { NetworkOnlineControl } from './network-flow-regulation.js';
import {
  networkToolCalculationSchemas,
  parseNetworkToolCalculationOperation,
  type NetworkToolCalculationOperation,
} from './network-tool-calculation.js';
export interface NetworkToolBase {
  readonly documentSessionId: string;
  readonly revision: number;
  readonly physicsRevision: number;
  readonly runtimeIdentity: NetworkIdentity | null;
}
export type NetworkToolCollection =
  | 'catalog'
  | 'project'
  | 'components'
  | 'probes'
  | 'nodes'
  | 'connections'
  | 'layout'
  | 'parameters'
  | 'current'
  | 'runs'
  | 'diagnostics'
  | 'diagnostic-batches'
  | 'samples'
  | 'controls';
export const networkToolCollections: readonly NetworkToolCollection[] = [
  'catalog',
  'project',
  'components',
  'probes',
  'nodes',
  'connections',
  'layout',
  'parameters',
  'current',
  'runs',
  'diagnostics',
  'diagnostic-batches',
  'samples',
  'controls',
];
// Shape/schema discovery for generic tool clients. Semantic graph/model/version checks still run in the planner.
const schemaObject = (properties: Readonly<Record<string, unknown>>, optional: readonly string[] = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const schemaId = {
  type: 'string',
  pattern: '^[-\\w]{1,40}$',
  not: { enum: ['__proto__', 'constructor', 'prototype'] },
};
const schemaNumber = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const schemaInteger = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const schemaText = (minLength: number, maxLength: number) => ({ type: 'string', minLength, maxLength });
const schemaLiteral = (value: string | number) => ({ const: value });
const schemaArray = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const schemaIdentity = schemaObject({
  documentSessionId: schemaId,
  simulationSessionId: schemaId,
  physicsRevision: schemaInteger(0, Number.MAX_SAFE_INTEGER),
  tick: schemaInteger(0, Number.MAX_SAFE_INTEGER),
  timeS: schemaNumber(0, 1e12),
  controlSequence: schemaInteger(0, Number.MAX_SAFE_INTEGER),
  requestSequence: schemaInteger(0, Number.MAX_SAFE_INTEGER),
});
const schemaBase = schemaObject({
  documentSessionId: schemaId,
  revision: schemaInteger(0, Number.MAX_SAFE_INTEGER),
  physicsRevision: schemaInteger(0, Number.MAX_SAFE_INTEGER),
  runtimeIdentity: { oneOf: [{ type: 'null' }, schemaIdentity] },
});
const schemaPosition = { x: schemaNumber(-1e6, 1e6), y: schemaNumber(-1e6, 1e6) };
const schemaViewport = {
  centerX: schemaNumber(-1e6, 1e6),
  centerY: schemaNumber(-1e6, 1e6),
  zoom: schemaNumber(0.0001, 8),
};
const schemaIds = { oneOf: [{ type: 'null' }, schemaArray(schemaId, 1000)] };
const schemaEndpoint = {
  oneOf: [
    schemaObject({ kind: schemaLiteral('port'), componentId: schemaId, portId: schemaId }),
    schemaObject({ kind: schemaLiteral('node'), nodeId: schemaId }),
  ],
};
const schemaRoute = {
  oneOf: [
    ...['auto', 'avoid'].map((mode) => schemaObject({ connectionId: schemaId, mode: schemaLiteral(mode) })),
    schemaObject({
      connectionId: schemaId,
      mode: schemaLiteral('manual'),
      points: { ...schemaArray(schemaObject(schemaPosition), 64), minItems: 1 },
    }),
  ],
};
function schemaSelection(kinds: readonly string[]) {
  return { ...schemaArray(schemaObject({ kind: { enum: kinds }, id: schemaId }), 100), minItems: 1, uniqueItems: true };
}
const schemaProbeEdit = {
  oneOf: [
    ...['add-gauge', 'move'].map((kind) =>
      schemaObject({ kind: schemaLiteral(kind), id: schemaId, ...schemaPosition }),
    ),
    schemaObject({ kind: schemaLiteral('add'), id: schemaId, controllerId: schemaId, ...schemaPosition }),
    schemaObject({ kind: schemaLiteral('add-near'), id: schemaId, controllerId: schemaId }),
    schemaObject({ kind: schemaLiteral('delete'), id: schemaId }),
    schemaObject({ kind: schemaLiteral('rename-controller'), id: schemaId, name: schemaText(1, 100) }),
    schemaObject({
      kind: schemaLiteral('route'),
      id: schemaId,
      points: { ...schemaArray(schemaObject(schemaPosition), 64), minItems: 1 },
    }),
    schemaObject({
      kind: schemaLiteral('configure'),
      id: schemaId,
      name: schemaText(0, 60),
      target: { oneOf: [...schemaEndpoint.oneOf, schemaObject({ kind: schemaLiteral('disconnected') })] },
    }),
  ],
};
const schemaSequenceLeaf = [
  schemaObject({ kind: schemaLiteral('time'), durationS: schemaNumber(0.01, 3600) }),
  schemaObject({
    kind: schemaLiteral('pressure-switch'),
    componentId: schemaId,
    contact: { enum: ['open', 'closed'] },
    holdS: schemaNumber(0.01, 10),
  }),
  schemaObject({
    kind: schemaLiteral('probe-pressure'),
    probeId: schemaId,
    comparison: { enum: ['gte', 'lte'] },
    thresholdPa: schemaNumber(-1e8, 1e9),
    holdS: schemaNumber(0.01, 10),
  }),
  schemaObject({
    kind: schemaLiteral('position'),
    componentId: schemaId,
    comparison: { enum: ['gte', 'lte'] },
    thresholdM: schemaNumber(0, 100),
    holdS: schemaNumber(0.01, 10),
  }),
  schemaObject({
    kind: schemaLiteral('pressure'),
    componentId: schemaId,
    portId: schemaText(1, 16),
    comparison: { enum: ['gte', 'lte'] },
    thresholdPa: schemaNumber(-1e8, 1e9),
    holdS: schemaNumber(0.01, 10),
  }),
  schemaObject({
    kind: schemaLiteral('flow'),
    componentId: schemaId,
    portId: schemaText(1, 16),
    comparison: { enum: ['gte', 'lte'] },
    thresholdM3PerS: schemaNumber(-10, 10),
    holdS: schemaNumber(0.01, 10),
  }),
];
const schemaSequence = schemaObject({
  version: schemaLiteral(1),
  cycles: schemaInteger(1, 100),
  steps: {
    ...schemaArray(
      schemaObject({
        id: schemaId,
        name: schemaText(1, 80),
        timeoutS: schemaNumber(0.01, 3600),
        commands: schemaArray(
          {
            oneOf: [
              schemaObject({
                componentId: schemaId,
                kind: schemaLiteral('position'),
                positionId: { enum: ['extend', 'neutral', 'retract'] },
              }),
              schemaObject({
                componentId: schemaId,
                kind: schemaLiteral('displacement'),
                source: schemaLiteral('controller'),
                value: schemaNumber(0, 1),
              }),
            ],
          },
          30,
        ),
        until: {
          oneOf: [
            ...schemaSequenceLeaf,
            ...['all', 'any'].map((kind) =>
              schemaObject({
                kind: schemaLiteral(kind),
                conditions: { ...schemaArray({ oneOf: schemaSequenceLeaf }, 8), minItems: 1 },
              }),
            ),
          ],
        },
      }),
      50,
    ),
    minItems: 1,
  },
});
const schemaAnchor = {
  oneOf: [
    ...schemaEndpoint.oneOf,
    schemaObject({ kind: schemaLiteral('route'), connectionId: schemaId, point: schemaObject(schemaPosition) }),
  ],
};
const schemaPressureRange = schemaObject({ lowPa: schemaNumber(-1e8, 70e6), highPa: schemaNumber(-1e8, 70e6) });
const schemaMotorCurve = (enabled: boolean) =>
  schemaObject({
    version: schemaLiteral(1),
    enabled: { const: enabled },
    pressureLimitPa: schemaNumber(1e4, 70e6),
    points: {
      ...schemaArray(
        schemaObject(
          {
            pressurePa: schemaNumber(0, 70e6),
            displacementM3PerRev: schemaNumber(0, 0.01),
            tangent: schemaObject({
              slopeM3PerRevPa: schemaNumber(-motorCurveSlopeLimit, motorCurveSlopeLimit),
              leftReach: schemaNumber(motorCurveReachMin, motorCurveReachMax),
              rightReach: schemaNumber(motorCurveReachMin, motorCurveReachMax),
            }),
          },
          ['tangent'],
        ),
        24,
      ),
      minItems: 2,
    },
  });
const schemaRetainedCurve = { ...schemaMotorCurve(false), type: ['object', 'null'] };
const schemaMotorControl = {
  oneOf: [
    schemaObject({ mode: schemaLiteral('manual'), curve: schemaRetainedCurve }),
    schemaObject({ mode: schemaLiteral('curve'), curve: schemaMotorCurve(true) }),
    schemaObject({
      mode: schemaLiteral('external-pressure'),
      curve: schemaRetainedCurve,
      pressureRange: schemaPressureRange,
    }),
    schemaObject({
      mode: schemaLiteral('external-voltage'),
      curve: schemaRetainedCurve,
      pressureRange: { ...schemaPressureRange, type: ['object', 'null'] },
    }),
  ],
};
const schemaCommand = {
  oneOf: [
    schemaObject({ kind: schemaLiteral('viewport'), ...schemaViewport }),
    schemaObject({ kind: schemaLiteral('motor-control'), id: schemaId, control: schemaMotorControl }),
    schemaObject({
      kind: schemaLiteral('switch-output'),
      id: schemaId,
      output: {
        ...schemaObject({
          mode: { enum: ['switch', 'analog'] },
          lowPa: schemaNumber(-1e8, 70e6),
          highPa: schemaNumber(-1e8, 70e6),
        }),
        type: ['object', 'null'],
      },
    }),
    schemaObject({ kind: schemaLiteral('probe-edit'), edit: schemaProbeEdit }),
    schemaObject({
      kind: schemaLiteral('controller-program'),
      id: schemaId,
      program: { ...schemaSequence, type: ['object', 'null'] },
    }),
    schemaObject({ kind: schemaLiteral('branch-connect'), from: schemaAnchor, to: schemaAnchor, idPrefix: schemaId }),
    schemaObject({
      kind: schemaLiteral('rotate'),
      selection: schemaSelection(['component']),
      direction: { enum: ['clockwise', 'counterclockwise'] },
    }),
    schemaObject({ kind: schemaLiteral('mirror'), selection: schemaSelection(['component']) }),
    schemaObject({
      kind: schemaLiteral('move-selection'),
      selection: schemaSelection(['component', 'node', 'probe', 'text']),
      delta: schemaObject(schemaPosition),
    }),
    schemaObject({
      kind: schemaLiteral('delete-selection'),
      selection: schemaSelection(['component', 'node', 'connection', 'probe', 'text']),
    }),
    schemaObject({
      kind: schemaLiteral('copy-selection'),
      selection: schemaSelection(['component', 'node', 'connection', 'probe', 'text']),
      point: schemaObject(schemaPosition),
      ids: schemaObject({
        components: schemaArray(schemaId, 1000),
        nodes: schemaArray(schemaId, 1000),
        connections: schemaArray(schemaId, 1000),
        texts: schemaArray(schemaId, 1000),
        probes: schemaArray(schemaId, 1000),
      }),
    }),
    schemaObject({
      kind: schemaLiteral('text'),
      edit: {
        oneOf: [
          schemaObject({ kind: schemaLiteral('delete'), id: schemaId }),
          schemaObject({
            kind: schemaLiteral('put'),
            replace: { type: 'boolean' },
            value: schemaObject({
              id: schemaId,
              kind: schemaLiteral('text'),
              version: schemaLiteral(1),
              ...schemaPosition,
              width: schemaNumber(60, 3000),
              text: schemaText(1, 4000),
              fontSize: schemaNumber(8, 72),
              color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              align: { enum: ['left', 'center', 'right'] },
              border: { type: 'boolean' },
              background: { enum: [null, '#ffffff'] },
            }),
          }),
        ],
      },
    }),
    ...['project-parameter', 'initial-parameter', 'pipe-parameter'].map((kind) =>
      schemaObject({
        kind: schemaLiteral(kind),
        id: schemaId,
        key: schemaId,
        value: { oneOf: [schemaNumber(-Number.MAX_VALUE, Number.MAX_VALUE), { type: 'null' }] },
      }),
    ),
    schemaObject({
      kind: schemaLiteral('add-component'),
      id: schemaId,
      definitionId: schemaText(1, 100),
      definitionVersion: schemaInteger(1, 10000),
      label: schemaText(1, 100),
      ...schemaPosition,
    }),
    schemaObject({ kind: schemaLiteral('add-node'), id: schemaId, label: schemaText(1, 100), ...schemaPosition }),
    schemaObject({ kind: schemaLiteral('move'), id: schemaId, ...schemaPosition }),
    schemaObject({
      kind: schemaLiteral('parameter'),
      id: schemaId,
      group: schemaId,
      key: schemaId,
      value: schemaNumber(-Number.MAX_VALUE, Number.MAX_VALUE),
    }),
    schemaObject({
      kind: schemaLiteral('connect'),
      id: schemaId,
      from: schemaEndpoint,
      to: schemaEndpoint,
      pipe: {
        oneOf: [
          { type: 'null' },
          schemaObject({
            internalDiameterM: schemaNumber(0.002, 0.2),
            lengthM: schemaNumber(0, 1000),
            roughnessM: schemaNumber(0, 0.001),
            localLossCoefficient: schemaNumber(0, 1000),
          }),
        ],
      },
    }),
    schemaObject({
      kind: schemaLiteral('remove'),
      target: { enum: ['component', 'node', 'connection'] },
      id: schemaId,
    }),
    schemaObject({ kind: schemaLiteral('route'), route: schemaRoute }),
    schemaObject({
      kind: schemaLiteral('arrange'),
      request: schemaObject({ kind: schemaLiteral('routing'), connectionIds: schemaIds }),
    }),
  ],
};
const schemaEnvelope = (method: string, params: unknown) =>
  schemaObject({
    protocol: schemaLiteral('HydraulicTools'),
    version: schemaLiteral(1),
    requestId: schemaId,
    method: schemaLiteral(method),
    params,
  });
const simulationActions = ['run', 'pause', 'step', 'reset', 'sequence-stop'] as const;
export type NetworkToolSimulationAction =
  | { readonly kind: (typeof simulationActions)[number] }
  | { readonly kind: 'run-for'; readonly ticks: number }
  | Extract<NetworkControl, { kind: 'position' | 'opening-area' }>
  | (Extract<NetworkControl, { kind: 'displacement' }> & { readonly source: 'manual' })
  | Extract<NetworkOnlineControl, { kind: 'target-flow' }>;

export type NetworkToolBookSelection =
  { readonly kind: 'primary' | 'current' } | { readonly kind: 'candidate'; readonly index: number };
type NetworkToolExportBatch = {
  readonly kind: 'export-batch';
  readonly curveId: string;
  readonly segment: number;
  readonly calculationId: string;
};
export type NetworkToolFileAction =
  | NetworkToolExportBatch
  | { readonly kind: 'curve-import' }
  | { readonly kind: 'project'; readonly mode: 'open' | 'new' | 'import' }
  | { readonly kind: 'project'; readonly mode: 'restore'; readonly recoveryId: string }
  | {
      readonly kind: 'curve';
      readonly curveId: string;
      readonly format: 'csv' | 'svg' | 'pdf';
      readonly segment: number;
      readonly destination: 'project' | 'external';
    }
  | {
      readonly kind: 'catalog';
      readonly calculationId: string;
      readonly format: 'docx' | 'md';
      readonly destination: 'project' | 'external';
    }
  | { readonly kind: 'save'; readonly mode: 'current' | 'as' }
  | { readonly kind: 'drawing'; readonly format: 'svg' | 'pdf'; readonly destination: 'project' | 'external' }
  | {
      readonly kind: 'book';
      readonly calculationId: string;
      readonly recordSelection: NetworkToolBookSelection;
      readonly format: 'docx' | 'pdf';
      readonly destination: 'project' | 'external';
    };
export const networkToolRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'HydraulicTools/1 request',
  description:
    'All editing values are SI. Schema describes shapes; exact references, model capabilities, graph constraints, revision/runtime identity and explicit UI confirmation remain required.',
  oneOf: [
    ...['capabilities', 'capture'].map((method) => schemaEnvelope(method, schemaObject({}))),
    schemaEnvelope('recovery_list', schemaObject({})),
    ...['view_read', 'settings_read'].map((method) => schemaEnvelope(method, schemaObject({}))),
    schemaEnvelope('diagnose', schemaObject({ base: schemaBase })),
    schemaEnvelope(
      'diagnostic_locate',
      schemaObject({
        base: schemaBase,
        batchId: schemaInteger(1, Number.MAX_SAFE_INTEGER),
        rowIndex: schemaInteger(0, 999),
      }),
    ),
    schemaEnvelope(
      'view_navigate',
      schemaObject({
        base: schemaBase,
        action: {
          oneOf: [
            schemaObject({ kind: schemaLiteral('fit') }),
            schemaObject({ kind: schemaLiteral('viewport'), ...schemaViewport }),
          ],
        },
      }),
    ),
    schemaEnvelope(
      'settings_prepare',
      schemaObject({ base: schemaBase, operationKey: schemaId, changes: networkToolSettingSchema }),
    ),
    ...['settings_status', 'settings_cancel'].map((method) =>
      schemaEnvelope(method, schemaObject({ operationId: schemaId })),
    ),
    schemaEnvelope('curve_history', schemaObject({})),
    schemaEnvelope('curve_capture', schemaObject({ base: schemaBase, historyId: schemaId }, ['historyId'])),
    schemaEnvelope('curve_prepare', {
      oneOf: [
        schemaObject({ sourceId: schemaId, curveIndex: schemaInteger(0, 63) }),
        schemaObject({
          sourceId: schemaText(1, 80),
          request: schemaObject({
            target: schemaObject({ objectKind: schemaText(1, 40), objectId: schemaId, field: schemaText(1, 80) }),
            fromS: schemaNumber(0, 1e12),
            toS: schemaNumber(0, 1e12),
            maximumPoints: schemaInteger(2, networkRecordMaximum),
            relativeTolerance: schemaNumber(0, 1),
            samplesPerFile: schemaInteger(2, 2000),
            scope: { enum: ['curve', 'all'] },
            keys: schemaArray(
              schemaObject({
                sampleIndex: schemaInteger(0, networkRecordMaximum - 1),
                label: schemaText(0, 80),
                offsetX: schemaNumber(-300, 300),
                offsetY: schemaNumber(-300, 300),
              }),
              16,
            ),
          }),
        }),
      ],
    }),
    schemaEnvelope(
      'curve_read',
      schemaObject({ curveId: schemaId, offset: schemaInteger(0, networkRecordMaximum), limit: schemaInteger(1, 100) }),
    ),
    schemaEnvelope(
      'file_prepare',
      schemaObject({
        base: schemaBase,
        operationKey: schemaId,
        action: {
          oneOf: [
            schemaObject({
              kind: schemaLiteral('curve'),
              curveId: schemaId,
              format: { enum: ['csv', 'svg', 'pdf'] },
              segment: schemaInteger(0, networkRecordMaximum),
              destination: { enum: ['project', 'external'] },
            }),
            schemaObject({
              kind: schemaLiteral('catalog'),
              calculationId: schemaId,
              format: { enum: ['docx', 'md'] },
              destination: { enum: ['project', 'external'] },
            }),
            schemaObject({ kind: schemaLiteral('save'), mode: { enum: ['current', 'as'] } }),
            schemaObject({ kind: schemaLiteral('curve-import') }),
            schemaObject({ kind: schemaLiteral('project'), mode: { enum: ['open', 'new', 'import'] } }),
            schemaObject({
              kind: schemaLiteral('project'),
              mode: schemaLiteral('restore'),
              recoveryId: schemaText(1, 100),
            }),
            schemaObject({
              kind: schemaLiteral('drawing'),
              format: { enum: ['svg', 'pdf'] },
              destination: { enum: ['project', 'external'] },
            }),
            schemaObject({
              kind: schemaLiteral('book'),
              calculationId: schemaId,
              recordSelection: {
                oneOf: [
                  schemaObject({ kind: { enum: ['primary', 'current'] } }),
                  schemaObject({ kind: schemaLiteral('candidate'), index: schemaInteger(0, 100) }),
                ],
              },
              format: { enum: ['docx', 'pdf'] },
              destination: { enum: ['project', 'external'] },
            }),
          ],
        },
      }),
    ),
    schemaEnvelope(
      'export_batch_prepare',
      schemaObject({
        base: schemaBase,
        operationKey: schemaId,
        curveId: schemaId,
        segment: schemaInteger(0, networkRecordMaximum),
        calculationId: schemaId,
      }),
    ),
    ...['file_status', 'file_cancel'].map((method) => schemaEnvelope(method, schemaObject({ operationId: schemaId }))),
    schemaEnvelope('calculate', {
      oneOf: Object.entries(networkToolCalculationSchemas).map(([operation, input]) =>
        schemaObject({ base: schemaBase, operation: schemaLiteral(operation), input }),
      ),
    }),
    schemaEnvelope(
      'simulate',
      schemaObject({
        base: schemaBase,
        action: {
          oneOf: [
            schemaObject({ kind: { enum: simulationActions } }),
            schemaObject({ kind: schemaLiteral('run-for'), ticks: schemaInteger(1, 10000) }),
            schemaObject({
              kind: schemaLiteral('position'),
              componentId: schemaId,
              positionId: { enum: ['extend', 'neutral', 'retract'] },
            }),
            schemaObject({
              kind: schemaLiteral('opening-area'),
              componentId: schemaId,
              areaM2: schemaNumber(0, Number.MAX_VALUE),
            }),
            schemaObject({
              kind: schemaLiteral('target-flow'),
              componentId: schemaId,
              targetM3PerS: schemaNumber(-10, 10),
            }),
            schemaObject({
              kind: schemaLiteral('displacement'),
              componentId: schemaId,
              source: schemaLiteral('manual'),
              value: schemaNumber(-Number.MAX_VALUE, Number.MAX_VALUE),
            }),
          ],
        },
      }),
    ),
    schemaEnvelope(
      'read',
      schemaObject({
        captureId: schemaId,
        collection: { enum: networkToolCollections },
        offset: schemaInteger(0, networkRecordMaximum),
        limit: schemaInteger(1, 20),
        simulationSessionId: { oneOf: [{ type: 'null' }, schemaId] },
      }),
    ),
    schemaEnvelope(
      'preview',
      schemaObject({
        base: schemaBase,
        operation: { enum: ['edit', 'undo', 'redo'] },
        commands: schemaArray(schemaCommand, 30),
      }),
    ),
    ...['proposal', 'cancel', 'apply'].map((method) => schemaEnvelope(method, schemaObject({ proposalId: schemaId }))),
  ],
};
export type NetworkToolRequest = {
  readonly protocol: 'HydraulicTools';
  readonly version: 1;
  readonly requestId: string;
} & (
  | { readonly method: 'view_read' | 'settings_read'; readonly params: Record<string, never> }
  | { readonly method: 'diagnose'; readonly params: { readonly base: NetworkToolBase } }
  | {
      readonly method: 'diagnostic_locate';
      readonly params: { readonly base: NetworkToolBase; readonly batchId: number; readonly rowIndex: number };
    }
  | {
      readonly method: 'view_navigate';
      readonly params: {
        readonly base: NetworkToolBase;
        readonly action:
          | { readonly kind: 'fit' }
          | { readonly kind: 'viewport'; readonly centerX: number; readonly centerY: number; readonly zoom: number };
      };
    }
  | {
      readonly method: 'settings_prepare';
      readonly params: {
        readonly base: NetworkToolBase;
        readonly operationKey: string;
        readonly changes: readonly NetworkToolSettingChange[];
      };
    }
  | { readonly method: 'settings_status' | 'settings_cancel'; readonly params: { readonly operationId: string } }
  | { readonly method: 'curve_history'; readonly params: Record<string, never> }
  | { readonly method: 'recovery_list'; readonly params: Record<string, never> }
  | {
      readonly method: 'curve_capture';
      readonly params: { readonly base: NetworkToolBase; readonly historyId?: string };
    }
  | {
      readonly method: 'curve_prepare';
      readonly params:
        | { readonly sourceId: string; readonly request: CurveRequest }
        | { readonly sourceId: string; readonly curveIndex: number };
    }
  | {
      readonly method: 'curve_read';
      readonly params: { readonly curveId: string; readonly offset: number; readonly limit: number };
    }
  | { readonly method: 'capabilities' | 'capture'; readonly params: Record<string, never> }
  | {
      readonly method: 'file_prepare';
      readonly params: {
        readonly base: NetworkToolBase;
        readonly operationKey: string;
        readonly action: NetworkToolFileAction;
      };
    }
  | { readonly method: 'file_status' | 'file_cancel'; readonly params: { readonly operationId: string } }
  | {
      readonly method: 'export_batch_prepare';
      readonly params: {
        readonly base: NetworkToolBase;
        readonly operationKey: string;
      } & Omit<NetworkToolExportBatch, 'kind'>;
    }
  | {
      readonly method: 'calculate';
      readonly params: {
        readonly base: NetworkToolBase;
        readonly operation: NetworkToolCalculationOperation;
        readonly input: unknown;
      };
    }
  | {
      readonly method: 'simulate';
      readonly params: { readonly base: NetworkToolBase; readonly action: NetworkToolSimulationAction };
    }
  | {
      readonly method: 'read';
      readonly params: {
        readonly captureId: string;
        readonly collection: NetworkToolCollection;
        readonly offset: number;
        readonly limit: number;
        readonly simulationSessionId: string | null;
      };
    }
  | {
      readonly method: 'preview';
      readonly params: {
        readonly base: NetworkToolBase;
        readonly operation: 'edit' | 'undo' | 'redo';
        readonly commands: readonly unknown[];
      };
    }
  | { readonly method: 'proposal' | 'cancel' | 'apply'; readonly params: { readonly proposalId: string } }
);
export const toolFailure = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/tools', message)],
});
export function readToolBase(r: ContractReader, input: unknown): NetworkToolBase {
  const o = r.object(input, '/params/base', ['documentSessionId', 'revision', 'physicsRevision', 'runtimeIdentity']);
  const number = (key: string) => {
    const n = r.number(o[key], '/params/base/' + key, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(n)) r.fail('IDENTITY_INVALID', '/params/base/' + key, '修订必须是安全整数。');
    return n;
  };
  return {
    documentSessionId: r.id(o.documentSessionId, '/params/base/documentSessionId'),
    revision: number('revision'),
    physicsRevision: number('physicsRevision'),
    runtimeIdentity:
      o.runtimeIdentity === null ? null : readNetworkIdentity(r, o.runtimeIdentity, '/params/base/runtimeIdentity'),
  };
}
/** Public wire envelope is a closed versioned JSON vocabulary, never arbitrary JS/IPC. */
export function parseNetworkToolRequest(input: unknown): Result<NetworkToolRequest> {
  const json = checkJson(input);
  if (!json.ok) return json;
  const r = new ContractReader(),
    o = r.object(input, '', ['protocol', 'version', 'requestId', 'method', 'params']);
  r.constant(o.protocol, 'HydraulicTools', '/protocol');
  r.constant(o.version, 1, '/version', 'VERSION_UNSUPPORTED');
  const header = {
    protocol: 'HydraulicTools' as const,
    version: 1 as const,
    requestId: r.id(o.requestId, '/requestId'),
  };
  if (
    o.method === 'capabilities' ||
    o.method === 'capture' ||
    o.method === 'recovery_list' ||
    o.method === 'curve_history' ||
    o.method === 'view_read' ||
    o.method === 'settings_read'
  ) {
    r.object(o.params, '/params', []);
    return r.finish({ ...header, method: o.method, params: {} });
  }
  if (o.method === 'settings_status' || o.method === 'settings_cancel') {
    const p = r.object(o.params, '/params', ['operationId']);
    return r.finish({
      ...header,
      method: o.method,
      params: { operationId: r.id(p.operationId, '/params/operationId') },
    });
  }
  if (o.method === 'settings_prepare') {
    const p = r.object(o.params, '/params', ['base', 'operationKey', 'changes']),
      changes = parseNetworkToolSettingChanges(p.changes);
    if (!changes.ok) return changes;
    return r.finish({
      ...header,
      method: o.method,
      params: {
        base: readToolBase(r, p.base),
        operationKey: r.id(p.operationKey, '/params/operationKey'),
        changes: changes.value,
      },
    });
  }
  if (o.method === 'diagnose' || o.method === 'diagnostic_locate' || o.method === 'view_navigate') {
    const p = r.object(
      o.params,
      '/params',
      o.method === 'diagnose'
        ? ['base']
        : o.method === 'diagnostic_locate'
          ? ['base', 'batchId', 'rowIndex']
          : ['base', 'action'],
    );
    const base = readToolBase(r, p.base);
    if (o.method === 'diagnose') return r.finish({ ...header, method: o.method, params: { base } });
    if (o.method === 'diagnostic_locate') {
      const batchId = r.number(p.batchId, '/params/batchId', 1, Number.MAX_SAFE_INTEGER),
        rowIndex = r.number(p.rowIndex, '/params/rowIndex', 0, 999);
      if (![batchId, rowIndex].every(Number.isSafeInteger))
        r.fail('PROTOCOL_INVALID', '/params', '诊断定位编号须为整数。');
      return r.finish({ ...header, method: o.method, params: { base, batchId, rowIndex } });
    }
    const a = r.object(p.action, '/params/action', ['kind', 'centerX', 'centerY', 'zoom']);
    if (a.kind === 'fit') {
      r.object(p.action, '/params/action', ['kind']);
      return r.finish({ ...header, method: o.method, params: { base, action: { kind: 'fit' } } });
    }
    if (a.kind !== 'viewport') return toolFailure('TOOL_METHOD_INVALID', '未知临时视图操作。');
    return r.finish({
      ...header,
      method: o.method,
      params: {
        base,
        action: {
          kind: 'viewport',
          centerX: r.number(a.centerX, '/params/action/centerX', -1e6, 1e6),
          centerY: r.number(a.centerY, '/params/action/centerY', -1e6, 1e6),
          zoom: r.number(a.zoom, '/params/action/zoom', 0.0001, 8),
        },
      },
    });
  }
  if (o.method === 'curve_capture') {
    const p = r.object(o.params, '/params', ['base', 'historyId']);
    return r.finish({
      ...header,
      method: o.method,
      params: {
        base: readToolBase(r, p.base),
        ...(p.historyId === undefined ? {} : { historyId: r.id(p.historyId, '/params/historyId') }),
      },
    });
  }
  if (o.method === 'curve_prepare') {
    const p = r.object(o.params, '/params', ['sourceId', 'request', 'curveIndex']);
    if (p.curveIndex !== undefined) {
      r.object(o.params, '/params', ['sourceId', 'curveIndex']);
      const curveIndex = r.number(p.curveIndex, '/params/curveIndex', 0, 63);
      if (!Number.isSafeInteger(curveIndex)) r.fail('CURVE_RANGE_INVALID', '/params/curveIndex', '曲线编号须为整数。');
      return r.finish({
        ...header,
        method: o.method,
        params: { sourceId: r.id(p.sourceId, '/params/sourceId'), curveIndex },
      });
    }
    const request = parseCurveRequest(p.request);
    if (!request.ok) return request;
    return r.finish({
      ...header,
      method: o.method,
      params: { sourceId: r.text(p.sourceId, '/params/sourceId', 1, 80), request: request.value },
    });
  }
  if (o.method === 'curve_read') {
    const p = r.object(o.params, '/params', ['curveId', 'offset', 'limit']);
    const offset = r.number(p.offset, '/params/offset', 0, networkRecordMaximum),
      limit = r.number(p.limit, '/params/limit', 1, 100);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit))
      r.fail('CURVE_PAGE_INVALID', '/params', '曲线分页必须为整数。');
    return r.finish({
      ...header,
      method: o.method,
      params: { curveId: r.id(p.curveId, '/params/curveId'), offset, limit },
    });
  }
  if (o.method === 'file_status' || o.method === 'file_cancel') {
    const p = r.object(o.params, '/params', ['operationId']);
    return r.finish({
      ...header,
      method: o.method,
      params: { operationId: r.id(p.operationId, '/params/operationId') },
    });
  }
  if (o.method === 'export_batch_prepare') {
    const p = r.object(o.params, '/params', ['base', 'operationKey', 'curveId', 'segment', 'calculationId']);
    const segment = r.number(p.segment, '/params/segment', 0, networkRecordMaximum);
    if (!Number.isSafeInteger(segment)) r.fail('CURVE_SEGMENT_INVALID', '/params/segment', '曲线分段无效。');
    return r.finish({
      ...header,
      method: o.method,
      params: {
        base: readToolBase(r, p.base),
        operationKey: r.id(p.operationKey, '/params/operationKey'),
        curveId: r.id(p.curveId, '/params/curveId'),
        segment,
        calculationId: r.id(p.calculationId, '/params/calculationId'),
      },
    });
  }
  if (o.method === 'file_prepare') {
    const p = r.object(o.params, '/params', ['base', 'operationKey', 'action']);
    const a = r.object(p.action, '/params/action', [
      'kind',
      'mode',
      'format',
      'destination',
      'calculationId',
      'recordSelection',
      'curveId',
      'segment',
      'recoveryId',
    ]);
    let action: NetworkToolFileAction;
    if (a.kind === 'curve-import') {
      r.object(p.action, '/params/action', ['kind']);
      action = { kind: a.kind };
    } else if (a.kind === 'project') {
      if (a.mode === 'restore') {
        r.object(p.action, '/params/action', ['kind', 'mode', 'recoveryId']);
        action = { kind: a.kind, mode: a.mode, recoveryId: r.text(a.recoveryId, '/params/action/recoveryId', 1, 100) };
      } else if (a.mode === 'open' || a.mode === 'new' || a.mode === 'import') {
        r.object(p.action, '/params/action', ['kind', 'mode']);
        action = { kind: a.kind, mode: a.mode };
      } else return toolFailure('TOOL_METHOD_INVALID', '未知工程切换方式。');
    } else if (a.kind === 'save') {
      r.object(p.action, '/params/action', ['kind', 'mode']);
      if (a.mode !== 'current' && a.mode !== 'as') return toolFailure('TOOL_METHOD_INVALID', '未知保存方式。');
      action = { kind: a.kind, mode: a.mode };
    } else if (a.kind === 'curve') {
      r.object(p.action, '/params/action', ['kind', 'curveId', 'format', 'segment', 'destination']);
      if (
        !['csv', 'svg', 'pdf'].includes(String(a.format)) ||
        (a.destination !== 'project' && a.destination !== 'external')
      )
        return toolFailure('TOOL_METHOD_INVALID', '未知曲线格式或目标。');
      if (a.format !== 'csv' && a.format !== 'svg' && a.format !== 'pdf')
        return toolFailure('TOOL_METHOD_INVALID', '未知曲线格式。');
      const segment = r.number(a.segment, '/params/action/segment', 0, networkRecordMaximum);
      if (!Number.isSafeInteger(segment) || (a.format !== 'csv' && segment !== 0))
        r.fail('CURVE_SEGMENT_INVALID', '/params/action/segment', '曲线分段无效。');
      action = {
        kind: a.kind,
        curveId: r.id(a.curveId, '/params/action/curveId'),
        format: a.format,
        segment,
        destination: a.destination,
      };
    } else if (a.kind === 'catalog') {
      r.object(p.action, '/params/action', ['kind', 'calculationId', 'format', 'destination']);
      if ((a.format !== 'docx' && a.format !== 'md') || (a.destination !== 'project' && a.destination !== 'external'))
        return toolFailure('TOOL_METHOD_INVALID', '未知选型任务书格式或目标类别。');
      action = {
        kind: a.kind,
        calculationId: r.id(a.calculationId, '/params/action/calculationId'),
        format: a.format,
        destination: a.destination,
      };
    } else if (a.kind === 'drawing') {
      r.object(p.action, '/params/action', ['kind', 'format', 'destination']);
      if ((a.format !== 'svg' && a.format !== 'pdf') || (a.destination !== 'project' && a.destination !== 'external'))
        return toolFailure('TOOL_METHOD_INVALID', '未知原理图格式或目标类别。');
      action = { kind: a.kind, format: a.format, destination: a.destination };
    } else if (a.kind === 'book') {
      r.object(p.action, '/params/action', ['kind', 'format', 'destination', 'calculationId', 'recordSelection']);
      if ((a.format !== 'docx' && a.format !== 'pdf') || (a.destination !== 'project' && a.destination !== 'external'))
        return toolFailure('TOOL_METHOD_INVALID', '未知计算书格式或目标类别。');
      const selection = r.object(a.recordSelection, '/params/action/recordSelection', ['kind', 'index']);
      let recordSelection: NetworkToolBookSelection;
      if (selection.kind === 'candidate') {
        const index = r.number(selection.index, '/params/action/recordSelection/index', 0, 100);
        if (!Number.isSafeInteger(index))
          r.fail('PROTOCOL_INVALID', '/params/action/recordSelection/index', '方案索引必须为整数。');
        recordSelection = { kind: selection.kind, index };
      } else if (selection.kind === 'primary' || selection.kind === 'current') {
        r.object(a.recordSelection, '/params/action/recordSelection', ['kind']);
        recordSelection = { kind: selection.kind };
      } else return toolFailure('TOOL_METHOD_INVALID', '未知计算记录来源。');
      action = {
        kind: a.kind,
        format: a.format,
        destination: a.destination,
        calculationId: r.id(a.calculationId, '/params/action/calculationId'),
        recordSelection,
      };
    } else return toolFailure('TOOL_METHOD_INVALID', '未知文件操作。');
    return r.finish({
      ...header,
      method: o.method,
      params: { base: readToolBase(r, p.base), operationKey: r.id(p.operationKey, '/params/operationKey'), action },
    });
  }
  if (o.method === 'calculate') {
    const p = r.object(o.params, '/params', ['base', 'operation', 'input']);
    const operation = parseNetworkToolCalculationOperation(p.operation);
    if (!operation.ok) return operation;
    if (!p.input || typeof p.input !== 'object' || Array.isArray(p.input))
      r.fail('PROTOCOL_INVALID', '/params/input', '计算输入必须是对象。');
    return r.finish({
      ...header,
      method: 'calculate',
      params: { base: readToolBase(r, p.base), operation: operation.value, input: p.input },
    });
  }
  if (o.method === 'simulate') {
    const p = r.object(o.params, '/params', ['base', 'action']);
    const field = '/params/action';
    const a = r.object(p.action, field, [
      'kind',
      'componentId',
      'positionId',
      'areaM2',
      'targetM3PerS',
      'ticks',
      'source',
      'value',
    ]);
    const kind = simulationActions.find((value) => value === a.kind);
    let action: NetworkToolSimulationAction;
    if (a.kind === 'run-for') {
      r.object(p.action, field, ['kind', 'ticks']);
      const ticks = r.number(a.ticks, field + '/ticks', 1, 10000);
      if (!Number.isSafeInteger(ticks)) r.fail('CLOCK_INVALID', field + '/ticks', '有限运行步数必须为整数。');
      action = { kind: 'run-for', ticks };
    } else if (kind) {
      r.object(p.action, field, ['kind']);
      action = { kind };
    } else {
      const componentId = r.id(a.componentId, field + '/componentId');
      if (a.kind === 'position') {
        r.object(p.action, field, ['kind', 'componentId', 'positionId']);
        action = { kind: a.kind, componentId, positionId: readPosition(r, a.positionId, field + '/positionId') };
      } else if (a.kind === 'opening-area') {
        r.object(p.action, field, ['kind', 'componentId', 'areaM2']);
        action = { kind: a.kind, componentId, areaM2: r.number(a.areaM2, field + '/areaM2', 0, Number.MAX_VALUE) };
      } else if (a.kind === 'displacement') {
        r.object(p.action, field, ['kind', 'componentId', 'source', 'value']);
        r.constant(a.source, 'manual', field + '/source');
        action = {
          kind: a.kind,
          componentId,
          source: 'manual',
          value: r.number(a.value, field + '/value', -Number.MAX_VALUE, Number.MAX_VALUE),
        };
      } else if (a.kind === 'target-flow') {
        r.object(p.action, field, ['kind', 'componentId', 'targetM3PerS']);
        action = {
          kind: a.kind,
          componentId,
          targetM3PerS: r.number(a.targetM3PerS, field + '/targetM3PerS', -10, 10),
        };
      } else return toolFailure('TOOL_METHOD_INVALID', '未知仿真操作。');
    }
    return r.finish({ ...header, method: o.method, params: { base: readToolBase(r, p.base), action } });
  }
  if (o.method === 'read') {
    const p = r.object(o.params, '/params', ['captureId', 'collection', 'offset', 'limit', 'simulationSessionId']),
      collection = networkToolCollections.find((c) => c === p.collection);
    if (!collection) return toolFailure('TOOL_METHOD_INVALID', '未知读取集合。');
    const maxOffset = collection === 'samples' ? networkRecordMaximum : legacyNetworkRecordCapacity;
    const offset = r.number(p.offset, '/params/offset', 0, maxOffset),
      limit = r.number(p.limit, '/params/limit', 1, 20);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit))
      r.fail('RECORD_RANGE_INVALID', '/params', '分页参数须为整数。');
    return r.finish({
      ...header,
      method: 'read',
      params: {
        captureId: r.id(p.captureId, '/params/captureId'),
        collection,
        offset,
        limit,
        simulationSessionId:
          p.simulationSessionId === null ? null : r.id(p.simulationSessionId, '/params/simulationSessionId'),
      },
    });
  }
  if (o.method === 'preview') {
    const p = r.object(o.params, '/params', ['base', 'operation', 'commands']);
    const operation = p.operation;
    if (operation !== 'edit' && operation !== 'undo' && operation !== 'redo')
      return toolFailure('TOOL_METHOD_INVALID', '未知编辑/历史操作。');
    const commands = r.array(p.commands, '/params/commands', 30);
    if (operation !== 'edit' && commands.length)
      r.fail('TOOL_COMMAND_INVALID', '/params/commands', '撤销/重做不接受附带编辑。');
    return r.finish({ ...header, method: 'preview', params: { base: readToolBase(r, p.base), operation, commands } });
  }
  if (o.method === 'proposal' || o.method === 'cancel' || o.method === 'apply') {
    const p = r.object(o.params, '/params', ['proposalId']);
    return r.finish({ ...header, method: o.method, params: { proposalId: r.id(p.proposalId, '/params/proposalId') } });
  }
  return toolFailure('TOOL_METHOD_INVALID', '未知工具；未提供任意文件、脚本或外部供应方调用。');
}
