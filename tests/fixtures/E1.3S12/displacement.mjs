import { networkInitialFor } from '@hyd/domain';
import { basicBuilder, good } from '../E04B/graphs.mjs';

export function displacementCircuit(kind = 'combined', controller = false) {
  const b = basicBuilder('variable-' + kind);
  b.tank();
  if (kind !== 'motor') {
    b.add('pump', 'variable-pump', undefined, kind === 'pump' ? { hydraulic: { leakageM3PerSPa: 1e-12 } } : {});
    b.edge('suction', 'tank:T', 'pump:S');
  }
  if (kind !== 'pump') {
    const motor = b.add('motor', 'variable-motor');
    b.project.design.initialConditions.push(good(networkInitialFor(motor)));
    b.edge('return', 'motor:B', 'tank:T');
  }
  if (kind === 'combined') {
    b.edge('delivery', 'pump:P', 'motor:A');
  } else if (kind === 'pump') {
    b.source('load', 1.1e6);
    b.edge('delivery', 'pump:P', 'load:P');
  } else {
    b.source('feed', 1.1e6);
    b.edge('delivery', 'feed:P', 'motor:A');
  }
  const placements = {
    tank: [230, 390],
    pump: [230, 190],
    motor: [530, 190],
    load: [530, 190],
    feed: [230, 190],
    controller: [410, 95],
  };
  if (controller) {
    const c = b.add('controller', 'dynamic-controller');
    c.controller = {
      version: 1,
      cycles: 1,
      steps: [0.5, 0.75].map((value, index) => ({
        id: `step-${index + 1}`,
        name: `排量 ${value * 100}%`,
        commands: [
          { kind: 'displacement', componentId: kind === 'pump' ? 'pump' : 'motor', source: 'controller', value },
        ],
        until: { kind: 'time', durationS: index === 0 ? 0.03 : 0.5 },
        timeoutS: 2,
      })),
    };
  }
  for (const placement of b.project.layout.components) {
    [placement.x, placement.y] = placements[placement.componentId];
  }
  return b.finish();
}
