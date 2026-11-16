import { builder, good } from '../E04A/graphs.mjs';
import { networkDefinition, networkDefaultParameters, parseNetworkProject } from '@hyd/domain';
export { good };
export const options = Object.freeze({ nativeStepS: .000025, junctionPolicy: 'tlm-limit', initialPressurePa: 1e5, volumeScale: 1, constraintPressureTolerancePa: 1 });
export function basicBuilder(name) {
  const b = builder(name);
  const add = (id, name, initial, overrides = {}) => {
    const version = ['check-valve', 'one-way-throttle'].includes(name) ? 2 : 1;
    const def = networkDefinition('teaching:' + name, version);
    if (!def) throw new Error('Missing definition: ' + name);
    const c = { id, typeId: def.typeId, definition: { id: def.id, version }, model: { id: def.model.id, version: def.model.version }, label: id,
      parameters: structuredClone(networkDefaultParameters(def.id, version)) };
    for (const [group, values] of Object.entries(overrides)) Object.assign(c.parameters[group], values);
    b.project.design.components.push(c); b.project.layout.components.push({ componentId: id, x: b.project.design.components.length * 80, y: 200 });
    if (initial) b.project.design.initialConditions.push({ componentId: id, ...initial });
    return c;
  };
  const tank = (id = 'tank', pressurePa = 1e5) => add(id, 'tank', undefined, { hydraulic: { pressurePa } });
  const station = () => {
    tank(); add('pump', 'pump'); add('relief', 'relief'); b.node('supply');
    add('supply-volume', 'volume', { kind: 'volume', pressurePa: 1e5 }, { hydraulic: { volumeM3: 1e-4 } });
    b.edge('suction', 'tank:T', 'pump:S'); b.edge('delivery', 'pump:P', '@supply');
    b.edge('safety', '@supply', 'relief:P'); b.edge('drain', 'relief:T', 'tank:T');
    b.edge('supply-storage', '@supply', 'supply-volume:H');
  };
  return { ...b, add, tank, station, finish: () => good(parseNetworkProject(b.project)) };
}
export function restrictionGraph(kind = 'check-valve', dp = 5e6, opening = 2e-6) {
  const b = basicBuilder('restriction');
  b.source('high', 1e5 + Math.max(0, dp)); b.tank('low', 1e5 + Math.max(0, -dp));
  b.add('part', kind, ['throttle', 'one-way-throttle'].includes(kind) ? { kind: 'throttle', openingAreaM2: opening } : undefined);
  b.edge('in', 'high:P', 'part:A'); b.edge('out', 'part:B', 'low:T'); return b.finish();
}
export function pumpGraph(opening = 1e-6) {
  const b = basicBuilder('pump-load'); b.station(); b.throttle('load', opening);
  b.edge('load-in', '@supply', 'load:A'); b.edge('load-out', 'load:B', 'tank:T'); return b.finish();
}
export function actuatorGraph(kind = 'cylinder', { position = .1, torque = 0, valve = 'extend', stroke = 1 } = {}) {
  const b = basicBuilder('single-' + kind); b.station();
  b.add('valve', 'valve-o', { kind: 'valve', positionId: valve });
  if (kind === 'cylinder') b.add('actuator', 'cylinder', { kind: 'cylinder', positionM: position, velocityMPerS: 0, capPressurePa: 1e5, rodPressurePa: 1e5 }, { geometry: { strokeM: stroke } });
  else {
    b.add('actuator', 'motor', { kind: 'motor', angleRad: position, angularSpeedRadPerS: 0 }, { mechanics: { externalTorqueNm: torque } });
    for (const port of ['A', 'B']) {
      b.add('chamber-' + port, 'volume', { kind: 'volume', pressurePa: 1e5 }, { hydraulic: { volumeM3: 1e-4 } });
      b.add('makeup-' + port, 'check-valve', undefined, { hydraulic: { openingDifferentialPa: 0, maximumAreaM2: 1e-4 } });
      b.edge('volume-' + port, 'chamber-' + port + ':H', 'actuator:' + port);
      b.edge('makeup-feed-' + port, 'tank:T', 'makeup-' + port + ':A');
      b.edge('makeup-working-' + port, 'makeup-' + port + ':B', 'actuator:' + port);
    }
  }
  b.edge('supply', '@supply', 'valve:P'); b.edge('return', 'valve:T', 'tank:T');
  b.edge('working-a', 'valve:A', 'actuator:A'); b.edge('working-b', 'valve:B', 'actuator:B'); return b.finish();
}
export function directMotor({ high = 5.1e6, low = 1e5, torque = 0, inertia = .01, friction = .05, angle = .3 } = {}) {
  const b = basicBuilder('motor-pressure'); b.source('source', high); b.tank('tank', low);
  b.add('motor', 'motor', { kind: 'motor', angleRad: angle, angularSpeedRadPerS: 0 },
    { mechanics: { externalTorqueNm: torque, inertiaKgM2: inertia, viscousFrictionNmSPerRad: friction } });
  b.edge('drive', 'source:P', 'motor:A'); b.edge('return', 'motor:B', 'tank:T'); return b.finish();
}
