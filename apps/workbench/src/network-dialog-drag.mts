/** View-only positioning shared by static and dynamically constructed modal dialogs. */
export function setupNetworkDialogDragging(): void {
  let drag: {
    dialog: HTMLDialogElement;
    header: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null = null;
  function place(dialog: HTMLDialogElement, left: number, top: number): void {
    const box = dialog.getBoundingClientRect();
    dialog.style.margin = '0';
    dialog.style.inset = 'auto';
    dialog.style.left = Math.max(8, Math.min(left, innerWidth - box.width - 8)) + 'px';
    dialog.style.top = Math.max(8, Math.min(top, innerHeight - box.height - 8)) + 'px';
    dialog.dataset.dragPositioned = 'true';
  }
  function stop(): void {
    const previous = drag;
    drag = null;
    if (previous?.header.hasPointerCapture(previous.pointerId))
      previous.header.releasePointerCapture(previous.pointerId);
    document.documentElement.classList.remove('dialog-dragging');
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || !(event.target instanceof Element)) return;
    if (event.target.closest('button,input,select,textarea,a,[contenteditable]')) return;
    const header = event.target.closest('.dialog-head'),
      dialog = header?.closest('dialog');
    if (!(header instanceof HTMLElement) || !(dialog instanceof HTMLDialogElement) || !dialog.open) return;
    const box = dialog.getBoundingClientRect();
    drag = {
      dialog,
      header,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: box.left,
      top: box.top,
    };
    header.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('dialog-dragging');
    event.preventDefault();
  });
  document.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dialog.open || !drag.dialog.isConnected) {
      stop();
      return;
    }
    place(drag.dialog, drag.left + event.clientX - drag.startX, drag.top + event.clientY - drag.startY);
    event.preventDefault();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
    document.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) stop();
    });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !drag) return;
      place(drag.dialog, drag.left, drag.top);
      stop();
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  window.addEventListener('blur', stop);
  window.addEventListener('resize', () => {
    stop();
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open][data-drag-positioned]')) {
      const box = dialog.getBoundingClientRect();
      place(dialog, box.left, box.top);
    }
  });
  new MutationObserver((changes) => {
    for (const change of changes) {
      const dialog = change.target;
      if (!(dialog instanceof HTMLDialogElement)) continue;
      if (!dialog.open) {
        if (drag?.dialog === dialog) stop();
        continue;
      }
      if (dialog.dataset.dragPositioned) {
        const box = dialog.getBoundingClientRect();
        place(dialog, box.left, box.top);
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
}
