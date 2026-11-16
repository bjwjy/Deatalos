import { type NetworkComponent } from '@hyd/domain';
import { nativeId, parameter } from './hopsan-components.js';
import type { NativeComponent, NativePort, Terminal } from './hopsan-types.js';
import { portKey, type ConnectionGraph, type IdealNet } from './network-graph.js';

interface PilotSeriesJunction {
  readonly valveKey: string;
  readonly checkKey: string;
  readonly readback: NativePort;
}

function hasPort(net: IdealNet | undefined, ownerId: string, portId: string): boolean {
  return net?.terminals.some((port) => port.key === portKey(ownerId, portId)) ?? false;
}

function supportsSeriesSpool(valve: NetworkComponent): boolean {
  const positions = valve.parameters.positions;
  return (
    ((positions?.extendFunction === 4 && positions.retractFunction === 3) ||
      (positions?.extendFunction === 3 && positions.retractFunction === 4)) &&
    (positions.neutralFunction === 0 || positions.neutralFunction === 5)
  );
}

/** Condense only the unbranched return segment of a cross-piloted cylinder circuit. */
export function couplePilotSeries(
  graph: ConnectionGraph,
  components: NativeComponent[],
  terminals: Map<string, Terminal>,
  initialPressurePa: number,
): ReadonlyMap<string, PilotSeriesJunction> {
  const junctions = new Map<string, PilotSeriesJunction>();
  const byId = new Map(graph.project.design.components.map((component) => [component.id, component]));
  const netByPort = new Map(graph.nets.flatMap((net) => net.terminals.map((port) => [port.key, net] as const)));
  for (const net of graph.nets) {
    if (net.terminals.length !== 2 || net.terminals.some((port) => port.kind !== 'component')) continue;
    const valvePort = net.terminals.find(
      (port) => ['A', 'B'].includes(port.portId) && byId.get(port.ownerId)?.typeId === 'valve',
    );
    const checkPort = net.terminals.find(
      (port) => port.portId === 'A' && byId.get(port.ownerId)?.definition.id === 'teaching:pilot-check-internal',
    );
    if (!valvePort || !checkPort) continue;
    const valve = byId.get(valvePort.ownerId);
    const check = byId.get(checkPort.ownerId);
    if (!valve || !check || !supportsSeriesSpool(valve)) continue;
    const ratio = parameter(check, 'hydraulic', 'pilotRatio');
    if (ratio < 1) continue;

    const loadNet = netByPort.get(portKey(check.id, 'B'));
    const pilotNet = netByPort.get(portKey(check.id, 'X'));
    const load = loadNet?.terminals.find(
      (port) => ['A', 'B'].includes(port.portId) && byId.get(port.ownerId)?.typeId === 'cylinder',
    );
    const otherWork = valvePort.portId === 'A' ? 'B' : 'A';
    if (
      !load ||
      loadNet?.terminals.length !== 2 ||
      !hasPort(pilotNet, valve.id, otherWork) ||
      !hasPort(pilotNet, load.ownerId, load.portId === 'A' ? 'B' : 'A')
    )
      continue;

    const valveIndex = components.findIndex((component) => component.id === nativeId('c', valve.id));
    const checkIndex = components.findIndex((component) => component.id === nativeId('c', check.id));
    const mappedValve = components[valveIndex];
    if (
      mappedValve?.type !== 'HydraulicTeachingManifold4' ||
      components[checkIndex]?.type !== 'HydraulicTeachingPilotCheckInternal'
    )
      continue;
    const { id } = mappedValve;
    components[valveIndex] = {
      ...mappedValve,
      type: 'HydraulicTeachingPilotSeries4',
      inputs: {
        ...mappedValve.inputs,
        pilotSide: valvePort.portId === 'A' ? 1 : 3,
        checkArea: parameter(check, 'hydraulic', 'maximumAreaM2'),
        checkCq: parameter(check, 'hydraulic', 'flowCoefficient'),
        checkCrack: parameter(check, 'hydraulic', 'openingDifferentialPa'),
        pilotRatio: ratio,
        junctionInitial: initialPressurePa,
      },
    };
    components.splice(checkIndex, 1);
    const readback = { component: id, port: valvePort.portId };
    for (const [port, native] of [
      ['A', readback.port],
      ['B', 'Load'],
      ['X', 'Pilot'],
    ] as const) {
      terminals.set(portKey(check.id, port), { category: 'Q', ref: { component: id, port: native }, pressurePa: null });
    }
    junctions.set(net.id, { valveKey: valvePort.key, checkKey: checkPort.key, readback });
  }
  return junctions;
}
