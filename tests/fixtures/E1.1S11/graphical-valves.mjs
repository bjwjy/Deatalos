import { networkDefinition, networkDefaultParameters, parseNetworkProject } from '@hyd/domain';
import { valveGraph, good } from './graphs.mjs';
export function graphicalValveGraph(ports, codes, pressure) {
  const source = structuredClone(valveGraph('directional-3-' + ports, ports === 2 ? [1,0,1] : ports === 3 ? [1,0,2] : ports === 4 ? [4,0,3] : [7,0,6], pressure));
  const valve = source.design.components.find((item) => item.id === 'valve');
  const definition = networkDefinition(valve.definition.id, 2);
  Object.assign(valve, {definition:{id:definition.id,version:2},model:{id:definition.model.id,version:definition.model.version},parameters:structuredClone(networkDefaultParameters(definition.id,2))});
  valve.parameters.positions = Object.fromEntries(['extend','neutral','retract'].map((slot,i) => [slot+'Function',codes[i]]));
  return good(parseNetworkProject(source));
}
