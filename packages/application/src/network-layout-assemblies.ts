import { connectionGraph } from '@hyd/engine';
import {
  diagnostic,
  isNetworkActuatorType,
  networkComponentPresentationBounds,
  type NetworkProject,
  type NetworkComponent,
  type NetworkPlacement,
  type NetworkEndpoint,
  type Result,
} from '@hyd/domain';
import { required, type Box, type TreeGeometry } from './network-tree-geometry.js';
import { networkLayoutProfiles } from './network-layout-roles.js';
type Assembly = {
  valveId: string;
  actuatorId: string;
  workIds: string[];
  volumes: { id: string; port: string }[];
  feed: { id: string; downstream: { id: string; port: string }; volumes: string[] }[];
  ids: string[];
};
type LayoutCandidate = { project: NetworkProject; label: string };
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('LAYOUT_UNSUPPORTED', '/layoutOperation', message)],
});
function annotationBox(c: NetworkComponent, p: NetworkPlacement) {
  const b = required(networkComponentPresentationBounds(c, p) ?? undefined);
  const y = p.y + Math.max(45, b.bottom - p.y + 24);
  const width = [...c.label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 16 : 9), 0) + 8;
  return { id: c.id, left: p.x - width / 2, right: p.x + width / 2, top: y - 16, bottom: y + 5 };
}
export function annotationBoxes(project: NetworkProject) {
  const components = new Map(project.design.components.map((c) => [c.id, c]));
  return project.layout.components.map((p) => annotationBox(required(components.get(p.componentId)), p));
}
const workComponents = new Set(['throttle', 'one-way-throttle', 'volume', 'check-valve']);

function workBranchLinks(project: NetworkProject) {
  const components = new Map(project.design.components.map((component) => [component.id, component]));
  const links = new Map<string, { portId: string | undefined; endpoint: NetworkEndpoint }[]>();
  for (const { from, to } of project.design.connections) {
    for (const [a, b] of [
      [from, to],
      [to, from],
    ] as const) {
      const id = a.kind === 'port' ? 'p:' + a.componentId : 'n:' + a.nodeId;
      const neighbors = links.get(id) ?? [];
      neighbors.push({ portId: a.kind === 'port' ? a.portId : undefined, endpoint: b });
      links.set(id, neighbors);
    }
  }
  const anchors = new Map<string, Set<string>>();
  for (const { id, typeId } of project.design.components.filter(
    ({ typeId }) => networkLayoutProfiles[typeId]?.role === 'directional',
  )) {
    const visited = new Set<string>();
    const ports = networkLayoutProfiles[typeId]?.ports;
    const queue = (links.get('p:' + id) ?? [])
      .filter(({ portId }) => portId !== undefined && ports?.[portId] === 'work')
      .map(({ endpoint }) => endpoint);
    for (const endpoint of queue) {
      const key = endpoint.kind === 'port' ? 'p:' + endpoint.componentId : 'n:' + endpoint.nodeId;
      const terminal = endpoint.kind === 'port' ? key + ':' + endpoint.portId : key;
      if (visited.has(terminal)) continue;
      visited.add(terminal);
      if (endpoint.kind === 'port') {
        const type = components.get(endpoint.componentId)?.typeId;
        if (type === undefined || (!isNetworkActuatorType(type) && !workComponents.has(type))) continue;
        const owners = anchors.get(endpoint.componentId) ?? new Set();
        owners.add(id);
        anchors.set(endpoint.componentId, owners);
        // Follow the working connection on this oil port, and through throttles only.
        if (type === 'volume') continue;
        for (const { portId, endpoint: next } of links.get(key) ?? []) {
          if (portId === endpoint.portId || type === 'throttle' || type === 'one-way-throttle') queue.push(next);
        }
      } else {
        queue.push(...(links.get(key) ?? []).map(({ endpoint: next }) => next));
      }
    }
  }
  return { links, anchors };
}

const pressureTypes = new Set(['pressure-reducing', 'sequence-valve']);
const key = (id: string, port: string) => `p:${id}:${port}`;

/** Geometric ownership follows working ports and upstream supply ports. Crossing
 * a valve here assigns a drawing group only; the hydraulic nets remain distinct. */
export function branchAssemblies(project: NetworkProject): Result<readonly Assembly[]> {
  const compiled = connectionGraph(project);
  if (!compiled.ok) return compiled;
  const components = new Map(project.design.components.map((c) => [c.id, c]));
  const nets = compiled.value.nets;
  const netAt = (id: string, port: string) => nets.find((n) => n.terminals.some((t) => t.key === key(id, port)));
  const { anchors } = workBranchLinks(project);
  const assemblies: Assembly[] = [];
  for (const valve of project.design.components
    .filter((c) => c.typeId === 'valve')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const workIds = [...anchors].filter(([, owners]) => owners.size === 1 && owners.has(valve.id)).map(([id]) => id);
    const actuatorIds = workIds.filter((id) => isNetworkActuatorType(required(components.get(id)).typeId));
    if (actuatorIds.length !== 1) continue;
    const actuatorId = required(actuatorIds[0]);
    const volumes = ['A', 'B'].flatMap((port) =>
      (netAt(actuatorId, port)?.terminals ?? [])
        .filter((t) => components.get(t.ownerId)?.typeId === 'volume')
        .map((t) => ({ id: t.ownerId, port })),
    );
    const feed: Assembly['feed'] = [],
      seen = new Set();
    let downstream = { id: valve.id, port: 'P' };
    while (true) {
      const net = netAt(downstream.id, downstream.port);
      if (!net || net.terminals.some((t) => t.ownerId !== valve.id && components.get(t.ownerId)?.typeId === 'valve'))
        break;
      const upstream = net.terminals.filter(
        (t) => pressureTypes.has(components.get(t.ownerId)?.typeId ?? '') && t.portId === 'A' && !seen.has(t.ownerId),
      );
      if (upstream.length !== 1) break;
      const id = required(upstream[0]).ownerId;
      seen.add(id);
      feed.push({
        id,
        downstream: { ...downstream },
        volumes: net.terminals.filter((t) => components.get(t.ownerId)?.typeId === 'volume').map((t) => t.ownerId),
      });
      downstream = { id, port: 'P' };
    }
    assemblies.push({
      valveId: valve.id,
      actuatorId,
      workIds,
      volumes,
      feed,
      ids: [...new Set([valve.id, ...workIds, ...feed.flatMap((f) => [f.id, ...f.volumes])])],
    });
  }
  return { ok: true, value: assemblies };
}

function extents(boxes: readonly Box[]) {
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    right: Math.max(...boxes.map((b) => b.right)),
    top: Math.min(...boxes.map((b) => b.top)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/** Registered body and name footprints produce all coordinates. No example IDs,
 * screenshot positions, new score coefficients, or independent actuator X moves. */
export function structuredBranchLayouts(
  project: NetworkProject,
  geometry: TreeGeometry,
): Result<readonly LayoutCandidate[]> {
  const groups = branchAssemblies(project);
  if (!groups.ok) return groups;
  const actuatorCount = project.design.components.filter((c) => isNetworkActuatorType(c.typeId)).length;
  // An assembly that misses an actuator cannot move that actuator to the
  // station row. Use the general topological placement for that circuit.
  if (
    !groups.value.length ||
    groups.value.length !== actuatorCount ||
    project.design.components.filter((c) => c.typeId === 'pump').length > 1
  )
    return { ok: true, value: [] };
  const assigned = new Set(groups.value.flatMap((g) => g.ids));
  const stationOrder = new Map<string, number>();
  for (const component of project.design.components) {
    if (assigned.has(component.id)) continue;
    const type = component.typeId;
    const role = networkLayoutProfiles[type]?.role;
    // Only supported station equipment has a slot in this recipe. A meter,
    // divider or load-side valve must keep its topology-based placement.
    if (type === 'volume') stationOrder.set(component.id, 0);
    else if (type === 'relief') stationOrder.set(component.id, 1);
    else if (role === 'source') stationOrder.set(component.id, type === 'pump' ? 2 : 4);
    else if (role === 'reservoir') stationOrder.set(component.id, 3);
    else return { ok: true, value: [] };
  }
  const station = [...stationOrder.keys()].sort(
    (a, b) => required(stationOrder.get(a)) - required(stationOrder.get(b)) || a.localeCompare(b),
  );
  const { obstacles, position } = geometry;
  if (obstacles(project).length !== project.design.components.length) return fail('元件缺少注册包络。');
  for (const group of groups.value)
    for (const id of [group.valveId, group.actuatorId]) {
      const p = project.layout.components.find((p) => p.componentId === id);
      if (!p || (p.rotation !== undefined && p.rotation !== 0)) return { ok: true, value: [] };
    }
  const types = new Map(project.design.components.map((c) => [c.id, c.typeId]));
  const components = new Map(project.design.components.map((c) => [c.id, c]));
  const layouts: LayoutCandidate[] = [];
  for (const gap of [24, 40, 64])
    for (const side of [-1, 1]) {
      const placements = new Map(project.layout.components.map((p) => [p.componentId, { ...p }]));
      const current = () => ({
        ...project,
        layout: {
          ...project.layout,
          components: project.layout.components.map((p) => required(placements.get(p.componentId))),
        },
      });
      const box = (id: string) => required(obstacles(current()).find((b) => b.id === id));
      const name = (id: string) => annotationBox(required(components.get(id)), required(placements.get(id)));
      const port = (id: string, portId: string) =>
        required(position(current(), { kind: 'port', componentId: id, portId }) ?? undefined);
      const workCenter = (id: string) => {
        const a = port(id, 'A');
        const b = position(current(), { kind: 'port', componentId: id, portId: 'B' });
        return b ? (a.x + b.x) / 2 : a.x;
      };
      const shift = (ids: readonly string[], dx: number, dy: number) => {
        for (const id of ids) {
          const p = required(placements.get(id));
          placements.set(id, { ...p, x: p.x + dx, y: p.y + dy });
        }
      };
      const above = (id: string, floor: number) => {
        const b = box(id),
          n = name(id);
        shift([id], 0, Math.min(floor - gap - b.bottom, floor - 8 - n.bottom));
      };
      for (const group of groups.value) {
        const { valveId, actuatorId } = group;
        const valve = box(valveId);
        const meters = group.workIds.filter((id) => ['throttle', 'one-way-throttle'].includes(types.get(id) ?? ''));
        let workFloor = valve.top;
        for (const id of meters) {
          const edge = project.design.connections.find(
            (e) =>
              [e.from, e.to].some(
                (p) => p.kind === 'port' && p.componentId === valveId && ['A', 'B'].includes(p.portId),
              ) && [e.from, e.to].some((p) => p.kind === 'port' && p.componentId === id),
          );
          const end = edge && [edge.from, edge.to].find((p) => p.kind === 'port' && p.componentId === valveId);
          const own = edge && [edge.from, edge.to].find((p) => p.kind === 'port' && p.componentId === id);
          if (end?.kind === 'port' && own?.kind === 'port')
            shift([id], port(valveId, end.portId).x - port(id, own.portId).x, 0);
          above(id, valve.top);
          workFloor = Math.min(workFloor, box(id).top);
        }
        shift([actuatorId], workCenter(valveId) - workCenter(actuatorId), 0);
        above(actuatorId, workFloor);
        const actor = box(actuatorId);
        for (const { id, port: workPort } of group.volumes) {
          const anchor = port(actuatorId, workPort),
            p = required(placements.get(actuatorId));
          const x = anchor.x < p.x ? actor.left : actor.right;
          shift([id], x - port(id, 'H').x, 0);
          above(id, actor.top);
        }
        let feedFloor = Math.max(valve.bottom + gap, name(valveId).bottom + 8);
        for (const feed of group.feed) {
          const b = box(feed.id),
            down = port(feed.downstream.id, feed.downstream.port);
          shift([feed.id], down.x - port(feed.id, 'A').x, feedFloor - b.top);
          const pressure = box(feed.id),
            output = port(feed.id, 'A');
          const lane = extents([pressure, box(feed.downstream.id)]);
          for (const id of feed.volumes) {
            const volume = box(id),
              label = name(id);
            const desired =
              side < 0
                ? lane.left - gap - Math.max(volume.right, label.right)
                : lane.right + gap - Math.min(volume.left, label.left);
            shift([id], desired, (down.y + output.y) / 2 - port(id, 'H').y);
          }
          feedFloor = Math.max(pressure.bottom + gap, name(feed.id).bottom + 8);
        }
      }
      // Retain the approved common actuator band for ordinary parallel branches.
      // Pressure-chain groups keep the independently verified local assembly geometry.
      if (groups.value.every((g) => g.feed.length === 0)) {
        const targetY = Math.min(...groups.value.map((g) => required(placements.get(g.actuatorId)).y));
        for (const g of groups.value)
          shift([g.actuatorId, ...g.volumes.map((v) => v.id)], 0, targetY - required(placements.get(g.actuatorId)).y);
      }
      // Pack complete columns, including branch-specific pressure valves and drains.
      const columns = groups.value.map((g) => ({ ...g, ...extents(g.ids.flatMap((id) => [box(id), name(id)])) }));
      if (columns.length > 1) {
        let left = Math.min(...columns.map((c) => c.left));
        const referenceY = Math.max(...columns.map((c) => required(placements.get(c.valveId)).y));
        for (const c of columns) {
          shift(c.ids, left - c.left, referenceY - required(placements.get(c.valveId)).y);
          left += c.right - c.left + gap;
        }
      }
      const branch = extents([...assigned].flatMap((id) => [box(id), name(id)]));
      let left = branch.left;
      for (const id of station) {
        const b = extents([box(id), name(id)]);
        shift([id], left - b.left, branch.bottom + 64 - b.top);
        left += b.right - b.left + 32;
      }
      const pump = station.find((id) => types.get(id) === 'pump');
      const tank = station.find((id) => types.get(id) === 'tank');
      if (pump && tank) shift([tank], 0, port(pump, 'S').y - port(tank, 'T').y);
      // Keep the same stable actuator reference as the existing arrangement command.
      // Otherwise every repeat would move the whole drawing by the local compaction delta.
      const referenceId = project.design.components
        .filter((c) => isNetworkActuatorType(c.typeId))
        .map((c) => c.id)
        .sort((a, b) => a.localeCompare(b, 'en'))[0];
      if (referenceId) {
        const before = required(project.layout.components.find((p) => p.componentId === referenceId)),
          after = required(placements.get(referenceId));
        shift([...placements.keys()], before.x - after.x, before.y - after.y);
      }
      const final = current(),
        boxes = obstacles(final);
      const collisions = boxes.flatMap((a, i) =>
        boxes
          .slice(i + 1)
          .filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
          .map((b) => [a, b]),
      );
      if (collisions.length) {
        continue;
      }
      layouts.push({ project: final, label: `assembly-gap-${gap}-side-${side}` });
    }
  return { ok: true, value: layouts };
}
