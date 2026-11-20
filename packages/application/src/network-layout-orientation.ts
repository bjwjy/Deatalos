import {
  networkPortAnchor,
  type NetworkEndpoint,
  type NetworkPlacement,
  type NetworkProject,
  type NetworkRotation,
} from '@hyd/domain';
import { distance } from './network-tree-geometry.js';

type Port = Extract<NetworkEndpoint, { kind: 'port' }>;
type Proposal = { placement: NetworkPlacement; gain: number };
const quarterTurns: readonly NetworkRotation[] = [0, 90, 180, 270];

/** Shortlist directions using the real port anchors and facing. The full router
 * and drawing score decide whether any of these estimates actually pay off. */
export function arrangementOrientations(
  project: NetworkProject,
): readonly { project: NetworkProject; label: string }[] {
  const components = new Map(project.design.components.map((c) => [c.id, c]));
  const placements = new Map(project.layout.components.map((p) => [p.componentId, p]));
  const nodes = new Map(project.layout.nodes.map((p) => [p.nodeId, p]));
  const incident = new Map<string, { port: Port; peer: NetworkEndpoint }[]>();
  for (const { from, to } of project.design.connections) {
    for (const [port, peer] of [
      [from, to],
      [to, from],
    ] as const) {
      if (port.kind !== 'port' || (peer.kind === 'port' && peer.componentId === port.componentId)) continue;
      const entries = incident.get(port.componentId) ?? [];
      entries.push({ port, peer });
      incident.set(port.componentId, entries);
    }
  }
  function cost(p: NetworkPlacement): number {
    const component = components.get(p.componentId);
    if (!component) return Infinity;
    let sum = 0;
    for (const { port, peer } of incident.get(p.componentId) ?? []) {
      const anchor = networkPortAnchor(component, p, port.portId);
      const peerComponent = peer.kind === 'port' ? components.get(peer.componentId) : undefined;
      const peerPlacement = peer.kind === 'port' ? placements.get(peer.componentId) : undefined;
      const target =
        peer.kind === 'node'
          ? nodes.get(peer.nodeId)
          : peerComponent && peerPlacement && networkPortAnchor(peerComponent, peerPlacement, peer.portId);
      if (!anchor || !target) return Infinity;
      const projection = (target.x - anchor.x) * anchor.dx + (target.y - anchor.y) * anchor.dy;
      sum += distance(anchor, target) + 2 * Math.max(0, 12 - projection);
    }
    return sum;
  }
  function choices(p: NetworkPlacement): Proposal[] {
    // The gauge has an upright face and distinct A/B taps. A shorter pipe
    // alone should not turn its dial or exchange the visual tap positions.
    const type = components.get(p.componentId)?.typeId;
    if (type === 'tank' || type === 'differential-pressure-gauge') return [];
    const baseline = cost(p),
      options: Proposal[] = [];
    const { rotation: oldRotation, mirrored: oldMirror, ...rest } = p;
    for (const mirrored of [!!oldMirror, !oldMirror])
      for (const rotation of quarterTurns) {
        if (rotation === (oldRotation ?? 0) && mirrored === !!oldMirror) continue;
        const placement: NetworkPlacement = {
          ...rest,
          ...(rotation !== 0 || oldRotation !== undefined ? { rotation } : {}),
          ...(mirrored ? { mirrored: true } : {}),
        };
        const gain = baseline - cost(placement);
        if (gain > 1e-8) options.push({ placement, gain });
      }
    return options.sort((a, b) => b.gain - a.gain);
  }
  const ordered = [...incident.keys()].sort().flatMap((id) => {
    const p = placements.get(id);
    return p ? [{ p, options: choices(p) }] : [];
  });
  const options = ordered
    .flatMap(({ p, options }) =>
      options.map((option) => ({ ...option, flips: p.mirrored !== option.placement.mirrored })),
    )
    .sort((a, b) => b.gain - a.gain);
  const result: { project: NetworkProject; label: string }[] = [];
  const seen = new Set<string>();
  function add(label: string, changed: ReadonlyMap<string, NetworkPlacement>): void {
    if (!changed.size) return;
    const key = JSON.stringify([...changed.values()].sort((a, b) => a.componentId.localeCompare(b.componentId)));
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      label,
      project: {
        ...project,
        layout: {
          ...project.layout,
          components: project.layout.components.map((p) => changed.get(p.componentId) ?? p),
        },
      },
    });
  }
  for (const flips of [false, true]) {
    const pick = options.find((option) => option.flips === flips)?.placement;
    if (pick) add(flips ? 'mirror' : 'rotate', new Map([[pick.componentId, pick]]));
  }
  // Recalculate after each choice so two facing components do not both flip to
  // resolve the same mismatch. Stable order also makes ties reproducible.
  const combined = new Map<string, NetworkPlacement>();
  for (const { p } of ordered.sort((a, b) => (b.options[0]?.gain ?? 0) - (a.options[0]?.gain ?? 0))) {
    const pick = choices(p)[0]?.placement;
    if (!pick) continue;
    combined.set(p.componentId, pick);
    placements.set(p.componentId, pick);
  }
  add('combined', combined);
  return result;
}
