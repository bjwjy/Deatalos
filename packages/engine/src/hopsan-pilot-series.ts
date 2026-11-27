import { type NetworkComponent } from '@hyd/domain';
import { nativeId, parameter } from './hopsan-components.js';
import type { NativeComponent, NativePort, Terminal } from './hopsan-types.js';
import { portKey, type ConnectionGraph, type IdealNet } from './network-graph.js';

interface PilotSeriesJunction {
  readonly valveKey: string;
  readonly checkKey: string;
  readonly pilotKey?: string;
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

/** The two spool/check junctions carry main flow and sense the opposite poppet.
 * Only eliminate exact ideal nets. Extra branches and physical pipes retain their own models. */
function coupleLockPair(
  valve: NetworkComponent,
  byId: ReadonlyMap<string, NetworkComponent>,
  netByPort: ReadonlyMap<string, IdealNet>,
  components: NativeComponent[],
  terminals: Map<string, Terminal>,
  junctions: Map<string, PilotSeriesJunction>,
  initialPressurePa: number,
): void {
  const valveIndex = components.findIndex((c) => c.id === nativeId('c', valve.id));
  const mapped = components[valveIndex];
  if (mapped?.type !== 'HydraulicTeachingManifold4' || !supportsSeriesSpool(valve)) return;
  function branch(side: 'A' | 'B') {
    const net = netByPort.get(portKey(valve.id, side));
    if (net?.terminals.length !== 3) return;
    const inlet = net.terminals.find(
      (port) => port.portId === 'A' && byId.get(port.ownerId)?.definition.id === 'teaching:pilot-check-internal',
    );
    const check = inlet && byId.get(inlet.ownerId);
    if (!check || parameter(check, 'hydraulic', 'pilotRatio') < 1) return;
    const nativeCheck = components.find((c) => c.id === nativeId('c', check.id));
    if (nativeCheck?.type !== 'HydraulicTeachingPilotCheckInternal') return;
    const loaded = netByPort.get(portKey(check.id, 'B'));
    if (loaded?.terminals.length !== 2) return;
    const load = loaded.terminals.find(
      (port) => ['A', 'B'].includes(port.portId) && byId.get(port.ownerId)?.typeId === 'cylinder',
    );
    return load ? { side, net, check, nativeCheck, load } : undefined;
  }
  const a = branch('A'),
    b = branch('B');
  if (
    !a ||
    !b ||
    a.check.id === b.check.id ||
    a.net === b.net ||
    a.load.ownerId !== b.load.ownerId ||
    a.load.portId === b.load.portId ||
    !hasPort(a.net, b.check.id, 'X') ||
    !hasPort(b.net, a.check.id, 'X')
  )
    return;
  const inputs: Record<string, number> = { ...mapped.inputs, junctionInitial: initialPressurePa };
  for (const [main, opposite] of [
    [a, b],
    [b, a],
  ] as const) {
    const { net, check, side } = main;
    const suffix = side === 'A' ? '' : 'B';
    inputs['checkArea' + suffix] = parameter(check, 'hydraulic', 'maximumAreaM2');
    inputs['checkCq' + suffix] = parameter(check, 'hydraulic', 'flowCoefficient');
    inputs['checkCrack' + suffix] = parameter(check, 'hydraulic', 'openingDifferentialPa');
    inputs['pilotRatio' + suffix] = parameter(check, 'hydraulic', 'pilotRatio');
    const readback = { component: mapped.id, port: side };
    const checkKey = portKey(check.id, 'A'),
      pilotKey = portKey(opposite.check.id, 'X');
    const internal = { category: 'Q' as const, ref: readback, pressurePa: null };
    terminals.set(checkKey, internal);
    terminals.set(pilotKey, internal);
    terminals.set(portKey(check.id, 'B'), { ...internal, ref: { component: mapped.id, port: 'Load' + side } });
    junctions.set(net.id, { valveKey: portKey(valve.id, side), checkKey, pilotKey, readback });
  }
  components[valveIndex] = { ...mapped, type: 'HydraulicTeachingPilotLockPair4', inputs };
  for (const { nativeCheck } of [a, b]) components.splice(components.indexOf(nativeCheck), 1);
}

/** Condense the ideal work junctions of supported single-check and lock-pair circuits. */
export function couplePilotSeries(
  graph: ConnectionGraph,
  components: NativeComponent[],
  terminals: Map<string, Terminal>,
  initialPressurePa: number,
): ReadonlyMap<string, PilotSeriesJunction> {
  const junctions = new Map<string, PilotSeriesJunction>();
  const byId = new Map(graph.project.design.components.map((component) => [component.id, component]));
  const netByPort = new Map(graph.nets.flatMap((net) => net.terminals.map((port) => [port.key, net] as const)));
  for (const valve of byId.values())
    if (valve.typeId === 'valve')
      coupleLockPair(valve, byId, netByPort, components, terminals, junctions, initialPressurePa);
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
