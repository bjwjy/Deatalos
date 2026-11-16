import { createNetworkDraft } from '@hyd/project-io';
import { networkDefinition, networkDefaultParameters, parseNetworkProject } from '@hyd/domain';
export const good = r => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.value; };
export function builder(name) {
  const project = structuredClone(good(createNetworkDraft({ projectId: name, timestamp: '2026-10-18T00:00:00.000Z', appVersion: 'E04A' })));
  project.provenance.preferredSolverId = 'hopsan'; project.design.fluid.bulkModulusPa = 1e9;
  project.design.pressureReference = { kind: 'kernel-numeric', absoluteReferencePa: null };
  const add = (id, definition, initial) => {
    const def = networkDefinition(`teaching:${definition}`, 1);
    const component = { id, typeId: def.typeId, definition: { id: def.id, version: 1 }, model: { ...def.model },
      label: id, parameters: structuredClone(networkDefaultParameters(def.id, 1)) };
    delete component.model.solverId;
    project.design.components.push(component);
    project.layout.components.push({ componentId: id, x: 100 + project.design.components.length * 50, y: 100 });
    if (initial) project.design.initialConditions.push({ componentId: id, ...initial });
    return component;
  };
  const node = id => { project.design.nodes.push({ id, kind: 'ideal-hydraulic', label: id }); project.layout.nodes.push({ nodeId: id, x: 300, y: 200 }); return `@${id}`; };
  const endpoint = text => text.startsWith('@') ? { kind: 'node', nodeId: text.slice(1) }
    : { kind: 'port', componentId: text.split(':')[0], portId: text.split(':')[1] };
  const edge = (id, a, b, pipe) => {
    project.design.connections.push({ id, from: endpoint(a), to: endpoint(b), ...(pipe
      ? { kind: 'pipe', model: { id: 'legacy-basic:pipe', version: '1.0.0-experimental' }, parameters: pipe } : { kind: 'ideal' }) });
    project.layout.routes.push({ connectionId: id, mode: 'auto' });
  };
  const source = (id, pressurePa) => { const c = add(id, 'pressure-source'); c.parameters.hydraulic.pressurePa = pressurePa; };
  const throttle = (id, area) => add(id, 'throttle', { kind: 'throttle', openingAreaM2: area });
  return { project, add, node, edge, source, throttle, finish: () => good(parseNetworkProject(project)) };
}
export function resistive(kind = 'series') {
  const b = builder(kind); b.source('high', 5.1e6); b.source('low', 1e5);
  if (kind === 'series') {
    b.throttle('first', 2e-6); b.throttle('last', 1e-6); b.node('junction');
    b.edge('in', 'high:P', 'first:A'); b.edge('first-link', 'first:B', '@junction');
    b.edge('last-link', '@junction', 'last:A'); b.edge('out', 'last:B', 'low:P');
  } else {
    b.throttle('feed', 3e-6); b.node('branch'); b.edge('in', 'high:P', 'feed:A'); b.edge('feed-link', 'feed:B', '@branch');
    for (let i = 1; i <= 3; i++) { b.throttle(`branch${i}`, i * .5e-6); b.edge(`take${i}`, '@branch', `branch${i}:A`); b.edge(`return${i}`, `branch${i}:B`, 'low:P'); }
  }
  return b.finish();
}
export function cylinderGraph(dual = false, explicitVolume = false) {
  const b = builder(dual ? 'dual-cylinder' : 'single-cylinder'); b.source('source', 5.1e6); b.source('tank', 1e5);
  b.throttle('feed', 2e-6); b.node('supply'); b.edge('feed-in', 'source:P', 'feed:A'); b.edge('feed-out', 'feed:B', '@supply');
  if (explicitVolume) { b.add('physicalVolume', 'volume', { kind: 'volume', pressurePa: 1e5 }); b.edge('physical', 'physicalVolume:H', '@supply'); }
  for (let i = 1; i <= (dual ? 2 : 1); i++) {
    b.add(`v${i}`, 'valve-o', { kind: 'valve', positionId: i === 1 ? 'extend' : 'neutral' });
    b.add(`c${i}`, 'cylinder', { kind: 'cylinder', positionM: .1 + .1 * (i - 1), velocityMPerS: 0, capPressurePa: 1e5, rodPressurePa: 1e5 });
    b.edge(`p${i}`, '@supply', `v${i}:P`); b.edge(`t${i}`, `v${i}:T`, 'tank:P');
    b.edge(`a${i}`, `v${i}:A`, `c${i}:A`); b.edge(`b${i}`, `v${i}:B`, `c${i}:B`);
  }
  return b.finish();
}
