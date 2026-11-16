import { parseNetworkProject, physicalPipeModel } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { colebrookReference } from './return-trunk-friction.mjs';
import { sharedReturnCircuit, sharedReturnInputs, sharedReturnReference } from './shared-return-trunk.mjs';

const rho = 870;
const nu = 3e-6;
const ratioA = 0.6;
const ratioB = 1 / 0.6;
const tankPa = 1e5;
const roundPipe = (d, k) => ({ internalDiameterM: d, roughnessM: 4e-5, localLossCoefficient: k });
const trunkGeometry = roundPipe(0.008, 18);
const branchAGeometry = roundPipe(0.004, 12);
const branchBGeometry = roundPipe(0.008, 25);

function segment(flowLpm, p) {
  const d = p.internalDiameterM;
  const velocity = flowLpm / 60000 / ((Math.PI * d * d) / 4);
  const re = (velocity * d) / nu;
  const eD = p.roughnessM / d;
  const fraction = (re - 2300) / 1700;
  const f =
    re <= 2300
      ? 64 / re
      : re >= 4000
        ? colebrookReference(re, eD)
        : ((1 - fraction) * 64) / 2300 + fraction * colebrookReference(4000, eD);
  const head = (rho * velocity ** 2) / 2;
  const frictionPerM = (f * head) / d;
  const localPa = p.localLossCoefficient * head;
  return { flowLpm, re, f, frictionPerM, localPa };
}

function lengthForDrop(geometry, flowLpm, desiredPa) {
  const model = segment(flowLpm, geometry);
  return { ...geometry, lengthM: (desiredPa - model.localPa) / model.frictionPerM };
}

function pipePoint(geometry, flowLpm) {
  const data = segment(flowLpm, geometry);
  const frictionPa = geometry.lengthM * data.frictionPerM;
  return { ...data, frictionPa, totalPa: frictionPa + data.localPa };
}

export function branchedReturnReference(mode = 'matched') {
  const inletA = mode === 'biased' ? 3.3 : 3;
  const inletB = 6 - inletA;
  const returnA = inletA * ratioA;
  const returnB = inletB * ratioB;
  const trunk = lengthForDrop(trunkGeometry, 6.8, 0.25e6);
  const branchA = lengthForDrop(branchAGeometry, 1.8, 0.3e6);
  const t = pipePoint(trunk, returnA + returnB);
  const a = pipePoint(branchA, returnA);
  const headerPa = tankPa + t.totalPa;
  const tA = headerPa + a.totalPa;
  const A = sharedReturnInputs[0].loadKn * 1e6;
  const B = (sharedReturnInputs[1].loadKn * 1000) / 0.0006;
  const factorA = (inletA / 3) ** 2;
  const factorB = (inletB / 3) ** 2;
  const pressurePa = A + ratioA * tA + 1e6 * factorA;
  const tB = (pressurePa - B - 0.44e6 * ratioB ** 3 * factorB) / ratioB;
  const branchB = lengthForDrop(branchBGeometry, returnB, tB - headerPa);
  const b = pipePoint(branchB, returnB);
  const base = sharedReturnReference('matched');
  return {
    trunk,
    branchA,
    branchB,
    t,
    a,
    b,
    inletA,
    inletB,
    tA,
    tB,
    headerPa,
    pressurePa,
    chamberA: tA + (base.chamberA - base.headerPa) * factorA,
    chamberB: tB + (base.chamberB - base.headerPa) * factorB,
    speedA: inletA / 60000 / 0.001,
    speedB: inletB / 60000 / 0.0006,
  };
}

export function branchedReturnCircuit(mode = 'matched') {
  const project = structuredClone(sharedReturnCircuit());
  project.title = {
    matched: '三段回油管路 · 两缸达标',
    biased: '三段回油管路 · B 支管阻力增大',
    pending: '三段回油管路 · B 支管管长待核',
  }[mode];
  const ref = branchedReturnReference(mode);
  project.design.fluid.kinematicViscosityM2PerS = nu;
  project.design.connections.find((edge) => edge.id === 'return-trunk').parameters = ref.trunk;
  for (const [id, pipe, p] of [
    ['return', 'return-branch-a', ref.branchA],
    ['return-b', 'return-branch-b', ref.branchB],
  ]) {
    const edge = project.design.connections.find((edge) => edge.id === id);
    Object.assign(edge, {
      id: pipe,
      kind: 'pipe',
      model: physicalPipeModel,
      parameters: { ...p, ...(mode === 'pending' && pipe === 'return-branch-b' ? { lengthM: 0 } : {}) },
    });
    project.layout.routes.find((route) => route.connectionId === id).connectionId = pipe;
  }
  return good(parseNetworkProject(project));
}
