import type { NetworkDraftSession } from '@hyd/application';
import type { NetworkProject } from '@hyd/domain';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { Point } from './network-cad.mjs';
import { boardElement } from './network-dom.mjs';

import { tailStrokeTargets, type TrimTarget } from './network-tail-trim-plan.mjs';
import { routePath } from './network-presentation.mjs';

export function setupTailTrim(
  canvas: NetworkCanvas,
  editor: () => NetworkDraftSession,
  apply: (project: NetworkProject) => boolean,
) {
  const board = boardElement();
  let armed: NetworkDraftSession | null = null;
  function beginStroke(event: PointerEvent, point: Point) {
    const owner = editor();
    return {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragged: false,
      owner,
      revision: owner.revision,
      previous: point,
      resolve: tailStrokeTargets(owner.document, canvas.currentRoute),
      target: undefined as TrimTarget | undefined | null,
    };
  }
  let stroke: ReturnType<typeof beginStroke> | null = null;
  function clearPreview() {
    board.querySelector('[data-trim-path]')?.remove();
    board.querySelectorAll('.trim-preview').forEach((el) => el.classList.remove('trim-preview'));
  }
  function finishStroke() {
    const id = stroke?.id;
    stroke = null;
    clearPreview();
    if (id !== undefined && board.hasPointerCapture(id)) board.releasePointerCapture(id);
  }
  function cancel() {
    finishStroke();
    armed = null;
    delete board.dataset.tailTrim;
  }
  function valid() {
    return armed === editor() && canvas.editable && !document.querySelector('dialog[open]');
  }
  function sweep(event: PointerEvent) {
    const s = stroke;
    if (!s || s.id !== event.pointerId) return;
    const p = canvas.positionAtClient(event.clientX, event.clientY);
    if (!p || !valid() || s.owner.revision !== s.revision) {
      finishStroke();
      return;
    }
    const target = s.resolve(s.previous, p);
    s.previous = p;
    if (!s.dragged && Math.hypot(event.clientX - s.startX, event.clientY - s.startY) < 6) return;
    s.dragged = true;
    if (target === s.target && (!target || board.querySelector('.trim-preview'))) return;
    s.target = target;
    paint(target);
  }
  board.addEventListener('refresh-trim-preview', () => {
    if (stroke?.target) paint(stroke.target);
  });
  function paint(target: TrimTarget | undefined | null) {
    clearPreview();
    if (!target) return;
    for (const item of target.selection) {
      board
        .querySelectorAll('[data-' + item.kind + '="' + CSS.escape(item.id) + '"]')
        .forEach((el) => el.classList.add('trim-preview'));
    }
    if (target.preview?.length) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.dataset.trimPath = '';
      path.setAttribute('d', target.preview.map(routePath).join(' '));
      board.append(path);
    }
  }
  board.addEventListener(
    'pointerdown',
    (event) => {
      if (!armed || event.button !== 0) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const point = canvas.positionAtClient(event.clientX, event.clientY);
      if (!valid() || !point) {
        finishStroke();
        return;
      }
      if (stroke) return;
      stroke = beginStroke(event, point);
      board.setPointerCapture(event.pointerId);
    },
    true,
  );
  board.addEventListener(
    'pointermove',
    (event) => {
      if (stroke?.id !== event.pointerId) return;
      event.stopImmediatePropagation();
      sweep(event);
    },
    true,
  );
  board.addEventListener(
    'pointerup',
    (event) => {
      if (stroke?.id !== event.pointerId) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      sweep(event);
      const target = stroke?.target;
      finishStroke();
      const planned = target?.apply();
      if (planned && apply(planned)) {
        canvas.select([]);
        canvas.draw();
      }
    },
    true,
  );
  for (const type of ['pointercancel', 'lostpointercapture'] as const)
    board.addEventListener(type, (e) => {
      if (stroke?.id === e.pointerId) finishStroke();
    });
  return {
    cancel,
    finishStroke,
    get active() {
      return !!armed;
    },
    arm() {
      armed = editor();
      board.dataset.tailTrim = 'armed';
    },
  };
}
