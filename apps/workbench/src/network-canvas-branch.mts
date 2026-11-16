import { networkBranchConnectionGroups, type DrawingPoint, type NetworkRouteAnchor } from '@hyd/application';
import type { NetworkProject, Result } from '@hyd/domain';

/** Default display radius in CSS pixels. */
export const branchRevealRadius = 96;
const same = (a: DrawingPoint, b: DrawingPoint) => a.x === b.x && a.y === b.y;
const on = (p: DrawingPoint, a: DrawingPoint, b: DrawingPoint) =>
  (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) ||
  (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x));
function compact(points: readonly DrawingPoint[]): DrawingPoint[] {
  const result: DrawingPoint[] = [];
  for (const p of points) {
    const last = result.at(-1);
    if (last && same(last, p)) continue;
    while (result.length >= 2) {
      const a = result.at(-2),
        b = result.at(-1);
      if (a && b && on(b, a, p)) result.pop();
      else break;
    }
    result.push(p);
  }
  return result;
}
/** Owns a single derived geometry cache; never searches routes or mutates an engineering document. */
export function createCanvasBranchPoints(
  route: (project: NetworkProject, id: string) => Result<readonly DrawingPoint[]>,
) {
  let owner: NetworkProject | null = null,
    scale = 0;
  let anchors: readonly NetworkRouteAnchor[] = [];
  let physicalAnchors: readonly NetworkRouteAnchor[] = [];
  function rebuild(project: NetworkProject, zoom: number): void {
    const paths = new Map<string, readonly DrawingPoint[]>();
    for (const edge of project.design.connections) {
      const path = route(project, edge.id);
      if (path.ok) paths.set(edge.id, compact(path.value));
    }
    const groups = networkBranchConnectionGroups(project),
      result: NetworkRouteAnchor[] = [],
      physical: NetworkRouteAnchor[] = [];
    const terminals = [...paths.values()].flatMap((p) => {
      const a = p[0],
        b = p.at(-1);
      return a && b ? [a, b] : [];
    });
    for (const edge of project.design.connections) {
      if (edge.kind === 'signal') continue;
      const path = paths.get(edge.id);
      if (!path || path.length < 2) continue;
      const candidate: DrawingPoint[] = [];
      const add = (p: DrawingPoint) => {
        if (terminals.some((t) => Math.hypot(t.x - p.x, t.y - p.y) * zoom < 19)) return;
        if (
          [...paths].some(
            ([id, other]) =>
              id !== edge.id &&
              (edge.kind === 'pipe' || !groups.has(id) || groups.get(id) !== groups.get(edge.id)) &&
              other.slice(1).some((b, i) => {
                const a = other[i];
                return a && on(p, a, b);
              }),
          )
        )
          return;
        if (candidate.some((q) => Math.hypot(q.x - p.x, q.y - p.y) * zoom < 20)) return;
        candidate.push(p);
      };
      for (const p of path.slice(1, -1)) add(p);
      if (edge.kind === 'pipe') {
        for (const [i, b] of path.slice(1).entries()) {
          const a = path[i];
          if (a) add({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
        physical.push(...candidate.map((point) => ({ kind: 'route' as const, connectionId: edge.id, point })));
        continue;
      }
      if (path.length === 2) {
        let a = path[0],
          b = path[1];
        if (!a || !b) continue;
        if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
        const first = a,
          last = b,
          length = Math.hypot(last.x - first.x, last.y - first.y) * zoom;
        const along = (pixels: number) => ({
          x: first.x + ((last.x - first.x) * pixels) / length,
          y: first.y + ((last.y - first.y) * pixels) / length,
        });
        if (length >= 100) {
          add(along(28));
          add(along(length - 28));
          if (candidate.length !== 2) candidate.length = 0;
        }
        if (!candidate.length && length >= 70) {
          add(along(20));
          if (!candidate.length) add(along(length - 20));
        }
      }
      for (const point of candidate) {
        if (result.some((a) => same(a.point, point) && groups.get(a.connectionId) === groups.get(edge.id))) continue;
        result.push({ kind: 'route', connectionId: edge.id, point });
      }
    }
    owner = project;
    scale = zoom;
    anchors = result;
    physicalAnchors = physical;
  }
  return (
    project: NetworkProject,
    zoom: number,
    selected: string | null,
    cursor: DrawingPoint | null,
    connecting: boolean,
    physicalTap = false,
    revealRadius = branchRevealRadius,
  ): readonly NetworkRouteAnchor[] => {
    if (!Number.isFinite(zoom) || zoom <= 0) return [];
    if (owner !== project || scale !== zoom) rebuild(project, zoom);
    if (connecting)
      return cursor
        ? (physicalTap ? [...anchors, ...physicalAnchors] : anchors).filter(
            (a) => Math.hypot(a.point.x - cursor.x, a.point.y - cursor.y) * zoom <= revealRadius,
          )
        : [];
    return selected ? anchors.filter((a) => a.connectionId === selected) : [];
  };
}
