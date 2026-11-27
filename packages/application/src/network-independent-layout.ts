import { diagnostic, type NetworkEndpoint, type NetworkProject, type Result } from '@hyd/domain';
import { annotationBoxes } from './network-layout-assemblies.js';
import { networkDrawingRoutes, networkTreeGeometry } from './network-routing.js';
import { readTreeRoutes, saveTreeRoutes } from './network-routing-cache.js';
import { required, type Point } from './network-tree-geometry.js';

type Routes = ReadonlyMap<string, readonly Point[]>;
type Group = { keys: Set<string>; edges: Set<string> };
const groupGap = 96;
const componentKey = (id: string) => 'component:' + id;
const nodeKey = (id: string) => 'node:' + id;
const owner = (end: NetworkEndpoint) => (end.kind === 'port' ? componentKey(end.componentId) : nodeKey(end.nodeId));
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('LAYOUT_UNSUPPORTED', '/layoutOperation', message)],
});

/** Component ownership groups the drawing. The oil nets inside a group are
 * still resolved separately by the original router. */
function groupsOf(project: NetworkProject): Group[] {
  const adjacency = new Map<string, string[]>();
  for (const { id } of project.design.components) adjacency.set(componentKey(id), []);
  for (const { id } of project.design.nodes) adjacency.set(nodeKey(id), []);
  for (const { from, to } of project.design.connections) {
    const a = owner(from),
      b = owner(to);
    required(adjacency.get(a)).push(b);
    required(adjacency.get(b)).push(a);
  }
  const groups: Group[] = [],
    byOwner = new Map<string, Group>();
  for (const start of adjacency.keys()) {
    if (byOwner.has(start)) continue;
    const group: Group = { keys: new Set([start]), edges: new Set() };
    byOwner.set(start, group);
    for (const key of group.keys) {
      for (const next of required(adjacency.get(key))) {
        if (byOwner.has(next)) continue;
        byOwner.set(next, group);
        group.keys.add(next);
      }
    }
    groups.push(group);
  }
  for (const edge of project.design.connections) required(byOwner.get(owner(edge.from))).edges.add(edge.id);
  return groups;
}

function projectForGroup(project: NetworkProject, group: Group): NetworkProject {
  const hasComponent = (id: string) => group.keys.has(componentKey(id));
  const hasNode = (id: string) => group.keys.has(nodeKey(id));
  return {
    ...project,
    controlProbes: [],
    extensions: {},
    design: {
      ...project.design,
      components: project.design.components.filter(({ id }) => hasComponent(id)),
      nodes: project.design.nodes.filter(({ id }) => hasNode(id)),
      connections: project.design.connections.filter(({ id }) => group.edges.has(id)),
      initialConditions: project.design.initialConditions.filter(({ componentId }) => hasComponent(componentId)),
    },
    layout: {
      components: project.layout.components.filter(({ componentId }) => hasComponent(componentId)),
      nodes: project.layout.nodes.filter(({ nodeId }) => hasNode(nodeId)),
      routes: project.layout.routes.filter(({ connectionId }) => group.edges.has(connectionId)),
    },
  };
}

function pathsFor(project: NetworkProject): Result<Routes> {
  const paths = new Map<string, readonly Point[]>();
  for (const [id, result] of networkDrawingRoutes(project)) {
    if (!result.ok) return result;
    paths.set(id, result.value);
  }
  return { ok: true, value: paths };
}

function frame(project: NetworkProject, paths: Routes) {
  const points = [
    ...project.layout.nodes,
    ...[...networkTreeGeometry.obstacles(project), ...annotationBoxes(project)].flatMap((box) => [
      { x: box.left, y: box.top },
      { x: box.right, y: box.bottom },
    ]),
  ];
  let left = Infinity,
    right = -Infinity,
    top = Infinity;
  for (const path of [points, ...paths.values()]) {
    for (const p of path) {
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
      top = Math.min(top, p.y);
    }
  }
  return { left, right, top };
}

/** Rebind translated axes to exact registered endpoints, including fractional
 * symbol sizes. Conflicting axes are rerouted in their own group. */
function movedPaths(before: Routes, after: NetworkProject, dx: number, dy: number): Routes | null {
  const xs = new Map<number, number>(),
    ys = new Map<number, number>();
  for (const edge of after.design.connections) {
    const points = required(before.get(edge.id));
    for (const [end, old] of [
      [edge.from, points[0]],
      [edge.to, points.at(-1)],
    ] as const) {
      const next = networkTreeGeometry.position(after, end);
      if (!old || !next) return null;
      if ((xs.has(old.x) && xs.get(old.x) !== next.x) || (ys.has(old.y) && ys.get(old.y) !== next.y)) return null;
      xs.set(old.x, next.x);
      ys.set(old.y, next.y);
    }
  }
  const moved = new Map(
    [...before].map(([id, points]) => [
      id,
      points.map((p) => ({
        x: xs.get(p.x) ?? p.x + dx,
        y: ys.get(p.y) ?? p.y + dy,
      })),
    ]),
  );
  return readTreeRoutes(saveTreeRoutes(after, moved), networkTreeGeometry);
}

type GroupPlanner = (project: NetworkProject) => Result<{ readonly document: NetworkProject }>;
export function arrangeIndependentCircuits(
  project: NetworkProject,
  arrange: GroupPlanner,
  reroute: GroupPlanner,
): Result<{ readonly project: NetworkProject; readonly paths: Routes }> | null {
  const groups = groupsOf(project);
  if (groups.filter((group) => group.edges.size > 0).length < 2) return null;
  const islands = groups.map((group) => projectForGroup(project, group));
  const originalX = (part: NetworkProject) =>
    Math.min(...[...part.layout.components, ...part.layout.nodes].map((p) => p.x));
  islands.sort(
    (a, b) =>
      Number(!a.design.connections.length) - Number(!b.design.connections.length) || originalX(a) - originalX(b),
  );
  const components = new Map<string, NetworkProject['layout']['components'][number]>();
  const nodes = new Map<string, NetworkProject['layout']['nodes'][number]>();
  const routes = new Map<string, NetworkProject['layout']['routes'][number]>();
  const paths = new Map<string, readonly Point[]>();
  let nextLeft: number | undefined, top: number | undefined;
  for (const island of islands) {
    let local: NetworkProject;
    if (island.layout.components.length) {
      const planned = arrange(island);
      if (!planned.ok) return planned;
      local = planned.value.document;
    } else {
      // A node-only branch has no symbols to place, but its connections still
      // need arrangement routes for translation, validation and save/reopen.
      local = {
        ...island,
        layout: {
          ...island.layout,
          routes: island.layout.routes.map(({ connectionId }) => ({ connectionId, mode: 'avoid' })),
        },
      };
    }
    const drawn = pathsFor(local);
    if (!drawn.ok) return drawn;
    const bounds = frame(local, drawn.value);
    top ??= bounds.top;
    const dx = nextLeft === undefined ? 0 : Math.ceil(nextLeft - bounds.left);
    const dy = Math.round(top - bounds.top);
    const move = <P extends Point>(p: P): P => ({ ...p, x: p.x + dx, y: p.y + dy });
    let shifted: NetworkProject = {
      ...local,
      layout: {
        ...local.layout,
        components: local.layout.components.map(move),
        nodes: local.layout.nodes.map(move),
      },
    };
    let drawing = dx || dy ? movedPaths(drawn.value, shifted, dx, dy) : drawn.value;
    if (!drawing) {
      const routed = reroute(shifted);
      if (!routed.ok) return routed;
      shifted = routed.value.document;
      const recovered = pathsFor(shifted);
      if (!recovered.ok) return recovered;
      drawing = recovered.value;
    }
    const packed = frame(shifted, drawing);
    if (nextLeft !== undefined && packed.left < nextLeft - 1e-6) return fail('独立回路的走线超出分区净空。');
    nextLeft = packed.right + groupGap;
    for (const p of shifted.layout.components) components.set(p.componentId, p);
    for (const p of shifted.layout.nodes) nodes.set(p.nodeId, p);
    for (const r of shifted.layout.routes) routes.set(r.connectionId, r);
    for (const [id, points] of drawing) paths.set(id, points);
  }
  const combined = {
    ...project,
    layout: {
      ...project.layout,
      components: project.layout.components.map((p) => required(components.get(p.componentId))),
      nodes: project.layout.nodes.map((p) => required(nodes.get(p.nodeId))),
      routes: project.layout.routes.map((r) => required(routes.get(r.connectionId))),
    },
  };
  if (readTreeRoutes(saveTreeRoutes(combined, paths), networkTreeGeometry)?.size !== paths.size)
    return fail('独立回路组合后的管线未通过几何校验。');
  return { ok: true, value: { project: combined, paths } };
}
