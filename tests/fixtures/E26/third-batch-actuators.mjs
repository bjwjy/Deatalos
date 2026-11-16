import { networkCreationDefinitions, networkCreationParameters, networkInitialFor } from '@hyd/domain';
import { basicBuilder, good } from '../E04B/graphs.mjs';

export function actuatorBoundary(type, pressures, initial = {}, parameters = {}) {
  const b = basicBuilder(type);
  const part = b.add('part', type, undefined, parameters);
  b.project.design.initialConditions.push({ ...good(networkInitialFor(part)), ...initial });
  const placement = b.project.layout.components.find((p) => p.componentId === 'part');
  placement.x = 370;
  placement.y = 220;
  for (const [i, [port, pressurePa]] of Object.entries(pressures).entries()) {
    b.source('source-' + port, pressurePa);
    const source = b.project.layout.components.find((p) => p.componentId === 'source-' + port);
    source.x = 100 + i * 540;
    source.y = 420;
    b.edge('line-' + port, 'source-' + port + ':P', 'part:' + port);
  }
  return b.finish();
}

export function switchedActuator(type) {
  const b = basicBuilder('switched-' + type);
  const spring = type === 'single-acting-cylinder';
  const rotary = type === 'limited-rotary-actuator';
  const part = b.add('part', type, undefined, rotary ? { geometry: { angularTravelRad: 0.35 } } : {});
  b.project.design.initialConditions.push(good(networkInitialFor(part)));
  b.source('feed', spring ? 9e5 : 2.1e6);
  b.tank('tank', 1e5);
  b.add('direction', spring ? 'directional-2-3' : 'directional-2-4', { kind: 'valve', positionId: 'extend' });
  b.edge('feed-line', 'feed:P', 'direction:P');
  b.edge('tank-line', 'direction:T', 'tank:T');
  b.edge('work-a', 'direction:A', 'part:A');
  if (!spring) b.edge('work-b', 'direction:B', 'part:B');
  return b.finish();
}

export function pumpedCylinder(type, valve = false) {
  const b = basicBuilder('pumped-' + type);
  const create = (id, type, initial) => {
    const part = b.add(id, type, initial);
    const def = networkCreationDefinitions.find((definition) => definition.id === 'teaching:' + type);
    part.definition = { id: def.id, version: def.version };
    part.model = { id: def.model.id, version: def.model.version };
    part.parameters = structuredClone(networkCreationParameters(def));
    return part;
  };
  const part = b.add('part', type);
  b.project.design.initialConditions.push(good(networkInitialFor(part)));
  create('pump', 'pump');
  b.tank();
  b.edge('suction', 'tank:T', 'pump:S');
  const single = type === 'single-acting-cylinder';
  if (valve) {
    create('direction', single ? 'directional-2-3' : 'directional-3-4', {
      kind: 'valve',
      positionId: 'extend',
    });
    b.edge('delivery', 'pump:P', 'direction:P');
    b.edge('return', 'direction:T', 'tank:T');
    b.edge('work-a', 'direction:A', 'part:A');
    if (!single) b.edge('work-b', 'direction:B', 'part:B');
  } else {
    b.edge('delivery', 'pump:P', 'part:A');
    if (!single) b.edge('return', 'part:B', 'tank:T');
  }
  return b.finish();
}
