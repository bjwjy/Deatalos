import { boardElement, element } from './network-dom.mjs';
import type { NetworkCanvas } from './network-canvas-controller.mjs';

/** Contextual commands reuse the existing route transactions and Escape handling. */
export function setupNetworkRouteMenu(canvas: NetworkCanvas, changed: () => void): void {
  const menu = document.createElement('div');
  menu.className = 'menu-popup';
  menu.popover = 'auto';
  menu.setAttribute('aria-label', '管路绘图路径');
  for (const [id, label] of [
    ['manualRoute', '编辑手动路径'],
    ['autoRoute', '恢复自动路径'],
    ['mergeRoute', '合并近共线线段'],
  ]) {
    if (!id || !label) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      menu.hidePopover();
      element(id).click();
    });
    menu.append(button);
  }
  document.body.append(menu);
  boardElement().addEventListener('contextmenu', (event) => {
    if (!canvas.editable || canvas.gestureActive || !(event.target instanceof Element)) return;
    const target = event.target.closest('[data-connection],[data-connection-hit]');
    const id = target?.getAttribute('data-connection') ?? target?.getAttribute('data-connection-hit');
    if (!id) return;
    event.preventDefault();
    canvas.select([{ kind: 'connection', id }]);
    changed();
    menu.style.inset = 'auto';
    menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - 220)) + 'px';
    menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - 150)) + 'px';
    menu.style.margin = '0';
    menu.showPopover();
  });
}
