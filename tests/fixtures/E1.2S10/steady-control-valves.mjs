import { networkDefaultParameters, networkDefinition, parseNetworkProject } from '@hyd/domain';
import { actuatorGraph, good } from '../E04B/graphs.mjs';

export const valveTypes = ['pressure-reducing', 'pressure-compensated-flow', 'sequence-valve'];
const names = {
  'pressure-reducing': '普通减压阀',
  'pressure-compensated-flow': '压力补偿调速阀',
  'sequence-valve': '顺序阀',
};
export const demand = {
  'pressure-reducing': { inletPa: 1.31e6, dropPa: 1e5 },
  'pressure-compensated-flow': { inletPa: 1.71e6, dropPa: 5e5 },
  'sequence-valve': { inletPa: 1.75e6, dropPa: 5.4e5 },
};

export function controlValveCircuit(type, { accessories = false } = {}) {
  const document = structuredClone(actuatorGraph());
  document.title = names[type] + '单泵稳态核算';
  const pump = document.design.components.find((part) => part.id === 'pump');
  pump.parameters.hydraulic.displacementM3PerRev = 2e-6;
  pump.parameters.drive.angularSpeedRadPerS = 50 * Math.PI;
  const definition = networkDefinition('teaching:' + type, 1);
  const parameters = structuredClone(networkDefaultParameters(definition.id, definition.version));
  const h = parameters.hydraulic;
  const q = 3 / 60000;
  const rho = document.design.fluid.densityKgPerM3;
  const area = q / (h.flowCoefficient * Math.sqrt((2 * demand[type].dropPa) / rho));
  if (type === 'pressure-compensated-flow') {
    h.meteringAreaM2 = area;
    h.compensationDifferentialPa = 5e5;
  } else {
    h.maximumAreaM2 = 2 * area;
    h.regulationBandPa = 5e5;
    h.controlSettingPa = type === 'pressure-reducing' ? 1.36e6 : 1.4e6;
  }
  document.design.components.push({
    id: 'control',
    typeId: type,
    label: names[type],
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters,
  });
  document.design.connections.find((item) => item.id === 'supply').to = {
    kind: 'port',
    componentId: 'control',
    portId: 'P',
  };
  const wire = (id, fromComponent, fromPort, toComponent, toPort) => {
    document.design.connections.push({
      id,
      kind: 'ideal',
      from: { kind: 'port', componentId: fromComponent, portId: fromPort },
      to: { kind: 'port', componentId: toComponent, portId: toPort },
    });
    document.layout.routes.push({ connectionId: id, mode: 'auto' });
  };
  wire('control-out', 'control', 'A', 'valve', 'P');
  if (type !== 'pressure-compensated-flow') wire('control-drain', 'control', 'Y', 'tank', 'T');
  const positions = {
    pump: [180, 460],
    tank: [720, 630],
    control: [440, 390],
    valve: [650, 330],
    actuator: [650, 145],
    relief: [285, 490],
    'supply-volume': [285, 270],
  };
  document.layout.components.push({ componentId: 'control', x: 440, y: 390 });
  for (const item of document.layout.components) [item.x, item.y] = positions[item.componentId];
  Object.assign(
    document.layout.nodes.find((item) => item.nodeId === 'supply'),
    { x: 275, y: 395 },
  );
  if (accessories) {
    document.title = names[type] + '与串联附件稳态核算';
    for (const [id, kind, label, x, y, hydraulic] of [
      ['meter-in', 'flow-meter', '阀前流量计', 330, 455, { meterResistancePaSPerM3: 2e9 }],
      ['meter-out', 'flow-meter', '阀后流量计', 550, 400, { meterResistancePaSPerM3: 1e9 }],
      ['filter', 'return-filter', '回油过滤器', 830, 485, { filterRatedFlowM3PerS: 1e-4, filterRatedDropPa: 1e5 }],
      ['gauge', 'differential-pressure-gauge', '控制阀差压表', 455, 220, {}],
      ['switch', 'adjustable-pressure-switch', '阀后压力开关', 800, 240, {}],
    ]) {
      const definition = networkDefinition('teaching:' + kind, 1);
      const parameters = structuredClone(networkDefaultParameters(definition.id, definition.version));
      if (Object.keys(hydraulic).length) Object.assign(parameters.hydraulic, hydraulic);
      document.design.components.push({
        id,
        typeId: kind,
        label,
        definition: { id: definition.id, version: definition.version },
        model: { id: definition.model.id, version: definition.model.version },
        parameters,
      });
      document.layout.components.push({ componentId: id, x, y });
    }
    document.design.connections.find((edge) => edge.id === 'supply').to = {
      kind: 'port',
      componentId: 'meter-in',
      portId: 'A',
    };
    document.design.connections.find((edge) => edge.id === 'control-out').to = {
      kind: 'port',
      componentId: 'meter-out',
      portId: 'A',
    };
    document.design.connections.find((edge) => edge.id === 'return').to = {
      kind: 'port',
      componentId: 'filter',
      portId: 'A',
    };
    wire('meter-to-control', 'meter-in', 'B', 'control', 'P');
    wire('meter-to-direction', 'meter-out', 'B', 'valve', 'P');
    wire('filter-to-tank', 'filter', 'B', 'tank', 'T');
    wire('gauge-before', 'gauge', 'A', 'control', 'P');
    wire('gauge-after', 'gauge', 'B', 'control', 'A');
    wire('switch-tap', 'switch', 'H', 'control', 'A');
  }
  return good(parseNetworkProject(document));
}

export function controlValveRequest() {
  return {
    pumpId: 'pump',
    angularSpeedRadPerS: 50 * Math.PI,
    pumpVolumetricEfficiency: 1,
    totalEfficiency: 0.8,
    pressureLimitPa: 3e6,
    phases: [
      {
        name: '稳态伸出',
        valves: [{ componentId: 'valve', positionId: 'extend' }],
        actions: [
          {
            componentId: 'actuator',
            direction: 'forward',
            speed: 0.05,
            resistingLoad: 1000,
            supplyLossPa: 1.5e5,
            returnPressurePa: 1e5,
            mechanicalEfficiency: 1,
            volumetricEfficiency: 1,
          },
        ],
      },
    ],
  };
}
