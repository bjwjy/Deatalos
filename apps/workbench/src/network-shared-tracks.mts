import { networkBranchConnectionGroups, type DrawingPoint as Point } from '@hyd/application';
import { networkEndpointActive, type NetworkProject, type NetworkRoute, type Result } from '@hyd/domain';
import { clampCoordinate, manualRoute } from './network-cad.mjs';

type Piece = { from: Point; to: Point; index: number };
type Member = { id: string; points: readonly Point[] };
type Run = Piece & { id: string; low: number; high: number };

export function sharedDrawingTracks(project: NetworkProject, routes: ReadonlyMap<string, Result<readonly Point[]>>) {
  const groups = networkBranchConnectionGroups(project);
  const nets = new Map<string, Member[]>();
  const lines = new Map<string, Run[]>();
  const pieces = new Map<string, Piece[]>();
  const junctions = new Map<string, { point: Point; connectionId: string }>();
  const directions = new Map<string, number>();
  const ends = new Set<string>();
  const sharedGroups = new Set<string>();
  const trimmed = new Set<string>();
  for (const edge of project.design.connections) {
    const group = groups.get(edge.id),
      route = routes.get(edge.id);
    if (!group || !route?.ok || !networkEndpointActive(project, edge.from) || !networkEndpointActive(project, edge.to))
      continue;
    const points = route.value;
    const members = nets.get(group) ?? [];
    members.push({ id: edge.id, points });
    nets.set(group, members);
    for (const p of [points[0], points.at(-1)]) if (p) ends.add(JSON.stringify([group, p.x, p.y]));
    const visible: Piece[] = [];
    pieces.set(edge.id, visible);
    for (let index = 0; index + 1 < points.length; index++) {
      const from = points[index]!,
        to = points[index + 1]!;
      if (from.x === to.x && from.y === to.y) continue;
      const vertical = from.x === to.x;
      if (!vertical && from.y !== to.y) {
        visible.push({ from, to, index });
        continue;
      }
      const key = JSON.stringify([group, vertical, vertical ? from.x : from.y]);
      const runs = lines.get(key) ?? [];
      const a = vertical ? from.y : from.x,
        b = vertical ? to.y : to.x;
      runs.push({ from, to, index, id: edge.id, low: Math.min(a, b), high: Math.max(a, b) });
      lines.set(key, runs);
    }
  }
  for (const runs of lines.values()) {
    // A sweep assigns every open interval to one covering connection. End-only contacts own no length.
    const events = new Map<number, { start: Run[]; stop: Run[] }>();
    for (const run of runs) {
      for (const [at, type] of [
        [run.low, 'start'],
        [run.high, 'stop'],
      ] as const) {
        const event = events.get(at) ?? { start: [], stop: [] };
        event[type].push(run);
        events.set(at, event);
      }
    }
    const active = new Set<Run>();
    const cuts = [...events.keys()].sort((a, b) => a - b);
    const representative = runs[0]!;
    const vertical = representative.from.x === representative.to.x;
    const point = (v: number) => (vertical ? { x: representative.from.x, y: v } : { x: v, y: representative.from.y });
    const group = groups.get(representative.id)!;

    for (const [i, low] of cuts.entries()) {
      const event = events.get(low)!;
      for (const run of event.stop) active.delete(run);
      for (const run of event.start) active.add(run);
      const owner = active.values().next().value;
      const shared = !!owner && active.size > 1 && [...active].some((run) => run.id !== owner.id);

      const high = cuts[i + 1];
      if (!owner || high === undefined) continue;
      for (const [value, bit] of [
        [low, vertical ? 1 : 4],
        [high, vertical ? 2 : 8],
      ] as const) {
        const p = point(value),
          key = JSON.stringify([group, p.x, p.y]);
        directions.set(key, (directions.get(key) ?? 0) | bit);
        if (shared && !ends.has(key)) junctions.set(key, { point: p, connectionId: owner.id });
      }
      if (shared) sharedGroups.add(group);
      if (shared) for (const run of active) trimmed.add(run.id);
      for (const run of shared ? [owner] : active) {
        const forward = vertical ? run.from.y < run.to.y : run.from.x < run.to.x;
        pieces
          .get(run.id)!
          .push({ from: point(forward ? low : high), to: point(forward ? high : low), index: run.index });
      }
    }
  }
  for (const [id, visible] of pieces) {
    if (!trimmed.has(id)) {
      pieces.delete(id);
      continue;
    }
    const points = routes.get(id);
    if (!points?.ok) continue;
    visible.sort(
      (a, b) =>
        a.index - b.index || distance(a.from, points.value[a.index]!) - distance(b.from, points.value[b.index]!),
    );
  }
  return {
    pieces,
    // Three or four distinct incident directions form a junction. An elbow has only two.
    junctions: [...junctions]
      .filter(([key]) => [7, 11, 13, 14, 15].includes(directions.get(key) ?? 0))
      .map(([, dot]) => dot),
    members(id: string) {
      const group = groups.get(id);
      return group && sharedGroups.has(group) ? nets.get(group) : undefined;
    },
  };
}
export function visibleTrackPath(pieces: readonly Piece[]) {
  return pieces
    .map(({ from, to }, i) => {
      const previous = pieces[i - 1]?.to;
      const start = previous && previous.x === from.x && previous.y === from.y ? '' : 'M' + from.x + ' ' + from.y;
      return start + 'L' + to.x + ' ' + to.y;
    })
    .join(' ');
}
export function longestTrack(pieces: readonly Piece[]): readonly Point[] {
  let longest: Piece | undefined;
  for (const piece of pieces)
    if (!longest || distance(piece.from, piece.to) > distance(longest.from, longest.to)) longest = piece;
  return longest ? [longest.from, longest.to] : [];
}
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Move a continuous same-net run and its incident elbows. Real endpoints retain their coordinates. */
export function moveSharedRun(
  members: readonly Member[] | undefined,
  id: string,
  index: number,
  delta: Point,
): readonly NetworkRoute[] | null {
  const path = members?.find((m) => m.id === id)?.points,
    a = path?.[index],
    b = path?.[index + 1];
  if (!members || !a || !b || (a.x !== b.x && a.y !== b.y)) return null;
  const axis = a.x === b.x ? 'x' : 'y',
    along = axis === 'x' ? 'y' : 'x';
  const coordinate = clampCoordinate(a[axis] + delta[axis]);
  if (coordinate === a[axis]) return null;
  let low = Math.min(a[along], b[along]),
    high = Math.max(a[along], b[along]);
  const runs = members
    .flatMap(({ points }) =>
      points.slice(1).flatMap((q, i) => {
        const p = points[i]!;
        return p[axis] === a[axis] && q[axis] === a[axis]
          ? [[Math.min(p[along], q[along]), Math.max(p[along], q[along])] as const]
          : [];
      }),
    )
    .sort((u, v) => u[0] - v[0]);
  // Glue touching intervals before selecting the one containing the dragged segment.
  let left = Infinity,
    right = -Infinity;
  for (const [lo, hi] of runs) {
    if (lo > right) {
      left = lo;
      right = hi;
    } else right = Math.max(right, hi);
    if (left <= low && right >= low) {
      low = left;
      high = Math.max(high, right);
    }
  }
  const moved: NetworkRoute[] = [];
  for (const member of members) {
    const points = member.points;
    if (!points.some((p) => p[axis] === a[axis] && p[along] >= low && p[along] <= high)) continue;
    const updated = points.map((p) =>
      p[axis] === a[axis] && p[along] >= low && p[along] <= high ? { ...p, [axis]: coordinate } : p,
    );
    const fixed = [points[0]!, ...updated, points.at(-1)!];
    const interior = fixed.filter((p, i) => !i || distance(p, fixed[i - 1]!) > 0).slice(1, -1);
    if (!interior.length) interior.push(updated[0]!);
    moved.push(manualRoute(member.id, interior));
  }
  return moved.length > 1 ? moved : null;
}
