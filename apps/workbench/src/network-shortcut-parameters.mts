import { networkDefinition, parameterDisplayName, unitDisplayName } from '@hyd/domain';
import type { NetworkDraftSession } from '@hyd/application';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import { element, escapeHtml as esc } from './network-dom.mjs';
import { parameterRuleField, bindParameterRuleFields, type ParameterLockChange } from './network-parameter-rules.mjs';
import { networkNumericInitialFields, networkInitialFieldUnit } from './network-properties.mjs';

interface Hooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  apply(root: HTMLElement): boolean;
  lock(componentId: string, group: string, key: string, locked: boolean): ReturnType<ParameterLockChange>;
  notify(message: string): void;
}
// These are the approved shortcut defaults, filtered through each registered definition.
const defaults: Readonly<Record<string, readonly string[]>> = {
  cylinder: ['geometry.strokeM', 'mechanics.externalForceN', 'mechanics.massKg'],
  'single-acting-cylinder': ['geometry.strokeM', 'mechanics.returnSpringNPerM', 'mechanics.returnPreloadN'],
  'cushioned-cylinder': ['geometry.strokeM', 'cushion.extendCushionAreaM2', 'cushion.retractCushionAreaM2'],
  'cushioned-double-rod-cylinder': ['geometry.strokeM', 'cushion.extendCushionAreaM2', 'cushion.retractCushionAreaM2'],
  'limited-rotary-actuator': [
    'geometry.angularTravelRad',
    'hydraulic.sweptVolumeM3PerRad',
    'mechanics.externalTorqueNm',
  ],
  pump: ['hydraulic.displacementM3PerRev', 'drive.angularSpeedRadPerS', 'relief.settingDifferentialPa'],
  motor: ['hydraulic.displacementM3PerRev', 'mechanics.externalTorqueNm', 'mechanics.inertiaKgM2'],
  valve: ['hydraulic.maximumAreaM2', 'spool.commandTravelM', 'hydraulic.flowCoefficient'],
  throttle: ['hydraulic.maximumAreaM2', 'hydraulic.flowCoefficient'],
  'one-way-throttle': ['hydraulic.maximumAreaM2', 'hydraulic.reverseOpeningDifferentialPa'],
  relief: ['hydraulic.settingDifferentialPa', 'hydraulic.maximumAreaM2'],
  'check-valve': ['hydraulic.openingDifferentialPa', 'hydraulic.maximumAreaM2'],
  'pilot-check': ['hydraulic.openingDifferentialPa', 'hydraulic.pilotRatio', 'hydraulic.maximumAreaM2'],
  'pressure-reducing': ['hydraulic.controlSettingPa', 'hydraulic.regulationBandPa'],
  'pressure-reducing-relieving': ['hydraulic.reducingRelievingSettingPa', 'hydraulic.regulationBandPa'],
  'two-pressure-valve': ['hydraulic.minimumInletPressurePa', 'hydraulic.activationBandPa'],
  'pilot-check-close': ['hydraulic.pilotRatio', 'hydraulic.openingDifferentialPa'],
  'sequence-valve': ['hydraulic.controlSettingPa', 'hydraulic.regulationBandPa'],
  counterbalance: ['hydraulic.counterbalanceSettingPa', 'hydraulic.pilotRatio'],
  'pressure-compensated-flow': ['hydraulic.meteringAreaM2', 'hydraulic.compensationDifferentialPa'],
  accumulator: ['gas.prechargeAbsolutePa', 'gas.totalVolumeM3'],
};
const preferenceKey = 'hydraulic-shortcut-fields-v1';

/** Selection and numeric drafts are view state; applying and locks stay in the properties owner. */
export function createNetworkShortcutParameters(hooks: Hooks) {
  const root = element('shortcutParameters');
  const advanced = document.createElement('details');
  advanced.className = 'shortcut-field-picker';
  element('properties').after(advanced);
  let identity = '',
    stamp = '',
    definitionId = '';
  let chosen: string[] = [];
  const drafts = new Map<string, string>();
  function selected() {
    const selection = hooks.canvas.selected;
    return selection?.kind === 'component'
      ? hooks.editor().document.design.components.find((c) => c.id === selection.id)
      : undefined;
  }
  function fields() {
    const component = selected();
    const def = component && networkDefinition(component.definition.id, component.definition.version);
    const initial =
      component && hooks.editor().document.design.initialConditions.find((c) => c.componentId === component.id);
    const numericInitial = initial
      ? networkNumericInitialFields
          .filter((key) => key in initial)
          .map((key) => ({ group: 'initial', key, path: 'initial.' + key, unit: networkInitialFieldUnit(key) }))
      : [];
    return [
      ...(def
        ? Object.entries(def.groups).flatMap(([group, specs]) =>
            specs
              .filter((spec) => spec.key !== 'enabled' && group !== 'positions')
              .map((spec) => ({ group, key: spec.key, path: group + '.' + spec.key, unit: spec.unit })),
          )
        : []),
      ...numericInitial,
    ];
  }
  function readChoice(): string[] {
    const component = selected();
    const specs = fields();
    const fallback = defaults[component?.typeId ?? ''] ?? specs.slice(0, 3).map((s) => s.path);
    try {
      const saved = localStorage.getItem(preferenceKey + ':' + definitionId);
      if (saved !== null) {
        const raw: unknown = JSON.parse(saved);
        if (
          Array.isArray(raw) &&
          raw.length <= specs.length &&
          raw.every((p) => typeof p === 'string' && specs.some((s) => s.path === p))
        )
          return [...new Set(raw.filter((p): p is string => typeof p === 'string'))];
        hooks.notify('卡片字段偏好无效，已使用常用字段。');
      }
    } catch {
      hooks.notify('无法读取卡片字段偏好，已使用常用字段。');
    }
    return fallback.filter((p) => specs.some((s) => s.path === p));
  }
  function render(): void {
    // The full properties renderer replaces its fields only when its context changes.
    const properties = element('properties');
    if (advanced.parentElement !== properties)
      properties.insertBefore(advanced, properties.querySelector('[data-property-drawing]'));
    const component = selected(),
      editor = hooks.editor();
    const nextIdentity = editor.documentSessionId + ':' + (component?.id ?? '');
    if (nextIdentity !== identity) {
      identity = nextIdentity;
      drafts.clear();
      stamp = '';
    }
    const nextStamp = JSON.stringify([identity, editor.physicsRevision, component, hooks.canvas.editable]);
    if (nextStamp === stamp) return;
    // A physical edit/undo replaces the saved baseline; lock-only edits preserve typed buffers.
    if (stamp && component && root.dataset.physicsRevision !== String(editor.physicsRevision)) drafts.clear();
    stamp = nextStamp;
    root.dataset.physicsRevision = String(editor.physicsRevision);
    advanced.hidden = !component;
    if (!component) {
      root.innerHTML = '<div class="c1-object-name">未选择元件</div>';
      advanced.replaceChildren();
      return;
    }
    const nextDefinition = component.definition.id + ':' + component.definition.version;
    if (definitionId !== nextDefinition || !stamp) {
      definitionId = nextDefinition;
      chosen = readChoice();
    }
    const specs = fields();
    root.innerHTML = `<div class="c1-object-name">${esc(component.label)}</div><div class="shortcut-fields">${chosen
      .map((path) => {
        const spec = specs.find((s) => s.path === path);
        if (!spec) return '';
        const initial = editor.document.design.initialConditions.find((c) => c.componentId === component.id);
        const saved =
          spec.group === 'initial'
            ? initial
              ? Object.entries(initial).find(([key]) => key === spec.key)?.[1]
              : undefined
            : component.parameters[spec.group]?.[spec.key];
        const value = drafts.get(path) ?? String(saved ?? '');
        return `<div class="c1-field"><label for="quick-${esc(spec.group)}-${esc(spec.key)}">${spec.group === 'initial' ? '初态 · ' : ''}${esc(parameterDisplayName(spec.key))}</label><div class="c1-field-meta"><small>${esc(unitDisplayName(spec.unit))}</small>${spec.group === 'initial' ? '' : parameterRuleField(component, spec.group, spec.key)}</div><input id="quick-${esc(spec.group)}-${esc(spec.key)}" aria-label="快捷${spec.group === 'initial' ? '初态 ' : ''}${esc(parameterDisplayName(spec.key))}" ${spec.group === 'initial' ? `data-initial="${esc(spec.key)}"` : `data-param="${esc(path)}"`} type="number" step="any" value="${esc(value)}" ${hooks.canvas.editable ? '' : 'disabled'}></div>`;
      })
      .join(
        '',
      )}</div><div class="c1-parameter-actions"><span data-shortcut-message role="status"></span><button type="button" class="c1-apply" data-shortcut-apply ${hooks.canvas.editable && chosen.length ? '' : 'disabled'}>应用</button></div>`;
    advanced.innerHTML = `<summary>高级：卡片显示字段 <small>已选 ${chosen.length} 项</small></summary><div class="shortcut-field-options">${specs.map((s) => `<label><input type="checkbox" data-shortcut-field="${esc(s.path)}" ${chosen.includes(s.path) ? 'checked' : ''}>${esc(parameterDisplayName(s.key))}<small>${esc(unitDisplayName(s.unit))}</small></label>`).join('')}</div>`;
    bindParameterRuleFields(root, (group, key, locked) => hooks.lock(component.id, group, key, locked));
    for (const lock of root.querySelectorAll('[data-rule-toggle]')) lock.classList.add('c1-lock');
    root.querySelector('[data-shortcut-apply]')?.addEventListener('click', () => {
      // The handler is retired if selection, document or revision changed while the user was typing.
      if (selected()?.id !== component.id || nextIdentity !== identity || !hooks.canvas.editable) return;
      const applied = hooks.apply(root);
      if (applied) {
        drafts.clear();
        stamp = '';
        render();
      }
      const message = root.querySelector('[data-shortcut-message]');
      if (message) message.textContent = applied ? '已应用，可撤销。' : '应用未完成；输入保留，请检查诊断。';
    });
  }
  root.addEventListener('input', (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      const path = input.dataset.param ?? (input.dataset.initial ? 'initial.' + input.dataset.initial : undefined);
      if (path) drafts.set(path, input.value);
    }
  });
  advanced.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.dataset.shortcutField) return;
    chosen = [...advanced.querySelectorAll<HTMLInputElement>('[data-shortcut-field]:checked')].flatMap((input) =>
      input.dataset.shortcutField ? [input.dataset.shortcutField] : [],
    );
    try {
      localStorage.setItem(preferenceKey + ':' + definitionId, JSON.stringify(chosen));
    } catch {
      hooks.notify('字段显示已调整，但本机偏好保存失败。');
    }
    stamp = '';
    render();
  });
  document.addEventListener('network-property-fields-accepted', (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!detail || typeof detail !== 'object' || !('componentId' in detail) || !('documentSessionId' in detail)) return;
    if (
      typeof detail.componentId !== 'string' ||
      typeof detail.documentSessionId !== 'string' ||
      identity !== detail.documentSessionId + ':' + detail.componentId
    )
      return;
    drafts.clear();
    stamp = '';
    render();
  });
  return { render };
}
