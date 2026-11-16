import { diagnostic, networkDisplacementRange, type Diagnostic, type NetworkProject } from '@hyd/domain';
import { networkPortPressureLimitPa } from './hopsan-types.js';
import { connectionGraph, portKey } from './network-graph.js';

/** Proves insufficient steady discharge only for a fixed pump and a single shuttable branch between two ideal nets. */
export function fixedPumpClosureGuard(project: NetworkProject): { loadId: string; diagnostic: Diagnostic } | null {
  const components = project.design.components;
  const pumps = components.filter((c) => c.definition.id === 'teaching:pump');
  const tanks = components.filter((c) => c.typeId === 'tank');
  const loads = components.filter((c) => c.typeId === 'throttle' || c.typeId === 'manual-shutoff');
  const reliefs = components.filter((c) => c.definition.id === 'teaching:relief');
  const pump = pumps[0],
    tank = tanks[0],
    load = loads[0];
  if (
    !pump ||
    !tank ||
    !load ||
    pumps.length !== 1 ||
    tanks.length !== 1 ||
    loads.length !== 1 ||
    networkDisplacementRange(pump) ||
    components.length !== 3 + reliefs.length + components.filter((c) => c.typeId === 'volume').length
  )
    return null;

  const graph = connectionGraph(project);
  if (!graph.ok || graph.value.nets.length !== 2 || graph.value.hydraulicConnections.some((e) => e.kind !== 'ideal'))
    return null;
  const netOf = (id: string, port: string) =>
    graph.value.nets.find((net) => net.terminals.some((p) => p.key === portKey(id, port)));
  const supply = netOf(pump.id, 'P'),
    returned = netOf(pump.id, 'S');
  if (
    !supply ||
    !returned ||
    supply === returned ||
    netOf(tank.id, 'T') !== returned ||
    netOf(load.id, 'A') === netOf(load.id, 'B') ||
    reliefs.some((c) => netOf(c.id, 'P') !== supply || netOf(c.id, 'T') !== returned)
  )
    return null;

  const speed = pump.parameters.drive?.angularSpeedRadPerS;
  const displacement = pump.parameters.hydraulic?.displacementM3PerRev;
  const leakage = pump.parameters.hydraulic?.leakageM3PerSPa;
  if (speed === undefined || displacement === undefined || leakage === undefined || speed <= 0) return null;
  const supplyFlow = (displacement * speed) / (2 * Math.PI);
  const branches = reliefs.map((c) => c.parameters.hydraulic);
  if (pump.parameters.relief?.enabled === 1) branches.push(pump.parameters.relief);
  // A nonnegative tank pressure can only reduce the available differential. Use the full limit as an upper bound.
  const limit = networkPortPressureLimitPa;
  let discharge = leakage * limit;
  for (const branch of branches) {
    const area = branch?.maximumAreaM2,
      coefficient = branch?.flowCoefficient,
      setting = branch?.settingDifferentialPa;
    if (area === undefined || coefficient === undefined || setting === undefined) return null;
    discharge +=
      coefficient * area * Math.sqrt((2 * Math.max(0, limit - setting)) / project.design.fluid.densityKgPerM3);
  }
  if (discharge >= supplyFlow) return null;
  return {
    loadId: load.id,
    diagnostic: {
      ...diagnostic(
        'PRESSURE_CONTROL_BLOCKED',
        `/design/components/${load.id}`,
        `已拒绝关闭${load.label}。${pump.label}供流 ${(supplyFlow * 60000).toPrecision(4)} L/min；即使压差达到 ${limit / 1e6} MPa，溢流与内泄合计最多 ${(discharge * 60000).toPrecision(4)} L/min。当前开口保持。`,
      ),
      suggestion: '保留通流开口，或在工程中核对并配置容量足够的溢流回路后重新初始化。',
    },
  };
}
