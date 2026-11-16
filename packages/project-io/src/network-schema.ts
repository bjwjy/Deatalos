import {
  networkDefinitions,
  physicalPipeModel,
  physicalPipeParameters,
  metadataNamespacePattern,
  identifierPattern,
  motorCurvePointLimit,
  motorCurvePressureGapPa,
  motorCurvePressureMaxPa,
  motorCurveReachMax,
  motorCurveReachMin,
  motorCurveSlopeLimit,
  type SIParameter,
} from '@hyd/domain';
type Schema = Readonly<Record<string, unknown>>;
const text = (minimum = 0, maximum = 100): Schema => ({
  type: 'string',
  minLength: minimum,
  maxLength: maximum,
});
const id: Schema = {
  type: 'string',
  pattern: identifierPattern,
  not: {
    enum: ['constructor', 'prototype', '__proto__'],
  },
};
const literal = (value: string | number): Schema => ({
  const: value,
});
const number = (minimum: number, maximum: number): Schema => ({
  type: 'number',
  minimum,
  maximum,
});
const nullable = (minimum: number, maximum: number): Schema => ({
  type: ['number', 'null'],
  minimum,
  maximum,
});
const object = (properties: Readonly<Record<string, Schema>>, optional: readonly string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false,
});
const array = (items: Schema, maxItems: number): Schema => ({
  type: 'array',
  items,
  maxItems,
});
const params = (list: readonly SIParameter[]) =>
  object(Object.fromEntries(list.map((p) => [p.key, number(p.minimum, p.maximum)])));
const model = (m: { readonly id: string; readonly version: string }) =>
  object({
    id: literal(m.id),
    version: literal(m.version),
  });
const position: Schema = {
  enum: ['extend', 'neutral', 'retract'],
};
const motorDisplacementCurve = object({
  version: literal(1),
  enabled: { type: 'boolean' },
  pressureLimitPa: number(motorCurvePressureGapPa, motorCurvePressureMaxPa),
  points: {
    ...array(
      object(
        {
          pressurePa: number(0, motorCurvePressureMaxPa),
          displacementM3PerRev: number(1e-9, 0.01),
          tangent: object({
            slopeM3PerRevPa: number(-motorCurveSlopeLimit, motorCurveSlopeLimit),
            leftReach: number(motorCurveReachMin, motorCurveReachMax),
            rightReach: number(motorCurveReachMin, motorCurveReachMax),
          }),
        },
        ['tangent'],
      ),
      motorCurvePointLimit,
    ),
    minItems: 2,
  },
});
const controlPressureRange = { lowPa: number(-1e8, 70e6), highPa: number(-1e8, 70e6) };
const pressureSwitchOutput = object({ mode: { enum: ['switch', 'analog'] }, ...controlPressureRange });
const externalMotorControl = {
  oneOf: [
    object({ kind: literal('pressure'), ...controlPressureRange }),
    object({ kind: literal('voltage') }),
    object({ kind: literal('voltage'), ...controlPressureRange }),
  ],
};
const valveEnd = object({
  springReturn: { type: 'boolean' },
  pilotStage: { type: 'boolean' },
  manual: { enum: ['none', 'button', 'lever', 'pedal'] },
  mechanical: { enum: ['none', 'plunger', 'roller'] },
  fluid: { enum: ['none', 'hydraulic', 'solenoid'] },
});
const valveActuation = object({ version: literal(1), left: valveEnd, right: valveEnd });
const sequenceLeafCondition: Schema = {
  oneOf: [
    object({
      kind: literal('pressure-switch'),
      componentId: id,
      contact: { enum: ['open', 'closed'] },
      holdS: number(0.01, 10),
    }),
    object({
      kind: literal('flow'),
      componentId: id,
      portId: text(1, 16),
      comparison: { enum: ['gte', 'lte'] },
      thresholdM3PerS: number(-10, 10),
      holdS: number(0.01, 10),
    }),
    object({
      kind: literal('probe-pressure'),
      probeId: id,
      comparison: { enum: ['gte', 'lte'] },
      thresholdPa: number(-1e8, 1e9),
      holdS: number(0.01, 10),
    }),
    object({ kind: literal('time'), durationS: number(0.01, 3600) }),
    object({
      kind: literal('position'),
      componentId: id,
      comparison: { enum: ['gte', 'lte'] },
      thresholdM: number(0, 100),
      holdS: number(0.01, 10),
    }),
    object({
      kind: literal('pressure'),
      componentId: id,
      portId: text(1, 16),
      comparison: { enum: ['gte', 'lte'] },
      thresholdPa: number(-1e8, 1e9),
      holdS: number(0.01, 10),
    }),
  ],
};
const sequenceCondition: Schema = {
  oneOf: [
    sequenceLeafCondition,
    object({ kind: { enum: ['all', 'any'] }, conditions: { ...array(sequenceLeafCondition, 8), minItems: 1 } }),
  ],
};
const sequence = object({
  version: literal(1),
  cycles: { type: 'integer', minimum: 1, maximum: 100 },
  steps: {
    ...array(
      object({
        id,
        name: text(1, 80),
        commands: array(
          {
            oneOf: [
              object({ kind: literal('position'), componentId: id, positionId: position }),
              object({
                kind: literal('displacement'),
                componentId: id,
                source: literal('controller'),
                value: number(0, 1),
              }),
            ],
          },
          30,
        ),
        until: sequenceCondition,
        timeoutS: number(0.01, 3600),
      }),
      50,
    ),
    minItems: 1,
  },
});
export function networkProjectSchema(): Schema {
  const endpoint: Schema = {
    oneOf: [
      object({
        kind: literal('port'),
        componentId: id,
        portId: text(1, 16),
      }),
      object({
        kind: literal('node'),
        nodeId: id,
      }),
    ],
  };
  const connection = {
    id,
    from: endpoint,
    to: endpoint,
  };
  const initial = (kind: string, fields: Readonly<Record<string, Schema>>) =>
    object({
      componentId: id,
      kind: literal(kind),
      ...fields,
    });
  const coordinates = {
    x: number(-1e6, 1e6),
    y: number(-1e6, 1e6),
  };
  const schema = object(
    {
      format: literal('HydraulicWorkbench'),
      version: literal(3),
      projectId: id,
      title: text(1, 100),
      description: text(0, 16384),
      note: text(0, 16384),
      createdAt: {
        type: 'string',
        pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$',
      },
      updatedAt: {
        type: 'string',
        pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$',
      },
      design: object({
        fluid: object({
          densityKgPerM3: number(400, 2000),
          kinematicViscosityM2PerS: number(1e-6, 0.002),
          bulkModulusPa: nullable(1e5, 1e11),
        }),
        pressureReference: object({
          kind: {
            enum: ['gauge', 'kernel-numeric'],
          },
          absoluteReferencePa: nullable(1, 1e9),
        }),
        components: array(
          {
            oneOf: networkDefinitions.map((d) =>
              object(
                {
                  id,
                  typeId: literal(d.typeId),
                  definition: object({
                    id: literal(d.id),
                    version: literal(d.version),
                  }),
                  model: model(d.model),
                  label: text(0, 60),
                  parameters: object(Object.fromEntries(Object.entries(d.groups).map(([g, p]) => [g, params(p)]))),
                  parameterRules: array(
                    {
                      oneOf: [
                        object({ group: text(1, 100), key: text(1, 100), mode: literal('locked') }),
                        object({
                          group: text(1, 100),
                          key: text(1, 100),
                          mode: literal('variable'),
                          minimum: number(-Number.MAX_VALUE, Number.MAX_VALUE),
                          maximum: number(-Number.MAX_VALUE, Number.MAX_VALUE),
                        }),
                      ],
                    },
                    300,
                  ),
                  ...(d.typeId === 'valve' ? { valveActuation } : {}),
                  ...(d.id === 'teaching:variable-motor' ? { motorDisplacementCurve, externalMotorControl } : {}),
                  ...(d.typeId === 'adjustable-pressure-switch' ? { pressureSwitchOutput } : {}),
                  ...(d.role === 'controller'
                    ? { controller: sequence, controllerColor: { type: 'integer', minimum: 1, maximum: 30 } }
                    : {}),
                },
                [
                  'valveActuation',
                  'parameterRules',
                  'controller',
                  'controllerColor',
                  'motorDisplacementCurve',
                  'externalMotorControl',
                  'pressureSwitchOutput',
                ],
              ),
            ),
          },
          30,
        ),
        nodes: array(
          object({
            id,
            kind: literal('ideal-hydraulic'),
            label: text(0, 60),
          }),
          60,
        ),
        connections: array(
          {
            oneOf: [
              object({ ...connection, kind: literal('signal') }),
              object({
                ...connection,
                kind: literal('ideal'),
              }),
              object({
                ...connection,
                kind: literal('pipe'),
                model: model(physicalPipeModel),
                parameters: params(physicalPipeParameters),
              }),
            ],
          },
          60,
        ),
        initialConditions: array(
          {
            oneOf: [
              initial('valve', {
                positionId: position,
              }),
              initial('cylinder', {
                positionM: number(0, 100),
                velocityMPerS: nullable(-1e4, 1e4),
                capPressurePa: nullable(0, 1e9),
                rodPressurePa: nullable(0, 1e9),
              }),
              initial('motor', {
                angleRad: number(-1e9, 1e9),
                angularSpeedRadPerS: nullable(-1e6, 1e6),
              }),
              initial('accumulator', { oilVolumeM3: number(0, 1) }),
              initial('volume', {
                pressurePa: nullable(0, 1e9),
              }),
              initial('throttle', {
                openingAreaM2: number(0, 1),
              }),
            ],
          },
          30,
        ),
      }),
      layout: object(
        {
          probes: array(
            object(
              {
                probeId: id,
                ...coordinates,
                signalPoints: { ...array(object(coordinates), 64), minItems: 1 },
              },
              ['signalPoints'],
            ),
            60,
          ),
          texts: array(
            object({
              id,
              kind: literal('text'),
              version: literal(1),
              ...coordinates,
              width: number(60, 3000),
              text: text(1, 4000),
              fontSize: number(8, 72),
              color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              align: { enum: ['left', 'center', 'right'] },
              border: { type: 'boolean' },
              background: { enum: [null, '#ffffff'] },
            }),
            60,
          ),
          components: array(
            object(
              {
                componentId: id,
                ...coordinates,
                rotation: { enum: [0, 90, 180, 270] },
                mirrored: { const: true },
                scale: { type: 'number', minimum: 0.5, maximum: 1.5 },
              },
              ['rotation', 'scale', 'mirrored'],
            ),
            30,
          ),
          nodes: array(
            object({
              nodeId: id,
              ...coordinates,
            }),
            60,
          ),
          routes: array(
            {
              oneOf: [
                object({ connectionId: id, mode: literal('auto') }),
                object({ connectionId: id, mode: literal('avoid') }),
                object({
                  connectionId: id,
                  mode: literal('manual'),
                  points: { ...array(object(coordinates), 64), minItems: 1 },
                }),
              ],
            },
            60,
          ),
          viewport: object({ centerX: number(-1e6, 1e6), centerY: number(-1e6, 1e6), zoom: number(0.0001, 8) }),
        },
        ['viewport', 'probes', 'texts'],
      ),
      provenance: object({
        createdWithAppVersion: text(1, 100),
        preferredSolverId: {
          enum: ['legacy-basic', 'hopsan'],
        },
      }),
      extensions: {
        type: 'object',
        patternProperties: {
          [metadataNamespacePattern]: {},
        },
        additionalProperties: false,
      },
      controlProbes: array(
        {
          ...object(
            {
              id,
              controllerId: { oneOf: [id, { type: 'null' }] },
              number: { type: 'integer', minimum: 1, maximum: 999999 },
              name: text(0, 60),
              nodeId: { oneOf: [id, { type: 'null' }] },
              port: object({ kind: literal('port'), componentId: id, portId: id }),
            },
            ['port'],
          ),
          dependencies: { port: { properties: { nodeId: { type: 'null' } } } },
        },
        60,
      ),
    },
    ['note', 'controlProbes'],
  );
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...schema,
    'x-semantic-validation': [
      'unique instance/node/connection IDs',
      'reference existence and completeness',
      'port/type/model versions',
      'parameter correlations',
      'initial value within component stroke/area',
      'valid UTC date',
      'resource budgets and no runtime fields',
    ],
    'x-capability':
      'Data structure only. Runtime compiler must verify model versions, actual graph, explicit storage and supported physical domain; no UI or solver certification.',
  };
}
