import { parseNetworkProject } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { lengthFor, segment, twoLevelCircuit, twoLevelInputs, twoLevelRequest } from './two-level-return.mjs';

const ratio = 0.6;
const tankPa = 1e5;
const geometry = (d, k) => ({ internalDiameterM: d, roughnessM: 4e-5, localLossCoefficient: k });

export const treeInputs = [
  ...twoLevelInputs.slice(0, 2),
  { ...twoLevelInputs[2], loadKn: 2 },
  { ...twoLevelInputs[2], id: 'actuator-d', valveId: 'valve-d', loadKn: 2 },
];

export function treeReference(mode = 'matched') {
  const qAB = mode === 'biased' ? 2.7 : 3;
  const qCD = 6 - qAB;
  const leaf = lengthFor(1.8, geometry(0.006, 8), 1e5);
  const trunk = lengthFor(7.2, geometry(0.008, 18), 3e5);
  const cd = lengthFor(3.6, geometry(0.004, 8), 2e5);
  const trunkPoint = segment(7.2, trunk);
  const cdPoint = segment(2 * qCD * ratio, cd);
  const abLeaf = segment(qAB * ratio, leaf);
  const cdLeaf = segment(qCD * ratio, leaf);
  const mainPa = tankPa + trunkPoint.totalPa;
  const cdT = mainPa + cdPoint.totalPa + cdLeaf.totalPa;
  const pressurePa = 2e6 + ratio * cdT + 1e6 * (qCD / 3) ** 2;
  const abT = (pressurePa - 2e6 - 1e6 * (qAB / 3) ** 2) / ratio;
  const ab = lengthFor(2 * qAB * ratio, geometry(0.004, 8), abT - abLeaf.totalPa - mainPa);
  const abPoint = segment(2 * qAB * ratio, ab);
  const chamberLoss = (1e6 * ratio ** 2) / (1 + ratio ** 3);
  return {
    qAB,
    qCD,
    pressurePa,
    abT,
    cdT,
    abChamber: abT + chamberLoss * (qAB / 3) ** 2,
    cdChamber: cdT + chamberLoss * (qCD / 3) ** 2,
    pipes: { ab, cd, leaf, trunk },
    points: [abLeaf, abLeaf, cdLeaf, cdLeaf, abPoint, cdPoint, trunkPoint],
  };
}

export function treeCircuit(mode = 'matched') {
  const project = structuredClone(twoLevelCircuit());
  project.title = {
    matched: '四缸树状回油 · 四缸达标',
    biased: '四缸树状回油 · AB 汇合段阻力增大',
    pending: '四缸树状回油 · CD 汇合段管长待核',
  }[mode];
  const { design, layout } = project;
  const { pipes } = treeReference(mode);
  const port = (componentId, portId) => ({ kind: 'port', componentId, portId });
  const node = (nodeId) => ({ kind: 'node', nodeId });
  const pipe = (id) => design.connections.find((edge) => edge.id === id);
  design.components.find((c) => c.id === 'pump').parameters.hydraulic.displacementM3PerRev = 8e-6;
  for (const [id, label, y] of [
    ['valve', '换向阀 D', 270],
    ['actuator', '油缸 D', 135],
  ]) {
    const component = structuredClone(design.components.find((c) => c.id === id + '-c'));
    design.components.push({ ...component, id: id + '-d', label });
    const initial = design.initialConditions.find((i) => i.componentId === id + '-c');
    if (initial) design.initialConditions.push({ ...structuredClone(initial), componentId: id + '-d' });
    layout.components.push({ componentId: id + '-d', x: 1440, y });
  }
  design.nodes.push({ id: 'return-header-cd', kind: 'ideal-hydraulic', label: 'C、D 汇流点' });
  layout.nodes.push({ nodeId: 'return-header-cd', x: 1240, y: 392 });
  pipe('return-branch-c').to = node('return-header-cd');
  for (const id of ['return-branch-a', 'return-branch-b', 'return-branch-c']) pipe(id).parameters = pipes.leaf;
  pipe('return-ab').parameters = pipes.ab;
  pipe('return-trunk').parameters = pipes.trunk;
  for (const [base, id, from, to, parameters] of [
    ['return-branch-c', 'return-branch-d', port('valve-d', 'T'), node('return-header-cd'), pipes.leaf],
    [
      'return-ab',
      'return-cd',
      node('return-header-cd'),
      node('return-main'),
      {
        ...pipes.cd,
        ...(mode === 'pending' ? { lengthM: 0 } : {}),
      },
    ],
    ['supply-c', 'supply-d', node('supply'), port('valve-d', 'P')],
    ['working-a-c', 'working-a-d', port('valve-d', 'A'), port('actuator-d', 'A')],
    ['working-b-c', 'working-b-d', port('valve-d', 'B'), port('actuator-d', 'B')],
  ]) {
    design.connections.push({ ...pipe(base), id, from, to, ...(parameters ? { parameters } : {}) });
    layout.routes.push({ connectionId: id, mode: 'auto' });
  }
  return good(parseNetworkProject(project));
}

export function treeRequest() {
  const request = twoLevelRequest();
  const phase = request.phases[0];
  const original = phase.actions[0];
  phase.name = 'A、B、C、D 四缸同时伸出';
  phase.actions = treeInputs.map(({ id, loadKn }) => ({ ...original, componentId: id, resistingLoad: loadKn * 1000 }));
  phase.valves = treeInputs.map(({ valveId, positionId }) => ({ componentId: valveId, positionId }));
  return request;
}
