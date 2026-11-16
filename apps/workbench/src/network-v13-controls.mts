import { element } from './network-dom.mjs';

/** Input feedback is decorative. It never dispatches commands or captures a pointer. */
export function setupNetworkPressFeedback(): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new WeakMap<HTMLButtonElement, Animation>();
  let active: { button: HTMLButtonElement; identity: number | string } | undefined;
  const geometry = (button: HTMLButtonElement) => ({
    scale: getComputedStyle(button).scale,
    width: button.offsetWidth,
  });
  function release(cancelled = false): void {
    if (!active) return;
    const { button } = active;
    const measured = reduced.matches ? undefined : geometry(button);
    active = undefined;
    button.removeAttribute('data-press-state');
    scale(button, false, cancelled, measured);
  }
  function scale(
    button: HTMLButtonElement,
    down: boolean,
    cancelled = false,
    measured?: { scale: string; width: number },
  ): void {
    const displayed = measured?.scale ?? 'none';
    animations.get(button)?.cancel();
    animations.delete(button);
    if (reduced.matches || !button.isConnected || button.matches('.card-move-title')) return;
    const from = displayed === 'none' ? 1 : Number.parseFloat(displayed);
    const frames = down
      ? [{ scale: from }, { scale: (measured?.width ?? 0) > 120 ? 0.985 : 0.95 }]
      : cancelled
        ? [{ scale: from }, { scale: 1 }]
        : [{ scale: from }, { scale: 1.012, offset: 0.65 }, { scale: 1 }];
    const animation = button.animate(frames, {
      duration: down ? 80 : cancelled ? 140 : 220,
      easing: down ? 'cubic-bezier(.2,0,.2,1)' : 'cubic-bezier(.22,1,.36,1)',
      fill: 'forwards',
    });
    animations.set(button, animation);
    if (!down)
      animation.onfinish = () => {
        if (animations.get(button) !== animation) return;
        animation.cancel();
        animations.delete(button);
      };
  }
  function press(target: EventTarget | null, identity: number | string): void {
    const button = target instanceof Element ? target.closest('button') : null;
    if (!button || button.disabled || button.dataset.pressFeedback === 'off' || button.closest('[inert]')) return;
    // Read the interrupted scale/size before adding the press surface or changing
    // state; otherwise the first click forces synchronous style/layout work.
    const measured = reduced.matches ? undefined : geometry(button);
    release(true);
    if (!button.querySelector(':scope>.button-press-surface')) {
      const surface = document.createElement('span');
      surface.className = 'button-press-surface';
      surface.setAttribute('aria-hidden', 'true');
      button.append(surface);
    }
    active = { button, identity };
    button.dataset.pressState = 'down';
    scale(button, true, false, measured);
  }
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button === 0 && e.isPrimary) press(e.target, e.pointerId);
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    (e) => {
      if (active?.identity === e.pointerId) release();
    },
    true,
  );
  document.addEventListener(
    'pointercancel',
    (e) => {
      if (active?.identity === e.pointerId) release(true);
    },
    true,
  );
  document.addEventListener(
    'pointerout',
    (e) => {
      if (
        typeof active?.identity === 'number' &&
        (!(e.relatedTarget instanceof Node) || !active.button.contains(e.relatedTarget))
      )
        release(true);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && [' ', 'Enter'].includes(e.key)) press(e.target, e.key);
    },
    true,
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (active?.identity === e.key) release();
    },
    true,
  );
  document.addEventListener(
    'focusout',
    () => {
      if (typeof active?.identity === 'string') release(true);
    },
    true,
  );
  window.addEventListener('blur', () => release(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) release(true);
  });
  reduced.addEventListener('change', () => release(true));
}

/** A shared surface glides between targets; target hit boxes remain unchanged. */
function glide(container: HTMLElement, selector: string, className: string): void {
  const indicator = document.createElement('span');
  indicator.className = className;
  indicator.setAttribute('aria-hidden', 'true');
  container.prepend(indicator);
  let current: HTMLElement | null = null;
  function move(target: EventTarget | null): void {
    const button = target instanceof Element ? target.closest<HTMLElement>(selector) : null;
    if (!button || (button instanceof HTMLButtonElement && button.disabled)) {
      hide();
      return;
    }
    if (current === button) return;
    current = button;
    const bounds = container.getBoundingClientRect(),
      rect = button.getBoundingClientRect();
    const first = !indicator.classList.contains('visible');
    if (first) indicator.style.transition = 'none';
    Object.assign(indicator.style, {
      width: rect.width + 'px',
      height: rect.height + 'px',
      transform: `translate(${rect.left - bounds.left + container.scrollLeft}px,${rect.top - bounds.top + container.scrollTop}px)`,
    });
    indicator.dataset.dark = String(!!button.closest('.simulation-tools'));
    if (first) {
      void indicator.offsetWidth;
      indicator.style.removeProperty('transition');
    }
    indicator.classList.add('visible');
  }
  function hide(): void {
    current = null;
    indicator.classList.remove('visible');
  }
  container.addEventListener('pointerover', (e) => move(e.target));
  container.addEventListener('focusin', (e) => move(e.target));
  container.addEventListener('pointerleave', () => {
    const focused = container.querySelector<HTMLElement>(selector + ':focus-visible');
    if (focused) move(focused);
    else hide();
  });
  container.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof Node) || !container.contains(e.relatedTarget)) hide();
  });
  container.addEventListener('scroll', hide);
  window.addEventListener('resize', hide);
}
export function setupNetworkToolbarMotion(): void {
  glide(element('mainMenus'), '.menu-trigger', 'menu-glide');
  const toolbar = document.querySelector<HTMLElement>('.quick-toolbar');
  if (toolbar) glide(toolbar, '.tool', 'toolbar-glide');
  // Reflect disabled state from the existing command owner, including toolbar aliases.
  for (const alias of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
    const owner = alias.dataset.command ? document.getElementById(alias.dataset.command) : null;
    if (!(owner instanceof HTMLButtonElement)) continue;
    const reflect = () => {
      alias.disabled = owner.disabled;
    };
    new MutationObserver(reflect).observe(owner, { attributes: true, attributeFilter: ['disabled'] });
    reflect();
  }
}

/** One tooltip owner survives transitions among an icon's SVG children. */
export function setupNetworkTooltips(): void {
  const tip = element('uiTooltip');
  tip.classList.add('tooltip');
  let hovered: HTMLElement | null = null,
    owner: HTMLElement | null = null,
    blocked: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: HTMLElement | null = null,
    lastShown = -Infinity;
  const targetFor = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
  const focused = () => {
    const target = targetFor(document.activeElement);
    return target?.matches(':focus-visible') ? target : null;
  };
  const wanted = () => hovered || focused();
  function hideVisible(): void {
    tip.hidden = true;
    if (owner) {
      const ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tip.id);
      if (ids.length) owner.setAttribute('aria-describedby', ids.join(' '));
      else owner.removeAttribute('aria-describedby');
    }
    owner = null;
  }
  function hide(): void {
    blocked = wanted() || owner;
    clearTimeout(timer);
    pending = null;
    hideVisible();
  }
  function schedule(target: HTMLElement | null): void {
    if (!target || target === blocked) {
      clearTimeout(timer);
      pending = null;
      hideVisible();
      return;
    }
    if (target === pending || (target === owner && !tip.hidden)) return;
    clearTimeout(timer);
    pending = target;
    timer = setTimeout(
      () => {
        pending = null;
        if (
          wanted() !== target ||
          blocked === target ||
          !target.isConnected ||
          target.closest('[hidden],[inert]') ||
          !target.getClientRects().length ||
          document.querySelector('.card-in-hand,.card-keyboard-move')
        ) {
          hideVisible();
          return;
        }
        hideVisible();
        owner = target;
        tip.textContent = target.dataset.tip || '';
        const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        ids.add(tip.id);
        target.setAttribute('aria-describedby', [...ids].join(' '));
        tip.hidden = false;
        const rect = target.getBoundingClientRect();
        tip.style.left =
          Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, rect.left + rect.width / 2 - tip.offsetWidth / 2)) +
          'px';
        tip.style.top =
          (rect.bottom + tip.offsetHeight + 12 < innerHeight ? rect.bottom + 7 : rect.top - tip.offsetHeight - 7) +
          'px';
        lastShown = performance.now();
      },
      target === focused() && !hovered ? 0 : performance.now() - lastShown < 900 ? 60 : 350,
    );
  }
  function change(next: HTMLElement | null): void {
    if (hovered === next) return;
    hovered = next;
    blocked = null;
    schedule(wanted());
  }
  document.addEventListener('pointerover', (e) => {
    const next = targetFor(e.target);
    if (next !== targetFor(e.relatedTarget)) change(next);
  });
  document.addEventListener('pointerout', (e) => {
    const next = targetFor(e.relatedTarget);
    if (targetFor(e.target) !== next) change(next);
  });
  document.addEventListener('focusin', () => {
    const target = focused();
    if (target) {
      hovered = null;
      blocked = null;
      schedule(target);
    }
  });
  document.addEventListener('focusout', () => {
    if (!hovered) {
      clearTimeout(timer);
      pending = null;
      hideVisible();
    }
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => {
    if (['Escape', 'Enter', ' '].includes(e.key)) hide();
  });
  document.addEventListener('status-layout-start', hide);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hide();
  });
}
