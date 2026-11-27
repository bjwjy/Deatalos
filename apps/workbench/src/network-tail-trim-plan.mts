import { planNetworkDeleteSelection } from '@hyd/application';
import type { NetworkProject } from '@hyd/domain';
import type { Point, Selection } from './network-cad.mjs';
import { sharedTail, type TrimTrack } from './network-shared-tail.mjs';

export interface TrimTarget {
  selection: Selection[];
  preview?: readonly (readonly Point[])[];
  apply(): NetworkProject | undefined;
}
type Prefix = { length: number; target: TrimTarget };
type Track = TrimTrack & { ordinary?: TrimTarget; start?: Prefix; end?: Prefix };
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
// Draw only the portion that disappears when the selected edge owns the visible
// copy of a shared trunk. The other ideal connections still carry that trunk.
function exclusivePath(track: Track): Point[] {
  function skip(points: readonly Point[], length: number): Point[] {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!,
        b = points[i]!,
        span = distance(a, b);
      if (!span) continue;
      if (length < span)
        return [{ x: a.x + ((b.x - a.x) * length) / span, y: a.y + ((b.y - a.y) * length) / span }, ...points.slice(i)];
      length -= span;
    }
    return [];
  }
  return skip(skip(track.points, track.start?.length ?? 0).reverse(), track.end?.length ?? 0).reverse();
}
export function tailStrokeTargets(project: NetworkProject, route: (id: string) => readonly Point[]) {
  const tracks: Track[] = project.design.connections.map((edge) => ({ edge, points: route(edge.id) }));
  const byNode = new Map<string, Track[]>();
  const labels = new Map(project.design.nodes.map((node) => [node.id, node.label]));
  const protectedNodes = new Set(project.controlProbes?.map((probe) => probe.nodeId));
  for (const track of tracks)
    for (const e of [track.edge.from, track.edge.to])
      if (e.kind === 'node') {
        const adjacent = byNode.get(e.nodeId);
        if (adjacent) adjacent.push(track);
        else byNode.set(e.nodeId, [track]);
      }
  const sharedNodes = new Set<string>();
  for (const [id, adjacent] of byNode) {
    if (adjacent.length < 2 || protectedNodes.has(id)) continue;
    const shared = sharedTail(project, id, adjacent);
    if (!shared) continue;
    sharedNodes.add(id);
    const prefix = {
      length: shared.length,
      target: { selection: [{ kind: 'node' as const, id }], preview: [shared.prefix], apply: shared.apply },
    };
    for (const track of adjacent) {
      if (track.edge.from.kind === 'node' && track.edge.from.nodeId === id) track.start = prefix;
      else track.end = prefix;
    }
  }
  for (const [id, adjacent] of byNode) {
    if (adjacent.length !== 1 || protectedNodes.has(id)) continue;
    let track = adjacent[0]!,
      node = id;
    if (track.ordinary || track.edge.kind === 'signal') continue;
    const selection: Selection[] = [{ kind: 'node', id }],
      chain: Track[] = [];
    // Walk only through unlabelled two-way ideal junctions. Stop at equipment,
    // instruments, named junctions, physical pipe boundaries and true branches.
    while (true) {
      chain.push(track);
      selection.push({ kind: 'connection', id: track.edge.id });
      const other =
        track.edge.from.kind === 'node' && track.edge.from.nodeId === node ? track.edge.to : track.edge.from;
      if (other.kind !== 'node' || protectedNodes.has(other.nodeId)) break;
      const next = byNode.get(other.nodeId)!;
      if (next.length === 1) {
        selection.push({ kind: 'node', id: other.nodeId });
        break;
      }
      if (
        next.length !== 2 ||
        sharedNodes.has(other.nodeId) ||
        labels.get(other.nodeId) ||
        next.some((t) => t.edge.kind !== 'ideal')
      )
        break;
      selection.push({ kind: 'node', id: other.nodeId });
      node = other.nodeId;
      track = next[0] === track ? next[1]! : next[0]!;
    }
    const partial = chain.filter((member) => member.start || member.end);
    const target: TrimTarget = {
      selection: selection.filter(
        (item) => item.kind !== 'connection' || !partial.some((member) => member.edge.id === item.id),
      ),
      preview: partial.map(exclusivePath).filter((path) => path.length > 1),
      apply() {
        const result = planNetworkDeleteSelection(project, selection);
        return result.ok ? result.value : undefined;
      },
    };
    for (const member of chain) member.ordinary = target;
  }
  // On a connected span remove the connection, including all its routing bends.
  // Shared prefixes keep their own topological target at the point of intersection.
  for (const track of tracks) {
    if (track.ordinary || track.edge.kind === 'signal') continue;
    if (
      [track.edge.from, track.edge.to].some(
        (end) => end.kind === 'node' && protectedNodes.has(end.nodeId) && byNode.get(end.nodeId)?.length === 1,
      )
    )
      continue;
    const selection: Selection[] = [{ kind: 'connection', id: track.edge.id }];
    const shared = track.start || track.end;
    track.ordinary = {
      selection: shared ? [] : selection,
      preview: shared ? [exclusivePath(track)].filter((points) => points.length > 1) : [],
      apply() {
        const result = planNetworkDeleteSelection(project, selection);
        return result.ok ? result.value : undefined;
      },
    };
  }
  const segments = tracks.flatMap((track) => {
    const total = track.points.reduce((sum, p, i) => sum + (i ? distance(track.points[i - 1]!, p) : 0), 0);
    let offset = 0;
    return track.points.slice(1).flatMap((end, i) => {
      const start = track.points[i]!,
        length = distance(start, end),
        at = offset;
      offset += length;
      return length ? [{ track, start, end, length, at, total }] : [];
    });
  });
  // null is a permanent veto for this stroke. Each actual crossing must point
  // to the same topological tail, including coincident routes hidden by the renderer.
  let choice: TrimTarget | undefined | null;
  return (a: Point, b: Point) => {
    if (choice === null || (a.x === b.x && a.y === b.y)) return choice;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    for (const { track, start, end, length, at, total } of segments) {
      if (
        Math.max(a.x, b.x) < Math.min(start.x, end.x) ||
        Math.min(a.x, b.x) > Math.max(start.x, end.x) ||
        Math.max(a.y, b.y) < Math.min(start.y, end.y) ||
        Math.min(a.y, b.y) > Math.max(start.y, end.y)
      )
        continue;
      const ex = end.x - start.x,
        ey = end.y - start.y,
        cx = start.x - a.x,
        cy = start.y - a.y,
        det = dx * ey - dy * ex;
      if (!det) {
        if (cx * dy === cy * dx) {
          choice = null;
          break;
        }
        continue;
      }
      const t = (cx * ey - cy * ex) / det,
        u = (cx * dy - cy * dx) / det;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const atHit = at + u * length;
      let hit = track.ordinary;
      if (track.start && atHit <= track.start.length)
        hit = atHit === track.start.length ? undefined : track.start.target;
      if (track.end && total - atHit <= track.end.length)
        hit = total - atHit === track.end.length ? undefined : track.end.target;
      if (!hit || (choice && hit !== choice)) {
        choice = null;
        break;
      }
      choice = hit;
    }
    return choice;
  };
}
