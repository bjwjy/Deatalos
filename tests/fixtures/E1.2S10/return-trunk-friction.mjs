import { parseNetworkProject } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { sharedReturnCircuit, sharedReturnReference } from './shared-return-trunk.mjs';

// Independent numerical root of the implicit Colebrook equation in 1/sqrt(f).
export function colebrookReference(reynolds, relativeRoughness) {
  let low = 1;
  let high = 30;
  for (let i = 0; i < 80; i++) {
    const x = (low + high) / 2;
    const residual = x + 2 * Math.log10(relativeRoughness / 3.7 + (2.51 * x) / reynolds);
    if (residual < 0) low = x;
    else high = x;
  }
  return 1 / ((low + high) / 2) ** 2;
}

export function frictionReference(mode) {
  const laminar = mode === 'local' || mode === 'pending';
  const flow = sharedReturnReference(laminar ? 'matched' : 'redistributed');
  const diameter = 0.008;
  const velocity = (flow.returnA + flow.returnB) / 60000 / ((Math.PI * diameter ** 2) / 4);
  const density = 870;
  const roughness = 4e-5;
  const K = 25;
  const viscosity = laminar ? 46e-6 : mode === 'transition' ? (velocity * diameter) / 3200 : 3e-6;
  const reynolds = (velocity * diameter) / viscosity;
  const ratio = (reynolds - 2300) / 1700;
  const factor = laminar
    ? 64 / reynolds
    : mode === 'transition'
      ? ((1 - ratio) * 64) / 2300 + ratio * colebrookReference(4000, roughness / diameter)
      : colebrookReference(reynolds, roughness / diameter);
  const localDropPa = (K * density * velocity ** 2) / 2;
  const frictionDropPa = flow.dropPa - localDropPa;
  const lengthM = (frictionDropPa * diameter) / ((factor * density * velocity ** 2) / 2);
  return {
    ...flow,
    lengthM,
    diameter,
    density,
    roughness,
    K,
    viscosity,
    velocity,
    reynolds,
    factor,
    frictionDropPa,
    localDropPa,
  };
}

export function frictionCircuit(mode = 'local') {
  const project = structuredClone(sharedReturnCircuit());
  project.title = {
    local: '回油干线 · 层流与局部损失',
    turbulent: '回油干线 · 湍流与局部损失',
    transition: '回油干线 · 过渡区估算',
    pending: '回油干线 · 管长待核',
  }[mode];
  const ref = frictionReference(mode);
  const trunk = project.design.connections.find((edge) => edge.id === 'return-trunk');
  Object.assign(trunk.parameters, {
    lengthM: mode === 'pending' ? 0 : ref.lengthM,
    internalDiameterM: ref.diameter,
    roughnessM: ref.roughness,
    localLossCoefficient: ref.K,
  });
  project.design.fluid.kinematicViscosityM2PerS = ref.viscosity;
  return good(parseNetworkProject(project));
}
