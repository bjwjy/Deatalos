import { element } from './network-dom.mjs';

/** One category highlight and one progress surface move across the original library controls. */
export function setupNetworkLibraryMotion(): void {
  const root = element('componentTools'),
    reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const indicator = document.createElement('span');
  indicator.className = 'category-glide';
  indicator.setAttribute('aria-hidden', 'true');
  let hovered: HTMLElement | null = null;
  let lastCardCategory: HTMLElement | null = null;
  function categoryFor(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return (
      target.closest<HTMLElement>('.category-trigger') ??
      target
        .closest('.tools')
        ?.closest('.library-group[open]')
        ?.querySelector<HTMLElement>(':scope > .category-trigger') ??
      null
    );
  }
  function move(button: HTMLElement | null): void {
    if (!button || indicator.parentElement === button) return;
    const before = indicator.isConnected ? indicator.getBoundingClientRect() : null;
    indicator.getAnimations().forEach((animation) => animation.cancel());
    button.append(indicator);
    const after = button.getBoundingClientRect();
    if (!before || reduced.matches || !after.width) return;
    const x = before.left - after.left,
      y = before.top - after.top;
    const from = `translate(${x}px,${y}px) scaleX(${before.width / after.width})`,
      rail = 6 / after.width,
      distant = Math.abs(y) > 48;
    indicator.animate(
      distant
        ? [
            { transform: from, easing: 'cubic-bezier(.22,1,.36,1)' },
            {
              transform: `translate(${x}px,${y}px) scaleX(${rail})`,
              offset: 0.16,
              easing: 'cubic-bezier(.77,0,.175,1)',
            },
            { transform: `scaleX(${rail})`, offset: 0.8, easing: 'cubic-bezier(.22,1,.36,1)' },
            { transform: 'none' },
          ]
        : [{ transform: from }, { transform: 'none' }],
      { duration: distant ? 300 : 240, easing: distant ? 'linear' : 'cubic-bezier(.22,1,.36,1)' },
    );
  }
  function sync(): void {
    if (hovered && !root.contains(hovered)) hovered = null;
    if (lastCardCategory && (!root.contains(lastCardCategory) || !lastCardCategory.closest('.library-group[open]')))
      lastCardCategory = null;
    for (const group of root.querySelectorAll<HTMLDetailsElement>('.library-group')) {
      const trigger = group.querySelector('summary'),
        value = String(group.open);
      if (trigger?.getAttribute('aria-expanded') !== value) trigger?.setAttribute('aria-expanded', value);
    }
    const focused = categoryFor(
        root.querySelector('.category-trigger:focus-visible, .tools .library-select:focus-visible'),
      ),
      selected = root.querySelector<HTMLElement>('.category-trigger[aria-expanded="true"]');
    const activeCategory = hovered || focused || lastCardCategory || selected;
    move(activeCategory);
    if (!activeCategory) indicator.remove();
    for (const dots of root.querySelectorAll<HTMLElement>('.carousel-dots')) {
      dots.classList.add('page-dots');
      const active = dots.querySelector<HTMLElement>('button[aria-current="true"]');
      if (!active) continue;
      let progress = dots.querySelector<HTMLElement>('.page-progress');
      const fresh = !progress;
      if (!progress) {
        progress = document.createElement('span');
        progress.className = 'page-progress';
        progress.setAttribute('aria-hidden', 'true');
        progress.style.transition = 'none';
        dots.append(progress);
      }
      progress.style.transform = `translate(${active.offsetLeft + active.offsetWidth / 2 - 8}px,-50%)`;
      if (fresh) {
        void progress.offsetWidth;
        progress.style.removeProperty('transition');
      }
    }
  }
  root.addEventListener('pointerover', (event) => {
    hovered = categoryFor(event.target);
    sync();
  });
  root.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.tools .library-select')) lastCardCategory = categoryFor(event.target);
      else if (event.target.closest('.category-trigger')) lastCardCategory = null;
      else return;
      sync();
    },
    true,
  );
  root.addEventListener('pointerleave', () => {
    hovered = null;
    sync();
  });
  root.addEventListener('focusin', sync);
  root.addEventListener('focusout', () => queueMicrotask(sync));
  new MutationObserver(sync).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'aria-current'],
  });
  sync();
}
