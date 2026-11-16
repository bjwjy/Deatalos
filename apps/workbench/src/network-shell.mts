import { setupNetworkDialogDragging } from './network-dialog-drag.mjs';
import { element } from './network-dom.mjs';

let fadeTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** One notice lifecycle; new feedback cannot be hidden by an older callback. Diagnostics live separately. */
export function showNetworkNotice(message: string): void {
  clearTimeout(fadeTimer);
  clearTimeout(hideTimer);
  const notice = element('toast');
  notice.textContent = message;
  notice.hidden = false;
  notice.dataset.noticeState = 'entering';
  // Commit the entering style before the visible transition, including rapid replacements.
  void notice.offsetHeight;
  notice.dataset.noticeState = 'visible';
  fadeTimer = setTimeout(() => {
    notice.dataset.noticeState = 'leaving';
    hideTimer = setTimeout(() => {
      notice.hidden = true;
    }, 260);
  }, 4000);
}

/** Thin menu routing to existing buttons/panels. It owns no engineering, run or file state. */
export function setupNetworkShell(): void {
  // Existing menu panels retain their controls and state; only their presentation moves.
  for (const [id, title] of [
    ['properties', '元件属性与设计初态'],
    ['resultData', '元件数据与运行状态'],
    ['layoutTools', '自动整理'],
    ['externalTools', 'AI 接入与候选'],
    ['routeTools', '手动绘图路径'],
    ['diagnostics', '诊断信息'],
  ]) {
    if (!id || !title) throw new Error('Menu panel definition missing');
    const panel = element(id),
      dialog = document.createElement('dialog');
    dialog.id = id + 'Dialog';
    dialog.setAttribute('aria-label', title);
    const header = document.createElement('div');
    header.className = 'dialog-head';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭' + title);
    close.addEventListener('click', () => dialog.close());
    header.append(heading, close);
    const body = document.createElement('div');
    body.className = 'dialog-body menu-panel-body';
    if (panel instanceof HTMLDetailsElement) {
      panel.open = true;
      const summary = panel.querySelector<HTMLElement>(':scope > summary');
      if (summary) summary.hidden = true;
    }
    body.append(panel);
    dialog.append(header, body);
    document.body.append(dialog);
  }

  setupNetworkDialogDragging();
  const helpControl = element('helpDialog');
  if (!(helpControl instanceof HTMLDialogElement)) throw new Error('Help must be a dialog');
  const help = helpControl;
  let menuCloseTimer: ReturnType<typeof setTimeout> | undefined;
  function closeMenus(): void {
    clearTimeout(menuCloseTimer);
    for (const popup of document.querySelectorAll<HTMLElement>('.menu-popup:popover-open, .submenu-popup:popover-open'))
      popup.hidePopover();
  }
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      const step = element('stepConfig');
      if (
        !document.querySelector('.menu-popup:popover-open,.submenu-popup:popover-open') &&
        !step.matches(':popover-open')
      )
        return;
      closeMenus();
      if (step.matches(':popover-open')) step.hidePopover();
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  function openHelp(topic: string): void {
    const topics = [...document.querySelectorAll<HTMLElement>('[data-help-section]')];
    if (!topics.some((section) => section.dataset.helpSection === topic)) throw new Error('Unknown help topic');
    closeMenus();
    for (const section of topics) section.hidden = section.dataset.helpSection !== topic;
    for (const button of help.querySelectorAll<HTMLButtonElement>('[data-help]'))
      button.setAttribute('aria-current', String(button.dataset.help === topic));
    if (!help.open) help.showModal();
    const body = help.querySelector('.dialog-body');
    if (body) body.scrollTop = 0;
  }
  // Hover opens menus without executing commands; clicks, touch and keyboard remain explicit.
  for (const trigger of document.querySelectorAll<HTMLButtonElement>('.menubar > button[popovertarget]')) {
    const targetId = trigger.getAttribute('popovertarget');
    const popup = targetId ? element(targetId) : null;
    if (!popup) throw new Error('Menu popup missing');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const open = () => {
      clearTimeout(menuCloseTimer);
      if (!popup.matches(':popover-open')) {
        closeMenus();
        popup.showPopover();
      }
    };
    const deferClose = () => {
      clearTimeout(menuCloseTimer);
      menuCloseTimer = setTimeout(() => {
        if (
          !trigger.matches(':hover') &&
          !popup.matches(':hover') &&
          !popup.contains(document.activeElement) &&
          !document.querySelector('.submenu-popup:popover-open:hover') &&
          !document.querySelector('.submenu-popup:popover-open :focus')
        )
          closeMenus();
      }, 220);
    };
    trigger.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') open();
    });
    trigger.addEventListener('pointerleave', deferClose);
    popup.addEventListener('pointerenter', () => clearTimeout(menuCloseTimer));
    popup.addEventListener('pointerleave', deferClose);
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      open();
    });
    popup.addEventListener('toggle', () =>
      trigger.setAttribute('aria-expanded', String(popup.matches(':popover-open'))),
    );
  }
  for (const trigger of document.querySelectorAll<HTMLButtonElement>('[data-submenu]')) {
    const target = trigger.dataset.submenu;
    const parent = trigger.closest<HTMLElement>('.menu-popup');
    if (!target || !parent) throw new Error('Submenu parent missing');
    const menu = element(target);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(closeTimer);
      if (menu.matches(':popover-open')) menu.hidePopover();
      trigger.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      clearTimeout(menuCloseTimer);
      clearTimeout(closeTimer);
      if (!parent.matches(':popover-open')) return;
      for (const sibling of document.querySelectorAll<HTMLElement>('.submenu-popup:popover-open'))
        if (sibling !== menu) sibling.hidePopover();
      if (!menu.matches(':popover-open')) menu.showPopover();
      const box = trigger.getBoundingClientRect(),
        width = menu.offsetWidth,
        height = menu.offsetHeight;
      menu.style.left = `${Math.max(8, box.right + width + 4 <= innerWidth ? box.right + 4 : box.left - width - 4)}px`;
      menu.style.top = `${Math.max(8, Math.min(box.top, innerHeight - height - 8))}px`;
      if (!menu.matches(':popover-open')) menu.showPopover();
      trigger.setAttribute('aria-expanded', 'true');
    };
    const isSiblingCommand = (target: EventTarget | null) => {
      const button = target instanceof Element ? target.closest('button') : null;
      return button !== null && button !== trigger;
    };
    const deferClose = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        const insideParent = menu.id === 'statusPanelMenu' && parent.matches(':hover');
        const retainKeyboardFocus = menu.id !== 'statusPanelMenu' && menu.contains(document.activeElement);
        if (!trigger.matches(':hover') && !menu.matches(':hover') && !insideParent && !retainKeyboardFocus) close();
      }, 220);
    };
    const closeOnSiblingCommand = (event: Event) => {
      if (menu.matches(':popover-open') && isSiblingCommand(event.target)) close();
    };
    parent.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'mouse') closeOnSiblingCommand(event);
    });
    parent.addEventListener('focusin', closeOnSiblingCommand);
    parent.addEventListener('click', closeOnSiblingCommand);
    trigger.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') open();
    });
    trigger.addEventListener('click', open);
    trigger.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      open();
      menu.querySelector<HTMLElement>('input,button')?.focus();
    });
    trigger.addEventListener('pointerleave', deferClose);
    menu.addEventListener('pointerenter', () => {
      clearTimeout(menuCloseTimer);
      clearTimeout(closeTimer);
    });
    menu.addEventListener('pointerleave', () => {
      deferClose();
      menuCloseTimer = setTimeout(() => {
        if (!document.querySelector('.menu-popup:popover-open:hover') && !menu.matches(':hover')) closeMenus();
      }, 240);
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'Escape') {
        event.preventDefault();
        close();
        trigger.focus();
      }
    });
    parent.addEventListener('toggle', () => {
      if (!parent.matches(':popover-open')) close();
    });
    menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
  }
  element('closeHelp').addEventListener('click', () => help.close());
  const wideWorkspace = window.matchMedia('(min-width: 761px)');
  const inspectorOpen = () =>
    document.documentElement.dataset.inspectorOpen === 'true' ||
    (document.documentElement.dataset.inspectorOpen === undefined && wideWorkspace.matches);
  function reflectInspector(): void {
    const open = inspectorOpen();
    element('showInspector').setAttribute('aria-expanded', String(open));
    element('showInspector').setAttribute('aria-controls', 'inspector');
    element('showInspector').title = open ? '收起右侧状态栏' : '打开右侧状态栏';
    for (const command of document.querySelectorAll<HTMLElement>('[data-command="showInspector"]')) {
      command.textContent = open ? '隐藏右侧状态栏' : '显示右侧状态栏';
      command.setAttribute('aria-pressed', String(open));
    }
  }
  new MutationObserver(reflectInspector).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-inspector-open'],
  });
  wideWorkspace.addEventListener('change', reflectInspector);
  reflectInspector();
  element('showInspector').addEventListener('click', () => {
    const open = !inspectorOpen();
    document.documentElement.dataset.inspectorOpen = String(open);
    reflectInspector();
    if (open) element('inspector').focus();
  });
  element('closeInspector').addEventListener('click', () => {
    document.documentElement.dataset.inspectorOpen = 'false';
    element('showInspector').focus();
  });
  const stepPopup = element('stepConfig');
  stepPopup.addEventListener('toggle', (event) => {
    if (!(event instanceof ToggleEvent) || event.newState !== 'open') return;
    const button = element('showStep').getBoundingClientRect();
    stepPopup.style.right = 'auto';
    stepPopup.style.left = `${Math.max(8, Math.min(button.right - stepPopup.offsetWidth, window.innerWidth - stepPopup.offsetWidth - 8))}px`;
    stepPopup.style.bottom = `${window.innerHeight - button.top + 6}px`;
  });
  for (const popup of document.querySelectorAll<HTMLElement>('.menu-popup')) {
    popup.addEventListener('beforetoggle', (event) => {
      if (!(event instanceof ToggleEvent) || event.newState !== 'open') return;
      const trigger = document.querySelector<HTMLButtonElement>(`[popovertarget="${popup.id}"]`);
      if (!trigger) throw new Error('Menu trigger missing');
      const box = trigger.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 246))}px`;
      popup.style.top = `${Math.min(box.bottom + 3, window.innerHeight - 80)}px`;
      for (const button of popup.querySelectorAll<HTMLButtonElement>('[data-command]')) {
        const target = button.dataset.command ? element(button.dataset.command) : null;
        button.disabled = target instanceof HTMLButtonElement && target.disabled;
      }
    });
  }
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const source = event.target.closest<HTMLButtonElement>('button');
    if (!source || source.dataset.submenu) return;
    // Inline toggles and status choices keep their menu available for consecutive changes.
    if (
      source.closest('.menu-popup, .submenu-popup') &&
      source.id &&
      !source.closest('#statusPanelMenu, [data-keep-menu-open]')
    )
      closeMenus();
    if (source.disabled) return;
    if (source.dataset.help) {
      openHelp(source.dataset.help);
      return;
    }
    if (source.dataset.panel) {
      closeMenus();
      if (source.dataset.panel === 'networkHelp') {
        openHelp('symbols');
        return;
      }
      const target = element(source.dataset.panel);
      const panelDialog =
        target instanceof HTMLDialogElement
          ? target
          : target.dataset.statusOwner
            ? element(target.dataset.statusOwner)
            : target.closest('dialog');
      if (panelDialog instanceof HTMLDialogElement) {
        if (!panelDialog.open) panelDialog.showModal();
        return;
      }
      document.documentElement.dataset.inspectorOpen = 'true';
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.scrollIntoView({ block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      showNetworkNotice('已打开对应面板，可展开说明查看使用条件。');
      return;
    }
    if (source.dataset.command) {
      closeMenus();
      const target = element(source.dataset.command);
      if (!(target instanceof HTMLButtonElement)) throw new Error('Menu command must target an existing button');
      if (!target.disabled) target.click();
    }
  });
  const policyControl = element('connectionPolicy');
  if (!(policyControl instanceof HTMLSelectElement)) throw new Error('Connection policy must be a select');
  const policy = policyControl;
  const toggle = element('connectionToggle');
  function renderPolicy(): void {
    toggle.textContent = policy.value === 'pipe' ? '新连线：物理管' : '新连线：理想';
    toggle.setAttribute('aria-pressed', String(policy.value === 'pipe'));
  }
  toggle.addEventListener('click', () => {
    policy.value = policy.value === 'pipe' ? 'ideal' : 'pipe';
    policy.dispatchEvent(new Event('change'));
    renderPolicy();
  });
  policy.addEventListener('change', renderPolicy);
  element('idealMode').addEventListener('click', renderPolicy);
  // A new/opened document resets the existing canvas policy without a DOM change event.
  new MutationObserver(() => {
    renderPolicy();
    const hint = element('connectHint').textContent?.trim();
    if (hint && hint !== '理想等压，忽略管损。') showNetworkNotice(hint);
  }).observe(element('connectHint'), {
    childList: true,
    characterData: true,
    subtree: true,
  });
  renderPolicy();
  // Toolbar aliases reflect the original command's disabled state, including undo after a save/reopen.
  for (const alias of document.querySelectorAll<HTMLButtonElement>(
    '.quick-toolbar [data-command], [data-status-export-action]',
  )) {
    const target = alias.dataset.command ? element(alias.dataset.command) : null;
    if (!(target instanceof HTMLButtonElement)) throw new Error('Toolbar command target missing');
    const reflect = () => {
      alias.disabled = target.disabled;
    };
    new MutationObserver(reflect).observe(target, { attributes: true, attributeFilter: ['disabled'] });
    reflect();
  }
}
