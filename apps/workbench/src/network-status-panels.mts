import { element } from './network-dom.mjs';
import {
  defaultStatusPreference,
  parseStatusPreference,
  statusPanelDefinitions,
  statusPreferenceKey,
  type StatusPanelId,
  type StatusPreference,
} from './network-status-preference.mjs';
interface Hooks {
  pipePinned(value: boolean): void;
  changed(): void;
  notify(message: string): void;
}
/** Reparents each existing panel once; original windows borrow the same nodes while open. */
export function setupNetworkStatusPanels(hooks: Hooks) {
  let preference: StatusPreference = defaultStatusPreference;
  const unreadable = () => hooks.notify('无法读取状态栏偏好，已使用默认显示；可重新勾选。');
  try {
    const saved = localStorage.getItem(statusPreferenceKey);
    if (saved !== null) {
      if (saved.length > 4096) unreadable();
      else {
        const raw: unknown = JSON.parse(saved),
          parsed = parseStatusPreference(raw);
        if (parsed.ok) preference = parsed.value;
        else unreadable();
      }
    }
  } catch {
    unreadable();
  }
  const container = element('statusPanels'),
    parking = element('statusPanelParking'),
    choices = element('statusPanelChoices');
  // Pipe double-click keeps its original transient readout; only its persistent card was retired.
  parking.append(element('exportPanel'));
  // Keep the single borrowed DOM in the closing window until its view-only exit finishes.
  // Native close/owner retirement still happen immediately; this delays only visual reparenting.
  const closing = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const panels = statusPanelDefinitions.map((definition) => {
    const node = element(definition.nodeId),
      origin = document.createComment('status-origin:' + definition.id);
    node.before(origin);
    const wrapper = document.createElement('section');
    wrapper.className = 'status-panel' + (definition.calculation ? ' calculation-dialog' : '');
    wrapper.dataset.statusPanel = definition.id;
    const heading = document.createElement('h3');
    heading.textContent = definition.label;
    wrapper.append(heading);
    container.append(wrapper);
    const label = document.createElement('label'),
      input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.statusPanel = definition.id;
    input.setAttribute('aria-label', definition.label);
    label.append(input, document.createTextNode(definition.label));
    choices.append(label);
    const owner = definition.ownerId ? element(definition.ownerId) : null;
    if (owner) node.dataset.statusOwner = owner.id;
    return { definition, node, origin, wrapper, input, owner };
  });
  const ownerOpen = (owner: HTMLElement | null) =>
    owner !== null &&
    (closing.has(owner) || (owner instanceof HTMLDialogElement ? owner.open : owner.matches(':popover-open')));
  function place() {
    for (const panel of panels) {
      const checked = preference.visible.includes(panel.definition.id);
      panel.input.checked = checked;
      if (panel.owner && (!checked || ownerOpen(panel.owner))) {
        if (panel.origin.parentNode && panel.node.previousSibling !== panel.origin)
          panel.origin.parentNode.insertBefore(panel.node, panel.origin.nextSibling);
      } else if (checked || panel.definition.id === 'pipe') {
        const body = panel.wrapper.querySelector(':scope > .c1-fold > .status-card-content') ?? panel.wrapper;
        if (panel.node.parentElement !== body) body.append(panel.node);
      } else if (panel.node.parentElement !== parking) parking.append(panel.node);
      panel.wrapper.hidden = !(
        (checked && !ownerOpen(panel.owner)) ||
        (panel.definition.id === 'pipe' && !panel.node.hidden)
      );
    }
    element('statusPanelsEmpty').hidden = panels.some((p) => !p.wrapper.hidden);
  }
  function update(next: StatusPreference, persist = true) {
    preference = next;
    hooks.pipePinned(preference.visible.includes('pipe'));
    place();
    if (persist) {
      try {
        localStorage.setItem(statusPreferenceKey, JSON.stringify(preference));
      } catch {
        hooks.notify('状态栏已调整，但本机偏好无法保存；本次显示仍可使用。');
      }
    }
    hooks.changed();
  }
  for (const panel of panels)
    panel.input.addEventListener('change', () => {
      const visible = panels.filter((p) => p.input.checked).map((p) => p.definition.id);
      update({ version: 1, visible });
      if (panel.input.checked) document.documentElement.dataset.inspectorOpen = 'true';
    });
  element('statusShowAll').addEventListener('click', () => {
    update({ version: 1, visible: statusPanelDefinitions.map((p) => p.id) });
    document.documentElement.dataset.inspectorOpen = 'true';
  });
  element('statusHideAll').addEventListener('click', () => update({ version: 1, visible: [] }));
  element('statusRestoreDefault').addEventListener('click', () => update(defaultStatusPreference));
  document.addEventListener(
    'beforetoggle',
    (event) => {
      if (!(event instanceof ToggleEvent) || event.newState !== 'open') return;
      if (event.target instanceof HTMLElement) {
        clearTimeout(closing.get(event.target));
        closing.delete(event.target);
      }
      for (const panel of panels)
        if (panel.owner === event.target && panel.origin.parentNode)
          panel.origin.parentNode.insertBefore(panel.node, panel.origin.nextSibling);
    },
    true,
  );
  document.addEventListener(
    'toggle',
    (event) => {
      const owner = event.target;
      if (!(owner instanceof HTMLElement) || !panels.some((p) => p.owner === owner)) return;
      clearTimeout(closing.get(owner));
      closing.delete(owner);
      if (
        owner instanceof HTMLDialogElement &&
        !owner.open &&
        owner.classList.contains('v13-dialog') &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        closing.set(
          owner,
          setTimeout(() => {
            closing.delete(owner);
            place();
          }, 170),
        );
      }
      place();
    },
    true,
  );
  new MutationObserver(place).observe(element('connectionReadout'), { attributes: true, attributeFilter: ['hidden'] });
  update(preference, false);
  return {
    show(id: StatusPanelId): void {
      document.documentElement.dataset.inspectorOpen = 'true';
      if (!preference.visible.includes(id)) update({ version: 1, visible: [...preference.visible, id] });
      panels
        .find((panel) => panel.definition.id === id)
        ?.wrapper.querySelector<HTMLButtonElement>('.status-card-collapse[aria-expanded="false"]')
        ?.click();
    },
  };
}
