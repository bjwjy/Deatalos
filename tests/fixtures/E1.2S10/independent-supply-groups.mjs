import { networkDefaultParameters, networkDefinition, parseNetworkProject } from '@hyd/domain';
import { actuatorGraph, good } from '../E04B/graphs.mjs';
import { controlValveRequest } from './steady-control-valves.mjs';

const returnPressure = (index) => 1e5 + index * 1.5e5;
const suffixAt = (index) => (index === 0 ? '' : '-' + String.fromCharCode(97 + index));

export function independentCircuit(shared = false, count = 2) {
  const project = structuredClone(actuatorGraph());
  project.title = count === 2 ? (shared ? '两泵共用油箱独立供油' : '两泵两油箱独立供油') : count + ' 泵独立供油';
  const preparePump = (design, rpm, displacement) => {
    const pump = design.components.find((c) => c.id === 'pump');
    pump.parameters.drive.angularSpeedRadPerS = (rpm * Math.PI) / 30;
    pump.parameters.hydraulic.displacementM3PerRev = displacement;
  };
  preparePump(project.design, 1500, 3e-6);
  const positions = {
    pump: [130, 410],
    tank: [185, 520],
    relief: [400, 370],
    'supply-volume': [100, 260],
    valve: [275, 270],
    actuator: [280, 135],
  };
  for (const item of project.layout.components) [item.x, item.y] = positions[item.componentId];
  for (const c of project.design.components) c.label += shared && c.id === 'tank' ? '（共用）' : ' A';
  Object.assign(project.layout.nodes[0], { x: 240, y: 375 });
  for (let index = 1; index < count; index++) {
    const other = structuredClone(actuatorGraph());
    const suffix = (id) => (shared && id === 'tank' ? id : id + suffixAt(index));
    const endpoint = (e) =>
      e.kind === 'port' ? { ...e, componentId: suffix(e.componentId) } : { ...e, nodeId: suffix(e.nodeId) };
    preparePump(other.design, 1200, 4e-6);
    other.design.components.find((c) => c.id === 'tank').parameters.hydraulic.pressurePa = returnPressure(index);
    const offset = 475 * index;
    for (const item of other.layout.components) {
      if (shared && item.componentId === 'tank') continue;
      const [x, y] = positions[item.componentId];
      project.layout.components.push({ ...item, componentId: suffix(item.componentId), x: x + offset, y });
    }
    project.design.components.push(
      ...other.design.components
        .filter((c) => !shared || c.id !== 'tank')
        .map((c) => ({ ...c, label: c.label + ' ' + String.fromCharCode(65 + index), id: suffix(c.id) })),
    );
    project.design.initialConditions.push(
      ...other.design.initialConditions.map((i) => ({ ...i, componentId: suffix(i.componentId) })),
    );
    project.design.nodes.push(...other.design.nodes.map((n) => ({ ...n, id: suffix(n.id) })));
    project.layout.nodes.push({ nodeId: suffix('supply'), x: 240 + offset, y: 375 });
    project.design.connections.push(
      ...other.design.connections.map((e) => ({ ...e, id: suffix(e.id), from: endpoint(e.from), to: endpoint(e.to) })),
    );
    project.layout.routes.push(...other.layout.routes.map((r) => ({ ...r, connectionId: suffix(r.connectionId) })));
  }
  if (shared) {
    project.layout.components.find((c) => c.componentId === 'tank').x = 430;
    project.design.nodes.push({ id: 'tank-header', kind: 'ideal-hydraulic', label: '共用油箱节点' });
    project.layout.nodes.push({ nodeId: 'tank-header', x: 430, y: 465 });
    for (const e of project.design.connections)
      for (const side of ['from', 'to'])
        if (e[side].kind === 'port' && e[side].componentId === 'tank')
          e[side] = { kind: 'node', nodeId: 'tank-header' };
    project.design.connections.push({
      id: 'tank-boundary',
      kind: 'ideal',
      from: { kind: 'node', nodeId: 'tank-header' },
      to: { kind: 'port', componentId: 'tank', portId: 'T' },
    });
    project.layout.routes.push({ connectionId: 'tank-boundary', mode: 'auto' });
  }
  return good(parseNetworkProject(project));
}

export function groupRequests(shared = false, count = 2) {
  return Array.from({ length: count }, (_, index) => {
    const duty = controlValveRequest();
    if (index > 0) {
      const suffix = suffixAt(index);
      duty.pumpId += suffix;
      duty.angularSpeedRadPerS = 40 * Math.PI;
      duty.totalEfficiency = 0.75;
      duty.phases[0].valves[0].componentId += suffix;
      Object.assign(duty.phases[0].actions[0], {
        componentId: 'actuator' + suffix,
        speed: 0.04,
        resistingLoad: 1000 + 500 * index,
        supplyLossPa: 1.5e5 + 0.5e5 * index,
        returnPressurePa: shared ? 1e5 : returnPressure(index),
      });
    }
    return { pumpId: duty.pumpId, duty, pendingPhases: [] };
  });
}

export function independentMultiCylinderCase(shared = false) {
  const project = structuredClone(independentCircuit(shared));
  project.title = '两组独立供油 · A组三缸、B组双缸';
  const requests = groupRequests(shared);
  const definition = networkDefinition('teaching:directional-3-4', 1);
  const dropAtThreeLitres = 0.6e6;
  const groupFlows = [4.5, 4.8];
  for (const [index, count] of [3, 2].entries()) {
    const suffix = suffixAt(index);
    const valve = project.design.components.find((c) => c.id === 'valve' + suffix);
    const cylinder = project.design.components.find((c) => c.id === 'actuator' + suffix);
    const { capAreaM2, rodSideAreaM2 } = cylinder.parameters.geometry;
    const ratio = rodSideAreaM2 / capAreaM2;
    const parameters = structuredClone(networkDefaultParameters(definition.id, definition.version));
    parameters.hydraulic.maximumAreaM2 =
      (0.00005 / parameters.hydraulic.flowCoefficient) *
      Math.sqrt((project.design.fluid.densityKgPerM3 * (1 + ratio ** 3)) / (2 * dropAtThreeLitres));
    Object.assign(valve, {
      definition: { id: definition.id, version: definition.version },
      model: { id: definition.model.id, version: definition.model.version },
      parameters,
    });
    const phase = requests[index].duty.phases[0];
    const action = phase.actions[0];
    Object.assign(action, { speed: groupFlows[index] / count / 60000 / capAreaM2, supplyLossPa: 0 });
    const sourceIds = [valve.id, cylinder.id];
    const branches = project.design.connections.filter((edge) =>
      [edge.from, edge.to].some((end) => end.kind === 'port' && sourceIds.includes(end.componentId)),
    );
    for (let branch = 2; branch <= count; branch++) {
      const id = (base) => base + '-' + branch;
      const endpoint = (end) =>
        end.kind === 'port' && sourceIds.includes(end.componentId) ? { ...end, componentId: id(end.componentId) } : end;
      for (const source of [valve, cylinder]) {
        project.design.components.push({ ...source, id: id(source.id), label: source.label + branch });
        const state = project.design.initialConditions.find((item) => item.componentId === source.id);
        project.design.initialConditions.push({ ...state, componentId: id(source.id) });
        const location = project.layout.components.find((item) => item.componentId === source.id);
        project.layout.components.push({ ...location, componentId: id(source.id), y: location.y - 175 * (branch - 1) });
      }
      for (const edge of branches) {
        project.design.connections.push({ ...edge, id: id(edge.id), from: endpoint(edge.from), to: endpoint(edge.to) });
        project.layout.routes.push({ connectionId: id(edge.id), mode: 'auto' });
      }
      phase.valves.push({ componentId: id(valve.id), positionId: 'extend' });
      phase.actions.push({ ...action, componentId: id(cylinder.id) });
    }
  }
  return { project: good(parseNetworkProject(project)), requests };
}
