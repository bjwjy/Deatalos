import {
  componentTypes,
  definitionIds,
  identifierPattern,
  limits,
  metadataNamespacePattern,
  specs,
  toSI,
  unitScales,
} from '@hyd/domain';

const text = (maxLength: number, minLength = 0) => ({
  type: 'string',
  minLength,
  maxLength,
  ...(minLength ? { pattern: '\\S' } : {}),
});
const id = { ...text(40, 1), pattern: identifierPattern, not: { enum: ['__proto__', 'constructor', 'prototype'] } };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const constant = (value: string | number) => ({ const: value });
const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const parameters = (group: string) =>
  object(
    Object.fromEntries(
      specs(group).map((spec) => [
        spec.key,
        {
          ...number(toSI(spec.quantity, spec.minimum), toSI(spec.quantity, spec.maximum)),
          title: spec.label,
          'x-unit': unitScales[spec.quantity].si,
          'x-quantity': spec.quantity,
          'x-legacy-key': spec.legacyKey,
        },
      ]),
    ),
  );
const endpoint = object({ componentId: id, portId: { type: 'string', enum: ['P', 'T', 'S', 'A', 'B'] } });
const timestamp = { ...text(24, 24), pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };

// Generated from the same parameter source used by runtime construction.
// Cross-object references/physics constraints are additionally checked by parseDocument.
export function projectSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'urn:hydraulic-workbench:project:2',
    title: 'HydraulicWorkbench v2 (F02 supported subset)',
    ...object(
      {
        format: constant('HydraulicWorkbench'),
        version: constant(2),
        projectId: id,
        title: text(100, 1),
        description: text(limits.note),
        note: text(limits.note),
        createdAt: timestamp,
        updatedAt: timestamp,
        design: object({
          fluid: parameters('fluid'),
          components: array(
            {
              oneOf: componentTypes.map((type) =>
                object({
                  id,
                  typeId: constant(type),
                  definitionId: { enum: definitionIds(type) },
                  definitionVersion: constant(1),
                  label: text(60),
                  params: parameters(type),
                }),
              ),
            },
            limits.components,
          ),
          connections: array(
            object({ id, from: endpoint, to: endpoint, params: parameters('pipe') }),
            limits.connections,
          ),
          initialConditions: object({
            actuators: array(
              {
                oneOf: [
                  object({ componentId: id, kind: constant('cylinder'), positionM: number(0, 10) }),
                  object({ componentId: id, kind: constant('motor'), angleRad: number(-1e9, 1e9) }),
                ],
              },
              limits.components,
            ),
            valves: array(
              object({ componentId: id, positionId: { enum: ['extend', 'neutral', 'retract'] } }),
              limits.components,
            ),
          }),
          embeddedDefinitions: { type: 'array', maxItems: 0 },
        }),
        layout: object({
          components: array(
            object({
              componentId: id,
              x: number(-limits.canvasCoordinate, limits.canvasCoordinate),
              y: number(-limits.canvasCoordinate, limits.canvasCoordinate),
            }),
            limits.components,
          ),
          routes: array(object({ connectionId: id, mode: constant('auto') }), limits.connections),
        }),
        provenance: object({
          createdWithAppVersion: text(100, 1),
          preferredSolverId: constant('legacy-basic'),
          modelVersion: constant('1.0.0-experimental'),
        }),
        extensions: {
          type: 'object',
          propertyNames: { pattern: metadataNamespacePattern },
          additionalProperties: true,
        },
      },
      [
        'format',
        'version',
        'projectId',
        'title',
        'description',
        'createdAt',
        'updatedAt',
        'design',
        'layout',
        'provenance',
        'extensions',
      ],
    ),
    'x-semantic-validation': [
      'component/connection IDs unique within their namespaces',
      'endpoint ports belong to referenced components; undirected pairs unique; endpoints distinct',
      'layout and initial-condition references match design exactly',
      'rodM < boreM; totalEfficiency <= volumetricEfficiency',
      'cylinder initial position <= its stroke; UTC timestamps calendar-valid',
      'finite JSON; no reserved property names; depth <= 32; nodes <= 50000; file bytes <= 2000000',
    ],
  };
}
