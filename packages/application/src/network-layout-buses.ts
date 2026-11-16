import {
  isNetworkActuatorType,
  networkComponentPresentationBounds,
  type NetworkEndpoint,
  type NetworkProject,
} from '@hyd/domain';

export interface NetworkDrawingBus {
  readonly kind: 'supply' | 'return';
  readonly y: number;
  readonly connectionIds: ReadonlySet<string>;
  readonly nodeIds: ReadonlySet<string>;
}

const endpointKey = (end: NetworkEndpoint): string =>
  end.kind === 'port' ? 'port:' + end.componentId + ':' + end.portId : 'node:' + end.nodeId;

/** Identify actual common ideal supply/return nets. Internal component passages
 * and physical pipes are never shorted together to manufacture a drawing bus. */
export function networkLayoutBuses(project: NetworkProject): readonly NetworkDrawingBus[] {
  if (project.design.components.filter((c) => isNetworkActuatorType(c.typeId)).length < 2) return [];
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let current = key;
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  for (const edge of project.design.connections) {
    if (edge.kind !== 'ideal') continue;
    const a = root(endpointKey(edge.from)),
      b = root(endpointKey(edge.to));
    if (a !== b) parent.set(a > b ? a : b, a > b ? b : a);
  }
  const groups = new Map<string, NetworkProject['design']['connections'][number][]>();
  for (const edge of project.design.connections) {
    if (edge.kind !== 'ideal') continue;
    const key = root(endpointKey(edge.from)),
      group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }
  const eligible: { kind: 'supply' | 'return'; edges: NetworkProject['design']['connections'][number][] }[] = [];
  for (const edges of groups.values()) {
    const ends = edges.flatMap((edge) => [edge.from, edge.to]);
    const ports = ends.flatMap((end) => {
      if (end.kind !== 'port') return [];
      const c = project.design.components.find((c) => c.id === end.componentId);
      return c ? [{ component: c, portId: end.portId }] : [];
    });
    const sources = ports.some(
      ({ component: c, portId }) => (c.typeId === 'pump' || c.typeId === 'pressure-source') && portId === 'P',
    );
    const tanks = ports.some(({ component: c, portId }) => c.typeId === 'tank' && portId === 'T');
    const consumers = new Set(
      ports
        .filter(
          ({ component: c, portId }) =>
            (c.typeId === 'valve' && (portId === 'P' || portId === 'T')) ||
            (['throttle', 'one-way-throttle'].includes(c.typeId) && portId === 'A'),
        )
        .map(({ component }) => component.id),
    );
    // An already shorted supply/return net is not two separate drawing channels.
    if (consumers.size < 2 || sources === tanks) continue;
    eligible.push({ kind: sources ? 'supply' : 'return', edges });
  }
  if (!eligible.some((g) => g.kind === 'supply') || !eligible.some((g) => g.kind === 'return')) return [];
  const controls = project.design.components.filter(
    (c) =>
      isNetworkActuatorType(c.typeId) || ['valve', 'throttle', 'one-way-throttle', 'check-valve'].includes(c.typeId),
  );
  const bounds = controls.flatMap((c) => {
    const p = project.layout.components.find((p) => p.componentId === c.id);
    const b = p && networkComponentPresentationBounds(c, p);
    return b ? [b] : [];
  });
  if (!bounds.length) return [];
  const bottom = Math.max(...bounds.map((b) => b.bottom));
  const ordered = eligible.sort(
    (a, b) =>
      Number(a.kind === 'return') - Number(b.kind === 'return') ||
      a.edges
        .map((e) => e.id)
        .sort()
        .join(':')
        .localeCompare(
          b.edges
            .map((e) => e.id)
            .sort()
            .join(':'),
          'en',
        ),
  );
  return ordered.map((group, i) => ({
    kind: group.kind,
    y: Number((bottom + 64 + i * 40).toFixed(6)),
    connectionIds: new Set(group.edges.map((edge) => edge.id)),
    nodeIds: new Set(
      group.edges.flatMap((edge) => [edge.from, edge.to]).flatMap((end) => (end.kind === 'node' ? [end.nodeId] : [])),
    ),
  }));
}
