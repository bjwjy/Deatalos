import type { setupNetworkGlass } from './network-v13-glass.mjs';
import { element } from './network-dom.mjs';
import { createPlanetOrbits } from './network-v13-planet-orbits.mjs';

declare global {
  interface Window {
    networkAppearance?: {
      applyTheme(theme: 'neutral' | 'silver' | 'oat' | 'coral'): Promise<boolean>;
      setDrawingModal(open: boolean): Promise<boolean>;
    };
  }
  interface Navigator {
    readonly windowControlsOverlay?: { readonly visible: boolean; getTitlebarAreaRect(): DOMRect };
  }
}

interface ToolThemeControl {
  read(): string;
  apply(value: string): Promise<{ readonly applied: boolean; readonly persisted: boolean | null }>;
}
let toolTheme: ToolThemeControl | null = null;
export const readNetworkTheme = (): string | null => toolTheme?.read() ?? null;
export const applyNetworkTheme = async (value: string) =>
  toolTheme ? toolTheme.apply(value) : { applied: false, persisted: null };
/** Appearance only. Preview and committed theme have independent lifecycles. */
export function setupNetworkTheme(glass: ReturnType<typeof setupNetworkGlass>): void {
  const root = document.documentElement;
  const themes = [
    { id: 'neutral', name: '默认' },
    { id: 'silver', name: '银白' },
    { id: 'oat', name: '姜黄' },
    { id: 'coral', name: '夜间' },
  ] as const;
  const defaultTheme = themes[0];
  const themeAt = (index: number) => themes[index] ?? defaultTheme;
  const themeControl = element('appTheme');
  if (!(themeControl instanceof HTMLSelectElement)) throw new Error('Settings theme selector required');
  const settingsChoice = themeControl;
  settingsChoice.replaceChildren(...themes.map((theme) => new Option(theme.name, theme.id)));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'themePlanet';
  button.className = 'theme-planet';
  button.innerHTML =
    '<span class="planet-stage" aria-hidden="true"></span><span class="planet-caption" aria-hidden="true"></span>';
  button.setAttribute('aria-describedby', 'themePlanetHelp');
  element('openHelpMenu').after(button);
  const stageNode = button.querySelector<HTMLElement>('.planet-stage');
  const captionNode = button.querySelector<HTMLElement>('.planet-caption');
  if (!stageNode || !captionNode) throw new Error('Theme planet surface required');
  const stage = stageNode,
    caption = captionNode;
  const help = document.createElement('span');
  help.id = 'themePlanetHelp';
  help.className = 'sr-only';
  help.textContent = '滚轮或方向键预选配色，点击或按Enter、空格应用；Esc取消预选。';
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  document.body.append(help, status);
  const preference = 'deatalos-theme-v1';
  let saved: string = defaultTheme.id;
  try {
    saved = localStorage.getItem(preference) ?? defaultTheme.id;
  } catch {
    /* Session theme remains usable. */
  }
  let selected = themes.findIndex((theme) => theme.id === saved);
  if (selected < 0) selected = themes.indexOf(defaultTheme);
  let committed = selected;
  let confirmed: number | null = null;
  let transitionTarget: number | null = null;
  let active: ViewTransition | null = null;
  let busy = false;
  let currentObject: HTMLElement | null = null;
  const orbitStep = 360 / themes.length;
  let orbitTarget = selected * orbitStep;
  let orbitAnimation: Animation | null = null;
  const orbits = new Map<HTMLElement, ReturnType<typeof createPlanetOrbits>>();
  const objects: HTMLElement[] = [];
  let wheelAmount = 0;
  let lastWheel = 0;
  function syncOrbits() {
    for (const object of objects) {
      const unapplied = object.dataset.theme !== themeAt(committed).id;
      orbits.get(object)?.setActive(unapplied && (object === currentObject || orbitAnimation !== null));
    }
  }

  function describe() {
    const pending = selected !== committed;
    settingsChoice.value = themeAt(confirmed ?? transitionTarget ?? committed).id;
    for (const object of objects) object.dataset.applied = String(object.dataset.theme === themeAt(committed).id);
    syncOrbits();
    button.dataset.theme = themeAt(selected).id;
    button.dataset.pending = String(pending);
    button.setAttribute(
      'aria-label',
      pending
        ? '预选' + themeAt(selected).name + '，点击应用；当前' + themeAt(committed).name
        : '当前' + themeAt(committed).name + '，滚轮预选配色，点击应用',
    );
    caption.textContent = themeAt(selected).name + (pending ? ' · 点击应用' : ' · 滚轮预选');
  }
  function glyph(index: number) {
    if (themeAt(index).id === 'neutral')
      return `<svg class="planet-glyph" viewBox="-20 -16 40 32" aria-hidden="true">
        <defs>
          <clipPath id="plain-earth"><circle cx="-3" r="10"/></clipPath>
          <g id="plain-moon-art">
            <circle r="3.6" fill="#f1f1eb" stroke="#8d99a1" stroke-width=".7"/>
            <circle cx="-1.05" cy="-.55" r=".75" fill="#bac2c5"/>
            <circle cx="1.1" cy="1.1" r=".55" fill="#bac2c5"/>
          </g>
        </defs>
        <g class="plain-earth-system">
          <g transform="translate(-3 0)"><use href="#plain-moon-art" class="plain-moon plain-moon-far"/></g>
          <circle class="planet-ball" cx="-3" r="10" fill="#64b4e9"/>
          <g clip-path="url(#plain-earth)" fill="#459861">
            <path d="m-12-4 3-3 4-2 5 1 2 3-3 2-3-1-2 3-2 2-3-2z"/>
            <path d="m-7 1 3-2 3 2 3 1-2 4-4 4-2-4z"/>
            <path d="m4-6 4 2 1 3-2 3-3-2 1-3z"/>
          </g>
          <g transform="translate(-3 0)"><use href="#plain-moon-art" class="plain-moon plain-moon-near"/></g>
        </g>
      </svg>`;
    const gradient = 'theme-globe-' + index;
    const highlight = 'theme-gloss-' + index;
    const ring =
      '<ellipse rx="16.1" ry="5.3" transform="rotate(-31)" class="planet-ring-edge"/><ellipse rx="16.1" ry="5.3" transform="rotate(-31)" class="planet-ring-band"/>';
    return (
      '<svg class="planet-glyph" viewBox="-20 -16 40 32" aria-hidden="true"><defs>' +
      '<linearGradient id="' +
      gradient +
      '" x1="0" y1="0" x2="0" y2="12" gradientUnits="userSpaceOnUse" gradientTransform="rotate(-25)" spreadMethod="repeat"><stop stop-color="var(--planet-a)"/><stop offset=".333" stop-color="var(--planet-a)"/><stop offset=".417" stop-color="var(--planet-b)"/><stop offset=".667" stop-color="var(--planet-b)"/><stop offset=".75" stop-color="var(--planet-c)"/><stop offset="1" stop-color="var(--planet-c)"/></linearGradient>' +
      '<radialGradient id="' +
      highlight +
      '" cx="28%" cy="23%" r="78%"><stop stop-color="#fff" stop-opacity=".65"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#101825" stop-opacity=".22"/></radialGradient></defs>' +
      ring +
      '<circle class="planet-ball" r="10" fill="url(#' +
      gradient +
      ')"/><circle r="9.7" fill="url(#' +
      highlight +
      ')"/>' +
      '<g transform="rotate(-31)"><path d="M-16.1 0 A16.1 5.3 0 0 0 16.1 0" class="planet-ring-edge"/><path d="M-16.1 0 A16.1 5.3 0 0 0 16.1 0" class="planet-ring-band"/></g></svg>'
    );
  }
  function preview() {
    if (!currentObject) {
      for (let index = 0; index < themes.length; index++) {
        const object = document.createElement('span');
        object.className = 'planet-object';
        object.dataset.theme = themeAt(index).id;
        object.style.setProperty('--planet-slot-angle', index * orbitStep + 'deg');
        object.innerHTML = glyph(index);
        stage.append(object);
        objects.push(object);
        if (themeAt(index).id !== 'neutral') orbits.set(object, createPlanetOrbits(object));
      }
      stage.style.setProperty('--planet-system-phase', orbitTarget + 'deg');
    } else {
      const previousTheme = currentObject.dataset.theme;
      const previous = themes.findIndex((theme) => theme.id === previousTheme);
      let direction = selected - previous;
      if (direction > themes.length / 2) direction -= themes.length;
      if (direction < -themes.length / 2) direction += themes.length;
      orbitTarget += direction * orbitStep;
      // One phase moves the bodies on the same ellipse; interruption reads
      // the actual displayed phase, so returning along the orbit never teleports.
      const from = parseFloat(getComputedStyle(stage).getPropertyValue('--planet-system-phase'));
      orbitAnimation?.cancel();
      stage.style.setProperty('--planet-system-phase', orbitTarget + 'deg');
      if (!reduced.matches && direction) {
        orbitAnimation = stage.animate(
          { '--planet-system-phase': [from + 'deg', orbitTarget + 'deg'] },
          {
            duration: 340,
            easing: getComputedStyle(root).getPropertyValue('--ease-in-out').trim(),
            fill: 'both' as const,
          },
        );
        const owned = orbitAnimation;
        owned.onfinish = () => {
          if (orbitAnimation === owned) {
            owned.cancel();
            orbitAnimation = null;
            syncOrbits();
          }
        };
      }
    }
    currentObject = objects[selected] ?? null;
    for (const object of objects) {
      object.dataset.selected = String(object === currentObject);
    }
    syncOrbits();
  }
  function applyTitleBar(index: number): void {
    void window.networkAppearance
      ?.applyTheme(themeAt(index).id)
      .catch((error) => console.error('窗口标题栏配色未更新', error));
  }
  async function apply(index: number, updateTitleBar = true) {
    const theme = themeAt(index);
    root.toggleAttribute('data-plain-theme', theme.id === 'neutral');
    if (theme.id === 'oat' || theme.id === 'coral') root.dataset.palette = theme.id;
    else delete root.dataset.palette;
    if (updateTitleBar) applyTitleBar(index);
    try {
      await glass.refreshPalette(theme.id);
    } catch (error) {
      console.error('玻璃材质无法解码', error);
    }
    try {
      localStorage.setItem(preference, theme.id);
    } catch {
      /* Session theme remains usable. */
    }
    committed = index;
    describe();
    status.textContent = '已应用' + theme.name;
  }
  async function reveal() {
    if (busy || confirmed === null) return;
    const target = confirmed;
    confirmed = null;
    if (target === committed) return;
    busy = true;
    transitionTarget = target;
    const edge = document.createElement('div');
    let pendingTitleBar = false;
    let titleBarFrame = 0;
    const updateTitleBar = () => {
      pendingTitleBar = false;
      applyTitleBar(target);
    };
    try {
      if (
        settingsChoice.closest('dialog')?.open ||
        document.hidden ||
        reduced.matches ||
        typeof document.startViewTransition !== 'function'
      ) {
        await apply(target);
      } else {
        // Confirming during an orbit brings the selected globe to the center before either snapshot.
        orbitAnimation?.cancel();
        orbitAnimation = null;
        syncOrbits();
        const bounds = (currentObject?.querySelector('.planet-ball') ?? stage).getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const width = innerWidth;
        const height = innerHeight;
        const originX = (100 * x) / width + '%';
        const originY = (100 * y) / height + '%';
        const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + 12;
        // Snapshot clip pixels and fixed-layer pixels can differ at browser zoom.
        // Circle percentages use the normalized diagonal; the rim uses viewport axes.
        const circleRadius = (100 * radius * Math.SQRT2) / Math.hypot(width, height) + '%';
        // Only Night changes native symbol contrast. Its transparent button area
        // already reveals the same animated title-bar background as the page.
        pendingTitleBar = (themeAt(committed).id === 'coral') !== (themeAt(target).id === 'coral');
        active = document.startViewTransition(async () => {
          root.classList.add('theme-snapshot');
          root.style.setProperty('--theme-wave-x', originX);
          root.style.setProperty('--theme-wave-y', originY);
          root.style.setProperty('--theme-wave-radius', circleRadius);
          root.style.setProperty('--theme-wave-width', (200 * radius) / width + '%');
          root.style.setProperty('--theme-wave-height', (200 * radius) / height + '%');
          await apply(target, false);
          edge.className = 'theme-wave-layer';
          edge.setAttribute('aria-hidden', 'true');
          document.body.append(edge);
        });
        try {
          await active.ready;
          if (pendingTitleBar && !reduced.matches) {
            const overlay = navigator.windowControlsOverlay;
            const bar = overlay?.visible ? overlay.getTitlebarAreaRect() : undefined;
            if (bar) {
              const controlsX = (bar.right + width) / 2;
              const controlsY = bar.top + bar.height / 2;
              const arrival = Math.hypot(controlsX - x, controlsY - y);
              const followReveal = () => {
                const rim = getComputedStyle(root, '::view-transition-new(theme-wave)');
                if (parseFloat(rim.width) / 2 >= arrival) updateTitleBar();
                else titleBarFrame = requestAnimationFrame(followReveal);
              };
              followReveal();
            } else updateTitleBar();
          }
        } catch (error) {
          if (!(error instanceof DOMException) || !['AbortError', 'InvalidStateError'].includes(error.name))
            throw error;
        }
        await active.finished;
      }
    } catch (error) {
      console.error('配色切换未完成', error);
      status.textContent = '配色切换未完成，请重试。';
    } finally {
      cancelAnimationFrame(titleBarFrame);
      if (pendingTitleBar && committed === target) updateTitleBar();
      edge?.remove();
      active = null;
      busy = false;
      transitionTarget = null;
      root.classList.remove('theme-snapshot');
      // Only another explicit activation may schedule an additional transition.
      if (confirmed !== null && confirmed !== committed) setTimeout(reveal, 0);
      else confirmed = null;
      describe();
    }
  }
  function step(direction: number) {
    selected = (selected + direction + themes.length) % themes.length;
    glass.prepare(themeAt(selected).id);
    preview();
    describe();
    status.textContent = '已预选' + themeAt(selected).name + '，点击应用。';
  }
  function inside(event: MouseEvent) {
    const bounds = button.getBoundingClientRect();
    return (
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    );
  }
  // Native transition snapshots retarget events to HTML. Keep the hit box local even then.
  document.addEventListener(
    'wheel',
    (event) => {
      if (!(event.target instanceof Node && button.contains(event.target)) && !inside(event)) return;
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;
      event.preventDefault();
      const now = performance.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1);
      if (now - lastWheel > 170 || Math.sign(delta) !== Math.sign(wheelAmount)) wheelAmount = 0;
      lastWheel = now;
      wheelAmount += delta;
      if (Math.abs(wheelAmount) < 45) return;
      const direction = Math.sign(wheelAmount);
      wheelAmount = 0;
      step(direction);
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Node && button.contains(event.target)) && !(busy && inside(event))) return;
      event.preventDefault();
      confirmed = selected;
      if (active && transitionTarget !== selected) active.skipTransition();
      void reveal();
    },
    { capture: true },
  );
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      selected = transitionTarget ?? committed;
      confirmed = null;
      glass.prepare(themeAt(selected).id);
      preview();
      describe();
    } else if (['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      step(event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  settingsChoice.addEventListener('change', () => {
    const index = themes.findIndex((theme) => theme.id === settingsChoice.value);
    if (index < 0) return;
    selected = index;
    confirmed = index;
    preview();
    describe();
    if (active && transitionTarget !== index) active.skipTransition();
    void reveal();
  });
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      active?.skipTransition();
      orbitAnimation?.finish();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) active?.skipTransition();
  });
  if (committed !== 0) void apply(committed);
  preview();
  describe();
  toolTheme = {
    read: () => themeAt(committed).id,
    async apply(value) {
      const index = themes.findIndex((theme) => theme.id === value);
      if (busy || active || index < 0) return { applied: false, persisted: false };
      selected = index;
      confirmed = null;
      await apply(index);
      preview();
      describe();
      let persisted: boolean | null = null;
      try {
        persisted = localStorage.getItem(preference) === value;
      } catch {
        /* A blocked read cannot certify persistence. */
      }
      return { applied: themeAt(committed).id === value, persisted };
    },
  };
}
