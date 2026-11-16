import { networkDefaultParameters, networkDefinition, parseNetworkProject } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { independentCircuit, groupRequests } from './independent-supply-groups.mjs';

export function parallelCircuit({ legacy = false } = {}) {
  const project = structuredClone(independentCircuit(true));
  project.title = legacy ? '单泵双缸 · 缺分流开口' : '单泵双缸 · 实际分流';
  const remove = new Set(['pump-b', 'relief-b', 'supply-volume-b']);
  project.design.components = project.design.components.filter((c) => !remove.has(c.id));
  project.design.initialConditions = project.design.initialConditions.filter((i) => !remove.has(i.componentId));
  project.layout.components = project.layout.components.filter((i) => !remove.has(i.componentId));
  project.design.connections = project.design.connections.filter(
    (e) => ![e.from, e.to].some((port) => port.kind === 'port' && remove.has(port.componentId)),
  );
  project.design.connections.find((e) => e.id === 'supply-b').from.nodeId = 'supply';
  project.design.nodes = project.design.nodes.filter((n) => n.id !== 'supply-b');
  project.layout.nodes = project.layout.nodes.filter((n) => n.nodeId !== 'supply-b');
  project.layout.routes = project.layout.routes.filter((r) =>
    project.design.connections.some((e) => e.id === r.connectionId),
  );
  project.design.components.find((c) => c.id === 'pump').parameters.hydraulic.displacementM3PerRev = 4e-6;
  const def = networkDefinition('teaching:directional-3-4', 1);
  for (const [id, drop] of [
    ['valve', 1e6],
    ['valve-b', 0.44e6],
  ]) {
    if (legacy && id === 'valve-b') continue;
    const c = project.design.components.find((part) => part.id === id);
    const parameters = structuredClone(networkDefaultParameters(def.id, def.version));
    parameters.hydraulic.maximumAreaM2 =
      (0.00005 / parameters.hydraulic.flowCoefficient) *
      Math.sqrt((project.design.fluid.densityKgPerM3 * (1 + 0.6 ** 3)) / (2 * drop));
    Object.assign(c, {
      definition: { id: def.id, version: def.version },
      model: { id: def.model.id, version: def.model.version },
      parameters,
    });
  }
  return good(parseNetworkProject(project));
}

export function parallelRequest(rpm = 1500) {
  const [a, b] = groupRequests(true).map((group) => group.duty);
  a.angularSpeedRadPerS = (rpm * Math.PI) / 30;
  a.pressureLimitPa = 3e6;
  const phase = a.phases[0];
  phase.flowSplit = true;
  phase.valves.push(...b.phases[0].valves);
  phase.actions[0].supplyLossPa = 0;
  const second = b.phases[0].actions[0];
  Object.assign(second, { speed: 0.05, supplyLossPa: 0, returnPressurePa: 0.2e6 });
  phase.actions.push(second);
  return a;
}
