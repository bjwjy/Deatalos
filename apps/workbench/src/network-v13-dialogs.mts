import { element } from './network-dom.mjs';
import { networkUiIcon, type NetworkUiIcon } from './network-v13-icons.mjs';
import { setupNetworkTaskSurfaces } from './network-v13-task-surfaces.mjs';
import { setupNetworkControllerMotion } from './network-v13-controller-motion.mjs';

const definitions: readonly (readonly [string, string, NetworkUiIcon, string])[] = [
  ['propertiesDialog', 'properties', 'settings', 'wide'],
  ['resultDataDialog', 'results', 'chart', 'wide'],
  ['valveSettings', 'valve', 'valve', 'valve'],
  ['throttleControl', 'throttle', 'throttle', 'compact'],
  ['probeDialog', 'probe', 'target', 'compact'],
  ['textAnnotationDialog', 'text', 'text', 'compact'],
  ['routeToolsDialog', 'route', 'connect', 'wide'],
  ['layoutToolsDialog', 'layout', 'grid', 'compact'],
  ['pressureSettings', 'pressure', 'drop', 'wide'],
  ['appSettings', 'app-settings', 'settings', 'compact'],
  ['networkRecovery', 'network-recovery', 'document', 'wide'],
  ['controllerDialog', 'controller', 'settings', 'wide'],
  ['sizingTools', 'sizing', 'settings', 'wide'],
  ['dutyTools', 'duty', 'grid', 'wide'],
  ['curveTools', 'curve', 'chart', 'wide'],
  ['formalExport', 'formal', 'save', 'wide'],
  ['externalToolsDialog', 'ai', 'ai', 'wide'],
  ['aiCandidateHistory', 'ai-history', 'ai', 'wide'],
  ['diagnosticsDialog', 'diagnostics', 'info', 'wide'],
  ['helpDialog', 'help', 'help', 'wide'],
  ['openDialog', 'open', 'folder', 'compact'],
];
function addClass(node: Element, name: string): void {
  if (!node.classList.contains(name)) node.classList.add(name);
}
function buttonClasses(dialog: HTMLDialogElement): void {
  for (const button of dialog.querySelectorAll('button')) {
    if (
      button.closest('.v13-dialog-header') ||
      button.matches(
        '.engineering-unit-toggle,.dialog-lock,[role="tab"],.b4-help-menu button,.valve-function-menu button',
      )
    )
      continue;
    addClass(button, 'dialog-button');
    if (
      button.matches(
        '.primary,#saveProbe,#saveController,#throttleControlApply,#applyPressureBands,#aiPreviewParameters,#aiBuildPrompt',
      )
    )
      addClass(button, 'dialog-primary');
    if (button.matches('#deleteProbe,#deleteTextAnnotation,[data-remove-action]')) addClass(button, 'dialog-danger');
  }
}
/** These are original controls, only grouped and styled. No input/result values are invented. */
function parameterRows(dialog: HTMLDialogElement): void {
  for (const input of dialog.querySelectorAll<HTMLInputElement>('#properties input[type="number"]')) {
    const row = input.closest('label');
    if (!row || row.classList.contains('dialog-field-row')) continue;
    const caption = row.querySelector(':scope>span');
    if (!caption) continue;
    const unit = caption.querySelector('small') || document.createElement('small');
    const lock = caption.querySelector('[data-rule-toggle]');
    row.classList.add('dialog-field-row');
    row.append(unit);
    if (lock) {
      lock.classList.add('dialog-lock');
      row.append(lock);
    } else {
      const space = document.createElement('span');
      space.setAttribute('aria-hidden', 'true');
      row.append(space);
    }
    row.append(input);
  }
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-rule-toggle]'))
    addClass(button, 'dialog-lock');
}
function shell(dialog: HTMLDialogElement, icon: NetworkUiIcon): void {
  const header = dialog.querySelector<HTMLElement>(':scope>.dialog-head');
  if (header) {
    addClass(header, 'v13-dialog-header');
    const title = header.querySelector('h2,strong');
    if (title?.tagName === 'STRONG') {
      const heading = document.createElement('h2');
      if (title.id) heading.id = title.id;
      heading.append(...title.childNodes);
      title.replaceWith(heading);
    }
    if (!header.querySelector('.v13-dialog-heading-icon')) {
      const symbol = document.createElement('span');
      symbol.className = 'v13-dialog-heading-icon';
      symbol.innerHTML = networkUiIcon(icon);
      header.prepend(symbol);
    }
    const close = header.querySelector('button.dialog-close') ?? header.querySelector('button');
    if (close && !close.classList.contains('dialog-close')) {
      close.classList.add('dialog-close');
      close.innerHTML = networkUiIcon('close');
    }
  }
  for (const body of dialog.querySelectorAll<HTMLElement>(':scope>.dialog-body')) addClass(body, 'v13-dialog-body');
  for (const footer of dialog.querySelectorAll<HTMLElement>(
    '.dialog-foot,.dialog-actions,.pressure-actions,.controller-commands',
  ))
    addClass(footer, 'v13-dialog-footer');
  for (const label of dialog.querySelectorAll('label')) {
    if (
      !label.classList.contains('dialog-control') &&
      label.querySelector('input:not([type="checkbox"]),select,textarea')
    )
      addClass(label, 'dialog-control');
    if (label.querySelector(':scope>input[type="checkbox"]')) addClass(label, 'dialog-check');
  }
  parameterRows(dialog);
  buttonClasses(dialog);
}
function footer(dialog: HTMLDialogElement, controls: readonly string[], primary?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'v13-dialog-footer';
  const left = document.createElement('div'),
    right = document.createElement('div');
  row.append(left, right);
  for (const id of controls) {
    const control = element(id);
    if (id.startsWith('delete') || id.startsWith('stop')) left.append(control);
    else right.append(control);
    if (id === primary) control.classList.add('dialog-primary');
  }
  dialog.append(row);
  return right;
}
function closeButton(dialog: HTMLDialogElement, text = '取消'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.className = 'dialog-button';
  button.addEventListener('click', () => dialog.close());
  return button;
}
function simpleDialogs(): void {
  const formal = element('formalExport');
  if (formal instanceof HTMLDialogElement) {
    const commands = footer(formal, ['formal-save'], 'formal-save');
    element('formal-save').textContent = '导出';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dialog-button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => element('formal-close').click());
    commands.prepend(cancel);
  }
  const text = element('textAnnotationDialog');
  if (text instanceof HTMLDialogElement) {
    element('annotationText').classList.add('b2-text-editor');
    element('annotationColor').classList.add('b2-color-input');
    const fields = text.querySelector('.text-style-fields');
    const align = element('annotationAlign').closest('label'),
      color = element('annotationColor').closest('label');
    if (fields && align && color) fields.insertBefore(align, color);
    const foot = text.querySelector('.dialog-foot'),
      apply = element('saveTextAnnotation');
    if (foot) foot.insertBefore(closeButton(text), apply);
    apply.classList.add('dialog-primary');
  }
  for (const [id, controls, primary] of [
    ['probeDialog', ['deleteProbe', 'saveProbe'], 'saveProbe'],
    ['throttleControl', ['throttleControlApply'], 'throttleControlApply'],
  ] satisfies [string, string[], string][]) {
    const dialog = element(id);
    if (!(dialog instanceof HTMLDialogElement)) continue;
    const right = footer(dialog, controls, primary);
    right.prepend(closeButton(dialog));
  }
  const layout = element('layoutToolsDialog');
  if (layout instanceof HTMLDialogElement) {
    const title = layout.querySelector('h2');
    if (title) title.textContent = '自动理线说明与状态';
    const note = element('layoutTools').querySelector(':scope>p.muted');
    if (note) note.remove();
    const right = footer(layout, []);
    right.append(closeButton(layout, '关闭'));
  }
  const pressure = element('pressureSettings');
  if (pressure instanceof HTMLDialogElement) {
    const count = element('pressureBandCount').closest('label');
    count?.classList.add('white-pressure-count');
    const actions = pressure.querySelector('.pressure-actions');
    if (actions) {
      const apply = element('applyPressureBands');
      actions.insertBefore(closeButton(pressure), apply);
      apply.classList.add('dialog-primary');
    }
  }
  const controller = element('controllerDialog');
  if (controller instanceof HTMLDialogElement) {
    const formerCommands = controller.querySelector('.controller-commands');
    const right = footer(controller, ['stopControllers', 'saveController'], 'saveController');
    formerCommands?.remove();
    right.prepend(closeButton(controller));
  }
}
function helpSurface(): void {
  const dialog = element('helpDialog'),
    menu = dialog.querySelector<HTMLElement>('.help-tabs'),
    body = dialog.querySelector<HTMLElement>('.dialog-body');
  if (!(dialog instanceof HTMLDialogElement) || !menu || !body) return;
  const layout = document.createElement('div');
  layout.className = 'b4-help-layout';
  menu.before(layout);
  menu.classList.add('b4-help-menu');
  body.classList.remove('dialog-body');
  body.classList.add('b4-help-reading');
  layout.append(menu, body);
  for (const button of menu.querySelectorAll('button')) button.classList.remove('dialog-button');
  const indicator = document.createElement('span');
  indicator.className = 'b4-topic-glide';
  indicator.setAttribute('aria-hidden', 'true');
  menu.prepend(indicator);
  const readingPositions = new Map<string, number>();
  let activeTopic = '';
  for (const section of body.querySelectorAll<HTMLElement>('[data-help-section]')) {
    section.classList.add('b4-help-article');
    const button = menu.querySelector<HTMLButtonElement>(`[data-help="${section.dataset.helpSection}"]`);
    if (button) {
      const title = document.createElement('div');
      title.className = 'b4-help-title';
      const heading = document.createElement('h3');
      heading.textContent = button.textContent;
      title.append(heading);
      section.prepend(title);
    }
  }
  function reflect(): void {
    for (const button of menu?.querySelectorAll<HTMLButtonElement>('button') || []) {
      const selected = button.getAttribute('aria-current') === 'true';
      button.setAttribute('aria-selected', String(selected));
      if (selected) {
        const topic = button.dataset.help || '';
        if (topic !== activeTopic && body) {
          if (activeTopic) readingPositions.set(activeTopic, body.scrollTop);
          activeTopic = topic;
          body.scrollTop = readingPositions.get(topic) || 0;
        }
        indicator.style.width = button.offsetWidth + 'px';
        indicator.style.height = button.offsetHeight + 'px';
        indicator.style.transform = `translateY(${button.offsetTop}px)`;
      }
    }
  }
  new MutationObserver(reflect).observe(menu, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
  dialog.addEventListener('toggle', reflect);
  menu.addEventListener('keydown', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const buttons = [...menu.querySelectorAll('button')],
      index = button ? buttons.indexOf(button) : -1;
    if (index < 0) return;
    const next =
      event.key === 'ArrowUp'
        ? Math.max(0, index - 1)
        : event.key === 'ArrowDown'
          ? Math.min(buttons.length - 1, index + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      buttons[next]?.click();
      buttons[next]?.focus({ preventScroll: true });
    }
  });
  window.addEventListener('resize', reflect);
  const foot = document.createElement('div');
  foot.className = 'v13-dialog-footer';
  foot.append(document.createElement('span'), closeButton(dialog, '关闭'));
  dialog.append(foot);
}

export function setupNetworkWhiteDialogs(): void {
  for (const [id, design, icon, size] of definitions) {
    const dialog = element(id);
    if (!(dialog instanceof HTMLDialogElement)) throw new Error('Dialog required: ' + id);
    dialog.classList.add('v13-dialog');
    dialog.dataset.designDialog = design;
    dialog.dataset.size = size;
    shell(dialog, icon);
    new MutationObserver(() => {
      if (dialog.open) shell(dialog, icon);
    }).observe(dialog, { childList: true, subtree: true });
    dialog.addEventListener('beforetoggle', () => shell(dialog, icon));
  }
  simpleDialogs();
  helpSurface();
  setupNetworkTaskSurfaces();
  setupNetworkControllerMotion();
}
