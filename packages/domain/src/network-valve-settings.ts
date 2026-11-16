import { ContractReader, diagnostic, checkJson } from './reader.js';
import { networkDefinition, networkDefaultParameters } from './network-registry.js';
import {
  directionalFunctions,
  directionalFunctionOptions,
  directionalValveCatalog,
  directionalValveSpec,
  networkValvePaths,
  networkValvePositions,
} from './network-valve.js';
import { parseNetworkProject } from './network-project.js';
import type { NetworkComponent, NetworkProject } from './network-model.js';
import type { Result } from './model.js';
import type { ValvePositionId } from './registry.js';
import {
  defaultValveActuation,
  readValveActuation,
  directionalValveAutoName,
  uniqueValveName,
  type ValveActuation,
} from './network-valve-actuation.js';
export interface DirectionalValveSettings {
  readonly positionCount: number;
  readonly portCount: number;
  readonly label: string;
  readonly initialPosition: ValvePositionId;
  readonly functions: Readonly<Record<string, number>>;
  readonly maximumAreaM2: number;
  readonly flowCoefficient: number;
  readonly valveActuation: ValveActuation;
}
/** Recognizes only this app's generated suffix; hand-written names are never guessed or trimmed. */
export function directionalValveBaseName(component: NetworkComponent, label = component.label): string {
  const spec = directionalValveSpec(component.definition.id);
  if (!spec) return label;
  const base = directionalValveAutoName(
    spec.slots.length,
    spec.ports.length,
    component.valveActuation ?? defaultValveActuation,
  );
  return label === base || (label.startsWith(base) && /^\d+$/.test(label.slice(base.length))) ? base : label;
}
/** Opening geometry is projected only for an explicit settings preview/upgrade. */
export function directionalValveSettings(
  component: NetworkComponent,
  initialPosition: ValvePositionId,
): DirectionalValveSettings | undefined {
  if (component.typeId !== 'valve' || !component.definition.id.startsWith('teaching:')) return undefined;
  const spec = directionalValveSpec(component.definition.id);
  const d = component.parameters.spool?.diameterM,
    travel = component.parameters.spool?.commandTravelM,
    overlap = component.parameters.spool?.overlapM;
  const area =
    component.parameters.hydraulic?.maximumAreaM2 ??
    (d !== undefined && travel !== undefined && overlap !== undefined ? Math.PI * d * (travel - overlap) : undefined);
  const coefficient = component.parameters.hydraulic?.flowCoefficient;
  if (area === undefined || coefficient === undefined) return undefined;
  const key = (paths: readonly (readonly [string, string])[]) =>
    paths
      .map((p) => [...p].sort().join('-'))
      .sort()
      .join(',');
  return {
    positionCount: spec?.slots.length ?? 3,
    portCount: spec?.ports.length ?? 4,
    label: component.label,
    initialPosition,
    functions: Object.fromEntries(
      networkValvePositions(component).map((slot) => [
        slot,
        spec
          ? (component.parameters.positions?.[slot + 'Function'] ?? NaN)
          : (directionalFunctions.find((fn) => key(fn.paths) === key(networkValvePaths(component, slot)))?.code ?? NaN),
      ]),
    ),
    maximumAreaM2: area,
    flowCoefficient: coefficient,
    valveActuation: component.valveActuation ?? defaultValveActuation,
  };
}
/** Reducing ports never deletes connected wires. Unchanged old O/M models remain exact. */
export function configureDirectionalValve(
  project: NetworkProject,
  componentId: string,
  input: unknown,
): Result<NetworkProject> {
  const bounded = checkJson(input);
  if (!bounded.ok) return bounded;
  const r = new ContractReader(),
    o = r.object(input, '/valveSettings', [
      'positionCount',
      'portCount',
      'label',
      'initialPosition',
      'functions',
      'maximumAreaM2',
      'flowCoefficient',
      'valveActuation',
      'autoName',
    ]);
  const positions = r.number(o.positionCount, '/valveSettings/positionCount', 2, 3),
    ports = r.number(o.portCount, '/valveSettings/portCount', 2, 5);
  const spec = directionalValveCatalog.find((s) => s.id === `teaching:directional-${positions}-${ports}`);
  const component = project.design.components.find((c) => c.id === componentId);
  const valveActuation =
    o.valveActuation === undefined
      ? (component?.valveActuation ?? defaultValveActuation)
      : readValveActuation(r, o.valveActuation, '/valveSettings/valveActuation');
  if (!spec || component?.typeId !== 'valve')
    return {
      ok: false,
      diagnostics: [
        diagnostic('VALVE_FUNCTION_UNSUPPORTED', '/valveSettings', '请选择受支持的二/三位、二至五通方向阀。'),
      ],
    };
  const functionsRaw = r.object(o.functions, '/valveSettings/functions', spec.slots);
  const functions = Object.fromEntries(
    spec.slots.map((slot) => [slot, r.number(functionsRaw[slot], '/valveSettings/functions/' + slot, 0, 21)]),
  );
  if (
    !Object.values(functions).every(
      (code) => Number.isInteger(code) && directionalFunctionOptions(ports).some((fn) => fn.code === code),
    )
  )
    r.fail(
      'VALVE_FUNCTION_UNSUPPORTED',
      '/valveSettings/functions',
      '机能与当前通数不兼容，请重新选择对应油口的机能。',
    );
  if (o.initialPosition !== 'extend' && o.initialPosition !== 'neutral' && o.initialPosition !== 'retract')
    r.fail('CONTROL_INVALID', '/valveSettings/initialPosition', '初始阀位无效。');
  const initialPosition =
    o.initialPosition === 'extend' || o.initialPosition === 'retract' ? o.initialPosition : 'neutral';
  if (!spec.slots.includes(initialPosition))
    r.fail('CONTROL_INVALID', '/valveSettings/initialPosition', '二位阀没有中位。');
  if (o.autoName !== undefined && typeof o.autoName !== 'boolean')
    r.fail('VALVE_NAME_INVALID', '/valveSettings/autoName', '自动命名开关无效。');
  const label = r.text(
      o.autoName === true
        ? uniqueValveName(
            directionalValveAutoName(positions, ports, valveActuation),
            project.design.components.filter((item) => item.id !== componentId).map((item) => item.label),
          )
        : o.label,
      '/valveSettings/label',
      0,
      60,
    ),
    area = r.number(o.maximumAreaM2, '/valveSettings/maximumAreaM2', 1e-10, 1e-3),
    coefficient = r.number(o.flowCoefficient, '/valveSettings/flowCoefficient', 0.01, 1);
  for (const edge of project.design.connections)
    for (const endpoint of [edge.from, edge.to])
      if (endpoint.kind === 'port' && endpoint.componentId === componentId && !spec.ports.includes(endpoint.portId))
        r.fail(
          'VALVE_PORT_CONNECTED',
          '/valveSettings/portCount',
          `${endpoint.portId}油口仍有接线，不能减少到当前通数；请先处理接线。`,
        );
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  const definition = networkDefinition(spec.id, 2),
    defaults = networkDefaultParameters(spec.id, 2);
  if (!definition || !defaults) throw new Error('Directional definition missing');
  const before = directionalValveSettings(component, initialPosition);
  const same =
    before &&
    before.positionCount === spec.slots.length &&
    before.portCount === spec.ports.length &&
    before.maximumAreaM2 === area &&
    before.flowCoefficient === coefficient &&
    JSON.stringify(before.functions) === JSON.stringify(functions);
  const configured = same
    ? { ...component, label }
    : {
        ...component,
        label,
        definition: { id: definition.id, version: definition.version },
        model: { id: definition.model.id, version: definition.model.version },
        parameters: {
          ...defaults,
          hydraulic: { ...defaults.hydraulic, maximumAreaM2: area, flowCoefficient: coefficient },
          spool: Object.fromEntries(
            Object.entries(defaults.spool ?? {}).map(([key, value]) => [
              key,
              component.parameters.spool?.[key] ?? value,
            ]),
          ),
          positions: Object.fromEntries(spec.slots.map((slot) => [slot + 'Function', functions[slot] ?? NaN])),
        },
      };
  const replacement =
    component.valveActuation || JSON.stringify(valveActuation) !== JSON.stringify(defaultValveActuation)
      ? { ...configured, valveActuation }
      : configured;
  return parseNetworkProject({
    ...project,
    design: {
      ...project.design,
      components: project.design.components.map((c) => (c.id === componentId ? replacement : c)),
      initialConditions: project.design.initialConditions.map((v) =>
        v.componentId === componentId && v.kind === 'valve' ? { ...v, positionId: initialPosition } : v,
      ),
    },
  });
}
