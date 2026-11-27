import type { NetworkDraftSession } from '@hyd/application';
import { boardElement, element } from './network-dom.mjs';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { Point } from './network-cad.mjs';

/** Bind pointer actions to the picked connection and the revision that supplied its geometry. */
export function setupNetworkRouteMenu(
  canvas: NetworkCanvas,
  editor: () => NetworkDraftSession,
  changed: () => void,
): void {
  const board = boardElement(),
    menu = element('routeTools');
  let intent: { owner: NetworkDraftSession; revision: number; id: string; point: Point } | null = null;
  menu.addEventListener(
    'click',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || !menu.matches(':popover-open')) return;
      const pick = intent;
      menu.hidePopover();
      board.focus({ preventScroll: true });
      if (
        !pick ||
        pick.owner !== editor() ||
        pick.revision !== editor().revision ||
        !canvas.editable ||
        canvas.selected?.kind !== 'connection' ||
        canvas.selected.id !== pick.id
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (button.id === 'addRouteBend') canvas.addRouteBend(pick.id, pick.point);
      if (button.id === 'deleteRoute') canvas.removeSelected();
    },
    true,
  );
  board.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented || !canvas.editable || !(event.target instanceof Element)) return;
    const target = event.target.closest<SVGElement>(
      '[data-path-id],[data-branch-connection],[data-connection],[data-connection-hit]',
    );
    const id =
      target?.dataset.pathId ??
      target?.dataset.branchConnection ??
      target?.dataset.connection ??
      target?.dataset.connectionHit;
    if (!target || !id) return;
    event.preventDefault();
    if (menu.matches(':popover-open')) menu.hidePopover();
    intent = null;
    const point = canvas.positionAtClient(event.clientX, event.clientY),
      owner = editor();
    if (!point || !owner.document.design.connections.some((edge) => edge.id === id)) return;
    if (!target.dataset.pathId && !target.dataset.branchConnection) {
      const candidates = new Set(
        document.elementsFromPoint(event.clientX, event.clientY).flatMap((el) => {
          if (!board.contains(el)) return [];
          const edge = el.getAttribute('data-connection') ?? el.getAttribute('data-connection-hit');
          return edge ? [edge] : [];
        }),
      );
      if (candidates.size > 1) return;
    }
    canvas.selectRoute(id, target.dataset.part === 'bend' ? Number(target.dataset.index) : null);
    changed();
    intent = { owner, revision: owner.revision, id, point };
    menu.style.inset = 'auto';
    menu.style.margin = '0';
    menu.style.left = '0';
    menu.style.top = '0';
    menu.showPopover();
    menu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY, innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.querySelector('button')?.focus({ preventScroll: true });
  });
}
