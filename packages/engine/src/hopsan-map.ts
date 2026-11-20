import {
  nativeId,
  parameter,
  mapHopsanComponent,
  hopsanRegisteredAreaBound,
  filterResistance,
} from './hopsan-components.js';
import type {
  NativePort,
  NativeComponent,
  PortBinding,
  MappingOptions,
  MappingPlan,
  Terminal,
} from './hopsan-types.js';
export type { NativePort, NativeComponent, PortBinding, MappingOptions, MappingPlan } from './hopsan-types.js';
import {
  immutable,
  networkDisplacementRange,
  isLinearActuatorType,
  isNetworkActuatorType,
  networkModelSetVersion,
  networkNativeStepAllowed,
  networkStepCapability,
  type Diagnostic,
  type NetworkComponent,
  type Result,
} from '@hyd/domain';
import {
  connectionGraph,
  failure,
  portKey,
  type ConnectionGraph,
  type GraphPort,
  type IdealNet,
} from './network-graph.js';
import { couplePilotSeries } from './hopsan-pilot-series.js';

const warning = (code: string, field: string, message: string): Diagnostic => ({
  code,
  field,
  message,
  severity: 'warning',
  suggestion: '保留映射清单与敏感性证据，勿解释为严格零容积瞬态模型。',
});
/** Static mapping prerequisite only; project ranges and runtime Reynolds checks remain separate. */
export function physicalPipeMappingSupport(parameters: Readonly<Record<string, number>>, field: string): Result<true> {
  if (
    parameters.internalDiameterM === undefined ||
    parameters.lengthM === undefined ||
    parameters.lengthM <= 0 ||
    parameters.localLossCoefficient !== 0
  ) {
    return failure('MODEL_UNSUPPORTED', field, '物理管路当前仅映射L>0、K=0的层流子域；运行时另检查Re<2000。');
  }
  return { ok: true, value: true };
}
/** The preview covers one fixed motor, an O spool and one declared volume on each work port. */
function motorCavityTopology(graph: ConnectionGraph) {
  const { components, connections, pressureReference } = graph.project.design;
  if (pressureReference.kind !== 'kernel-numeric' || connections.some((edge) => edge.kind !== 'ideal')) return null;
  const motor = components.find((c) => c.definition.id === 'teaching:motor' && c.model.version === '0.2.0');
  const valve = components.find((c) => c.definition.id === 'teaching:valve-o' && c.model.version === '0.1.0');
  const supply = components.find((c) => c.definition.id === 'teaching:pressure-source');
  const tank = components.find((c) => c.definition.id === 'teaching:tank');
  const protection = components.find((c) => c.definition.id === 'teaching:shock-makeup-valve');
  const volumes = components.filter((c) => c.definition.id === 'teaching:volume' && c.model.version === '0.1.0');
  if (!motor || !valve || !supply || !tank || volumes.length !== 2 || components.length !== (protection ? 7 : 6))
    return null;
  const exactNet = (keys: readonly string[]) =>
    graph.nets.some((net) => net.terminals.length === keys.length && net.terminals.every((p) => keys.includes(p.key)));
  const protectionKey = (port: string) => (protection ? [portKey(protection.id, port)] : []);
  if (
    !exactNet([portKey(supply.id, 'P'), portKey(valve.id, 'P')]) ||
    !exactNet([portKey(tank.id, 'T'), portKey(valve.id, 'T'), ...protectionKey('T')])
  )
    return null;
  const storage = new Map<string, NativePort>();
  for (const port of ['A', 'B']) {
    const keys = [portKey(motor.id, port), portKey(valve.id, port), ...protectionKey(port)];
    const volume = volumes.find((c) => exactNet([...keys, portKey(c.id, 'H')]));
    if (!volume) return null;
    const cavity = { component: nativeId('c', volume.id), port: 'cavity' };
    for (const key of [...keys, portKey(volume.id, 'H')]) storage.set(key, cavity);
  }
  return { motorId: motor.id, volumeIds: new Set(volumes.map((c) => c.id)), storage };
}

/** Two independently metered directional branches in one real pump/tank network. */
function coupledCavityWorkNets(graph: ConnectionGraph, actuators: readonly NetworkComponent[]) {
  const { components } = graph.project.design;
  const pumps = components.filter((c) => c.typeId === 'pump');
  const tanks = components.filter((c) => c.typeId === 'tank');
  const [pump] = pumps;
  const [tank] = tanks;
  if (
    !pump ||
    !tank ||
    pumps.length !== 1 ||
    tanks.length !== 1 ||
    graph.hydraulicConnections.some((edge) => edge.kind !== 'ideal')
  )
    return null;
  const byId = new Map(components.map((c) => [c.id, c]));
  const byPort = new Map(graph.nets.flatMap((net) => net.terminals.map((p) => [p.key, net] as const)));
  const supply = byPort.get(portKey(pump.id, 'P'));
  const drain = byPort.get(portKey(tank.id, 'T'));
  if (!supply || !drain || supply === drain || byPort.get(portKey(pump.id, 'S')) !== drain) return null;
  const fed = new Set([supply]);
  for (const port of supply.terminals) {
    if (byId.get(port.ownerId)?.typeId !== 'throttle' || !['A', 'B'].includes(port.portId)) continue;
    const downstream = byPort.get(portKey(port.ownerId, port.portId === 'A' ? 'B' : 'A'));
    if (downstream && downstream !== drain) fed.add(downstream);
  }
  const valves = new Set<string>();
  const work = new Map<string, IdealNet>();
  for (const actuator of actuators) {
    let branch: string | undefined;
    for (const side of actuator.typeId === 'single-acting-cylinder' ? ['A'] : ['A', 'B']) {
      const key = portKey(actuator.id, side);
      const net = byPort.get(key);
      if (!net || fed.has(net) || net === drain || [...work.values()].includes(net)) return null;
      const connected = net.terminals.filter((p) => byId.get(p.ownerId)?.typeId === 'valve');
      const [edge] = connected;
      if (
        !edge ||
        connected.length !== 1 ||
        !['A', 'B'].includes(edge.portId) ||
        (branch !== undefined && edge.ownerId !== branch)
      )
        return null;
      if (
        net.terminals.some((p) => {
          if (p.key === key || p === edge) return false;
          const type = byId.get(p.ownerId)?.typeId;
          return (
            type !== 'volume' &&
            !(type === 'check-valve' && p.portId === 'B' && byPort.get(portKey(p.ownerId, 'A')) === drain)
          );
        })
      )
        return null;
      branch = edge.ownerId;
      work.set(key, net);
    }
    const branchSupply = branch && byPort.get(portKey(branch, 'P'));
    if (
      !branch ||
      !branchSupply ||
      valves.has(branch) ||
      !fed.has(branchSupply) ||
      byPort.get(portKey(branch, 'T')) !== drain
    )
      return null;
    valves.add(branch);
  }
  return work;
}

export function compileHopsan(input: unknown, options: MappingOptions): Result<MappingPlan> {
  const checked = connectionGraph(input);
  if (!checked.ok) return checked;
  if (!networkNativeStepAllowed(checked.value.project.design.components, options.nativeStepS)) {
    const capability = networkStepCapability(checked.value.project.design.components);
    return failure(
      'CLOCK_DOMAIN_EXCEEDED',
      '/mapping/nativeStepS',
      `${capability.reason}允许${capability.allowedSteps.map((step) => step * 1e6 + ' μs').join('、')}；不自动重试。`,
    );
  }
  if (
    !['strict', 'tlm-limit'].includes(options.junctionPolicy) ||
    (options.lowPressureModel !== undefined && options.lowPressureModel !== 'equivalent-cavity-v1') ||
    !Number.isFinite(options.initialPressurePa) ||
    options.initialPressurePa < 0 ||
    !Number.isFinite(options.volumeScale) ||
    options.volumeScale < 0.25 ||
    options.volumeScale > 4 ||
    !Number.isFinite(options.constraintPressureTolerancePa) ||
    options.constraintPressureTolerancePa <= 0
  ) {
    return failure('MAPPING_CONFIG_INVALID', '/mapping', '需声明已测原生步长、初压和有界近似配置。');
  }
  const graph = checked.value,
    project = graph.project;
  const actuators = project.design.components.filter((c) => isNetworkActuatorType(c.typeId));
  const requested = options.lowPressureModel && project.design.pressureReference.kind === 'kernel-numeric';
  const coupledWork = requested && actuators.length === 2 ? coupledCavityWorkNets(graph, actuators) : null;
  const previewActuators = requested && (actuators.length === 1 || coupledWork) ? actuators : [];
  const previewActuator = previewActuators.length === 1 ? previewActuators[0] : undefined;
  const motorCavity = previewActuator?.typeId === 'motor' ? motorCavityTopology(graph) : null;
  const storedCavityOwners = new Set(
    previewActuators
      .filter(
        (c) =>
          c.typeId === 'limited-rotary-actuator' ||
          (c.typeId === 'motor' && c.model.version === '0.3.0') ||
          (coupledWork && c.typeId !== 'cylinder' && isLinearActuatorType(c.typeId)),
      )
      .map((c) => c.id),
  );
  const cavityMotors = new Set(
    previewActuators.filter((c) => c.typeId === 'motor' && storedCavityOwners.has(c.id)).map((c) => c.id),
  );
  const cavityVolumes = new Set(motorCavity?.volumeIds);
  const cavityPorts = new Map(motorCavity?.storage);
  if (motorCavity) cavityMotors.add(motorCavity.motorId);
  if (coupledWork) {
    for (const actuator of previewActuators.filter((c) => c.typeId === 'motor' && c.model.version === '0.2.0')) {
      const nets = ['A', 'B'].map((side) => coupledWork.get(portKey(actuator.id, side)));
      const volumes = nets.map((net) =>
        project.design.components.filter(
          (c) => c.typeId === 'volume' && net?.terminals.some((p) => p.ownerId === c.id),
        ),
      );
      if (!volumes.every((members) => members.length === 1)) continue;
      cavityMotors.add(actuator.id);
      for (const [index, [volume]] of volumes.entries()) {
        if (!volume) throw new Error('Checked physical volume missing');
        cavityVolumes.add(volume.id);
        const cavity = { component: nativeId('c', volume.id), port: 'cavity' };
        for (const port of nets[index]?.terminals ?? []) cavityPorts.set(port.key, cavity);
      }
    }
  }
  const movingChambers = new Set<string>();
  for (const cylinder of previewActuators.filter((c) => c.typeId === 'cylinder')) {
    for (const side of ['A', 'B']) {
      const key = portKey(cylinder.id, side);
      const net = graph.nets.find((n) => n.terminals.some((p) => p.key === key));
      if (
        net &&
        net.terminals.length > 1 &&
        net.terminals.every(
          (p) =>
            p.key === key ||
            (p.kind === 'component' &&
              project.design.components.some(
                (c) => c.id === p.ownerId && ['valve', 'check-valve', 'shock-makeup-valve'].includes(c.typeId),
              )),
        )
      )
        movingChambers.add(key);
    }
  }
  if (motorCavity && ![25e-6, 12.5e-6].includes(options.nativeStepS))
    return failure(
      'CAVITY_MODEL_UNSUPPORTED',
      '/mapping/nativeStepS',
      '定量马达等效空穴预览使用 25 或 12.5 μs 原生步长。',
    );
  const modelSetVersion = networkModelSetVersion(project.design.components);
  // E04C extends the verified composition domain, not the component laws.
  // Keep every instance in this ONE native system. Shared nets below connect
  // the actual ports; there is no per-actuator solve or flow allocation.
  if (project.provenance.preferredSolverId !== 'hopsan')
    return failure('MODEL_UNSUPPORTED', '/provenance', '不能静默将旧模型转换为新内核模型。');
  const reference = project.design.pressureReference;
  if (reference.kind === 'gauge' && reference.absoluteReferencePa === null)
    return failure('PRESSURE_REFERENCE_REQUIRED', '/design/pressureReference', '表压到内核压力需显式绝压参考。');
  const offset = reference.kind === 'gauge' ? (reference.absoluteReferencePa ?? 0) : 0;
  const beta = project.design.fluid.bulkModulusPa;
  if (beta === null) return failure('INITIALIZATION_REQUIRED', '/design/fluid/bulkModulusPa', '映射需明确体积模量。');
  const bulkModulusPa = beta;
  const rho = project.design.fluid.densityKgPerM3;
  // The new flow-source/motor transients need declared fluid storage or a
  // prescribed pressure at their ports. Numerical junction compliance alone
  // did not meet the E04B first-10ms sensitivity budget; never silently add V.
  for (const c of project.design.components) {
    if (['0.3.0', '0.4.0'].includes(c.model.version) && c.parameters.storage) continue;
    const required = ['teaching:pump', 'teaching:valve-m'].includes(c.definition.id)
      ? ['P']
      : c.definition.id === 'teaching:motor'
        ? ['A', 'B']
        : [];
    for (const port of required) {
      const net = graph.nets.find((n) => n.terminals.some((p) => p.key === portKey(c.id, port)));
      const stored = net?.terminals.some((p) => {
        const other = project.design.components.find((v) => v.id === p.ownerId);
        return (
          p.kind === 'component' &&
          other &&
          (['volume', 'cylinder', 'pressure-source', 'tank'].includes(other.typeId) ||
            other.parameters.storage !== undefined)
        );
      });
      if (!stored)
        return failure(
          'PHYSICAL_STORAGE_REQUIRED',
          `/design/components/${c.id}/${port}`,
          '此流量源/马达口需工程显式油液容积或已验证C端/压力边界；仅数值接点柔度尚未通过E04B瞬态预算。',
        );
    }
  }
  const components: NativeComponent[] = [],
    connections: (readonly [string, string, string, string])[] = [];
  const terminals = new Map<string, Terminal>(),
    flows = new Map<string, { ref: NativePort; sign: number }[]>();
  const controls: MappingPlan['controls'][number][] = [],
    cylinders: MappingPlan['cylinders'][number][] = [];
  const motors: MappingPlan['motors'][number][] = [];
  const integratedPorts: MappingPlan['integratedPorts'][number][] = [];
  const storageModels = new Map<
    string,
    {
      volumeM3: number;
      initialPressurePa: number;
      local: readonly NativePort[];
      bounded: boolean;
      shareable: boolean;
      cavityPreview: boolean;
    }
  >();
  const sharedPorts = new Map<string, { storage: NativePort; cavity: NativePort }>();
  const reliefBranches: MappingPlan['reliefBranches'][number][] = [];
  const returnBranches = new Map<string, NativePort>();
  const approximations: MappingPlan['approximations'][number][] = [],
    diagnostics: Diagnostic[] = [];
  if (motorCavity)
    diagnostics.push({
      code: 'MOTOR_CAVITY_PREVIEW',
      field: '/mapping/lowPressureModel',
      severity: 'info',
      message: '正在使用定量马达等效空穴预览，0 Pa 为原生数值压力边界。',
      suggestion: '空穴体积随原油路油量收支变化。当前未标定绝压、析气和溃灭冲击。',
    });
  const constraints: MappingPlan['constraints'][number][] = [];
  const componentTypes = new Map(project.design.components.map((c) => [c.id, c.typeId]));
  const pumpIds = new Set(project.design.components.filter((c) => c.typeId === 'pump').map((c) => c.id));
  const valveIds = new Set(project.design.components.filter((c) => c.typeId === 'valve').map((c) => c.id));
  const pumpDeliveryNets = graph.nets.filter((net) =>
    net.terminals.some((p) => p.kind === 'component' && p.portId === 'P' && pumpIds.has(p.ownerId)),
  );
  const suppliedValves = new Set(
    pumpDeliveryNets.flatMap((net) =>
      net.terminals
        .filter((p) => p.kind === 'component' && p.portId === 'P' && valveIds.has(p.ownerId))
        .map((p) => p.ownerId),
    ),
  );
  const pumpFedWorkingPort = (p: GraphPort) =>
    p.kind === 'component' && ['A', 'B'].includes(p.portId) && suppliedValves.has(p.ownerId);
  const add = (
    id: string,
    type: string,
    inputs: Record<string, number>,
    constants: Record<string, number> = {},
    start: NativeComponent['start'] = [],
  ) => {
    components.push({ id, type, inputs, constants, start });
    return id;
  };
  const connect = (a: NativePort, b: NativePort) => connections.push([a.component, a.port, b.component, b.port]);
  // A composite port exposes the flow through its external connector, not the
  // rotor/pump flow. Local storage and makeup are accounted for separately.
  function integratedPort(
    component: NetworkComponent,
    portId: string,
    core: NativePort,
    leakage: NativePort | null = null,
    initialPressurePa: number | null = null,
    protection?: NativePort,
  ): void {
    const initial =
      initialPressurePa ??
      parameter(
        component,
        'storage',
        component.typeId === 'pump' &&
          portId === 'P' &&
          component.parameters.storage?.deliveryInitialPressurePa !== undefined
          ? 'deliveryInitialPressurePa'
          : 'initialPressurePa',
      );
    const id = nativeId('storage' + portId, component.id);
    const storage = { component: id, port: 'P1' };
    let makeup: NativePort | null = null;
    if (component.typeId === 'motor' && parameter(component, 'makeup', 'maximumAreaM2') > 0) {
      const valve = add(nativeId('makeup' + portId, component.id), 'HydraulicTeachingRestriction', {
        Aforward: parameter(component, 'makeup', 'maximumAreaM2'),
        Abase: 0,
        Areverse: 0,
        pForward: parameter(component, 'makeup', 'openingDifferentialPa'),
        pReverse: 0,
        Cq: parameter(component, 'makeup', 'flowCoefficient'),
        rho,
      });
      const supply = add(nativeId('supply' + portId, component.id), 'HydraulicMultiPressureSourceC', {
        p: parameter(component, 'makeup', 'supplyPressurePa') + offset,
      });
      connect({ component: supply, port: 'MP' }, { component: valve, port: 'P1' });
      makeup = { component: valve, port: 'P2' };
    }
    const corePorts = leakage ? [core, leakage] : [core];
    const cavityPreview = storedCavityOwners.has(component.id);
    const bounded = cavityPreview || (component.typeId !== 'cylinder' && isLinearActuatorType(component.typeId));
    storageModels.set(id, {
      volumeM3: parameter(component, 'storage', 'portVolumeM3'),
      initialPressurePa: initial + offset,
      local: [...corePorts, ...(makeup ? [makeup] : []), ...(protection ? [protection] : [])],
      bounded,
      shareable: bounded || (component.typeId === 'pump' && portId === 'P'),
      cavityPreview,
    });
    terminals.set(portKey(component.id, portId), { category: 'C', ref: storage, pressurePa: null });
    integratedPorts.push({
      componentId: component.id,
      portId,
      core: corePorts,
      storage,
      makeup,
    });
    diagnostics.push({
      code: 'INTEGRATED_OIL_MODEL',
      severity: 'info',
      field: `/design/components/${component.id}/${portId}`,
      message: `${component.label} ${portId}口采用显式模型参数中的内置油液容积${parameter(component, 'storage', 'portVolumeM3')} m³，初压${initial} Pa。${makeup ? '带有限开口的内置补油支路，实际补油流量单独记录。' : ''}`,
      suggestion: makeup
        ? '可在属性中修改内置容积和补油参数；补油源为教学模型假设。'
        : '内置容积及初压可在属性中修改。',
    });
  }
  function attachStorage(ref: NativePort): void {
    const spec = storageModels.get(ref.component);
    if (!spec) return;
    add(ref.component, 'HydraulicVolumeMultiPort', { V: spec.volumeM3, Beta_e: bulkModulusPa, alpha: 0.1 }, {}, [
      [ref.port, 'Pressure', spec.initialPressurePa],
    ]);
    for (const local of spec.local) connect(ref, local);
  }
  const connectedPorts = new Set(graph.nets.flatMap((net) => net.terminals.map((port) => port.key)));
  for (const c of [...project.design.components].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    const initial = project.design.initialConditions.find((i) => i.componentId === c.id);
    const mapped = mapHopsanComponent(c, initial, {
      reference,
      offset,
      beta,
      rho,
      options,
      add,
      connect,
      terminals,
      returnBranches,
      connectedPorts,
      controls,
      motors,
      cylinders,
      integratedPort,
      cavityMotorIds: cavityMotors,
      cavityVolumeIds: cavityVolumes,
      movingChambers,
      reliefBranches,
    });
    if (!mapped.ok) return mapped;
  }
  for (const edge of project.design.connections) {
    if (edge.kind !== 'signal' || edge.from.kind !== 'port' || edge.to.kind !== 'port') continue;
    const { componentId } = edge.to;
    const target = project.design.components.find((c) => c.id === componentId);
    if (target?.externalMotorControl?.kind !== 'voltage') continue;
    connect(
      { component: nativeId('c', edge.from.componentId), port: 'OUT' },
      { component: nativeId('motorvoltage', target.id), port: 'U' },
    );
  }
  for (const edge of graph.hydraulicConnections)
    if (edge.kind === 'pipe') {
      const p = edge.parameters,
        d = p.internalDiameterM,
        length = p.lengthM;
      const supported = physicalPipeMappingSupport(p, `/design/connections/${edge.id}`);
      if (!supported.ok) return supported;
      if (d === undefined || length === undefined) throw new Error('Validated pipe dimensions missing');
      const id = nativeId('pipe', edge.id),
        kc = (Math.PI * d ** 4) / (128 * rho * project.design.fluid.kinematicViscosityM2PerS * length);
      add(id, 'HydraulicLaminarOrifice', { Kc: kc });
      for (const [end, port] of [
        ['A', 'P1'],
        ['B', 'P2'],
      ] as const)
        terminals.set(`e:${edge.id}:${end}`, { category: 'Q', ref: { component: id, port }, pressurePa: null });
    }
  const boundaryValues = [...terminals.values()].flatMap((t) => (t.pressurePa === null ? [] : [t.pressurePa]));
  const reliefScales = project.design.components
    .filter((c) => c.typeId === 'relief')
    .map((c) => parameter(c, 'hydraulic', 'settingDifferentialPa'));
  const dp = Math.max(1e5, Math.max(...boundaryValues) - Math.min(...boundaryValues), ...reliefScales);
  function conductance(p: GraphPort, referenceDp = dp): number {
    if (p.kind === 'pipe') {
      const part = components.find((c) => c.id === nativeId('pipe', p.ownerId));
      return part?.inputs.Kc ?? 0;
    }
    const c = project.design.components.find((c) => c.id === p.ownerId);
    if (!c) return 0;
    if (c.definition.id === 'teaching:variable-motor' && p.portId === 'X') return 0;
    if (c.typeId === 'accumulator') return 1 / parameter(c, 'hydraulic', 'portResistancePaSPerM3');
    if (c.typeId === 'flow-meter') return 1 / parameter(c, 'hydraulic', 'meterResistancePaSPerM3');
    if (c.typeId === 'return-filter') return 1 / Math.sqrt(filterResistance(c) * dp);
    if (c.typeId === 'pilot-unloading-valve' && p.portId === 'X') return 0;
    if (c.typeId === 'three-way-flow-control') {
      const metering =
        parameter(c, 'hydraulic', 'priorityFlowM3PerS') /
        Math.sqrt(parameter(c, 'hydraulic', 'compensationDifferentialPa') * dp);
      const bypass =
        (parameter(c, 'hydraulic', 'flowCoefficient') * parameter(c, 'hydraulic', 'maximumAreaM2')) /
        Math.sqrt(2 * rho * dp);
      return p.portId === 'A' ? metering : p.portId === 'T' ? bypass : metering + bypass;
    }
    if (c.typeId === 'shock-makeup-valve') {
      const area = Math.max(parameter(c, 'hydraulic', 'maximumAreaM2'), parameter(c, 'hydraulic', 'makeupAreaM2'));
      return (
        ((p.portId === 'T' ? 2 : 1) * parameter(c, 'hydraulic', 'flowCoefficient') * area) / Math.sqrt(2 * rho * dp)
      );
    }
    if (c.typeId === 'pressure-intensifier') {
      const ratio = parameter(c, 'hydraulic', 'intensificationRatio');
      const scale = p.portId === 'IN' ? ratio : p.portId === 'R' ? ratio - 1 : 1;
      return (
        scale ** 2 / parameter(c, 'hydraulic', 'boostResistancePaSPerM3') +
        (p.portId === 'R' ? 0 : 1 / parameter(c, 'hydraulic', 'bypassResistancePaSPerM3'))
      );
    }
    const displacement = networkDisplacementRange(c);
    if (c.definition.id === 'teaching:pump' || c.definition.id === 'teaching:variable-pump')
      return (
        parameter(c, 'hydraulic', 'leakageM3PerSPa') +
        Math.abs(
          (displacement?.max ?? parameter(c, 'hydraulic', 'displacementM3PerRev')) *
            parameter(c, 'drive', 'angularSpeedRadPerS'),
        ) /
          (2 * Math.PI * dp)
      );
    if (c.definition.id === 'teaching:motor' || c.definition.id === 'teaching:variable-motor')
      return (
        parameter(c, 'hydraulic', 'leakageM3PerSPa') +
        ((displacement?.max ?? parameter(c, 'hydraulic', 'displacementM3PerRev')) / (2 * Math.PI)) ** 2 /
          parameter(c, 'mechanics', 'viscousFrictionNmSPerRad')
      );
    if (
      ![
        'throttle',
        'manual-shutoff',
        'shuttle-valve',
        'two-pressure-valve',
        'pilot-check-close',
        'pressure-reducing-relieving',
        'valve',
        'check-valve',
        'one-way-throttle',
        'relief',
        'pressure-reducing',
        'sequence-valve',
        'pilot-check',
        'counterbalance',
        'pressure-compensated-flow',
        'flow-divider-combiner',
        'synchronizing-flow-divider',
        'pilot-unloading-valve',
      ].includes(c.typeId)
    )
      return 0;
    const workingArea =
      c.typeId === 'valve' && c.parameters.spool?.diameterM !== undefined
        ? 2 *
          Math.PI *
          parameter(c, 'spool', 'diameterM') *
          (parameter(c, 'spool', 'commandTravelM') - parameter(c, 'spool', 'overlapM'))
        : 0;
    const registeredArea = hopsanRegisteredAreaBound(c);
    const area =
      registeredArea ??
      (c.typeId === 'one-way-throttle' && c.definition.version === 3
        ? parameter(c, 'hydraulic', 'maximumAreaM2') + parameter(c, 'hydraulic', 'reverseMaximumAreaM2')
        : c.typeId !== 'valve'
          ? parameter(c, 'hydraulic', 'maximumAreaM2')
          : c.definition.id === 'teaching:valve-m' || c.definition.id === 'teaching:custom-m'
            ? Math.max(
                workingArea,
                Math.PI *
                  parameter(c, 'spool', 'diameterM') *
                  parameter(c, 'spool', 'maximumTravelM') *
                  parameter(c, 'center', 'circumferenceFraction'),
              )
            : workingArea);
    const divider = c.typeId === 'flow-divider-combiner' || c.typeId === 'synchronizing-flow-divider';
    const parallelPaths = divider && p.portId === 'P' ? 2 : 1;
    return (parallelPaths * parameter(c, 'hydraulic', 'flowCoefficient') * area) / Math.sqrt(2 * rho * referenceDp);
  }
  const pilotSeries =
    options.junctionPolicy === 'tlm-limit'
      ? couplePilotSeries(graph, components, terminals, options.initialPressurePa + offset)
      : undefined;
  // A direct pump feed can pass through the intensifier bypass at full flow.
  // The outlet storage's own conductance does not include that supply.
  const intensifierFeedFlow = new Map<string, number>();
  for (const net of pumpDeliveryNets) {
    const feed = net.terminals
      .filter((p) => p.kind === 'component' && p.portId === 'P' && pumpIds.has(p.ownerId))
      .reduce((sum, p) => sum + dp * conductance(p), 0);
    for (const p of net.terminals)
      if (p.kind === 'component' && p.portId === 'IN' && componentTypes.get(p.ownerId) === 'pressure-intensifier')
        intensifierFeedFlow.set(p.ownerId, feed);
  }
  for (const net of graph.nets) {
    const series = pilotSeries?.get(net.id);
    if (series) {
      flows.set(series.valveKey, [{ ref: series.readback, sign: -1 }]);
      flows.set(series.checkKey, [{ ref: series.readback, sign: 1 }]);
      continue;
    }
    const list = net.terminals.map((p) => ({ p, t: terminals.get(p.key) }));
    if (list.some((v) => !v.t)) throw new Error('Mapped terminal missing');
    const boundaries = list.filter((v) => v.t?.category === 'boundary');
    const qs = list
        .filter((v) => v.t?.category === 'Q')
        .flatMap((v) => {
          const branch = returnBranches.get(v.p.key);
          return branch ? [v, { p: v.p, t: { category: 'Q' as const, ref: branch, pressurePa: null } }] : [v];
        }),
      cs = list.filter((v) => v.t?.category === 'C');
    if (
      !boundaries.length &&
      !cs.length &&
      qs.some(({ p }) =>
        project.design.components.some((c) => c.id === p.ownerId && c.typeId === 'pressure-compensated-flow'),
      )
    )
      return failure(
        'MAPPING_PHYSICAL_STORAGE_REQUIRED',
        '/mapping/' + net.id,
        '压力补偿调速阀暂不支持纯Q-Q零容积理想支路；可在旧阀属性中为 A 口启用内置油液容积，或接入显式容积及已支持的执行器储油。P 口仍需有实际供压或储油。',
      );
    const netId = nativeId('n', net.id);
    const remember = (key: string, ref: NativePort, sign: number) =>
      flows.set(key, [...(flows.get(key) ?? []), { ref, sign }]);
    const fixedStorage = cs.flatMap(({ p, t }) => {
      const spec = t?.ref && storageModels.get(t.ref.component);
      return spec ? [{ p, spec }] : [];
    });
    const moving = cs.find(({ p }) => movingChambers.has(p.key));
    if (moving && cs.length === 1 && !boundaries.length) {
      const cavity = { component: nativeId('c', moving.p.ownerId), port: 'cavity' + moving.p.portId };
      for (const { p } of list) cavityPorts.set(p.key, cavity);
    }
    const storagePort = cs[0]?.p;
    const loadPort = qs[0]?.p;
    const dividerType = loadPort && componentTypes.get(loadPort.ownerId);
    const dividerFeedsSpringCylinder =
      cs.length === 1 &&
      storagePort?.portId === 'A' &&
      componentTypes.get(storagePort.ownerId) === 'single-acting-cylinder' &&
      qs.length === 1 &&
      (loadPort?.portId === 'A' || loadPort?.portId === 'B') &&
      (dividerType === 'flow-divider-combiner' || dividerType === 'synchronizing-flow-divider');
    const pumpFedStorage =
      (pumpDeliveryNets.includes(net) || net.terminals.some(pumpFedWorkingPort)) &&
      qs.every(({ p }) => p.kind === 'component' && (pumpIds.has(p.ownerId) || valveIds.has(p.ownerId)));
    const previewStorage =
      fixedStorage.some(({ spec }) => spec.cavityPreview) &&
      qs.every(({ p }) => p.kind === 'component' && (pumpIds.has(p.ownerId) || valveIds.has(p.ownerId)));
    // In the fixed-volume cylinder/pump and cylinder/directional-valve cases,
    // and on the divider-to-spring-cylinder branch, the declared volume owns
    // one pressure and tracks liquid shortage until net inflow fills it.
    if (
      !boundaries.length &&
      (pumpFedStorage || dividerFeedsSpringCylinder || previewStorage) &&
      fixedStorage.length === cs.length &&
      fixedStorage.some(({ spec }) => spec.bounded) &&
      fixedStorage.every(({ spec }) => spec.shareable)
    ) {
      const volume = fixedStorage.reduce((sum, { spec }) => sum + spec.volumeM3, 0);
      const inventory = fixedStorage.reduce((sum, { spec }) => sum + spec.volumeM3 * spec.initialPressurePa, 0);
      // A single existing volume keeps its liquid TLM impedance. This is
      // needed near a stopped rotary actuator with a wide metering edge.
      const preserveLiquidWaves =
        previewStorage &&
        fixedStorage.length === 1 &&
        !fixedStorage.some(({ p }) => isLinearActuatorType(componentTypes.get(p.ownerId) ?? ''));
      const storage = { component: netId, port: preserveLiquidWaves ? 'P1' : 'P' };
      const cavity = { component: netId, port: 'cavity' };
      if (preserveLiquidWaves)
        add(netId, 'HydraulicTeachingMotorVolume', { V: volume, Beta_e: bulkModulusPa, alpha: 0.1 }, {}, [
          [storage.port, 'Pressure', inventory / volume],
        ]);
      else add(netId, 'HydraulicTeachingOilStorage', { V: volume, Beta: bulkModulusPa, p0: inventory / volume });
      const localRefs = fixedStorage.flatMap(({ spec }) => spec.local);
      for (const { p, t } of qs) {
        if (!t?.ref) throw new Error('Q terminal missing native port');
        localRefs.push(t.ref);
        remember(p.key, t.ref, -1);
        sharedPorts.set(p.key, { storage, cavity });
      }
      for (const ref of localRefs) connect(storage, ref);
      for (const { p, spec } of fixedStorage) {
        // Incoming terminal flow = volume share of net storage rate minus
        // native flow delivered to this net by this component's local ports.
        for (const ref of localRefs) remember(p.key, ref, spec.volumeM3 / volume);
        for (const ref of spec.local) remember(p.key, ref, -1);
        sharedPorts.set(p.key, { storage, cavity });
      }
      continue;
    }
    for (const { t } of cs) if (t?.ref) attachStorage(t.ref);
    if (boundaries.length) {
      const pressure = boundaries[0]?.t?.pressurePa;
      if (pressure === null || pressure === undefined) throw new Error('Boundary value missing');
      if (boundaries.some((b) => b.t?.pressurePa !== pressure))
        return failure('GRAPH_CONFLICT', '/design', '同一理想连接组有互相冲突的压力边界。');
      if (qs.length) {
        add(netId, 'HydraulicMultiPressureSourceC', { p: pressure });
        for (const q of qs)
          if (q.t?.ref) {
            connect({ component: netId, port: 'MP' }, q.t.ref);
            remember(q.p.key, q.t.ref, -1);
            for (const b of boundaries) remember(b.p.key, q.t.ref, 1);
          }
      }
      for (const [i, c] of cs.entries())
        if (c.t?.ref) {
          const id = add(`${netId}_q${i}`, 'HydraulicPressureSourceQ', { p: pressure });
          const ref = { component: id, port: 'P1' };
          connect(c.t.ref, ref);
          remember(c.p.key, ref, 1);
          for (const b of boundaries) remember(b.p.key, ref, -1);
        }
      if (!qs.length && !cs.length)
        return failure('GRAPH_UNDERDETERMINED', '/design', '仅并接理想压力边界，没有可确定的流量。');
      if (boundaries.length > 1)
        diagnostics.push(
          warning('BOUNDARY_FLOW_UNDETERMINED', '/design', '等压理想源并接：总流量可测，但各源分担未知。'),
        );
    } else {
      let owner = cs[0]?.t?.ref;
      const restrictionTypes = qs.map(({ p }) => componentTypes.get(p.ownerId));
      // These zero-volume branches can be unloaded toward tank by an opening
      // command. Size their numerical admittance near that low-pressure state.
      const unloadedOrificePair =
        !cs.length &&
        qs.length === 2 &&
        restrictionTypes.includes('throttle') &&
        restrictionTypes.some(
          (type) =>
            type === 'one-way-throttle' || type === 'flow-divider-combiner' || type === 'synchronizing-flow-divider',
        );
      const referenceDp = unloadedOrificePair ? 1e5 : dp;
      const g = list.reduce((s, entry) => s + conductance(entry.p, referenceDp), 0);
      if (!owner) {
        if (options.junctionPolicy !== 'tlm-limit')
          return failure(
            'MAPPING_POLICY_REQUIRED',
            '/mapping',
            'Q-Q/分支理想接点需要明确数值近似政策，不能静默插入物理容积。',
          );
        if (!(g > 0)) return failure('MAPPING_CONFIG_INVALID', '/mapping', '无法建立局部阻抗尺度。');
        // Native C volume has Zc=N*beta*h/(2*V*(1-alpha)). Match Zc to
        // inverse MEAN port admittance N/sum(G), not inverse whole-net sum(G).
        const volume = ((beta * options.nativeStepS * g) / (2 * (1 - 0.1))) * options.volumeScale;
        add(netId, 'HydraulicVolumeMultiPort', { V: volume, Beta_e: beta, alpha: 0.1 }, {}, [
          ['P1', 'Pressure', options.initialPressurePa + offset],
        ]);
        owner = { component: netId, port: 'P1' };
        approximations.push({
          netId: net.id,
          kind: 'numerical-compliance',
          value: volume,
          unit: 'm³',
          basis: `Zc=N/sum(G); V=beta*h*sum(G)/(2*(1-alpha))*scale; N=${qs.length}; sum(G)=${g}; reference dp=${referenceDp} Pa; alpha=0.1; h→0 implies V→0; not a physical volume`,
        });
      }
      for (const q of qs)
        if (q.t?.ref) {
          connect(owner, q.t.ref);
          remember(q.p.key, q.t.ref, -1);
          if (cs[0]) remember(cs[0].p.key, q.t.ref, 1);
        }
      for (const [i, c] of cs.slice(1).entries())
        if (c.t?.ref && cs[0]) {
          if (options.junctionPolicy !== 'tlm-limit')
            return failure('MAPPING_POLICY_REQUIRED', '/mapping', '多个C元件需要有压力误差预算的约束桥。');
          const outletSupply = cs.reduce(
            (sum, { p }) => sum + (p.portId === 'H' ? (intensifierFeedFlow.get(p.ownerId) ?? 0) : 0),
            0,
          );
          const qBound = Math.max(g * dp * 2, outletSupply, 1e-6),
            resistance = options.constraintPressureTolerancePa / qBound;
          const id = add(`${netId}_bridge${i}`, 'HydraulicLaminarOrifice', { Kc: 1 / resistance });
          const p1 = { component: id, port: 'P1' },
            p2 = { component: id, port: 'P2' };
          constraints.push({ netId: net.id, ports: [p1, p2], pressureBudgetPa: options.constraintPressureTolerancePa });
          connect(owner, p1);
          connect(c.t.ref, p2);
          remember(cs[0].p.key, p1, 1);
          remember(c.p.key, p2, 1);
          approximations.push({
            netId: net.id,
            kind: 'constraint-resistance',
            value: resistance,
            unit: 'Pa·s/m³',
            basis: `R=declared pressure budget / local estimated flow bound (${qBound}); not a physical pipe`,
          });
        }
    }
  }
  if (options.lowPressureModel && !motorCavity) {
    if (
      !previewActuators.length ||
      !previewActuators.every((actuator) =>
        ['A', 'B'].some((port) => {
          const key = portKey(actuator.id, port);
          return sharedPorts.has(key) || cavityPorts.has(key);
        }),
      )
    )
      return failure(
        'CAVITY_MODEL_UNSUPPORTED',
        '/mapping/lowPressureModel',
        '低压预览需要原生数值压力及可映射真实油液存量的工作口。耦合模式支持同泵同箱、独立换向的两条理想支路，阀前可串节流。',
      );
    diagnostics.push({
      code: coupledWork
        ? 'COUPLED_CAVITY_PREVIEW'
        : previewActuator && isLinearActuatorType(previewActuator.typeId)
          ? 'CYLINDER_CAVITY_PREVIEW'
          : 'ACTUATOR_CAVITY_PREVIEW',
      field: previewActuator ? '/design/components/' + previewActuator.id : '/mapping/lowPressureModel',
      severity: 'info',
      message: '正在使用等效空穴预览。已有容腔按原油路的流量收支跟踪缺油和回填。',
      suggestion: '0 Pa 是原生数值边界。空穴曲线只显示有原生空穴状态的油口。',
    });
  }
  if (approximations.length)
    diagnostics.push(
      warning(
        'MAPPING_REGULARIZED',
        '/mapping',
        '包含明确列出的数值柔度/约束桥；必须通过独立参考和步长/附加量敏感性，不声称严格理想瞬态。',
      ),
    );
  const ports: PortBinding[] = [...terminals].map(([key, t]) => {
    const flow = flows.get(key) ?? [];
    const duplicateBoundary =
      t.category === 'boundary' &&
      graph.nets.some(
        (n) =>
          n.terminals.some((p) => p.key === key) &&
          n.terminals.filter((p) => terminals.get(p.key)?.category === 'boundary').length > 1,
      );
    const integrated = integratedPorts.find((port) => portKey(port.componentId, port.portId) === key);
    const local = integrated ? [...integrated.core, ...(integrated.makeup ? [integrated.makeup] : [])] : [];
    const cavity = cavityPorts.get(key) ?? sharedPorts.get(key)?.cavity;
    return {
      key,
      pressure: [...flow.map((f) => f.ref), ...local],
      flow,
      unknownFlow: duplicateBoundary ? 'BOUNDARY_FLOW_UNDETERMINED' : null,
      ...(cavity ? { cavity } : {}),
    };
  });
  return {
    ok: true,
    value: immutable({
      format: 'E04A-Hopsan-Mapping',
      version: 1,
      graph,
      options,
      pressureOffsetPa: offset,
      components,
      connections,
      ports,
      controls,
      cylinders,
      motors,
      integratedPorts: integratedPorts.map((port) => ({
        ...port,
        storage: sharedPorts.get(portKey(port.componentId, port.portId))?.storage ?? port.storage,
      })),
      reliefBranches,
      modelSetVersion,
      approximations,
      diagnostics,
      constraints,
    }),
  };
}
export const nativeComponentId = (projectId: string) => nativeId('c', projectId);
