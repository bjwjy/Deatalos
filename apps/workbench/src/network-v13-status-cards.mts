import { element } from './network-dom.mjs';
import { networkUiIcon } from './network-v13-icons.mjs';

interface Gesture {
  card: HTMLElement;
  handle: HTMLButtonElement;
  order: HTMLElement[];
  keyboard: boolean;
  active: boolean;
  pointerId: number | undefined;
  startX: number;
  startY: number;
  x: number;
  y: number;
  centerY: number;
  rect: DOMRect;
  slot: HTMLElement | undefined;
}
/** View-only reordering: original result nodes and their owners are never cloned. */
export function setupNetworkStatusCardMotion(): void {
  const list = element('statusPanels'),
    panel = element('inspector');
  const announcement = document.createElement('span');
  announcement.className = 'sr-only';
  announcement.setAttribute('role', 'status');
  document.body.append(announcement);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const defaults = [...list.querySelectorAll<HTMLElement>('.status-section')];
  const layer = document.createElement('div');
  layer.className = 'status-drag-layer';
  document.body.append(layer);
  const cards = () => [...list.querySelectorAll<HTMLElement>('.status-section')];
  const visible = () => cards().filter((card) => !card.hidden);
  const name = (card: HTMLElement) => card.querySelector('h3')?.textContent || '状态';
  const position = (card: HTMLElement) => `${name(card)}，第${visible().indexOf(card) + 1}项，共${visible().length}项`;
  let gesture: Gesture | undefined,
    scrollFrame = 0;
  function rearrange(change: () => void, moving = gesture?.card): void {
    const neighbors = visible().filter((card) => card !== moving);
    const before = new Map(neighbors.map((card) => [card, card.getBoundingClientRect().top]));
    neighbors.forEach((card) => card.getAnimations().forEach((animation) => animation.cancel()));
    change();
    for (const card of neighbors) {
      const previous = before.get(card);
      if (previous === undefined) continue;
      const distance = previous - card.getBoundingClientRect().top;
      if (distance && !reduced.matches)
        card.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }], {
          duration: 240,
          easing: 'cubic-bezier(.4,0,.2,1)',
        });
    }
  }
  function finish(cancel = false): void {
    if (!gesture) return;
    const current = gesture;
    // Commit the latest pointer position even when release arrives before RAF.
    if (current.active && !current.keyboard && !cancel) positionCard(current);
    gesture = undefined;
    cancelAnimationFrame(scrollFrame);
    if (!current.active) return;
    const before = current.card.getBoundingClientRect();
    current.card.getAnimations().forEach((animation) => animation.cancel());
    current.slot?.replaceWith(current.card);
    current.card.classList.remove('card-in-hand', 'card-keyboard-move');
    for (const property of ['left', 'top', 'width', 'height', 'transform']) current.card.style.removeProperty(property);
    if (cancel) rearrange(() => current.order.forEach((card) => list.append(card)), current.card);
    document.body.classList.remove('sorting-status-cards');
    current.handle.setAttribute('aria-pressed', 'false');
    if (current.pointerId !== undefined && layer.hasPointerCapture(current.pointerId))
      layer.releasePointerCapture(current.pointerId);
    const after = current.card.getBoundingClientRect(),
      dx = before.left - after.left,
      dy = before.top - after.top;
    if (!reduced.matches && after.width)
      current.card.animate(
        [
          {
            transform: `translate(${dx}px,${dy}px) scale(${before.width / after.width},${before.height / after.height})`,
            easing: 'cubic-bezier(.22,1,.36,1)',
          },
          { transform: `translate(0,${Math.abs(dy) > 12 ? -Math.sign(dy) * 2 : 0}px) scale(1)`, offset: 0.8 },
          { transform: 'none' },
        ],
        { duration: 300 },
      );
    current.handle.focus({ preventScroll: true });
    announcement.textContent = (cancel ? '已取消移动。' : '已放下。') + position(current.card);
  }
  function placeSlot(current: Gesture): void {
    const slot = current.slot;
    if (!slot) return;
    const top = list.getBoundingClientRect().top;
    const target = visible().find((card) => current.centerY < top + card.offsetTop + card.offsetHeight / 2);
    if ((target && slot.nextElementSibling === target) || (!target && !slot.nextElementSibling)) return;
    rearrange(() => {
      if (target) list.insertBefore(slot, target);
      else list.append(slot);
    });
  }
  function positionCard(current: Gesture): void {
    const bounds = panel.getBoundingClientRect();
    current.centerY = Math.max(bounds.top + 8, Math.min(Math.max(bounds.top + 8, bounds.bottom - 8), current.y));
    const bottom = Math.max(0, current.centerY + 26 - bounds.bottom + 85),
      top = Math.max(0, bounds.top + 85 - (current.centerY - 26));
    const speed = Math.max(-9, Math.min(9, (bottom - top) / 4));
    if (speed) panel.scrollTop += speed;
    // Read slot geometry before writing the lifted card's position. Pointer
    // events only retain coordinates; hit testing/painting runs once per frame.
    placeSlot(current);
    current.card.style.left = current.x - 26 + 'px';
    current.card.style.top = current.centerY - 26 + 'px';
  }
  function autoScroll(): void {
    const current = gesture;
    if (!current?.active || current.keyboard) return;
    positionCard(current);
    scrollFrame = requestAnimationFrame(autoScroll);
  }
  function start(current: Gesture): void {
    current.active = true;
    current.rect = current.card.getBoundingClientRect();
    const rect = current.rect;
    current.card.getAnimations().forEach((animation) => animation.cancel());
    const slot = document.createElement('div');
    current.slot = slot;
    slot.className = 'status-card-slot c1-slot';
    slot.style.height = Math.min(128, rect.height) + 'px';
    slot.setAttribute('aria-hidden', 'true');
    current.card.before(slot);
    layer.append(current.card);
    current.card.classList.add('card-in-hand');
    Object.assign(current.card.style, {
      left: current.x - 26 + 'px',
      top: current.y - 26 + 'px',
      width: '52px',
      height: '52px',
    });
    if (current.pointerId !== undefined) layer.setPointerCapture(current.pointerId);
    if (!reduced.matches)
      current.card.animate(
        [
          {
            transform: `translate(${rect.left + rect.width / 2 - current.x}px,${rect.top + rect.height / 2 - current.y}px) scale(${rect.width / 52},${rect.height / 52})`,
          },
          { transform: 'none' },
        ],
        {
          duration: 270,
          easing: 'cubic-bezier(.22,1,.36,1)',
        },
      );
    current.handle.setAttribute('aria-pressed', 'true');
    document.body.classList.add('sorting-status-cards');
    announcement.textContent = '已拿起' + name(current.card);
    scrollFrame = requestAnimationFrame(autoScroll);
  }
  for (const card of defaults) {
    const heading = card.querySelector('h3');
    if (!heading) continue;
    const row = document.createElement('div');
    row.className = 'status-card-heading c1-head';
    card.classList.add('c1-card');
    card.dataset.c1Card = card.dataset.statusPanel;
    heading.before(row);
    row.append(heading);
    const content = document.createElement('div');
    content.className = 'status-card-content c1-fold-inner';
    for (const node of [...card.childNodes])
      if (node !== row && !(node instanceof HTMLElement && node.classList.contains('liquid-glass-surface')))
        content.append(node);
    const fold = document.createElement('div');
    fold.className = 'c1-fold';
    fold.append(content);
    card.append(fold);
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'status-card-collapse c1-fold-button';
    collapse.innerHTML = networkUiIcon('up');
    collapse.setAttribute('aria-label', '收起' + name(card));
    collapse.setAttribute('aria-expanded', 'true');
    collapse.addEventListener('click', () => {
      const expanded = collapse.getAttribute('aria-expanded') !== 'true';
      collapse.setAttribute('aria-expanded', String(expanded));
      collapse.setAttribute('aria-label', (expanded ? '收起' : '展开') + name(card));
      collapse.innerHTML = networkUiIcon(expanded ? 'up' : 'down');
      card.dataset.collapsed = String(!expanded);
      content.inert = !expanded;
      content.setAttribute('aria-hidden', String(!expanded));
      card.classList.toggle('status-card-collapsed', !expanded);
    });
    row.append(collapse);
    const handle = document.createElement('button');
    handle.className = 'card-move-title c1-move';
    handle.type = 'button';
    handle.setAttribute('aria-label', '移动' + name(card) + '卡片');
    handle.setAttribute('aria-pressed', 'false');
    handle.dataset.tip = '卡片空白处可拖动 · 空格拿起，方向键移动，Esc取消';
    handle.append(...heading.childNodes);
    heading.append(handle);
    function begin(keyboard: boolean, event?: PointerEvent): void {
      finish(true);
      document.dispatchEvent(new Event('status-layout-start'));
      handle.focus({ preventScroll: true });
      gesture = {
        card,
        handle,
        order: cards(),
        keyboard,
        active: keyboard,
        pointerId: event?.pointerId,
        startX: event?.clientX || 0,
        startY: event?.clientY || 0,
        x: event?.clientX || 0,
        y: event?.clientY || 0,
        centerY: 0,
        rect: card.getBoundingClientRect(),
        slot: undefined,
      };
      if (keyboard) {
        card.classList.add('card-keyboard-move');
        handle.setAttribute('aria-pressed', 'true');
        announcement.textContent = '已拿起。' + position(card);
      }
    }
    card.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || (gesture && !gesture.keyboard)) return;
      const control =
        event.target instanceof Element
          ? event.target.closest('button,input,select,textarea,a,label,[contenteditable="true"],[role="slider"]')
          : null;
      if (control && control !== handle) return;
      begin(false, event);
      event.preventDefault();
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (gesture?.keyboard && gesture.card === card) finish();
        else begin(true);
      } else if (
        gesture?.keyboard &&
        gesture.card === card &&
        ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
      ) {
        event.preventDefault();
        const items = visible(),
          index = items.indexOf(card);
        const destination =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
        const target = items[destination];
        if (target && target !== card) {
          rearrange(() => {
            if (destination < index) list.insertBefore(card, target);
            else target.after(card);
          });
          handle.focus({ preventScroll: true });
          card.scrollIntoView({ block: 'nearest' });
          announcement.textContent = position(card);
        }
      } else if (event.key === 'Tab' && gesture?.keyboard) finish();
    });
    handle.addEventListener('click', (event) => event.preventDefault());
  }
  document.addEventListener('pointermove', (event) => {
    const current = gesture;
    if (!current || current.keyboard || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) >= 5) start(current);
  });
  document.addEventListener('pointerup', (e) => {
    if (gesture?.pointerId === e.pointerId) finish();
  });
  document.addEventListener('pointercancel', (e) => {
    if (gesture?.pointerId === e.pointerId) finish(true);
  });
  layer.addEventListener('lostpointercapture', (e) => {
    if (gesture?.pointerId === e.pointerId) finish(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && gesture) {
      e.preventDefault();
      finish(true);
    }
  });
  document.addEventListener('status-layout-cancel', () => finish(true));
  document.addEventListener(
    'beforetoggle',
    (event) => {
      if (event instanceof ToggleEvent && event.newState === 'open' && event.target instanceof HTMLDialogElement)
        finish(true);
    },
    true,
  );
  document.addEventListener('status-layout-reset', () => {
    finish(true);
    rearrange(() => defaults.forEach((card) => list.append(card)));
  });
  window.addEventListener('blur', () => finish(true));
}
