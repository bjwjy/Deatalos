import { parseNetworkProject, physicalPipeModel } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { branchedReturnCircuit } from './branched-return-pipes.mjs';
import { colebrookReference } from './return-trunk-friction.mjs';
import { sharedReturnRequest } from './shared-return-trunk.mjs';

const rho = 870;
const nu = 3e-6;
const ratio = 0.6;
const tankPa = 0.1e6;
const geometry = (d, k) => ({ internalDiameterM: d, roughnessM: 4e-5, localLossCoefficient: k });

function loss(flow, parameters) {
  const d = parameters.internalDiameterM;
  const velocity = flow / 60000 / ((Math.PI * d * d) / 4);
  const reynolds = (velocity * d) / nu;
  const roughness = parameters.roughnessM / d;
  const blend = (reynolds - 2300) / 1700;
  const f =
    reynolds <= 2300
      ? 64 / reynolds
      : reynolds >= 4000
        ? colebrookReference(reynolds, roughness)
        : ((1 - blend) * 64) / 2300 + blend * colebrookReference(4000, roughness);
  const head = (rho * velocity ** 2) / 2;
  const localPa = parameters.localLossCoefficient * head;
  const frictionPerM = (f * head) / d;
  return { flow, reynolds, localPa, frictionPerM };
}

export function lengthFor(flow, geometry, totalPa) {
  const { localPa, frictionPerM } = loss(flow, geometry);
  return { ...geometry, lengthM: (totalPa - localPa) / frictionPerM };
}

export function segment(flow, parameters) {
  const state = loss(flow, parameters);
  const frictionPa = state.frictionPerM * parameters.lengthM;
  return { ...state, frictionPa, totalPa: frictionPa + state.localPa };
}

export function twoLevelReference(mode = 'matched') {
  const q = mode === 'biased' ? 2.7 : 3;
  const qC = 9 - 2 * q;
  const leaf = lengthFor(1.8, geometry(0.006, 8), 0.1e6);
  const trunk = lengthFor(5.4, geometry(0.008, 18), 0.25e6);
  const ab = segment(q * ratio, leaf);
  const c = segment(qC * ratio, leaf);
  const t = segment(5.4, trunk);
  const mainHeaderPa = tankPa + t.totalPa;
  const cT = mainHeaderPa + c.totalPa;
  const p = 2.12e6 + ratio * cT + 1e6 * (qC / 3) ** 2;
  const abT = (p - 2e6 - 1e6 * (q / 3) ** 2) / ratio;
  const abHeaderPa = abT - ab.totalPa;
  const intermediate = lengthFor(q * ratio * 2, geometry(0.004, 8), abHeaderPa - mainHeaderPa);
  const m = segment(q * ratio * 2, intermediate);
  const chamberLoss = (1e6 * ratio ** 2) / (1 + ratio ** 3);
  return {
    q,
    qC,
    leaf,
    trunk,
    intermediate,
    ab,
    c,
    t,
    m,
    abT,
    cT,
    abHeaderPa,
    mainHeaderPa,
    p,
    abChamber: abT + chamberLoss * (q / 3) ** 2,
    cChamber: cT + chamberLoss * (qC / 3) ** 2,
  };
}

export const twoLevelInputs = [
  { id: 'actuator', valveId: 'valve', direction: 'forward', positionId: 'extend', loadKn: 2, speedMmPerS: 50 },
  { id: 'actuator-b', valveId: 'valve-b', direction: 'forward', positionId: 'extend', loadKn: 2, speedMmPerS: 50 },
  { id: 'actuator-c', valveId: 'valve-c', direction: 'forward', positionId: 'extend', loadKn: 2.12, speedMmPerS: 50 },
];

export function twoLevelCircuit(mode = 'matched') {
  const project = structuredClone(branchedReturnCircuit());
  project.title = {
    matched: '三缸两级回油 · 三缸达标',
    biased: '三缸两级回油 · 两缸汇合段阻力增大',
    pending: '三缸两级回油 · 汇合段管长待核',
  }[mode];
  const { design, layout } = project;
  const ref = twoLevelReference(mode);
  design.components.find((c) => c.id === 'pump').parameters.hydraulic.displacementM3PerRev = 6e-6;
  const aValve = design.components.find((c) => c.id === 'valve');
  design.components.find((c) => c.id === 'valve-b').parameters = structuredClone(aValve.parameters);
  for (const [id, name, y] of [
    ['valve', '换向阀 C', 270],
    ['actuator', '油缸 C', 135],
  ]) {
    const component = structuredClone(design.components.find((c) => c.id === id));
    design.components.push({ ...component, id: id + '-c', label: name });
    const initial = design.initialConditions.find((i) => i.componentId === id);
    if (initial) design.initialConditions.push({ ...structuredClone(initial), componentId: id + '-c' });
    layout.components.push({ componentId: id + '-c', x: 1130, y });
  }
  const node = (nodeId) => ({ kind: 'node', nodeId });
  const port = (componentId, portId) => ({ kind: 'port', componentId, portId });
  const add = (id, from, to, parameters) => {
    design.connections.push(
      parameters
        ? { id, from, to, kind: 'pipe', model: physicalPipeModel, parameters }
        : { id, from, to, kind: 'ideal' },
    );
    layout.routes.push({ connectionId: id, mode: 'auto' });
  };
  design.nodes.push({ id: 'return-main', kind: 'ideal-hydraulic', label: '总汇流点' });
  layout.nodes.push({ nodeId: 'return-main', x: 805, y: 450 });
  design.nodes.find((n) => n.id === 'return-header').label = 'A、B 汇流点';
  for (const id of ['return-branch-a', 'return-branch-b'])
    design.connections.find((e) => e.id === id).parameters = ref.leaf;
  const trunk = design.connections.find((e) => e.id === 'return-trunk');
  trunk.from = node('return-main');
  trunk.parameters = ref.trunk;
  add('return-branch-c', port('valve-c', 'T'), node('return-main'), ref.leaf);
  add('return-ab', node('return-header'), node('return-main'), {
    ...ref.intermediate,
    ...(mode === 'pending' ? { lengthM: 0 } : {}),
  });
  add('supply-c', node('supply'), port('valve-c', 'P'));
  add('working-a-c', port('valve-c', 'A'), port('actuator-c', 'A'));
  add('working-b-c', port('valve-c', 'B'), port('actuator-c', 'B'));
  return good(parseNetworkProject(project));
}

export function twoLevelRequest() {
  const request = sharedReturnRequest();
  const phase = request.phases[0];
  const original = phase.actions[0];
  phase.name = 'A、B、C 三缸同时伸出';
  phase.actions = twoLevelInputs.map((input) => ({
    ...original,
    componentId: input.id,
    direction: input.direction,
    resistingLoad: input.loadKn * 1000,
  }));
  phase.valves = twoLevelInputs.map(({ valveId, positionId }) => ({ componentId: valveId, positionId }));
  return request;
}
