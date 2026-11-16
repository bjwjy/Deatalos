import { parseNetworkProject, physicalPipeModel } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { parallelCircuit, parallelRequest } from './parallel-cylinder-flow.mjs';

const flow = (litersPerMinute) => litersPerMinute / 60000;
const diameterM = 0.008;
const capArea = 0.001;
const rodArea = 0.0006;
const ratioA = rodArea / capArea;
const ratioB = capArea / rodArea;
const loadA = 2000;
const dropAAt3 = 1e6;
const dropBAt3 = 0.44e6 * ratioB ** 3;
const tankPa = 0.1e6;
const matchedHeaderPa = 0.35e6;
const loadB = (loadA / capArea + (ratioA - ratioB) * matchedHeaderPa + dropAAt3 - dropBAt3) * rodArea;

// Independent references prescribe inlet flows and obtain the required pipe length from force balance.
export function sharedReturnReference(mode) {
  const inletA = mode === 'redistributed' ? 3.2 : 3;
  const inletB = 6 - inletA;
  const lossA = dropAAt3 * (inletA / 3) ** 2;
  const lossB = dropBAt3 * (inletB / 3) ** 2;
  const headerPa = (loadA / capArea - loadB / rodArea + lossA - lossB) / (ratioB - ratioA);
  const returnA = ratioA * inletA;
  const returnB = ratioB * inletB;
  return {
    inletA,
    inletB,
    returnA,
    returnB,
    headerPa,
    dropPa: headerPa - tankPa,
    supplyPa: loadA / capArea + ratioA * headerPa + lossA,
    chamberA: headerPa + (lossA / (1 + ratioA ** 3)) * ratioA ** 2,
    chamberB: headerPa + (lossB / (1 + ratioB ** 3)) * ratioB ** 2,
    speedA: flow(inletA) / capArea,
    speedB: flow(inletB) / rodArea,
  };
}

export function sharedReturnCircuit(mode = 'matched') {
  const project = structuredClone(parallelCircuit());
  project.title = {
    matched: '共用回油干线 · 两缸达标',
    redistributed: '共用回油干线 · 阻力增大',
    pending: '共用回油干线 · 长度待核',
  }[mode];
  const { design, layout } = project;
  const ref = sharedReturnReference(mode);
  const { densityKgPerM3: rho, kinematicViscosityM2PerS: nu } = design.fluid;
  const lengthM = (ref.dropPa * Math.PI * diameterM ** 4) / (128 * rho * nu * flow(ref.returnA + ref.returnB));
  design.nodes.push({ id: 'return-header', kind: 'ideal-hydraulic', label: '两缸回油汇合点' });
  layout.nodes.push({ nodeId: 'return-header', x: 500, y: 345 });
  for (const edge of design.connections.filter((item) => item.id === 'return' || item.id === 'return-b'))
    edge.to = { kind: 'node', nodeId: 'return-header' };
  design.connections.push({
    id: 'return-trunk',
    kind: 'pipe',
    from: { kind: 'node', nodeId: 'return-header' },
    to: { kind: 'node', nodeId: 'tank-header' },
    model: physicalPipeModel,
    parameters: {
      lengthM: mode === 'pending' ? 0 : lengthM,
      internalDiameterM: diameterM,
      localLossCoefficient: 0,
      roughnessM: 0,
    },
  });
  layout.routes.push({ connectionId: 'return-trunk', mode: 'auto' });
  design.components.find((part) => part.id === 'relief').parameters.hydraulic.settingDifferentialPa = 6e6;
  return good(parseNetworkProject(project));
}

export const sharedReturnInputs = [
  {
    id: 'actuator',
    valveId: 'valve',
    direction: 'forward',
    positionId: 'extend',
    loadKn: loadA / 1000,
    speedMmPerS: (flow(3) / capArea) * 1000,
  },
  {
    id: 'actuator-b',
    valveId: 'valve-b',
    direction: 'reverse',
    positionId: 'retract',
    loadKn: loadB / 1000,
    speedMmPerS: (flow(3) / rodArea) * 1000,
  },
];

export function sharedReturnRequest() {
  const request = parallelRequest();
  request.pressureLimitPa = 6e6;
  const phase = request.phases[0];
  phase.name = 'A 缸伸出，B 缸缩回';
  for (const [index, inputs] of sharedReturnInputs.entries()) {
    Object.assign(phase.actions[index], {
      direction: inputs.direction,
      speed: inputs.speedMmPerS / 1000,
      resistingLoad: inputs.loadKn * 1000,
      returnPressurePa: tankPa,
    });
    phase.valves[index].positionId = inputs.positionId;
  }
  return request;
}
