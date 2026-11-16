import { networkDefaultParameters, networkDefinition, networkInitialFor, parseNetworkProject } from '@hyd/domain';
import { actuatorGraph, good } from '../E04B/graphs.mjs';

export function accessoryCircuit({ pressureSwitch = false } = {}) {
  const project = structuredClone(actuatorGraph());
  project.title = pressureSwitch ? '单泵双作用缸 · 含压力开关的附件核算' : '单泵双作用缸 · 四种附件核算';
  const pump = project.design.components.find((part) => part.id === 'pump');
  pump.parameters.hydraulic.displacementM3PerRev = 6e-6;
  pump.parameters.drive.angularSpeedRadPerS = 50 * Math.PI;
  for (const [id, type, label] of [
    ['cutoff', 'manual-shutoff', '供油截止阀'],
    ['meter', 'flow-meter', '供油流量计'],
    ['filter', 'return-filter', '回油过滤器'],
    ['gauge', 'differential-pressure-gauge', '滤芯差压表'],
    ...(pressureSwitch ? [['switch', 'adjustable-pressure-switch', '回油压力开关']] : []),
  ]) {
    const definition = networkDefinition('teaching:' + type, 1);
    const component = {
      id,
      typeId: type,
      label,
      definition: { id: definition.id, version: definition.version },
      model: { id: definition.model.id, version: definition.model.version },
      parameters: structuredClone(networkDefaultParameters(definition.id, definition.version)),
    };
    project.design.components.push(component);
    project.layout.components.push({ componentId: id, x: 0, y: 0 });
    const initial = good(networkInitialFor(component));
    if (initial) project.design.initialConditions.push(initial);
  }
  project.design.connections = project.design.connections.filter((edge) => !['supply', 'return'].includes(edge.id));
  project.layout.routes = project.layout.routes.filter((route) => !['supply', 'return'].includes(route.connectionId));
  const endpoint = (key) =>
    key.startsWith('@')
      ? { kind: 'node', nodeId: key.slice(1) }
      : {
          kind: 'port',
          componentId: key.split(':')[0],
          portId: key.split(':')[1],
        };
  for (const [id, from, to] of [
    ['supply', '@supply', 'cutoff:A'],
    ['cutoff-to-meter', 'cutoff:B', 'meter:A'],
    ['meter-to-valve', 'meter:B', 'valve:P'],
    ['return', 'valve:T', 'filter:A'],
    ['filter-to-tank', 'filter:B', 'tank:T'],
    ['gauge-in', 'gauge:A', 'filter:A'],
    ['gauge-out', 'gauge:B', 'filter:B'],
    ...(pressureSwitch ? [['switch-tap', 'switch:H', 'filter:A']] : []),
  ]) {
    project.design.connections.push({ id, kind: 'ideal', from: endpoint(from), to: endpoint(to) });
    project.layout.routes.push({ connectionId: id, mode: 'auto' });
  }
  const positions = {
    pump: [130, 400],
    tank: [780, 630],
    relief: [225, 465],
    'supply-volume': [235, 260],
    cutoff: [340, 400],
    meter: [500, 400],
    valve: [680, 350],
    actuator: [680, 165],
    filter: [830, 500],
    gauge: [1040, 470],
    switch: [1030, 650],
  };
  for (const place of project.layout.components) [place.x, place.y] = positions[place.componentId];
  Object.assign(
    project.layout.nodes.find((node) => node.nodeId === 'supply'),
    { x: 230, y: 400 },
  );
  return good(parseNetworkProject(project));
}

export function accessoryRequest(direction = 'forward') {
  return {
    pumpId: 'pump',
    angularSpeedRadPerS: 50 * Math.PI,
    pumpVolumetricEfficiency: 0.9,
    totalEfficiency: 0.8,
    pressureLimitPa: 3e6,
    phases: [
      {
        name: direction === 'forward' ? '稳态伸出' : '稳态缩回',
        valves: [{ componentId: 'valve', positionId: direction === 'forward' ? 'extend' : 'retract' }],
        shutoffs: [{ componentId: 'cutoff', state: 'open' }],
        actions: [
          {
            componentId: 'actuator',
            direction,
            speed: 0.1,
            resistingLoad: 1000,
            supplyLossPa: 2e5,
            returnPressurePa: 1e5,
            mechanicalEfficiency: 1,
            volumetricEfficiency: 1,
          },
        ],
      },
    ],
  };
}
