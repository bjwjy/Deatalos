import { element } from './network-dom.mjs';
// View-only optical material. The shared scene is visible through glass masks only;
// it never paints the working paper, circuit symbols, controls or engineering values.
export function setupNetworkGlass(): () => Promise<void> {
  const workspace = element('workspace');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const targets = [
    element('componentLibrary'),
    element('statusDrawerShell'),
    ...document.querySelectorAll<HTMLElement>('#statusPanels > .status-section'),
  ];
  // A cached, locally drawn light field gives white paper something to transmit.
  // Its displaced bands are decorative optics, never a warped copy of circuit data.
  const root = document.documentElement;
  async function refreshPalette() {
    if (root.hasAttribute('data-plain-theme')) {
      root.style.removeProperty('--liquid-field');
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      for (const state of surfaces) {
        state.previous = null;
        state.x = state.y = state.vx = state.vy = 0;
      }
      return;
    }
    const tokens = getComputedStyle(root);
    const color = (name: string) => tokens.getPropertyValue('--glass-scene-' + name).trim();
    const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
    <defs>
      <linearGradient id="silver" x2=".8" y2="1"><stop stop-color="${color('top')}"/><stop offset=".55" stop-color="${color('middle')}"/><stop offset="1" stop-color="${color('bottom')}"/></linearGradient>
      <filter id="soft" x="-30%" y="-50%" width="160%" height="200%">
        <feTurbulence type="fractalNoise" baseFrequency=".004 .008" numOctaves="2" seed="8" result="wave"/>
        <feDisplacementMap in="SourceGraphic" in2="wave" scale="32" xChannelSelector="R" yChannelSelector="G"/>
        <feGaussianBlur stdDeviation="18"/>
      </filter>
    </defs>
    <path fill="url(#silver)" d="M0 0h1600v1000H0z"/>
    <g fill="none" filter="url(#soft)">
      <path d="M-240 420C80 30 220 690 570 330S1060 80 1230 410S1660 640 1900 220" stroke="${color('cool')}" stroke-opacity=".65" stroke-width="160"/>
      <path d="M-150 240C230 520 240-60 620 160S1030 700 1450 420S1650 40 1810 50" stroke="${color('light')}" stroke-width="130"/>
      <path d="M-160 760C230 400 300 950 730 720S1060 380 1380 720S1690 840 1800 540" stroke="${color('warm')}" stroke-opacity=".55" stroke-width="180"/>
      <path d="M-80 640C280 280 450 960 820 470S1290 230 1710 640" stroke="${color('light')}" stroke-opacity=".9" stroke-width="90"/>
    </g>
  </svg>`;
    const url = 'data:image/svg+xml,' + encodeURIComponent(scene);
    root.style.setProperty('--liquid-field', 'url("' + url + '")');
    wake();
    // A theme snapshot must wait for its new optical image, rather than capture the old field.
    const image = new Image();
    image.src = url;
    return image.decode();
  }
  type Surface = {
    element: HTMLElement;
    surface: HTMLDivElement;
    previous: { left: number; top: number } | null;
    x: number;
    y: number;
    vx: number;
    vy: number;
    values: Map<string, string>;
  };
  const surfaces: Surface[] = targets.map((element) => {
    const surface = document.createElement('div');
    surface.className = 'liquid-glass-surface';
    surface.setAttribute('aria-hidden', 'true');
    element.prepend(surface);
    return { element, surface, previous: null, x: 0, y: 0, vx: 0, vy: 0, values: new Map() };
  });
  let frame = 0;
  let previousTime = 0;
  let deadline = 0;
  let pointer: number | null = null;
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

  function wake() {
    if (document.hidden || root.hasAttribute('data-plain-theme')) return;
    deadline = performance.now() + 700;
    if (!frame) {
      previousTime = performance.now();
      frame = requestAnimationFrame(paint);
    }
  }
  function paint(time: number) {
    frame = 0;
    const dt = Math.min(0.032, Math.max(0.001, (time - previousTime) / 1000));
    previousTime = time;
    let settling = false;
    const fieldWidth = Math.max(1280, innerWidth + 160);
    const fieldHeight = Math.max(900, innerHeight + 160);
    // Read geometry first; style writes follow as a separate pass.
    const geometry = surfaces.flatMap((state) => {
      if (state.element.closest('[hidden]')) {
        state.previous = null;
        return [];
      }
      return [{ state, rect: state.element.getBoundingClientRect() }];
    });
    for (const { state, rect } of geometry) {
      if (!rect.width || !rect.height) {
        state.previous = null;
        continue;
      }
      const dx = state.previous ? rect.left - state.previous.left : 0;
      const dy = state.previous ? rect.top - state.previous.top : 0;
      state.previous = { left: rect.left, top: rect.top };
      if (reducedMotion.matches || reducedTransparency.matches) {
        state.x = state.y = state.vx = state.vy = 0;
      } else {
        // Motion disturbs the transmitted field; a damped spring settles after release.
        state.x = clamp(state.x - dx * 0.24, 14);
        state.y = clamp(state.y - dy * 0.24, 14);
        state.vx += (-180 * state.x - 24 * state.vx) * dt;
        state.vy += (-180 * state.y - 24 * state.vy) * dt;
        state.x += state.vx * dt;
        state.y += state.vy * dt;
      }
      settling ||= Math.abs(state.x) + Math.abs(state.y) + Math.abs(state.vx) + Math.abs(state.vy) > 0.1;
      const style = state.surface.style;
      const set = (name: string, value: string) => {
        if (state.values.get(name) === value) return;
        style.setProperty(name, value);
        state.values.set(name, value);
      };
      // The mask moves over a viewport-anchored field, rather than carrying a wallpaper.
      set('--field-width', fieldWidth + 'px');
      set('--field-height', fieldHeight + 'px');
      set('--field-x', (-rect.left - 56).toFixed(2) + 'px');
      set('--field-y', (-rect.top - 56).toFixed(2) + 'px');
      set('--liquid-x', state.x.toFixed(2) + 'px');
      set('--liquid-y', state.y.toFixed(2) + 'px');
      set('--rim-x', (-rect.left * 1.055 - 80).toFixed(2) + 'px');
      set('--rim-y', (-rect.top * 1.055 - 80).toFixed(2) + 'px');
    }
    if (pointer !== null || time < deadline || settling) frame = requestAnimationFrame(paint);
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('#componentLibrary, #statusPanels, .status-drag-layer, #inspectorResize')
      )
        return;
      pointer = event.pointerId;
      wake();
    },
    { passive: true },
  );
  function release(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    pointer = null;
    wake();
  }
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  window.addEventListener('blur', () => {
    pointer = null;
    wake();
  });
  window.addEventListener('resize', wake);
  document.addEventListener('scroll', wake, { capture: true, passive: true });
  workspace.addEventListener('transitionrun', (event) => {
    // Pressure/readout/button transitions do not move the glass. Waking for every
    // descendant transition otherwise keeps all surface geometry reads alive.
    if (
      event.target instanceof Element &&
      (event.target === workspace ||
        event.target.matches('#componentLibrary, #statusDrawerShell, #inspector, .status-section')) &&
      ['transform', 'translate', 'width', 'height', 'grid-template-columns'].includes(event.propertyName)
    )
      wake();
  });
  // Live circuit/result updates must not turn this finite optical effect into a permanent render loop.
  new MutationObserver(wake).observe(workspace, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(wake).observe(element('statusPanels'), { childList: true });
  const sizeObserver = new ResizeObserver(wake);
  for (const target of targets) sizeObserver.observe(target);
  reducedMotion.addEventListener('change', wake);
  reducedTransparency.addEventListener('change', wake);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
    } else wake();
  });
  wake();
  return refreshPalette;
}
