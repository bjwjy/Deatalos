import { element } from './network-dom.mjs';
/** Draws one populated surface; the existing shell remains the visibility preference owner. */
export function setupNetworkDrawer(): void {
  const workspace = element('workspace'),
    panel = element('inspector'),
    shell = element('statusDrawerShell'),
    divider = element('inspectorResize'),
    button = element('statusDrawerToggle');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let completion: ReturnType<typeof setTimeout> | undefined;
  let requested = document.documentElement.dataset.inspectorOpen !== 'false';
  function settle() {
    clearTimeout(completion);
    workspace.classList.remove('drawer-moving');
    const closed = !requested;
    panel.hidden = closed;
    shell.hidden = closed;
    workspace.classList.toggle('sidebar-reserved', !closed);
    divider.hidden = closed;
  }
  function show(open: boolean) {
    clearTimeout(completion);
    requested = open;
    document.dispatchEvent(new Event('status-layout-cancel'));
    panel.hidden = false;
    shell.hidden = false;
    panel.inert = !open;
    divider.hidden = true;
    workspace.classList.remove('sidebar-reserved');
    void shell.offsetWidth;
    workspace.classList.add('drawer-moving');
    workspace.classList.toggle('sidebar-hidden', !open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '收回状态栏' : '展开状态栏');
    button.dataset.tip = open ? '收回状态栏' : '展开状态栏';
    completion = setTimeout(settle, reduced.matches ? 1 : open ? 470 : 300);
  }
  button.addEventListener('click', () => element('showInspector').click());
  shell.addEventListener('transitionend', (event) => {
    if (event.target === shell && event.propertyName === 'transform') settle();
  });
  new MutationObserver(() => {
    const open = document.documentElement.dataset.inspectorOpen !== 'false';
    if (open !== requested) show(open);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-inspector-open'] });
  workspace.classList.toggle('sidebar-hidden', !requested);
  settle();
  button.setAttribute('aria-expanded', String(requested));
}
