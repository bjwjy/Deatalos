import { checkJson, ContractReader } from './reader.js';
import { componentPorts, definitionIds, isComponentType, specs, type ValvePositionId } from './registry.js';
import { toSI } from './units.js';
import {
  limits,
  type ActuatorInitial,
  type Component,
  type Connection,
  type Endpoint,
  type InitialConditions,
  type Parameters,
  type ProjectDocument,
  type Result,
} from './model.js';

export function readParameters(
  reader: ContractReader,
  input: unknown,
  group: string,
  field: string,
  representation: 'legacy' | 'si',
): Parameters {
  const list = specs(group);
  const source = reader.object(
    input,
    field,
    list.map((spec) => (representation === 'legacy' ? spec.legacyKey : spec.key)),
  );
  const values: Record<string, number> = {};
  for (const spec of list) {
    const key = representation === 'legacy' ? spec.legacyKey : spec.key;
    const min = representation === 'legacy' ? spec.minimum : toSI(spec.quantity, spec.minimum);
    const max = representation === 'legacy' ? spec.maximum : toSI(spec.quantity, spec.maximum);
    const value = reader.number(source[key], `${field}/${key}`, min, max);
    values[spec.key] = representation === 'legacy' ? toSI(spec.quantity, value) : value;
  }
  if (group === 'cylinder' && (values.rodM ?? 0) >= (values.boreM ?? 0)) {
    reader.fail('PARAMETER_INVALID', field, '杆径必须小于缸径。');
  }
  if (group === 'pump' && (values.totalEfficiency ?? 0) > (values.volumetricEfficiency ?? 0)) {
    reader.fail('PARAMETER_INVALID', field, '总效率不能大于容积效率。');
  }
  return values;
}

function readComponent(reader: ContractReader, input: unknown, field: string): Component {
  const object = reader.object(input, field, ['id', 'typeId', 'definitionId', 'definitionVersion', 'label', 'params']);
  const type = isComponentType(object.typeId) ? object.typeId : 'tank';
  if (!isComponentType(object.typeId)) reader.fail('MODEL_UNSUPPORTED', `${field}/typeId`, '元件类型不受支持。');
  const definitionId = reader.text(object.definitionId, `${field}/definitionId`, 1, 100);
  if (!definitionIds(type).includes(definitionId))
    reader.fail('MODEL_UNSUPPORTED', `${field}/definitionId`, '未识别的物理定义不能参与计算。');
  reader.constant(object.definitionVersion, 1, `${field}/definitionVersion`, 'MODEL_UNSUPPORTED');
  return {
    id: reader.id(object.id, `${field}/id`),
    typeId: type,
    definitionId,
    definitionVersion: 1,
    label: reader.text(object.label, `${field}/label`, 0, 60),
    params: readParameters(reader, object.params, type, `${field}/params`, 'si'),
  };
}
function endpoint(reader: ContractReader, input: unknown, field: string, components: readonly Component[]): Endpoint {
  const object = reader.object(input, field, ['componentId', 'portId']);
  const componentId = reader.id(object.componentId, `${field}/componentId`);
  const portId = reader.text(object.portId, `${field}/portId`, 1, 8);
  const component = components.find((item) => item.id === componentId);
  if (!component || !componentPorts[component.typeId].includes(portId))
    reader.fail('ENDPOINT_INVALID', field, '端点元件或油口不存在。');
  return { componentId, portId };
}
function initialConditions(
  reader: ContractReader,
  input: unknown,
  components: readonly Component[],
): InitialConditions {
  const field = '/design/initialConditions';
  const object = reader.object(input, field, ['actuators', 'valves']);
  const actuators: ActuatorInitial[] = reader
    .array(object.actuators, `${field}/actuators`, limits.components)
    .map((item, i) => {
      const location = `${field}/actuators/${i}`;
      const raw = reader.object(item, location, ['componentId', 'kind', 'positionM', 'angleRad']);
      const componentId = reader.id(raw.componentId, `${location}/componentId`);
      const component = components.find((c) => c.id === componentId);
      if (raw.kind === 'cylinder') {
        if (component?.typeId !== 'cylinder')
          reader.fail('INITIAL_CONDITION_INVALID', location, '初始位移必须引用油缸。');
        if ('angleRad' in raw) reader.fail('UNKNOWN_FIELD', `${location}/angleRad`, '油缸初始条件不含马达角度。');
        return {
          componentId,
          kind: 'cylinder',
          positionM: reader.number(raw.positionM, `${location}/positionM`, 0, component?.params.strokeM ?? 0),
        };
      }
      if (raw.kind !== 'motor' || component?.typeId !== 'motor')
        reader.fail('INITIAL_CONDITION_INVALID', location, '初始转角必须引用马达。');
      if ('positionM' in raw) reader.fail('UNKNOWN_FIELD', `${location}/positionM`, '马达初始条件不含油缸位移。');
      return { componentId, kind: 'motor', angleRad: reader.number(raw.angleRad, `${location}/angleRad`, -1e9, 1e9) };
    });
  const valves = reader.array(object.valves, `${field}/valves`, limits.components).map((item, i) => {
    const location = `${field}/valves/${i}`;
    const raw = reader.object(item, location, ['componentId', 'positionId']);
    const componentId = reader.id(raw.componentId, `${location}/componentId`);
    if (components.find((c) => c.id === componentId)?.typeId !== 'valve')
      reader.fail('INITIAL_CONDITION_INVALID', location, '控制必须引用换向阀。');
    let positionId: ValvePositionId = 'neutral';
    if (raw.positionId === 'extend' || raw.positionId === 'neutral' || raw.positionId === 'retract')
      positionId = raw.positionId;
    else reader.fail('INITIAL_CONDITION_INVALID', `${location}/positionId`, '未知阀位。');
    return { componentId, positionId };
  });
  exactReferences(
    reader,
    actuators.map((item) => item.componentId),
    components.filter((c) => c.typeId === 'cylinder' || c.typeId === 'motor').map((c) => c.id),
    `${field}/actuators`,
  );
  exactReferences(
    reader,
    valves.map((item) => item.componentId),
    components.filter((c) => c.typeId === 'valve').map((c) => c.id),
    `${field}/valves`,
  );
  return { actuators, valves };
}
function exactReferences(
  reader: ContractReader,
  actual: readonly string[],
  expected: readonly string[],
  field: string,
): void {
  reader.unique(actual, field);
  if (actual.length !== expected.length || actual.some((id) => !expected.includes(id)))
    reader.fail('REFERENCE_INVALID', field, '引用集合须与对应的元件或连接一一匹配。');
}

export function parseDocument(input: unknown): Result<ProjectDocument> {
  const budget = checkJson(input);
  if (!budget.ok) return budget;
  const reader = new ContractReader();
  const raw = reader.object(input, '', [
    'format',
    'version',
    'projectId',
    'title',
    'description',
    'note',
    'createdAt',
    'updatedAt',
    'design',
    'layout',
    'provenance',
    'extensions',
  ]);
  reader.constant(raw.format, 'HydraulicWorkbench', '/format');
  reader.constant(raw.version, 2, '/version', 'VERSION_UNSUPPORTED');
  const design = reader.object(raw.design, '/design', [
    'fluid',
    'components',
    'connections',
    'initialConditions',
    'embeddedDefinitions',
  ]);
  const components = reader
    .array(design.components, '/design/components', limits.components)
    .map((item, i) => readComponent(reader, item, `/design/components/${i}`));
  reader.unique(
    components.map((c) => c.id),
    '/design/components',
  );
  const connections: Connection[] = reader
    .array(design.connections, '/design/connections', limits.connections)
    .map((item, i) => {
      const field = `/design/connections/${i}`;
      const raw = reader.object(item, field, ['id', 'from', 'to', 'params']);
      return {
        id: reader.id(raw.id, `${field}/id`),
        from: endpoint(reader, raw.from, `${field}/from`, components),
        to: endpoint(reader, raw.to, `${field}/to`, components),
        params: readParameters(reader, raw.params, 'pipe', `${field}/params`, 'si'),
      };
    });
  reader.unique(
    connections.map((c) => c.id),
    '/design/connections',
  );
  const pairs = new Set<string>();
  for (const [i, connection] of connections.entries()) {
    const from = `${connection.from.componentId}:${connection.from.portId}`;
    const to = `${connection.to.componentId}:${connection.to.portId}`;
    const pair = [from, to].sort().join('|');
    if (from === to || pairs.has(pair))
      reader.fail('ENDPOINT_INVALID', `/design/connections/${i}`, '不能连接同一油口或重复连接同一对端点。');
    pairs.add(pair);
  }
  if (!Array.isArray(design.embeddedDefinitions) || design.embeddedDefinitions.length !== 0) {
    reader.fail(
      'MODEL_UNSUPPORTED',
      '/design/embeddedDefinitions',
      'F02 只支持注册的内置物理定义；自定义定义不能静默忽略。',
    );
  }
  const layout = reader.object(raw.layout, '/layout', ['components', 'routes']);
  const positions = reader.array(layout.components, '/layout/components', limits.components).map((item, i) => {
    const field = `/layout/components/${i}`;
    const position = reader.object(item, field, ['componentId', 'x', 'y']);
    return {
      componentId: reader.id(position.componentId, `${field}/componentId`),
      x: reader.number(position.x, `${field}/x`, -limits.canvasCoordinate, limits.canvasCoordinate),
      y: reader.number(position.y, `${field}/y`, -limits.canvasCoordinate, limits.canvasCoordinate),
    };
  });
  const routes = reader.array(layout.routes, '/layout/routes', limits.connections).map((item, i) => {
    const field = `/layout/routes/${i}`;
    const route = reader.object(item, field, ['connectionId', 'mode']);
    reader.constant(route.mode, 'auto', `${field}/mode`, 'LAYOUT_UNSUPPORTED');
    return { connectionId: reader.id(route.connectionId, `${field}/connectionId`), mode: 'auto' as const };
  });
  exactReferences(
    reader,
    positions.map((p) => p.componentId),
    components.map((c) => c.id),
    '/layout/components',
  );
  exactReferences(
    reader,
    routes.map((p) => p.connectionId),
    connections.map((c) => c.id),
    '/layout/routes',
  );
  const provenance = reader.object(raw.provenance, '/provenance', [
    'createdWithAppVersion',
    'preferredSolverId',
    'modelVersion',
  ]);
  reader.constant(provenance.preferredSolverId, 'legacy-basic', '/provenance/preferredSolverId', 'MODEL_UNSUPPORTED');
  reader.constant(provenance.modelVersion, '1.0.0-experimental', '/provenance/modelVersion', 'MODEL_UNSUPPORTED');
  const document: ProjectDocument = {
    format: 'HydraulicWorkbench',
    version: 2,
    projectId: reader.id(raw.projectId, '/projectId'),
    title: reader.text(raw.title, '/title', 1, 100),
    description: reader.text(raw.description, '/description', 0, limits.note),
    ...(raw.note === undefined ? {} : { note: reader.text(raw.note, '/note', 0, limits.note) }),
    createdAt: reader.timestamp(raw.createdAt, '/createdAt'),
    updatedAt: reader.timestamp(raw.updatedAt, '/updatedAt'),
    design: {
      fluid: readParameters(reader, design.fluid, 'fluid', '/design/fluid', 'si'),
      components,
      connections,
      initialConditions: initialConditions(reader, design.initialConditions, components),
      embeddedDefinitions: [],
    },
    layout: { components: positions, routes },
    provenance: {
      createdWithAppVersion: reader.text(provenance.createdWithAppVersion, '/provenance/createdWithAppVersion', 1, 100),
      preferredSolverId: 'legacy-basic',
      modelVersion: '1.0.0-experimental',
    },
    extensions: reader.extensions(raw.extensions, '/extensions'),
  };
  return reader.finish(document);
}
