import type { NetworkDraftSession, NetworkConnectionAnchor, NetworkRouteAnchor } from '@hyd/application';
import type { NetworkEndpoint } from '@hyd/domain';
import { nearestEndpoint } from './network-cad.mjs';
import { boardElement } from './network-dom.mjs';
export type BoardTarget =
  | { kind: 'component' | 'node' | 'connection' | 'text'; id: string; positionId?: string; endpoint?: NetworkEndpoint }
  | { kind: 'endpoint'; endpoint: NetworkEndpoint }
  | { kind: 'branch'; endpoint: NetworkRouteAnchor }
  | { kind: 'background' }
  | { kind: 'ambiguous' }
  | { kind: 'path'; id: string; index: number; part: 'bend' | 'segment' };

export function createCanvasTargets(hooks: {
  editor(): NetworkDraftSession;
  connectionActive(): boolean;
  connectionRadius(): number;
  branchPoints(): readonly NetworkRouteAnchor[];
}) {
  const board = boardElement();
  const targetOf = (element: Element): BoardTarget => {
    const branch = element.closest('[data-branch-connection]');
    if (branch) {
      const point = hooks
        .branchPoints()
        .find(
          (p) =>
            p.connectionId === branch.getAttribute('data-branch-connection') &&
            String(p.point.x) === branch.getAttribute('data-branch-x') &&
            String(p.point.y) === branch.getAttribute('data-branch-y'),
        );
      if (point) return { kind: 'branch', endpoint: point };
    }
    const text = element.closest('[data-text-id]')?.getAttribute('data-text-id');
    if (text) return { kind: 'text', id: text };
    const handle = element.closest<SVGElement>('[data-path-id]');
    if (handle)
      return {
        kind: 'path',
        id: handle.dataset.pathId!,
        index: Number(handle.dataset.index),
        part: handle.dataset.part === 'bend' ? 'bend' : 'segment',
      };
    const endpointElement = element.closest<SVGElement>('[data-endpoint]');
    const endpoint = endpointElement ? readEndpoint(endpointElement.dataset.endpoint ?? '{}') : undefined;
    const node = element.closest<SVGGElement>('[data-node]');
    if (node) return { kind: 'node', id: node.dataset.node!, ...(endpoint ? { endpoint } : {}) };
    if (endpoint) return { kind: 'endpoint', endpoint };
    const component = element.closest<SVGGElement>('[data-component]');
    if (component) {
      const cell = element.closest<SVGGElement>('[data-position]');
      return {
        kind: 'component',
        id: component.dataset.component!,
        ...(cell ? { positionId: cell.dataset.position! } : {}),
      };
    }
    const edge = element.closest<SVGPathElement>('[data-connection],[data-connection-hit]');
    return edge
      ? { kind: 'connection', id: edge.dataset.connection ?? edge.dataset.connectionHit! }
      : { kind: 'background' };
  };
  const snapAt = (
    x: number,
    y: number,
    includeNodes: boolean,
  ): { kind: 'hit'; endpoint: NetworkConnectionAnchor } | { kind: 'ambiguous' } | null => {
    const matrix = board.getScreenCTM();
    if (!matrix) return null;
    const radius = hooks.connectionRadius();
    const existing = nearestEndpoint(
      hooks.editor().document,
      { x, y },
      (point) => new DOMPoint(point.x, point.y).matrixTransform(matrix),
      includeNodes,
      radius,
    );
    if (existing) return existing;
    const points = hooks
      .branchPoints()
      .map((endpoint) => {
        const p = new DOMPoint(endpoint.point.x, endpoint.point.y).matrixTransform(matrix);
        return { endpoint, distance: Math.hypot(p.x - x, p.y - y) };
      })
      .filter((p) => p.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    const first = points[0];
    if (!first) return null;
    if (points[1] && points[1].distance - first.distance <= 2) return { kind: 'ambiguous' };
    return { kind: 'hit', endpoint: first.endpoint };
  };
  const targetAt = (element: Element, x: number, y: number): BoardTarget => {
    const direct = targetOf(element);
    if (
      direct.kind === 'branch' ||
      direct.kind === 'path' ||
      direct.kind === 'node' ||
      element.closest('[data-body-hit],[data-position]')
    )
      return direct;
    const hit = snapAt(x, y, hooks.connectionActive());
    if (hit?.kind === 'ambiguous') return hit;
    return hit
      ? hit.endpoint.kind === 'route'
        ? { kind: 'branch', endpoint: hit.endpoint }
        : { kind: 'endpoint', endpoint: hit.endpoint }
      : direct;
  };

  return { targetOf, targetAt, snapAt };
}
export function readEndpoint(text: string): NetworkEndpoint | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !('kind' in raw)) return undefined;
    if (
      raw.kind === 'port' &&
      'componentId' in raw &&
      typeof raw.componentId === 'string' &&
      'portId' in raw &&
      typeof raw.portId === 'string'
    )
      return { kind: 'port', componentId: raw.componentId, portId: raw.portId };
    if (raw.kind === 'node' && 'nodeId' in raw && typeof raw.nodeId === 'string')
      return { kind: 'node', nodeId: raw.nodeId };
  } catch {
    return undefined;
  }
  return undefined;
}
