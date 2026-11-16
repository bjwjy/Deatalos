import type { NetworkEndpoint, NetworkProject } from '@hyd/domain';
import { networkLayoutProfiles } from './network-layout-roles.js';

type Port = Extract<NetworkEndpoint, { kind: 'port' }>;
type WorkRow = { readonly actuator: string; readonly depth: number };
type WorkStages = { readonly rows: ReadonlyMap<string, WorkRow>; readonly shared: ReadonlySet<string> };
const key = (end: NetworkEndpoint) =>
  end.kind === 'node' ? 'n:' + end.nodeId : JSON.stringify([end.componentId, end.portId]);

/** Wire adjacency for placement, including physical pipes. Only wire ends and
 * junctions are traversed here. These groups never replace hydraulic nets. */
function connectedPorts(project: NetworkProject): ReadonlyMap<string, readonly Port[]> {
  const links = new Map<string, NetworkEndpoint[]>();
  for (const { from, to, kind } of project.design.connections) {
    if (kind === 'signal') continue;
    for (const [a, b] of [
      [from, to],
      [to, from],
    ] as const) {
      const id = key(a),
        peers = links.get(id) ?? [];
      peers.push(b);
      links.set(id, peers);
    }
  }
  const groups = new Map<string, readonly Port[]>(),
    visited = new Set<string>();
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const ports = new Map<string, Port>(),
      queue = [start];
    visited.add(start);
    for (const id of queue) {
      for (const end of links.get(id) ?? []) {
        const next = key(end);
        if (end.kind === 'port') ports.set(next, end);
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    const terminals = [...ports.values()];
    for (const id of ports.keys()) groups.set(id, terminals);
  }
  return groups;
}

/** Find the order of an unambiguous work line from its actuator oil port.
 * A tap is a side connection. It cannot create a shortcut to a second oil line. */
export function networkLayoutWorkStages(project: NetworkProject): WorkStages {
  const profiles = new Map(project.design.components.map((c) => [c.id, networkLayoutProfiles[c.typeId]]));
  const rows = new Map<string, WorkRow>(),
    shared = new Set<string>();
  if (
    ![...profiles.values()].some(
      (p) => p?.role === 'divider' || p?.role === 'flow-control' || p?.role === 'pressure-stage',
    )
  )
    return { rows, shared };
  const nets = connectedPorts(project);
  const isTap = (p: Port) => profiles.get(p.componentId)?.ports[p.portId] === 'tap';
  const neighbors = (p: Port) => (nets.get(key(p)) ?? []).filter((peer) => key(peer) !== key(p));
  const primary = new Set(['through', 'inlet', 'outlet', 'high-pressure']);
  const splitClaims = new Map<string, { actuator: string; port: string; members: Map<string, number> }[]>();
  const ambiguous = new Set<string>();
  const claim = (actuator: string, members: ReadonlyMap<string, number>) => {
    for (const [id, depth] of members) {
      const old = rows.get(id);
      if (old && old.actuator !== actuator) ambiguous.add(id);
      else rows.set(id, { actuator, depth: Math.max(depth, old?.depth ?? 0) });
    }
  };
  for (const [actuator, profile] of profiles) {
    if (profile?.role !== 'actuator') continue;
    for (const [portId, usage] of Object.entries(profile.ports)) {
      if (usage !== 'work') continue;
      let current: Port = { kind: 'port', componentId: actuator, portId };
      let depth = 1,
        hasStage = false;
      const seen = new Set([actuator]),
        members = new Map<string, number>();
      while (true) {
        const peers = neighbors(current);
        const line = peers.filter((p) => !isTap(p));
        const next = line.length === 1 ? line[0] : undefined;
        if (!next || seen.has(next.componentId)) break;
        for (const tap of peers.filter(isTap)) members.set(tap.componentId, Math.max(1, depth - 1));
        const id = next.componentId,
          part = profiles.get(id),
          use = part?.ports[next.portId];
        if (part?.role === 'directional' && use === 'work') {
          if (hasStage) {
            members.set(id, depth);
            claim(actuator, members);
          }
          break;
        }
        if (part?.role === 'divider') {
          if (use === 'common' && depth === 1) {
            members.set(id, depth);
            claim(actuator, members);
          } else if (use === 'work') {
            const claims = splitClaims.get(id) ?? [];
            claims.push({ actuator, port: next.portId, members });
            splitClaims.set(id, claims);
          }
          break;
        }
        if (!part || !use || !primary.has(use) || !['inline', 'flow-control', 'pressure-stage'].includes(part.role))
          break;
        const exit = Object.entries(part.ports).find(
          ([port, role]) => port !== next.portId && role !== undefined && primary.has(role),
        );
        if (!exit) break;
        seen.add(id);
        members.set(id, depth++);
        hasStage ||= part.role !== 'inline';
        current = { kind: 'port', componentId: id, portId: exit[0] };
      }
    }
  }
  for (const [id, claims] of splitClaims) {
    if (new Set(claims.map((c) => c.actuator)).size < 2 || new Set(claims.map((c) => c.port)).size < 2) continue;
    const common = Object.entries(profiles.get(id)?.ports ?? {}).find(([, role]) => role === 'common')?.[0];
    if (!common) continue;
    const feed = neighbors({ kind: 'port', componentId: id, portId: common }).filter((p) => !isTap(p));
    const control = feed.length === 1 ? feed[0] : undefined;
    if (!control) continue;
    const profile = profiles.get(control.componentId);
    if (!profile || (profile.role !== 'directional' && profile.role !== 'source')) continue;
    const usage = profile.ports[control.portId];
    if (usage !== 'work' && usage !== 'outlet') continue;
    shared.add(id);
    if (profile.role === 'directional') shared.add(control.componentId);
    for (const item of claims) claim(item.actuator, item.members);
  }
  for (const id of ambiguous) rows.delete(id);
  return { rows, shared };
}
