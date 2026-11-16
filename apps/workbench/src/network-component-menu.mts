import type { NetworkDraftSession } from '@hyd/application';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import { boardElement, element } from './network-dom.mjs';
import { networkUiIcon, type NetworkUiIcon } from './network-v13-icons.mjs';

interface MenuHooks {
  editor(): NetworkDraftSession;
  changed(): void;
  properties(id: string): void;
  rotate(direction: 'clockwise' | 'counterclockwise'): void;
  flip(): void;
  copy(cut: boolean): Promise<void>;
  paste(): Promise<void>;
  canPaste(): Promise<boolean>;
  toast(message: string): void;
}
type Command = 'copy' | 'cut' | 'paste' | 'delete' | 'clockwise' | 'counterclockwise' | 'flip' | 'properties';
/** Presentation-only contextual commands; selection, history and clipboard intents retain their owners. */
export function setupNetworkComponentMenu(canvas: NetworkCanvas, hooks: MenuHooks): void {
  const board = boardElement(),
    menu = document.createElement('div');
  menu.id = 'componentContextMenu';
  menu.className = 'menu-popup component-context-menu';
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '元件操作');
  const heading = document.createElement('div');
  heading.className = 'component-context-heading';
  heading.setAttribute('role', 'presentation');
  menu.append(heading);
  const buttons = new Map<Command, HTMLButtonElement>();
  const sources: Partial<Record<Command, string>> = {
    copy: 'copySelected',
    cut: 'cutSelected',
    paste: 'pasteSelected',
    delete: 'deleteSelected',
    clockwise: 'rotateSelected',
    counterclockwise: 'rotateSelected',
    flip: 'rotateSelected',
  };
  const unavailable = (command: Command, componentId: string | null): boolean => {
    if (!canvas.editable) return true;
    if (command === 'delete' && canvas.selections.length === 0) return true;
    const source = sources[command];
    return source
      ? element(source).hasAttribute('disabled')
      : componentId === null || element('rotateSelected').hasAttribute('disabled');
  };
  let intent: { owner: NetworkDraftSession; revision: number; selection: string; componentId: string | null } | null =
    null;
  const close = () => {
    if (menu.matches(':popover-open')) menu.hidePopover();
    board.focus({ preventScroll: true });
  };
  const invoke = (command: Command) => {
    if (buttons.get(command)?.disabled) return;
    const captured = intent;
    close();
    intent = null;
    if (
      !captured ||
      !canvas.editable ||
      hooks.editor() !== captured.owner ||
      hooks.editor().revision !== captured.revision ||
      JSON.stringify(canvas.selections) !== captured.selection
    ) {
      hooks.toast('工程或选择已改变，请重新右键选择。');
      return;
    }
    if (unavailable(command, captured.componentId)) return;
    if (command === 'copy' || command === 'cut') void hooks.copy(command === 'cut');
    else if (command === 'paste') void hooks.paste();
    else if (command === 'delete') element('deleteSelected').click();
    else if (command === 'clockwise' || command === 'counterclockwise') hooks.rotate(command);
    else if (command === 'flip') hooks.flip();
    else if (captured.componentId) hooks.properties(captured.componentId);
  };
  const items: readonly { command: Command; label: string; hint?: string; icon: NetworkUiIcon; group: number }[] = [
    { command: 'copy', label: '复制', hint: 'Ctrl+C', icon: 'copy', group: 0 },
    { command: 'cut', label: '剪切', hint: 'Ctrl+X', icon: 'cut', group: 0 },
    { command: 'paste', label: '粘贴', hint: 'Ctrl+V', icon: 'paste', group: 0 },
    { command: 'delete', label: '删除', hint: 'Delete', icon: 'trash', group: 0 },
    { command: 'clockwise', label: '顺时针旋转 90°', hint: '空格', icon: 'rotate-clockwise', group: 1 },
    { command: 'counterclockwise', label: '逆时针旋转 90°', icon: 'rotate-counterclockwise', group: 1 },
    { command: 'flip', label: '翻转', icon: 'flip-horizontal', group: 1 },
    { command: 'properties', label: '属性…', hint: '双击元件', icon: 'settings', group: 2 },
  ];
  let group = 0;
  for (const item of items) {
    if (item.group !== group) {
      const separator = document.createElement('div');
      separator.className = 'component-context-separator';
      separator.setAttribute('role', 'separator');
      menu.append(separator);
      group = item.group;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.componentCommand = item.command;
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    const icon = document.createElement('span');
    icon.className = 'component-context-icon';
    icon.innerHTML = networkUiIcon(item.icon);
    const label = document.createElement('span');
    label.className = 'component-context-label';
    label.textContent = item.label;
    button.append(icon, label);
    if (item.hint) {
      const hint = document.createElement(item.command === 'properties' ? 'span' : 'kbd');
      hint.className = 'component-context-hint';
      hint.textContent = item.hint;
      button.append(hint);
    }
    button.addEventListener('click', () => invoke(item.command));
    menu.append(button);
    buttons.set(item.command, button);
  }
  document.body.append(menu);
  menu.addEventListener('toggle', () => {
    if (!menu.matches(':popover-open')) intent = null;
  });
  menu.addEventListener('keydown', (event) => {
    const enabled = [...buttons.values()].filter((button) => !button.disabled),
      key = event.key.toLowerCase();
    const shortcut: Command | null =
      event.ctrlKey || event.metaKey
        ? key === 'c'
          ? 'copy'
          : key === 'x'
            ? 'cut'
            : key === 'v'
              ? 'paste'
              : null
        : event.key === ' '
          ? 'clockwise'
          : event.key === 'Delete'
            ? 'delete'
            : null;
    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) invoke(shortcut);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!enabled.length) return;
    const current = document.activeElement instanceof HTMLButtonElement ? enabled.indexOf(document.activeElement) : -1;
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? enabled.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[index]?.focus();
  });
  board.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const id = event.target.closest('[data-component]')?.getAttribute('data-component');
    const gaugeId = event.target.closest('[data-probe-id]')?.getAttribute('data-probe-id');
    if (
      !id &&
      !gaugeId &&
      event.target.closest(
        '[data-node],[data-text-id],[data-endpoint],[data-path-id],[data-connection],[data-connection-hit],[data-branch-connection]',
      )
    ) {
      if (menu.matches(':popover-open')) menu.hidePopover();
      return;
    }
    if (canvas.gestureActive) return;
    event.preventDefault();
    if (id && canvas.editable && !canvas.selections.some((s) => s.kind === 'component' && s.id === id))
      canvas.select([{ kind: 'component', id }]);
    if (gaugeId && canvas.editable && !canvas.selections.some((s) => s.kind === 'probe' && s.id === gaugeId))
      canvas.select([{ kind: 'probe', id: gaugeId }]);
    hooks.changed();
    const components = canvas.selections.filter((s) => s.kind === 'component');
    const single = canvas.selections.length === 1 && components.length === 1 ? (components[0]?.id ?? null) : null;
    const component = hooks.editor().document.design.components.find((c) => c.id === single);
    const gauge =
      canvas.selections.length === 1 ? hooks.editor().document.controlProbes?.find((p) => p.id === gaugeId) : null;
    heading.textContent =
      canvas.selections.length === 0
        ? '画布操作'
        : single
          ? component?.label || '元件操作'
          : gauge
            ? gauge.name || '压力表'
            : `已选 ${canvas.selections.length} 项`;
    menu.setAttribute('aria-label', id || gaugeId ? '元件操作' : '画布操作');
    heading.title = heading.textContent;
    intent = {
      owner: hooks.editor(),
      revision: hooks.editor().revision,
      selection: JSON.stringify(canvas.selections),
      componentId: single,
    };
    for (const [command, button] of buttons) {
      button.disabled = command === 'paste' || unavailable(command, single);
    }
    const captured = intent;
    menu.setAttribute('aria-busy', 'true');
    void hooks.canPaste().then((canPaste) => {
      if (intent !== captured || !menu.matches(':popover-open')) return;
      const paste = buttons.get('paste');
      if (paste) paste.disabled = !canPaste || unavailable('paste', single);
      menu.setAttribute('aria-busy', 'false');
    });
    menu.style.inset = 'auto';
    menu.style.margin = '0';
    menu.style.left = '8px';
    menu.style.top = '8px';
    menu.showPopover();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(event.clientX + 4, innerWidth - bounds.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(event.clientY + 4, innerHeight - bounds.height - 8)) + 'px';
    menu.tabIndex = -1;
    ([...buttons.values()].find((button) => !button.disabled) ?? menu).focus({ preventScroll: true });
  });
}
