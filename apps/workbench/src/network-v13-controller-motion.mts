import { element } from './network-dom.mjs';
import { networkUiIcon } from './network-v13-icons.mjs';

interface ActionDrag {
  readonly card: HTMLElement;
  readonly list: HTMLElement;
  readonly header: HTMLElement;
  readonly order: readonly HTMLElement[];
  readonly pointerId: number;
  readonly pressX: number;
  readonly pressY: number;
  lastX: number;
  lastY: number;
  preview?: { readonly proxy: HTMLElement; readonly slot: HTMLElement };
}
/** Controller form DOM remains its input buffer. Dragging changes only that DOM's order. */
export function setupNetworkControllerMotion(): void {
  const dialog = element('controllerDialog'),
    form = element('controllerForm');
  const body = dialog.querySelector<HTMLElement>(':scope>.dialog-body');
  if (!body) throw new Error('Controller scroll surface missing');
  const viewport = body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let drag: ActionDrag | undefined,
    frame = 0;
  const cards = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope>.controller-action')];
  const cancelAnimations = (list: HTMLElement) =>
    cards(list).forEach((card) => card.getAnimations().forEach((animation) => animation.cancel()));
  function rearrange(list: HTMLElement, change: () => void, moving?: HTMLElement): void {
    const others = cards(list).filter((card) => card !== moving);
    const positions = new Map(others.map((card) => [card, card.getBoundingClientRect().top]));
    cancelAnimations(list);
    change();
    if (reduced.matches) return;
    for (const card of others) {
      const previous = positions.get(card);
      if (previous === undefined) continue;
      const distance = previous - card.getBoundingClientRect().top;
      if (distance)
        card.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }], {
          duration: 220,
          easing: 'cubic-bezier(.22,1,.36,1)',
        });
    }
  }
  function decorate(): void {
    const list = document.getElementById('controllerActions');
    if (!list) return;
    list.classList.add('b2-action-list');
    for (const [index, card] of cards(list).entries()) {
      if (!card.classList.contains('b2-action-card')) {
        card.classList.add('b2-action-card');
        card.removeAttribute('style');
        const legend = card.querySelector(':scope>legend');
        legend?.remove();
        const header = document.createElement('header');
        header.className = 'b2-action-header';
        header.tabIndex = 0;
        header.setAttribute('aria-label', '拖动动作；上下方向键调整顺序');
        const order = document.createElement('span');
        order.className = 'b2-step-number';
        header.append(order);
        const title = card.querySelector<HTMLElement>(':scope>label:has([data-field="name"])');
        if (title) {
          title.classList.add('white-action-name');
          header.append(title);
        }
        const buttons = document.createElement('div');
        buttons.className = 'b2-card-order-buttons';
        for (const [selector, text, label] of [
          ['[data-up-action]', '↑', '上移动作'],
          ['[data-down-action]', '↓', '下移动作'],
          ['[data-remove-action]', '×', '删除动作'],
        ]) {
          const button = selector ? card.querySelector<HTMLButtonElement>(selector) : null;
          if (!button) continue;
          button.textContent = text || '';
          button.setAttribute('aria-label', label || '');
          button.classList.add('b2-icon-button');
          buttons.append(button);
        }
        header.append(buttons);
        card.prepend(header);
        const core = document.createElement('div');
        core.className = 'b2-action-core';
        for (const label of card.querySelectorAll<HTMLElement>(
          ':scope>label[data-command-field],:scope>label:has([data-field="timeout"])',
        ))
          core.append(label);
        header.after(core);
        const details = document.createElement('details');
        details.className = 'b2-action-details';
        const summary = document.createElement('summary');
        summary.append('结束条件');
        const count = document.createElement('span');
        count.dataset.conditionSummary = '';
        summary.append(count);
        details.append(summary);
        for (const node of card.querySelectorAll<HTMLElement>(
          ':scope>label:has([data-field="mode"]),:scope>.controller-conditions,:scope>[data-add-condition]',
        ))
          details.append(node);
        card.append(details);
      }
      const number = card.querySelector('.b2-step-number'),
        text = String(index + 1).padStart(2, '0');
      if (number && number.textContent !== text) number.textContent = text;
      const up = card.querySelector<HTMLButtonElement>('[data-up-action]'),
        down = card.querySelector<HTMLButtonElement>('[data-down-action]');
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === cards(list).length - 1;
      const summary = card.querySelector<HTMLElement>('[data-condition-summary]');
      const mode = card.querySelector<HTMLSelectElement>('[data-field="mode"] select')?.value;
      const value = `${card.querySelectorAll('.controller-condition').length}项 · ${mode === 'any' ? '任一满足' : '全部满足'}`;
      if (summary && summary.textContent !== value) summary.textContent = value;
    }
  }
  function finish(cancel = false): void {
    const current = drag;
    drag = undefined;
    cancelAnimationFrame(frame);
    if (!current) return;
    if (dialog.hasPointerCapture(current.pointerId)) dialog.releasePointerCapture(current.pointerId);
    if (!current.preview) return;
    const { proxy, slot } = current.preview;
    proxy.remove();
    const active = form.contains(current.list) && current.card.parentElement === current.list;
    rearrange(
      current.list,
      () => {
        if (!cancel && active) slot.replaceWith(current.card);
        else slot.remove();
        current.card.classList.remove('b2-action-in-hand');
      },
      current.card,
    );
    current.list.classList.remove('is-sorting');
    dialog.classList.remove('b2-action-sort-active');
    dialog.style.removeProperty('--action-sort-width');
    dialog.style.removeProperty('--action-sort-height');
    if (!active) return;
    const changed = cards(current.list).some((card, index) => current.order[index] !== card);
    if (!cancel && changed) form.dispatchEvent(new Event('change', { bubbles: true }));
    current.header.focus({ preventScroll: true });
    decorate();
  }
  function follow(): void {
    const current = drag;
    if (!current?.preview) return;
    const { proxy, slot } = current.preview;
    const dialogBox = dialog.getBoundingClientRect();
    proxy.style.left = current.lastX - dialogBox.left - dialog.clientLeft + 'px';
    proxy.style.top = current.lastY - dialogBox.top - dialog.clientTop + 'px';
    const listTop = current.list.getBoundingClientRect().top;
    const next = cards(current.list).find(
      (card) => card !== current.card && current.lastY < listTop + card.offsetTop + card.offsetHeight / 2,
    );
    const following =
      slot.nextElementSibling === current.card ? current.card.nextElementSibling : slot.nextElementSibling;
    if (following !== (next ?? null))
      rearrange(current.list, () => current.list.insertBefore(slot, next ?? null), current.card);
  }
  function scroll(): void {
    const current = drag;
    if (!current?.preview) return;
    const bounds = viewport.getBoundingClientRect();
    const bottom = Math.max(0, current.lastY - bounds.bottom + 45),
      top = Math.max(0, bounds.top + 45 - current.lastY);
    const speed = Math.max(-12, Math.min(12, (bottom - top) / 4));
    if (speed) {
      viewport.scrollTop += speed;
      follow();
    }
    frame = requestAnimationFrame(scroll);
  }
  form.addEventListener('pointerdown', (event) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      !(event.target instanceof Element) ||
      event.target.closest('button,input,select,textarea')
    )
      return;
    const header = event.target.closest<HTMLElement>('.b2-action-header'),
      card = header?.closest<HTMLElement>('.controller-action'),
      list = card?.parentElement;
    if (!header || !card || !list) return;
    finish(true);
    event.preventDefault();
    header.focus({ preventScroll: true });
    drag = {
      card,
      header,
      list,
      order: cards(list),
      pointerId: event.pointerId,
      pressX: event.clientX,
      pressY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    dialog.setPointerCapture(event.pointerId);
  });
  dialog.addEventListener('pointermove', (event) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
    if (!current.preview) {
      if (Math.hypot(event.clientX - current.pressX, event.clientY - current.pressY) < 4) return;
      const proxy = document.createElement('div');
      proxy.className = 'b2-action-drag-proxy';
      proxy.setAttribute('aria-hidden', 'true');
      proxy.textContent =
        current.header.querySelector<HTMLInputElement>('[data-field="name"] input')?.value.trim() || '新动作';
      proxy.style.width = Math.min(240, current.card.offsetWidth * 0.6) + 'px';
      const slot = document.createElement('div');
      slot.className = 'b2-action-drag-slot';
      slot.setAttribute('aria-hidden', 'true');
      current.preview = { proxy, slot };
      dialog.style.setProperty('--action-sort-width', dialog.offsetWidth + 'px');
      dialog.style.setProperty('--action-sort-height', dialog.offsetHeight + 'px');
      dialog.classList.add('b2-action-sort-active');
      rearrange(
        current.list,
        () => {
          current.list.classList.add('is-sorting');
          current.card.before(slot);
          current.card.classList.add('b2-action-in-hand');
        },
        current.card,
      );
      dialog.append(proxy);
      if (!reduced.matches)
        proxy.animate(
          [
            { opacity: 0.6, scale: '0.94' },
            { opacity: 1, scale: '1' },
          ],
          { duration: 140, easing: 'ease-out' },
        );
      frame = requestAnimationFrame(scroll);
    }
    follow();
  });
  dialog.addEventListener('pointerup', (event) => {
    if (drag?.pointerId === event.pointerId) finish();
  });
  dialog.addEventListener('pointercancel', (event) => {
    if (drag?.pointerId === event.pointerId) finish(true);
  });
  dialog.addEventListener('lostpointercapture', (event) => {
    if (drag?.pointerId === event.pointerId) finish(true);
  });
  dialog.addEventListener('close', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finish(true);
      return;
    }
    const header =
      event.target instanceof HTMLElement && event.target.matches('.b2-action-header') ? event.target : null;
    const card = header?.closest<HTMLElement>('.controller-action'),
      list = card?.parentElement;
    if (!header || !card || !list || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = cards(list),
      index = items.indexOf(card);
    const target =
      items[
        event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1)
      ];
    if (!target || target === card) return;
    rearrange(list, () => {
      if (items.indexOf(target) < index) list.insertBefore(card, target);
      else target.after(card);
    });
    form.dispatchEvent(new Event('change', { bubbles: true }));
    header.focus();
    decorate();
  });
  new MutationObserver(() => {
    if (drag && !form.contains(drag.card)) finish(true);
    decorate();
  }).observe(form, { childList: true, subtree: true });
  form.addEventListener('change', decorate);
  decorate();
  // Icon vocabulary is kept local/offline; no payload or dynamic remote markup is used.
  element('saveController').insertAdjacentHTML('afterbegin', networkUiIcon('save'));
}
