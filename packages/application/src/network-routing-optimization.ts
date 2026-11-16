import {
  diagnostic,
  isNetworkActuatorType,
  networkComponentPresentationBounds,
  parseNetworkProject,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { branchEndpointKey, networkBranchConnectionGroups } from './network-branch-geometry.js';
import { annotationBoxes, structuredBranchLayouts } from './network-layout-assemblies.js';
import { arrangementOrientations } from './network-layout-orientation.js';
import { planNetworkComponentPositions, planNetworkJunctionPositions } from './network-layout-placement.js';
import { portTerminal, routeHydraulicTrees, type HydraulicTreeDrawing } from './network-tree-routing.js';
import { scoreHydraulicTree, type NetworkRoutingScore } from './network-tree-score.js';
import { pointKey, segments, type Point, type Track, type TreeGeometry } from './network-tree-geometry.js';
import { networkLayoutBuses } from './network-layout-buses.js';
import { networkDrawingRoutes } from './network-routing.js';
export interface OptimizedNetworkDrawing {
  readonly drawing: HydraulicTreeDrawing;
  readonly metrics: NetworkRoutingScore;
  readonly method: string;
  readonly trials: number;
}
function better(a: OptimizedNetworkDrawing, b: OptimizedNetworkDrawing | null): boolean {
  return (
    !b ||
    a.metrics.annotationCollisions < b.metrics.annotationCollisions ||
    (a.metrics.annotationCollisions === b.metrics.annotationCollisions && a.metrics.score < b.metrics.score - 1e-8)
  );
}

function presentationsClear(project: NetworkProject): boolean {
  const components = new Map(project.design.components.map((c) => [c.id, c]));
  const boxes = project.layout.components.flatMap((p) => {
    const c = components.get(p.componentId),
      box = c && networkComponentPresentationBounds(c, p);
    return box ? [box] : [];
  });
  return (
    boxes.length === project.layout.components.length &&
    !boxes.some((a, i) =>
      boxes.slice(i + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom),
    )
  );
}

/** A symmetric flip may change the SVG transform without changing any inputs
 * to tree routing or scoring. Only collapse trials with identical geometry. */
function orientationGeometryKey(project: NetworkProject, geometry: TreeGeometry, withBuses: boolean): string {
  const boxes = geometry.obstacles(project);
  const fixedGeometry = { ...geometry, obstacles: () => boxes };
  const ends = new Map(
    project.design.connections
      .flatMap(({ from, to }) => [from, to])
      .filter((end) => end.kind === 'port')
      .map((end) => [branchEndpointKey(end), end]),
  );
  return JSON.stringify({
    boxes,
    terminals: [...ends.values()].map((end) => portTerminal(project, end, fixedGeometry)),
    nodes: project.layout.nodes,
    labels: annotationBoxes(project),
    buses: withBuses ? networkLayoutBuses(project).map((b) => [b.y, [...b.connectionIds]]) : [],
  });
}

/** Draw incomplete or mixed circuits with the existing per-edge avoid router.
 * A physical pipe has its own drawing track. Contact is legal only at a shared
 * real terminal, without merging the pressure networks on either side. */
function scoreAvoidDrawing(
  project: NetworkProject,
  geometry: TreeGeometry,
  label: string,
  trials: number,
): OptimizedNetworkDrawing | null {
  const paths = new Map<string, readonly Point[]>(),
    tracks: Track[] = [];
  const groups = networkBranchConnectionGroups(project);
  const terminals = new Map<string, Map<string, Set<string>>>();
  const routes = networkDrawingRoutes(project);
  for (const edge of project.design.connections) {
    const route = routes.get(edge.id);
    if (!route?.ok) return null;
    const netId = edge.kind === 'ideal' ? 'ideal:' + (groups.get(edge.id) ?? edge.id) : edge.kind + ':' + edge.id;
    paths.set(edge.id, route.value);
    for (const span of segments(route.value)) tracks.push({ ...span, netId });
    for (const end of [edge.from, edge.to]) {
      const p = geometry.position(project, end);
      if (!p) return null;
      const key = pointKey(p),
        terminal = branchEndpointKey(end);
      const contacts = terminals.get(key) ?? new Map<string, Set<string>>();
      const nets = contacts.get(terminal) ?? new Set<string>();
      nets.add(netId);
      contacts.set(terminal, nets);
      terminals.set(key, contacts);
    }
  }
  const drawing = { project, paths, tracks, searches: 0, expanded: 0 };
  const metrics = scoreHydraulicTree(drawing, geometry, (p, a, b) =>
    [...(terminals.get(pointKey(p))?.values() ?? [])].some((nets) => nets.has(a) && nets.has(b)),
  );
  return { drawing, metrics, method: label + ':avoid', trials };
}
/** Screen each placement once before trying more route policies. Full recovery
 * is reserved for a failed first pass, when every placement is still unproven.
 * Rendering consumes saved drawing metadata and never runs this candidate search. */
export function optimizeNetworkDrawing(
  project: NetworkProject,
  geometry: TreeGeometry,
  kind: 'arrangement' | 'routing',
): Result<OptimizedNetworkDrawing> {
  const branches = project.design.components.filter((c) => isNetworkActuatorType(c.typeId)).length;
  if (
    kind === 'arrangement' &&
    branches >= 2 &&
    branches <= 3 &&
    project.design.connections.every((e) => e.kind === 'ideal') &&
    !project.design.components.some((c) => c.typeId === 'pressure-reducing' || c.typeId === 'sequence-valve') &&
    networkLayoutBuses(project).length >= 2
  ) {
    // Prioritize a legal shared supply/return layout. A tight drawing may need
    // shorter leads, but that should not make it give up its shared trunks.
    for (const lead of [24, 0]) {
      const shared = optimizeCandidates(project, geometry, kind, lead);
      if (shared.ok) return shared;
    }
  }
  return optimizeCandidates(project, geometry, kind);
}

function optimizeCandidates(
  project: NetworkProject,
  geometry: TreeGeometry,
  kind: 'arrangement' | 'routing',
  busPortLead?: number,
): Result<OptimizedNetworkDrawing> {
  const layouts: { project: NetworkProject; label: string }[] = [];
  const allIdeal = project.design.connections.every((e) => e.kind === 'ideal');
  if (kind === 'arrangement' && allIdeal) {
    const grouped = structuredBranchLayouts(project, geometry);
    if (grouped.ok) layouts.push(...grouped.value);
  }
  // Keep the current structured-placement baseline as a candidate for unsupported group shapes.
  layouts.push({ project, label: 'baseline' });
  let best: OptimizedNetworkDrawing | null = null,
    trials = 0;
  let preferredPolicy = { crossingCost: 64, reverse: false };
  const ordinaryParallel =
    busPortLead !== undefined ||
    (project.design.components.filter((c) => isNetworkActuatorType(c.typeId)).length >= 4 &&
      !project.design.components.some((c) => c.typeId === 'pressure-reducing' || c.typeId === 'sequence-valve'));
  function evaluate(layout: (typeof layouts)[number], crossingCost: number, reverse: boolean) {
    trials++;
    const routed = routeHydraulicTrees(layout.project, geometry, {
      junctions: kind === 'arrangement' ? 'follow' : 'preserve',
      reverse,
      searchPolicy: { crossingCost, maximumExpanded: 24000, maximumGrid: 32000 },
      buses: ordinaryParallel ? networkLayoutBuses(layout.project) : [],
      ...(busPortLead === undefined ? {} : { busPortLead }),
    });
    if (!routed.ok) return null;
    const metrics = scoreHydraulicTree(routed.value, geometry);
    return metrics.valid
      ? { drawing: routed.value, metrics, method: layout.label + ':' + crossingCost + ':' + reverse, trials }
      : null;
  }
  function tryPolicy(layout: (typeof layouts)[number], crossingCost: number, reverse: boolean) {
    const candidate = evaluate(layout, crossingCost, reverse);
    if (candidate && better(candidate, best)) {
      best = candidate;
      preferredPolicy = { crossingCost, reverse };
    }
    return candidate;
  }
  if (allIdeal) {
    const ranked = layouts.flatMap((layout) => {
      const first = tryPolicy(layout, 64, false);
      return first ? [{ layout, metrics: first.metrics }] : [];
    });
    ranked.sort(
      (a, b) => a.metrics.annotationCollisions - b.metrics.annotationCollisions || a.metrics.score - b.metrics.score,
    );
    const finalists = ranked.length ? ranked.slice(0, 2).map(({ layout }) => layout) : layouts;
    for (const layout of finalists) {
      tryPolicy(layout, 64, true);
      tryPolicy(layout, 512, false);
      tryPolicy(layout, 512, true);
    }
  }
  if (kind === 'arrangement' && project.design.connections.length && (busPortLead === undefined || best)) {
    const useAvoid = !best;
    const baseline = best ?? scoreAvoidDrawing(project, geometry, 'baseline', ++trials);
    const legalBaseline = baseline?.metrics.valid ? baseline : null;
    if (legalBaseline) best = legalBaseline;
    const { crossingCost, reverse } = preferredPolicy;
    const seed = baseline?.drawing.project ?? project;
    const orientations = arrangementOrientations(seed);
    const triedGeometry = new Set<string>();
    function tryOrientation(variant: (typeof layouts)[number]): boolean {
      if (!presentationsClear(variant.project)) return false;
      // The per-edge fallback can consume persisted path metadata, so only
      // deduplicate the tree router, whose inputs are fully captured here.
      const key = useAvoid ? undefined : orientationGeometryKey(variant.project, geometry, ordinaryParallel);
      if (key !== undefined) {
        if (triedGeometry.has(key)) return false;
        triedGeometry.add(key);
      }
      const label = 'orientation-' + variant.label;
      let candidate = useAvoid
        ? scoreAvoidDrawing(variant.project, geometry, label, ++trials)
        : evaluate({ ...variant, label }, crossingCost, reverse);
      // A rotation can open a port exit that was blocked in every original
      // tree candidate. Retry only when neither baseline nor this variant has
      // a legal drawing, and reuse the already shortlisted orientations.
      if (useAvoid && allIdeal && !legalBaseline && !candidate?.metrics.valid)
        candidate = evaluate({ ...variant, label }, crossingCost, reverse);
      if (!candidate?.metrics.valid || !better(candidate, best)) return false;
      if (legalBaseline) {
        const a = candidate.metrics,
          b = legalBaseline.metrics;
        if (a.length > b.length + 1e-8 || a.crossings > b.crossings || a.annotationCollisions > b.annotationCollisions)
          return false;
        if (a.length >= b.length - 1e-8 && a.crossings === b.crossings) return false;
      }
      if (!parseNetworkProject(candidate.drawing.project).ok) return false;
      best = candidate;
      return true;
    }
    // Check all fixed-center options first. Only reflow when none pays off,
    // since a new placement needs another full route and can disturb the drawing.
    let improved = false;
    for (const orientation of orientations) if (tryOrientation(orientation)) improved = true;
    const moving = new Set(seed.layout.components.map((p) => p.componentId));
    for (const orientation of improved ? [] : orientations) {
      const positions = planNetworkComponentPositions(orientation.project, moving, 'follow', 'compact');
      if (!positions.ok) continue;
      const repacked = {
        ...orientation.project,
        layout: {
          ...orientation.project.layout,
          components: orientation.project.layout.components.map((p) => ({
            ...p,
            ...positions.value.get(p.componentId),
          })),
        },
      };
      tryOrientation({
        label: orientation.label + '-repacked',
        project: { ...repacked, layout: { ...repacked.layout, nodes: planNetworkJunctionPositions(repacked) } },
      });
    }
  }
  return best
    ? { ok: true, value: { ...best, trials } }
    : {
        ok: false,
        diagnostics: [diagnostic('ROUTE_BLOCKED', '/layout/routes', '本轮同网树候选均受阻，未替换原有布线。')],
      };
}
