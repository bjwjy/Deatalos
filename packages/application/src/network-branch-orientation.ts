import type { NetworkEndpoint, NetworkPlacement, NetworkProject, NetworkRotation } from '@hyd/domain';
import { branchPathCost, routeBranch, type BranchPaths } from './network-branch-geometry.js';
import { networkTreeGeometry } from './network-routing.js';
import { segments, type Point } from './network-tree-geometry.js';

interface OrientedBranch {
  readonly project: NetworkProject;
  readonly paths: BranchPaths;
  readonly changedComponentId: string;
  readonly affectedConnectionIds: ReadonlySet<string>;
}

const owns = (end: NetworkEndpoint, id: string) => end.kind === 'port' && end.componentId === id;
const quarterTurns: readonly NetworkRotation[] = [0, 90, 180, 270];

function orientedPlacement(p: NetworkPlacement, rotation: NetworkRotation, mirrored: boolean): NetworkPlacement {
  const { rotation: previousRotation, mirrored: previousMirror, ...rest } = p;
  return {
    ...rest,
    ...(rotation !== 0 || previousRotation !== undefined ? { rotation } : {}),
    ...(mirrored ? { mirrored: true } : {}),
  };
}

/** One local coordinate step: try the seven other orientations of each
 * directly connected component, one component at a time. Keep centers fixed.
 * User manual anchors and physical pipes are protected; all incident automatic
 * paths must reroute successfully before a direction change can be accepted. */
export function orientBranch(
  project: NetworkProject,
  paths: BranchPaths,
  connectionId: string,
  createdNodes: ReadonlySet<string>,
  routing: 'optimized' | 'basic',
): OrientedBranch | null {
  if (paths.size > 64) return null;
  const branch = project.design.connections.find((edge) => edge.id === connectionId);
  if (!branch) return null;
  const ids = new Set([branch.from, branch.to].flatMap((end) => (end.kind === 'port' ? [end.componentId] : [])));
  let best: { value: OrientedBranch; improvement: number } | null = null;
  for (const id of ids) {
    const placement = project.layout.components.find((p) => p.componentId === id);
    const incident = project.design.connections.filter((e) => owns(e.from, id) || owns(e.to, id));
    if (
      !placement ||
      incident.length > 4 ||
      incident.some(
        (e) =>
          e.kind !== 'ideal' ||
          (e.id !== connectionId && project.layout.routes.some((r) => r.connectionId === e.id && r.mode === 'manual')),
      )
    )
      continue;
    const affected = new Set(incident.map((e) => e.id));
    const fixed = new Map([...paths].filter(([edgeId]) => !affected.has(edgeId)));
    const fixedSegments = [...fixed.values()].flatMap(segments);
    const cost = (drawing: BranchPaths) =>
      incident.reduce((sum, e) => sum + branchPathCost(drawing.get(e.id) ?? [], []), 0);
    const baseline = cost(paths);
    for (const rotation of quarterTurns)
      for (const mirrored of [false, true]) {
        if (rotation === (placement.rotation ?? 0) && mirrored === !!placement.mirrored) continue;
        const candidate: NetworkProject = {
          ...project,
          layout: {
            ...project.layout,
            components: project.layout.components.map((p) =>
              p.componentId === id ? orientedPlacement(p, rotation, mirrored) : p,
            ),
          },
        };
        const boxes = networkTreeGeometry.obstacles(candidate),
          body = boxes.find((b) => b.id === id);
        if (
          !body ||
          boxes.some(
            (b) =>
              b.id !== id && body.left < b.right && body.right > b.left && body.top < b.bottom && body.bottom > b.top,
          )
        )
          continue;
        const clear = (p: Point) => networkTreeGeometry.clear(p, p, [body]);
        if (
          candidate.layout.nodes.some((n) => !clear(n)) ||
          fixedSegments.some((s) => !networkTreeGeometry.clear(s.from, s.to, [body]))
        )
          continue;
        const drawing = new Map(fixed);
        for (const edge of incident) {
          const routed = routeBranch(candidate, drawing, edge.from, edge.to, createdNodes);
          if (!routed) break;
          drawing.set(edge.id, routed.points);
        }
        if (drawing.size !== paths.size) continue;
        const improvement = baseline - cost(drawing) - 16;
        if ((routing === 'optimized' && improvement <= 0) || (best && improvement <= best.improvement)) continue;
        best = {
          value: { project: candidate, paths: drawing, changedComponentId: id, affectedConnectionIds: affected },
          improvement,
        };
      }
  }
  return best?.value ?? null;
}
