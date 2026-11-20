import { diagnostic, type NetworkProject, type NetworkEndpoint, type Result } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import {
  pipeParameters,
  returnPipeLoss,
  reportReturnPipe,
  returnAccessoryParameters,
  reportReturnAccessory,
  seriesAccessoryDrop,
  type ReturnPipeLaw,
  type ReturnAccessoryLaw,
  type ReturnAccessoryResult,
} from './network-duty-return-pipes.js';
import type { BridgeRow } from './network-duty-return-bridge.js';
const key = (e: NetworkEndpoint) => (e.kind === 'node' ? 'node:' + e.nodeId : e.componentId + ':' + e.portId);
interface Edge {
  from: number;
  to: number;
  law: ReturnPipeLaw | ReturnAccessoryLaw;
}
interface Leg {
  index: number;
  sign: number;
}
export interface Mesh {
  nodes: string[];
  edges: Edge[];
  cycles: Leg[][];
  paths: Leg[][];
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/return-mesh', message)],
});
export function findMesh(project: NetworkProject, paths: DutyPhasePaths, tank: string): Result<Mesh | null> {
  const cs = project.design.components,
    vs = cs.filter((c) => c.typeId === 'valve'),
    inlet = vs[0]?.id + ':T';
  if (!vs.length || vs.some((c) => !paths.idealReachable(c.id + ':T', inlet)) || paths.idealReachable(inlet, tank))
    return { ok: true, value: null };
  const pipes = project.design.connections.filter((e) => e.kind === 'pipe'),
    accessories = cs.filter((c) => ['flow-meter', 'return-filter'].includes(c.typeId));
  if (
    pipes.length < 4 ||
    cs.some(
      (c) =>
        !['valve', 'tank', 'cylinder', 'pump', 'relief', 'volume', 'flow-meter', 'return-filter'].includes(c.typeId),
    )
  )
    return { ok: true, value: null };
  const nodes = [tank, inlet];
  const group = (port: string) => {
    let n = nodes.findIndex((k) => paths.idealReachable(k, port));
    if (n < 0) {
      n = nodes.length;
      nodes.push(port);
    }
    return n;
  };
  const candidates = [
    ...pipes.map((p) => ({
      from: group(key(p.from)),
      to: group(key(p.to)),
      law: () => pipeParameters(project, p, '网状回油管'),
    })),
    ...accessories.map((c) => ({
      from: group(c.id + ':A'),
      to: group(c.id + ':B'),
      law: () => returnAccessoryParameters(project, c, true),
    })),
  ];
  if (
    candidates.length < nodes.length + 1 ||
    candidates.some((e) => e.from === e.to) ||
    (candidates.length === 5 && nodes.length === 4 && !accessories.length)
  )
    return { ok: true, value: null };
  if (candidates.length > 64 || candidates.length - nodes.length + 1 > 16)
    return fail('回油网超出 64 段或 16 个独立环路。');
  const treePaths: Leg[][] = Array.from({ length: nodes.length }, () => []);
  const tree = new Set<number>(),
    seen = new Set([0]),
    queue = [0];
  for (const n of queue)
    for (const [index, e] of candidates.entries()) {
      if (e.from !== n && e.to !== n) continue;
      const next = e.from === n ? e.to : e.from;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      tree.add(index);
      treePaths[next] = [...treePaths[n]!, { index, sign: e.from === n ? -1 : 1 }]; // positive flow from child toward tank
    }
  if (seen.size !== nodes.length) return { ok: true, value: null };
  if (nodes.some((_, i) => i > 1 && candidates.filter((e) => e.from === i || e.to === i).length < 2))
    return fail('网状回油存在未接通的管端，须明确终点边界。');
  const protectedPorts = cs.flatMap((c) =>
    c.typeId === 'valve'
      ? [c.id + ':P', c.id + ':A', c.id + ':B']
      : c.typeId === 'cylinder'
        ? [c.id + ':A', c.id + ':B']
        : c.typeId === 'pump' || c.typeId === 'relief'
          ? [c.id + ':P']
          : [],
  );
  if (nodes.some((n) => protectedPorts.some((p) => paths.idealReachable(n, p))))
    return fail('回油网混入供油或油缸工作节点。');
  if (
    cs.some(
      (c) =>
        (c.typeId === 'relief' && !paths.idealReachable(c.id + ':T', tank)) ||
        (c.typeId === 'volume' && nodes.some((node, i) => i > 0 && paths.idealReachable(node, c.id + ':H'))),
    )
  )
    return fail('网状回油混入独立泄流或未定义的容腔边界。');
  const edges: Edge[] = [],
    cycles: Leg[][] = [];
  for (const [index, e] of candidates.entries()) {
    const law = e.law();
    if (!law.ok) return law;
    edges.push({ ...e, law: law.value });
    if (!tree.has(index)) {
      const signs = new Map<number, number>([[index, 1]]);
      for (const l of treePaths[e.to]!) signs.set(l.index, (signs.get(l.index) ?? 0) + l.sign);
      for (const l of treePaths[e.from]!) signs.set(l.index, (signs.get(l.index) ?? 0) - l.sign);
      cycles.push([...signs].filter(([, v]) => v !== 0).map(([i, sign]) => ({ index: i, sign })));
    }
  }
  const idealGroups = nodes.map((_, i) => i);
  for (const e of edges) {
    if ('connectionId' in e.law || seriesAccessoryDrop(e.law, 1e-6) > 0) continue;
    const from = idealGroups[e.from],
      to = idealGroups[e.to];
    if (from === to) return fail('零阻附件成环，支路流量缺少唯一分配条件。');
    for (let i = 0; i < idealGroups.length; i++) if (idealGroups[i] === from) idealGroups[i] = to!;
  }
  return { ok: true, value: { nodes, edges, cycles, paths: treePaths } };
}
function drops(mesh: Mesh, i: number, q: number) {
  const law = mesh.edges[i]!.law;
  return (
    Math.sign(q) *
    ('connectionId' in law ? returnPipeLoss(law, Math.abs(q)).pressureDropPa : seriesAccessoryDrop(law, Math.abs(q)))
  );
}
export function meshPoint(mesh: Mesh, total: number) {
  const flows = mesh.edges.map(() => 0);
  for (const l of mesh.paths[1]!) flows[l.index] = total * l.sign;
  const residual = (legs: Leg[], change: number) =>
    legs.reduce((s, l) => s + l.sign * drops(mesh, l.index, flows[l.index]! + l.sign * change), 0);
  for (let it = 0; it < 180; it++) {
    const head = residual(mesh.paths[1]!, 0),
      tol = Math.max(0.00000002, Math.abs(head) * 1e-10);
    if (mesh.cycles.every((c) => Math.abs(residual(c, 0)) <= tol))
      return { head, flows, pressures: mesh.paths.map((p) => residual(p, 0)) };
    for (const c of mesh.cycles) {
      if (Math.abs(residual(c, 0)) <= tol) continue;
      let lo = -2 * total,
        hi = 2 * total;
      for (let k = 0; k < 42; k++) {
        const mid = (lo + hi) / 2;
        if (residual(c, mid) < 0) lo = mid;
        else hi = mid;
      }
      for (const l of c) flows[l.index] = flows[l.index]! + (l.sign * (hi + lo)) / 2;
    }
  }
  return undefined;
}
export function reportMesh(mesh: Mesh, total: number, tank: number) {
  const point = meshPoint(mesh, total);
  if (!point) return fail('网状回油未通过环路压差残差校核。');
  const rows: BridgeRow[] = [],
    accessories: ReturnAccessoryResult[] = [];
  for (const [i, e] of mesh.edges.entries()) {
    const q = point.flows[i]!,
      from = q < 0 ? e.to : e.from,
      to = q < 0 ? e.from : e.to,
      p = tank + point.pressures[to]!;
    if ('connectionId' in e.law) {
      const r = reportReturnPipe(e.law, Math.abs(q), p, '网状回油管');
      if (!r.ok) return r;
      rows.push({ ...r.value, from: mesh.nodes[from]!, to: mesh.nodes[to]!, role: '网状回油管' });
    } else {
      if (e.law.kind === 'filter' && q < 0)
        return fail('桥臂滤芯 [' + e.law.componentId + '] 反向过流，缺少反向压降特性。');
      const r = reportReturnAccessory({ ...e.law, forward: q >= 0 }, Math.abs(q), p);
      if (!r.ok) return r;
      accessories.push(r.value);
    }
  }
  return { ok: true as const, value: { dropPa: point.head, rows, accessories } };
}
