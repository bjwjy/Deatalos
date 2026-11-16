import {
  diagnostic,
  isNetworkActuatorType,
  networkComponentBounds,
  networkComponentPresentationBounds,
  networkPortAnchor,
  type NetworkProject,
  type NetworkDrawingBounds,
  type Result,
} from '@hyd/domain';
import { balanceNetworkComponentPositions } from './network-layout-balance.js';
import { networkLayoutBuses } from './network-layout-buses.js';
import { networkLayoutProfiles } from './network-layout-roles.js';
import { networkLayoutWorkStages } from './network-layout-work-stages.js';

type Point = { readonly x: number; readonly y: number };
type Frame = NetworkDrawingBounds & { readonly id: string };
type Group = {
  readonly id: string;
  readonly rows: ReadonlyMap<number, readonly string[]>;
  readonly width: number;
  readonly anchorX: number | null;
};
const horizontalGap = 24,
  branchGap = 36,
  verticalGap = 24,
  obstacleGap = 24;
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('LAYOUT_UNSUPPORTED', '/layoutOperation', message)],
});
const overlaps = (a: NetworkDrawingBounds, b: NetworkDrawingBounds) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const translated = (f: NetworkDrawingBounds, p: Point): NetworkDrawingBounds => ({
  left: f.left + p.x,
  right: f.right + p.x,
  top: f.top + p.y,
  bottom: f.bottom + p.y,
});

/** Presentation space includes the registered rotated envelope and the upright name used by canvas/SVG.
 * Text space is conservative drawing-unit estimation, not a DOM measurement or a physical dimension. */
function frames(project: NetworkProject, policy: 'legacy' | 'compact'): Result<ReadonlyMap<string, Frame>> {
  const result = new Map<string, Frame>();
  for (const c of project.design.components) {
    const p = project.layout.components.find((p) => p.componentId === c.id);
    if (!p) return fail('元件缺少布局位置，未生成整理候选。');
    const b = networkComponentPresentationBounds(c, { ...p, x: 0, y: 0 });
    if (!b) return fail('元件缺少注册绘图包络，未生成整理候选。');
    const textWidth = Math.max(
      policy === 'compact' ? 32 : 144,
      [...c.label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 14 : 8), 0),
    );
    result.set(c.id, {
      id: c.id,
      left: Math.min(b.left - 8, -textWidth / 2 - 8),
      right: Math.max(b.right + 8, textWidth / 2 + 8),
      top: b.top - 8,
      bottom: policy === 'compact' ? Math.max(45, b.bottom + 24) + 8 : Math.max(102, b.bottom + 24),
    });
  }
  return { ok: true, value: result };
}

/** Shared junctions follow connected port positions only when explicitly requested for a whole drawing.
 * Manual-route junctions stay put; this changes drawing coordinates, never node/edge identities. */
export function planNetworkJunctionPositions(project: NetworkProject): NetworkProject['layout']['nodes'] {
  const buses = networkLayoutBuses(project);
  const boxes = project.design.components.flatMap((c) => {
    const p = project.layout.components.find((p) => p.componentId === c.id);
    const b = p && networkComponentBounds(c, p);
    return b ? [{ left: b.left - 16, right: b.right + 16, top: b.top - 16, bottom: b.bottom + 16 }] : [];
  });
  const result: NetworkProject['layout']['nodes'][number][] = [];
  for (const node of [...project.layout.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en'))) {
    const edges = project.design.connections.filter((e) =>
      [e.from, e.to].some((end) => end.kind === 'node' && end.nodeId === node.nodeId),
    );
    if (edges.some((e) => project.layout.routes.find((r) => r.connectionId === e.id)?.mode === 'manual')) {
      result.push(node);
      continue;
    }
    const anchors: Point[] = [];
    for (const edge of edges)
      for (const end of [edge.from, edge.to])
        if (end.kind === 'port') {
          const c = project.design.components.find((c) => c.id === end.componentId),
            p = project.layout.components.find((p) => p.componentId === end.componentId),
            anchor = c && p && networkPortAnchor(c, p, end.portId);
          if (anchor) anchors.push(anchor);
        }
    if (!anchors.length) {
      result.push(node);
      continue;
    }
    const median = (values: number[]) => {
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    const centerX = median(anchors.map((p) => p.x)),
      centerY = median(anchors.map((p) => p.y));
    if (centerX === undefined || centerY === undefined) {
      result.push(node);
      continue;
    }
    const center = { x: centerX, y: centerY };
    const bus = buses.find((bus) => bus.nodeIds.has(node.nodeId));
    if (bus) {
      const point = { x: Number(centerX.toFixed(6)), y: bus.y };
      const box = { left: point.x - 14, right: point.x + 14, top: point.y - 14, bottom: point.y + 14 };
      if (
        !boxes.some((b) => overlaps(box, b)) &&
        !result.some((n) => Math.abs(n.x - point.x) < 28 && Math.abs(n.y - point.y) < 28)
      ) {
        result.push({ ...node, ...point });
        continue;
      }
    }
    const xs = [center.x, ...boxes.flatMap((b) => [b.left - 16, b.right + 16])],
      ys = [center.y, ...boxes.flatMap((b) => [b.top - 16, b.bottom + 16])];
    const options: Point[] = [];
    for (const x of xs)
      for (const y of ys) {
        const box = { left: x - 14, right: x + 14, top: y - 14, bottom: y + 14 };
        if (
          Math.abs(x) > 1e6 ||
          Math.abs(y) > 1e6 ||
          boxes.some((b) => overlaps(box, b)) ||
          result.some((n) => Math.abs(n.x - x) < 28 && Math.abs(n.y - y) < 28)
        )
          continue;
        options.push({ x, y });
      }
    const cost = (p: Point) => anchors.reduce((n, a) => n + Math.abs(a.x - p.x) + Math.abs(a.y - p.y), 0);
    options.sort(
      (a, b) =>
        cost(a) - cost(b) ||
        Math.abs(a.x - center.x) + Math.abs(a.y - center.y) - Math.abs(b.x - center.x) - Math.abs(b.y - center.y) ||
        a.y - b.y ||
        a.x - b.x,
    );
    const chosen = options[0];
    result.push(chosen ? { ...node, ...chosen } : node);
  }
  return project.layout.nodes.map((n) => result.find((p) => p.nodeId === n.nodeId) ?? n);
}

/** Stop at power/return equipment and shared junctions, so common supply cannot merge independent actuators.
 * Equal-distance equipment is shared instead of being silently assigned to the first actuator. */
function branches(
  project: NetworkProject,
  policy: 'legacy' | 'compact',
): {
  owners: ReadonlyMap<string, string>;
  distances: ReadonlyMap<string, number>;
  seeds: readonly string[];
  staged: ReadonlySet<string>;
} {
  const components = new Map(project.design.components.map((c) => ['c:' + c.id, c]));
  const adjacency = new Map<string, Set<string>>();
  const owner = (e: NetworkProject['design']['connections'][number]['from']) =>
    e.kind === 'port' ? 'c:' + e.componentId : 'n:' + e.nodeId;
  for (const e of project.design.connections) {
    const a = owner(e.from),
      b = owner(e.to);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      if (from === undefined || to === undefined) continue;
      const next = adjacency.get(from) ?? new Set<string>();
      next.add(to);
      adjacency.set(from, next);
    }
  }
  const position = new Map(project.layout.components.map((p) => [p.componentId, p]));
  const seeds = project.design.components
    .filter((c) => isNetworkActuatorType(c.typeId))
    .map((c) => c.id)
    .sort(
      (a, b) =>
        (policy === 'compact' ? 0 : (position.get(a)?.x ?? 0) - (position.get(b)?.x ?? 0)) || a.localeCompare(b, 'en'),
    );
  const nearest = new Map<string, { distance: number; owners: Set<string> }>();
  for (const seed of seeds) {
    const queue = [{ id: 'c:' + seed, distance: 0 }],
      seen = new Set<string>();
    for (const entry of queue) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const c = components.get(entry.id);
      const role = c && networkLayoutProfiles[c.typeId]?.role;
      const localTank =
        policy === 'compact' &&
        c?.typeId === 'tank' &&
        adjacency.get(entry.id)?.size === 1 &&
        [...(adjacency.get(entry.id) ?? [])].every((id) => components.get(id)?.typeId === 'check-valve');
      if (
        entry.distance > 0 &&
        (c
          ? (role === 'source' || role === 'reservoir' || role === 'actuator' || c.typeId === 'relief') && !localTank
          : (adjacency.get(entry.id)?.size ?? 0) > 2)
      )
        continue;
      if (c) {
        const previous = nearest.get(c.id);
        if (!previous || entry.distance < previous.distance)
          nearest.set(c.id, { distance: entry.distance, owners: new Set([seed]) });
        else if (entry.distance === previous.distance) previous.owners.add(seed);
      }
      for (const next of [...(adjacency.get(entry.id) ?? [])].sort())
        queue.push({ id: next, distance: entry.distance + 1 });
    }
  }
  const owners = new Map<string, string>(),
    distances = new Map<string, number>(),
    staged = new Set<string>();
  for (const [id, value] of nearest) {
    if (value.owners.size !== 1) continue;
    for (const owner of value.owners) {
      owners.set(id, owner);
      distances.set(id, value.distance);
    }
  }
  if (policy === 'compact') {
    const work = networkLayoutWorkStages(project);
    for (const [id, { actuator, depth }] of work.rows) {
      owners.set(id, actuator);
      distances.set(id, depth);
      staged.add(id);
    }
    for (const id of work.shared) {
      owners.delete(id);
      distances.delete(id);
    }
  }
  return { owners, distances, seeds, staged };
}

/** Pure placement policy behind the existing layout preview/transaction boundary. No topology or route editing. */
export function planNetworkComponentPositions(
  project: NetworkProject,
  moving: ReadonlySet<string>,
  junctions: 'preserve' | 'follow' = 'preserve',
  policy: 'legacy' | 'compact' = 'legacy',
): Result<ReadonlyMap<string, Point>> {
  const measured = frames(project, policy);
  if (!measured.ok) return measured;
  const boxes = measured.value,
    original = new Map(project.layout.components.map((p) => [p.componentId, p]));
  const graph = branches(project, policy),
    rows = new Map<number, string[]>(),
    branchRows = new Map<string, Map<number, string[]>>();
  const verticalBranches = policy === 'compact' && graph.seeds.length > 1 && networkLayoutBuses(project).length >= 2;
  const branchDepth = (c: NetworkProject['design']['components'][number], owner: string): number => {
    if (!verticalBranches || graph.staged.has(c.id)) return graph.distances.get(c.id) ?? 0;
    if (c.typeId === 'valve') return 2;
    if (c.typeId === 'throttle' || c.typeId === 'one-way-throttle') {
      const workingSide = project.design.connections.some(
        (edge) =>
          [edge.from, edge.to].some((end) => end.kind === 'port' && end.componentId === c.id) &&
          [edge.from, edge.to].some((end) => end.kind === 'port' && end.componentId === owner),
      );
      return workingSide ? 1 : 3;
    }
    return graph.distances.get(c.id) ?? 0;
  };
  const sharedTypes: Readonly<Record<string, number>> = { tank: 1 };
  const storageStation =
    policy === 'compact' &&
    graph.seeds.length === 0 &&
    project.design.components.some((c) => c.typeId === 'accumulator') &&
    project.design.components.some((c) => c.typeId === 'pilot-unloading-valve');
  // A charging station has no actuator to seed the upper row. Keep its
  // pressure storage and measurement above the valves and supply.
  const stationRows: Readonly<Record<string, number>> = {
    accumulator: 0,
    'adjustable-pressure-switch': 0,
    pump: 2,
    'pressure-source': 2,
    tank: 3,
  };
  const maxDepth = Math.max(
    0,
    ...[...moving].filter((id) => graph.owners.has(id)).map((id) => graph.distances.get(id) ?? 0),
  );
  const compactControlDepth = Math.max(
    1,
    ...project.design.components
      .filter(
        (c) =>
          graph.owners.has(c.id) && !isNetworkActuatorType(c.typeId) && !['volume', 'check-valve'].includes(c.typeId),
      )
      .map((c) => graph.distances.get(c.id) ?? 1),
  );
  for (const c of project.design.components.filter((c) => moving.has(c.id))) {
    const owner = graph.owners.get(c.id),
      row = storageStation
        ? (stationRows[c.typeId] ?? 1)
        : policy === 'compact'
          ? owner
            ? ['volume', 'tank'].includes(c.typeId)
              ? -1
              : c.typeId === 'check-valve'
                ? 0
                : branchDepth(c, owner)
            : compactControlDepth + 1 + (sharedTypes[c.typeId] ?? 0)
          : owner
            ? (graph.distances.get(c.id) ?? 0)
            : maxDepth + 1 + (sharedTypes[c.typeId] ?? 0);
    const list = rows.get(row) ?? [];
    list.push(c.id);
    rows.set(row, list);
    const groupId = owner ? 'branch:' + owner : 'shared',
      group = branchRows.get(groupId) ?? new Map<number, string[]>(),
      members = group.get(row) ?? [];
    members.push(c.id);
    group.set(row, members);
    branchRows.set(groupId, group);
  }
  const groups: Group[] = [];
  for (const groupId of [...graph.seeds.map((id) => 'branch:' + id), 'shared']) {
    const groupRows = branchRows.get(groupId);
    if (!groupRows) continue;
    let width = 0;
    for (const ids of groupRows.values()) {
      // The actuator stays between local A/B accessories, independent of their initial grid positions.
      const side = (id: string): number => {
        if (policy !== 'compact' || groupId === 'shared') return original.get(id)?.x ?? 0;
        const seed = groupId.slice('branch:'.length);
        if (id === seed) return 0;
        for (const edge of project.design.connections) {
          const ends = [edge.from, edge.to];
          if (!ends.some((e) => e.kind === 'port' && e.componentId === id)) continue;
          const end = ends.find((e) => e.kind === 'port' && e.componentId === seed);
          const component = project.design.components.find((c) => c.id === seed),
            placement = original.get(seed);
          if (end?.kind === 'port' && component && placement) {
            const anchor = networkPortAnchor(component, { ...placement, x: 0, y: 0 }, end.portId);
            if (anchor) return anchor.x || anchor.y;
          }
        }
        return policy === 'compact' ? 0 : (original.get(id)?.x ?? 0);
      };
      ids.sort((a, b) => side(a) - side(b) || a.localeCompare(b, 'en'));
      let total = 0;
      for (const id of ids) {
        const frame = boxes.get(id);
        if (!frame) return fail('整理对象缺少绘图包络。');
        total += frame.right - frame.left;
      }
      width = Math.max(width, total + (ids.length - 1) * horizontalGap);
    }
    const seedId = groupId.slice('branch:'.length);
    const anchor = groupId !== 'shared' && !moving.has(seedId) ? original.get(seedId) : undefined;
    groups.push({ id: groupId, rows: groupRows, width, anchorX: anchor ? anchor.x : null });
  }
  const branchGroups = groups.filter((g) => g.id !== 'shared'),
    shared = groups.find((g) => g.id === 'shared');
  const branchWidth = branchGroups.reduce((n, g) => n + g.width, 0) + Math.max(0, branchGroups.length - 1) * branchGap;
  const totalWidth = Math.max(branchWidth, shared?.width ?? 0);
  const movingFrames: Frame[] = [];
  for (const id of moving) {
    const f = boxes.get(id),
      p = original.get(id);
    if (!f || !p) return fail('整理范围缺少元件位置。');
    movingFrames.push({ id, ...translated(f, p) });
  }
  if (!movingFrames.length) return fail('请选择至少一个未锁定元件。');
  const rowLevels = [...rows.keys()].sort((a, b) => a - b),
    rowSizes = new Map<number, { top: number; bottom: number }>();
  for (const row of rowLevels) {
    const members = rows.get(row) ?? [],
      present = members.flatMap((id) => {
        const f = boxes.get(id);
        return f ? [f] : [];
      });
    rowSizes.set(row, {
      top: Math.min(...present.map((f) => f.top)),
      bottom: Math.max(...present.map((f) => f.bottom)),
    });
  }
  const totalHeight =
    [...rowSizes.values()].reduce((n, b) => n + b.bottom - b.top, 0) + Math.max(0, rowLevels.length - 1) * verticalGap;
  if (totalWidth > 1980000 || totalHeight > 1980000) return fail('元件与名称占位超出画布支持范围；请缩小整理范围。');
  const originX = Math.max(-990000, Math.min(990000 - totalWidth, Math.min(...movingFrames.map((f) => f.left))));
  const originY = Math.max(-990000, Math.min(990000 - totalHeight, Math.min(...movingFrames.map((f) => f.top))));
  const centers = new Map<string, number>();
  let cursor = originX + (totalWidth - branchWidth) / 2;
  for (const g of branchGroups) {
    centers.set(g.id, g.anchorX ?? cursor + g.width / 2);
    cursor += g.width + branchGap;
  }
  centers.set('shared', originX + totalWidth / 2);
  const desired = new Map<string, Point>();
  let top = originY;
  for (const row of rowLevels) {
    const size = rowSizes.get(row);
    if (!size) return fail('整理层次缺少尺寸。');
    const y = top - size.top;
    for (const g of groups) {
      const ids = g.rows.get(row);
      if (!ids) continue;
      const center = centers.get(g.id);
      if (center === undefined) return fail('整理分支缺少中心。');
      let width = 0;
      for (const id of ids) {
        const f = boxes.get(id);
        if (!f) return fail('整理元件缺少尺寸。');
        width += f.right - f.left;
      }
      width += Math.max(0, ids.length - 1) * horizontalGap;
      let left = center - width / 2;
      for (const id of ids) {
        const f = boxes.get(id);
        if (!f) return fail('整理元件缺少尺寸。');
        let x = left - f.left;
        if (policy === 'compact' && g.id !== 'shared' && ids.length === 1) {
          const c = project.design.components.find((c) => c.id === id),
            p = original.get(id);
          // Align the working-port centre of a cylinder/valve column, rather than its asymmetric rod envelope.
          const ports =
            c && p
              ? ['A', 'B'].flatMap((portId) => {
                  const a = networkPortAnchor(c, { ...p, x: 0, y: 0 }, portId);
                  return a ? [a.x] : [];
                })
              : [];
          if (ports.length) x = center - ports.reduce((sum, value) => sum + value, 0) / ports.length;
        }
        desired.set(id, { x, y });
        left += f.right - f.left + horizontalGap;
      }
    }
    top += size.bottom - size.top + verticalGap;
  }
  // Keep a stable reference component near its original position. Deriving every new origin from the
  // previous bounding box makes repeated arrangement drift when a fixed node displaces one symbol.
  const referenceId = graph.seeds.find((id) => moving.has(id)) ?? [...moving].sort()[0];
  if (policy === 'compact' && referenceId && branchGroups.length && moving.size === project.design.components.length)
    return balanceNetworkComponentPositions(
      project,
      boxes,
      desired,
      branchGroups.map((g) => [...g.rows.values()].flat()),
      shared ? [...shared.rows.values()].flat() : [],
      referenceId,
      graph.staged,
    );
  const reference = referenceId ? original.get(referenceId) : undefined;
  const target = referenceId ? desired.get(referenceId) : undefined;
  if (!reference || !target) return fail('整理范围缺少参考位置。');
  const planned: NetworkDrawingBounds[] = [];
  for (const [id, p] of desired) {
    const f = boxes.get(id);
    if (!f) return fail('整理元件缺少尺寸。');
    planned.push(translated(f, p));
  }
  const minX = Math.min(...planned.map((f) => f.left)),
    maxX = Math.max(...planned.map((f) => f.right)),
    minY = Math.min(...planned.map((f) => f.top)),
    maxY = Math.max(...planned.map((f) => f.bottom));
  const dx = Math.max(-990000 - minX, Math.min(reference.x - target.x, 990000 - maxX));
  const dy = Math.max(-990000 - minY, Math.min(reference.y - target.y, 990000 - maxY));
  for (const [id, p] of desired) desired.set(id, { x: p.x + dx, y: p.y + dy });
  const blocked: NetworkDrawingBounds[] = [];
  for (const [id, f] of boxes) {
    const p = original.get(id);
    if (!moving.has(id) && p) blocked.push(translated(f, p));
  }
  blocked.push(
    ...project.layout.nodes
      .filter(
        (p) =>
          junctions === 'preserve' ||
          project.design.connections.some(
            (e) =>
              project.layout.routes.find((r) => r.connectionId === e.id)?.mode === 'manual' &&
              [e.from, e.to].some((end) => end.kind === 'node' && end.nodeId === p.nodeId),
          ),
      )
      .map((p) => ({ left: p.x - 28, right: p.x + 28, top: p.y - 28, bottom: p.y + 28 })),
  );
  const positions = new Map<string, Point>();
  // At most two edge candidates per existing obstacle. Search stays finite and fails as one batch.
  for (const row of rowLevels) {
    const ids = [...(rows.get(row) ?? [])].sort(
      (a, b) => (desired.get(a)?.x ?? 0) - (desired.get(b)?.x ?? 0) || a.localeCompare(b, 'en'),
    );
    for (const id of ids) {
      const f = boxes.get(id),
        p = desired.get(id);
      if (!f || !p) return fail('整理对象缺少候选位置。');
      const relevant = blocked.filter(
        (b) => p.y + f.top < b.bottom + obstacleGap && p.y + f.bottom > b.top - obstacleGap,
      );
      const xs = [
        p.x,
        ...relevant.flatMap((b) => [b.right + obstacleGap - f.left, b.left - obstacleGap - f.right]),
      ].sort((a, b) => Math.abs(a - p.x) - Math.abs(b - p.x) || a - b);
      const x = xs.find((x) => {
        const box = translated(f, { x, y: p.y });
        return (
          box.left >= -1e6 &&
          box.right <= 1e6 &&
          box.top >= -1e6 &&
          box.bottom <= 1e6 &&
          !blocked.some((b) => overlaps(box, b))
        );
      });
      if (x === undefined) return fail('当前坐标边界或固定障碍下找不到布局位置；工程未改变。');
      // Canonical drawing coordinates prevent roundoff-only movement/history on repeated arrangement.
      // This precision is drawing-only and does not round any SI parameter or result.
      positions.set(id, policy === 'compact' ? { x: Number(x.toFixed(6)), y: Number(p.y.toFixed(6)) } : { x, y: p.y });
      blocked.push(translated(f, { x, y: p.y }));
    }
  }
  return { ok: true, value: positions };
}
