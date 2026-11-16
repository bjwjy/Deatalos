import {
  diagnostic,
  isNetworkActuatorType,
  networkPortAnchor,
  type NetworkDrawingBounds,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { networkLayoutBuses } from './network-layout-buses.js';
import { networkLayoutProfiles } from './network-layout-roles.js';

type Point = { readonly x: number; readonly y: number };
type Item = {
  readonly id: string;
  readonly frame: NetworkDrawingBounds;
  readonly base: Point;
  readonly component: NetworkProject['design']['components'][number];
  readonly placement: NetworkProject['layout']['components'][number];
};
type Placed = { readonly item: Item; readonly x: number; readonly y: number };
const gap = 32;
const extent = (items: readonly Placed[]): NetworkDrawingBounds => ({
  left: Math.min(...items.map((p) => p.x + p.item.frame.left)),
  right: Math.max(...items.map((p) => p.x + p.item.frame.right)),
  top: Math.min(...items.map((p) => p.y + p.item.frame.top)),
  bottom: Math.max(...items.map((p) => p.y + p.item.frame.bottom)),
});
const shifted = (items: readonly Placed[], x: number, y: number): Placed[] =>
  items.map((p) => ({ ...p, x: p.x + x, y: p.y + y }));
const fail = (): Result<never> => ({
  ok: false,
  diagnostics: [
    diagnostic('LAYOUT_UNSUPPORTED', '/layoutOperation', '整理对象缺少完整几何或超出绘图边界；工程未改变。'),
  ],
});

/** Finite block packing: keep each actuator/control branch intact, fold wide sets into bands,
 * and pack the common supply compactly. Scores use real extents and connected-port distance;
 * there is no stretching, symbol scaling, topology change or screenshot-coordinate template. */
export function balanceNetworkComponentPositions(
  project: NetworkProject,
  frames: ReadonlyMap<string, NetworkDrawingBounds>,
  base: ReadonlyMap<string, Point>,
  branchIds: readonly (readonly string[])[],
  sharedIds: readonly string[],
  referenceId: string,
  workRows: ReadonlySet<string>,
): Result<ReadonlyMap<string, Point>> {
  const items = new Map<string, Item>();
  for (const component of project.design.components) {
    const frame = frames.get(component.id),
      point = base.get(component.id),
      placement = project.layout.components.find((p) => p.componentId === component.id);
    if (!frame || !point || !placement) return fail();
    items.set(component.id, { id: component.id, component, frame, base: point, placement });
  }
  const branches = branchIds.map((ids) =>
    ids.flatMap((id) => {
      const item = items.get(id);
      return item ? [{ item, ...item.base }] : [];
    }),
  );
  const shared = sharedIds.flatMap((id) => {
    const item = items.get(id);
    return item ? [item] : [];
  });
  const reference = items.get(referenceId);
  if (
    !reference ||
    !branches.length ||
    branches.some((b, i) => b.length !== branchIds[i]?.length) ||
    shared.length !== sharedIds.length
  )
    return fail();
  // Stable semantic/ID order also survives band wrapping and differently ordered input arrays.
  const role = (item: Item) =>
    item.component.typeId === 'tank'
      ? 3
      : item.component.typeId === 'pump' || item.component.typeId === 'pressure-source'
        ? 2
        : item.component.typeId === 'relief'
          ? 1
          : 0;
  shared.sort((a, b) => role(a) - role(b) || a.id.localeCompare(b.id, 'en'));
  let best: { readonly score: number; readonly positions: ReadonlyMap<string, Point> } | null = null;
  const dividers = shared.filter(({ component }) => networkLayoutProfiles[component.typeId]?.role === 'divider');
  const dividedBranches = branches.length > 1 && dividers.length > 0;
  const busColumns = branches.length > 1 && networkLayoutBuses(project).length >= 2;
  // Multi-actuator drawings read as independent vertical columns. Do not fold
  // those columns into stacked bands merely to improve the aspect-ratio score.
  const verticalBranches = busColumns || dividedBranches;
  const collectorColumns =
    branches.length > 1 &&
    branches.some((branch) =>
      branch.some(
        ({ item }) => workRows.has(item.id) && networkLayoutProfiles[item.component.typeId]?.role === 'divider',
      ),
    );
  const stages = dividedBranches ? [dividers, shared.filter((item) => item.component.typeId === 'valve')] : [];
  const supplyItems = shared.filter((item) => !stages.some((stage) => stage.includes(item)));
  const columnCounts =
    verticalBranches || collectorColumns ? [branches.length] : Array.from({ length: branches.length }, (_, i) => i + 1);
  for (const columns of columnCounts) {
    const branchLayout: Placed[] = [];
    let top = 0;
    for (let i = 0; i < branches.length; i += columns) {
      const band = branches.slice(i, i + columns),
        originalTop = Math.min(...band.map((b) => extent(b).top));
      let left = 0;
      const placedBand: Placed[] = [];
      for (const block of band) {
        const bounds = extent(block);
        placedBand.push(...shifted(block, left - bounds.left, top - originalTop));
        left += bounds.right - bounds.left + gap;
      }
      branchLayout.push(...placedBand);
      top = extent(placedBand).bottom + gap;
    }
    const branchBounds = extent(branchLayout);
    const executionFloor = Math.max(
      ...branchLayout
        .filter(
          ({ item }) =>
            isNetworkActuatorType(item.component.typeId) ||
            (workRows.has(item.id) && networkLayoutProfiles[item.component.typeId]?.role !== 'directional'),
        )
        .map((p) => p.y + p.item.frame.bottom),
    );
    for (let supplyColumns = 1; supplyColumns <= Math.max(1, Math.min(4, supplyItems.length)); supplyColumns++) {
      const supply: Placed[] = [];
      let supplyTop = 0;
      const supplyRows = stages.filter((stage) => stage.length > 0);
      for (let i = 0; i < supplyItems.length; i += supplyColumns)
        supplyRows.push(supplyItems.slice(i, i + supplyColumns));
      for (const row of supplyRows) {
        const rowPlaced: Placed[] = [];
        let left = 0;
        for (const item of row) {
          // A nearby return tank can sit slightly lower without consuming a whole extra layer.
          const drop = item.component.typeId === 'tank' ? 40 : 0;
          rowPlaced.push({ item, x: left - item.frame.left, y: supplyTop - item.frame.top + drop });
          left += item.frame.right - item.frame.left + gap;
        }
        const bounds = extent(rowPlaced);
        supply.push(...(dividedBranches ? shifted(rowPlaced, -(bounds.left + bounds.right) / 2, 0) : rowPlaced));
        supplyTop = bounds.bottom + gap;
      }
      const supplyBounds = supply.length ? extent(supply) : { left: 0, right: 0, top: 0, bottom: 0 };
      const sides = verticalBranches ? (['bottom'] as const) : (['bottom', 'left', 'right'] as const);
      for (const side of sides) {
        const dx =
          side === 'bottom'
            ? (branchBounds.left + branchBounds.right - supplyBounds.left - supplyBounds.right) / 2
            : side === 'left'
              ? branchBounds.left - gap - supplyBounds.right
              : branchBounds.right + gap - supplyBounds.left;
        const dy =
          side === 'bottom'
            ? branchBounds.bottom + gap + (busColumns ? 112 : 0) - supplyBounds.top
            : branchBounds.bottom - supplyBounds.bottom;
        if (side !== 'bottom' && supply.length && supplyBounds.top + dy < executionFloor + gap) continue;
        const candidate = [...branchLayout, ...shifted(supply, dx, dy)],
          bounds = extent(candidate);
        const width = bounds.right - bounds.left,
          height = bounds.bottom - bounds.top;
        const positions = new Map(candidate.map((p) => [p.item.id, { x: p.x, y: p.y }]));
        let wire = 0;
        for (const edge of project.design.connections) {
          if (edge.from.kind !== 'port' || edge.to.kind !== 'port') continue;
          const a = items.get(edge.from.componentId),
            b = items.get(edge.to.componentId),
            pa = positions.get(edge.from.componentId),
            pb = positions.get(edge.to.componentId);
          if (!a || !b || !pa || !pb) return fail();
          const start = networkPortAnchor(a.component, { ...a.placement, ...pa }, edge.from.portId),
            end = networkPortAnchor(b.component, { ...b.placement, ...pb }, edge.to.portId);
          if (!start || !end) return fail();
          wire += Math.abs(start.x - end.x) + Math.abs(start.y - end.y);
        }
        // Minimise the longest side first, while charging for empty area and needlessly long links.
        const elongation = Math.max(0, Math.max(width, height) / Math.min(width, height) - 1.4);
        const score =
          Math.max(width, height) ** 2 +
          width * height * (0.3 + 5 * elongation ** 2) +
          wire * Math.sqrt(width * height) * 0.04;
        if (!best || score < best.score) best = { score, positions };
      }
    }
  }
  if (!best) return fail();
  const target = best.positions.get(referenceId);
  if (!target) return fail();
  const dx = reference.placement.x - target.x,
    dy = reference.placement.y - target.y;
  const result = new Map<string, Point>();
  for (const [id, p] of best.positions) {
    const frame = frames.get(id);
    if (!frame) return fail();
    const x = Number((p.x + dx).toFixed(6)),
      y = Number((p.y + dy).toFixed(6));
    if (x + frame.left < -1e6 || x + frame.right > 1e6 || y + frame.top < -1e6 || y + frame.bottom > 1e6) return fail();
    result.set(id, { x, y });
  }
  return { ok: true, value: result };
}
