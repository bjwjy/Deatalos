import type { NetworkConnection, NetworkEndpoint, NetworkProject, Result } from '@hyd/domain';
import {
  pipeParameters,
  reportReturnPipe,
  returnPipeLoss,
  type ReturnPipeLaw,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';
type Pipe = Extract<NetworkConnection, { kind: 'pipe' }>;
const key = (e: NetworkEndpoint) => (e.kind === 'node' ? 'node:' + e.nodeId : e.componentId + ':' + e.portId);

/** Isolate unbranched cylinder-to-valve lines before solving the shared header network. */
export function cylinderPipes(project: NetworkProject) {
  const adjacency = new Map<string, NetworkConnection[]>();
  for (const edge of project.design.connections) {
    if (edge.kind === 'signal') continue;
    for (const port of [key(edge.from), key(edge.to)]) {
      const list = adjacency.get(port) ?? [];
      list.push(edge);
      adjacency.set(port, list);
    }
  }
  const workPorts = new Set(
    project.design.components.filter((c) => c.typeId === 'valve').flatMap((c) => [c.id + ':A', c.id + ':B']),
  );
  const pipes = new Map<string, Pipe[]>(),
    ids = new Set<string>();
  for (const c of project.design.components.filter((c) => c.typeId === 'cylinder'))
    for (const side of ['A', 'B']) {
      const start = c.id + ':' + side;
      let port = start;
      let previous: NetworkConnection | undefined;
      const line: Pipe[] = [];
      const seen = new Set<string>();
      while (port === start || port.startsWith('node:')) {
        if (seen.has(port)) break;
        seen.add(port);
        const links = adjacency.get(port)?.filter((e) => e !== previous);
        if (links?.length !== 1) break;
        const edge = links[0]!;
        if (edge.kind === 'pipe') line.push(edge);
        previous = edge;
        port = key(edge.from) === port ? key(edge.to) : key(edge.from);
      }
      if (line.length && workPorts.has(port) && adjacency.get(port)?.length === 1) {
        pipes.set(start, line);
        for (const e of line) ids.add(e.id);
      }
    }
  const connections = project.design.connections.map((e) =>
    ids.has(e.id) ? { kind: 'ideal' as const, id: e.id, from: e.from, to: e.to } : e,
  );
  return { pipes, ids, idealWork: ids.size ? { ...project, design: { ...project.design, connections } } : project };
}
export function workLaws(project: NetworkProject, pipes: readonly Pipe[], role: string): Result<ReturnPipeLaw[]> {
  const result: ReturnPipeLaw[] = [];
  for (const p of pipes) {
    const parsed = pipeParameters(project, p, role);
    if (!parsed.ok) return parsed;
    result.push(parsed.value);
  }
  return { ok: true, value: result };
}
export const workDrop = (pipes: readonly ReturnPipeLaw[], flow: number) =>
  pipes.reduce((sum, p) => sum + returnPipeLoss(p, flow).pressureDropPa, 0);
export function workReport(
  laws: readonly ReturnPipeLaw[],
  flow: number,
  downstream: number,
  role: string,
): Result<(ReturnPipeResult & { role: string })[]> {
  const rows: (ReturnPipeResult & { role: string })[] = [];
  let pressure = downstream;
  for (const law of laws) {
    const r = reportReturnPipe(law, flow, pressure, role);
    if (!r.ok) return r;
    rows.push({ ...r.value, role });
    pressure = r.value.upstreamPressurePa;
  }
  return { ok: true, value: rows };
}
