import {
  configureDirectionalValve,
  initialNetworkControls,
  networkComponentPresentationBounds,
  directionalValveSettings,
  directionalValveCatalog,
  networkCreationParameters,
  networkDefinition,
  parseNetworkProject,
  parameterDisplayName,
  defaultValveActuation,
  type NetworkProject,
} from '@hyd/domain';
import { networkParameterRulesOnlyEdit, planNetworkParameterLock, type NetworkDraftSession } from '@hyd/application';
import { parameterRuleField, bindParameterRuleFields, readParameterRuleFields } from './network-parameter-rules.mjs';
import { escapeHtml as esc } from './network-dom.mjs';
import { networkSymbol } from './network-symbols.mjs';
import { mountValveFunctionPickers, syncValveFunctionPickers, valveDialogMarkup } from './network-valve-dialog.mjs';
import type { ValveLibrary } from './network-valve-library.mjs';
import { teachingDemoButton } from './network-teaching-demo.mjs';
interface Hooks {
  editor(): NetworkDraftSession;
  canEdit(): boolean;
  mutate(candidate: unknown, physical?: boolean): boolean;
  toast(message: string): void;
  presets: ValveLibrary;
  uid(): string;
  placement(): { readonly x: number; readonly y: number };
  selected(id: string): void;
}
export function createNetworkValveSettings(hooks: Hooks) {
  const dialog = document.createElement('dialog');
  dialog.id = 'valveSettings';
  dialog.className = 'valve-settings-dialog';
  dialog.setAttribute('aria-labelledby', 'valveSettingsTitle');
  document.body.append(dialog);
  let owner: NetworkDraftSession | null = null,
    revision = -1,
    componentId = '',
    candidate: NetworkProject | null = null,
    stagedProject: NetworkProject | null = null,
    autoName = false,
    configurationEdited = false,
    preserveInputs = false;
  const get = (id: string) => {
    const value = dialog.querySelector('#' + id);
    if (!(value instanceof HTMLInputElement || value instanceof HTMLSelectElement))
      throw new Error('Valve setting missing: ' + id);
    return value;
  };
  const status = (text: string) => {
    const node = dialog.querySelector('#valveSettingsStatus');
    if (node) node.textContent = text;
  };
  const current = () => owner === hooks.editor() && revision === owner?.revision && hooks.canEdit();
  function syncFavorite() {
    const button = dialog.querySelector<HTMLButtonElement>('#valveSettingsFavorite');
    if (!button) return;
    button.disabled = candidate === null;
    button.textContent = candidate && hooks.presets.isSaved(candidate, componentId) ? '取消收藏' : '收藏';
  }
  function close() {
    for (const menu of dialog.querySelectorAll<HTMLElement>('[popover]'))
      if (menu.matches(':popover-open')) menu.hidePopover();
    candidate = null;
    stagedProject = null;
    owner = null;
    if (dialog.open) dialog.close();
  }
  function base(): NetworkProject | null {
    if (!owner || !current()) {
      status('工程或运行状态已变化，请关闭后重新打开。');
      return null;
    }
    const document = stagedProject ?? owner.document;
    const component = document.design.components.find((c) => c.id === componentId);
    if (!component) return null;
    const parameters: Record<string, Record<string, number>> = Object.fromEntries(
      Object.entries(component.parameters).map(([group, values]) => [group, { ...values }]),
    );
    for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-valve-advanced]')) {
      const [group, key] = input.dataset.valveAdvanced?.split('.') ?? [];
      if (group && key && parameters[group]) parameters[group][key] = input.value === '' ? NaN : Number(input.value);
    }
    const parameterRules = readParameterRuleFields(dialog, component);
    const parsed = parseNetworkProject({
      ...document,
      design: {
        ...document.design,
        components: document.design.components.map((c) =>
          c.id === componentId ? { ...c, parameters, ...(parameterRules === undefined ? {} : { parameterRules }) } : c,
        ),
      },
    });
    if (!parsed.ok) {
      status(parsed.diagnostics.map((d) => d.message).join('；'));
      return null;
    }
    return parsed.value;
  }
  function preview() {
    candidate = null;
    const button = dialog.querySelector<HTMLButtonElement>('#valveSettingsApply');
    if (button) button.disabled = true;
    syncFavorite();
    syncValveFunctionPickers(dialog, Number(get('valvePortCount').value));
    const source = base();
    if (!source) return;
    const functions = Object.fromEntries(
      [...dialog.querySelectorAll<HTMLSelectElement>('[data-valve-function]')].map((input) => [
        input.dataset.valveFunction ?? '',
        Number(input.value),
      ]),
    );
    const result =
      !configurationEdited && stagedProject === null
        ? { ok: true as const, value: source }
        : configureDirectionalValve(source, componentId, {
            positionCount: Number(get('valvePositionCount').value),
            portCount: Number(get('valvePortCount').value),
            label: get('valveSettingsName').value,
            initialPosition: get('valveSettingsInitial').value,
            functions,
            maximumAreaM2: Number(get('valveSettingsArea').value || NaN),
            flowCoefficient: Number(get('valveSettingsCoefficient').value || NaN),
            autoName,
            valveActuation: {
              version: 1,
              ...Object.fromEntries(
                ['left', 'right'].map((side) => [
                  side,
                  Object.fromEntries(
                    ['springReturn', 'pilotStage', 'manual', 'mechanical', 'fluid'].map((field) => {
                      const input = dialog.querySelector(`[data-valve-drive="${side}.${field}"]`);
                      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement))
                        throw new Error('Missing valve drive input');
                      return [field, input instanceof HTMLInputElement ? input.checked : input.value];
                    }),
                  ),
                ]),
              ),
            },
          });
    const view = dialog.querySelector('#valveSettingsPreview');
    if (!result.ok) {
      status(result.diagnostics.map((d) => d.message).join('；'));
      if (view) view.textContent = '';
      return;
    }
    candidate = result.value;
    const component = candidate.design.components.find((c) => c.id === componentId);
    if (!component) throw new Error('Preview valve missing');
    if (autoName) get('valveSettingsName').value = component.label;
    if (view) {
      const bounds = networkComponentPresentationBounds(component, { componentId: component.id, x: 0, y: 0, scale: 1 });
      if (!bounds) throw new Error('Preview valve geometry missing');
      view.innerHTML =
        `<svg viewBox="${bounds.left - 12} ${bounds.top - 12} ${bounds.right - bounds.left + 24} ${bounds.bottom - bounds.top + 24}" role="img" aria-label="阀位机能预览">` +
        networkSymbol(component, [], initialNetworkControls(candidate), { labels: false, details: false }) +
        '</svg>';
    }
    const original = owner?.document.design.components.find((c) => c.id === componentId);
    const modelChanged =
      original && (original.model.id !== component.model.id || original.model.version !== component.model.version);
    status(!stagedProject && modelChanged ? '应用后将采用新版准静态换向阀模型，可撤销。' : '');
    if (button) button.disabled = false;
    syncFavorite();
  }
  function shape(origin: 'initial' | 'edit' = 'edit') {
    if (origin === 'edit') configurationEdited = true;
    const spec = directionalValveCatalog.find(
      (s) =>
        s.slots.length === Number(get('valvePositionCount').value) &&
        s.ports.length === Number(get('valvePortCount').value),
    );
    if (!spec) return;
    const container = dialog.querySelector<HTMLElement>('#valveSettingsFunctions');
    if (!container) return;
    mountValveFunctionPickers(container, spec, () => {
      configurationEdited = true;
      preview();
    });
    const initial = get('valveSettingsInitial');
    initial.innerHTML = spec.slots
      .map(
        (slot) =>
          `<option value="${slot}">${slot === 'extend' ? '左位' : slot === 'retract' ? '右位' : '中位'}</option>`,
      )
      .join('');
    initial.value = spec.slots.includes('neutral') ? 'neutral' : 'retract';
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-way]'))
      button.setAttribute('aria-pressed', String(button.dataset.way === get('valvePortCount').value));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-positions]'))
      button.setAttribute('aria-pressed', String(button.dataset.positions === get('valvePositionCount').value));
    preview();
  }
  function open(id: string, source: NetworkProject = hooks.editor().document) {
    if (!hooks.canEdit()) {
      hooks.toast('请先暂停仿真，再双击阀设置位数、通数和机能。');
      return;
    }
    const editor = hooks.editor(),
      component = source.design.components.find((c) => c.id === id),
      initial = source.design.initialConditions.find((v) => v.componentId === id);
    if (!component || initial?.kind !== 'valve') return;
    const settings = directionalValveSettings(component, initial.positionId),
      definition = networkDefinition(component.definition.id, component.definition.version);
    if (!settings || !definition) {
      hooks.toast('此旧阀模型不支持位通设置，请保留原工程或换用已支持方向阀。');
      return;
    }
    close();
    owner = editor;
    stagedProject = source === editor.document ? null : source;
    autoName = stagedProject !== null;
    configurationEdited = false;
    revision = editor.revision;
    componentId = id;
    const parameterHeading = (group: string, key: string, title: string, unit: string) =>
      `<span class="valve-parameter-heading"><span>${esc(title)}</span><small>${esc(unit)}</small>${parameterRuleField(component, group, key)}</span>`;
    const advanced = Object.entries(definition.groups)
      .filter(([group]) => group !== 'positions')
      .flatMap(([group, specs]) =>
        specs
          .filter((spec) => !(group === 'hydraulic' && ['maximumAreaM2', 'flowCoefficient'].includes(spec.key)))
          .map(
            (spec) =>
              `<label>${parameterHeading(group, spec.key, parameterDisplayName(spec.key), spec.unit)}<input type="number" step="any" data-valve-advanced="${group}.${spec.key}" value="${component.parameters[group]?.[spec.key] ?? ''}"></label>`,
          ),
      )
      .join('');
    dialog.innerHTML = valveDialogMarkup(settings, advanced, stagedProject !== null);
    for (const [selector, key, title, unit] of [
      ['#valveSettingsArea', 'maximumAreaM2', '等效两口开口面积', 'm²'],
      ['#valveSettingsCoefficient', 'flowCoefficient', '流量系数', '无量纲'],
    ] as const) {
      const input = dialog.querySelector(selector),
        label = input?.closest('label');
      if (label && input) {
        label.replaceChildren(input);
        input.insertAdjacentHTML('beforebegin', parameterHeading('hydraulic', key, title, unit));
      }
    }
    bindParameterRuleFields(dialog, (group, key, locked) => {
      if (!owner || !current()) return false;
      if (stagedProject) {
        queueMicrotask(preview);
        return 'staged';
      }
      const planned = planNetworkParameterLock(owner.document, { componentId, group, key, locked });
      if (!planned.ok) {
        status(planned.diagnostics.map((d) => d.message).join('；'));
        return false;
      }
      preserveInputs = true;
      let changed = false;
      try {
        changed = hooks.mutate(planned.value, false);
      } finally {
        preserveInputs = false;
      }
      if (!changed) return false;
      revision = owner.revision;
      queueMicrotask(() => {
        preview();
        status(locked ? '参数已锁定。' : '参数已解锁。');
      });
      return 'persisted';
    });
    get('valvePositionCount').value = String(settings.positionCount);
    get('valvePortCount').value = String(settings.portCount);
    shape('initial');
    for (const select of dialog.querySelectorAll<HTMLSelectElement>('[data-valve-function]'))
      select.value = String(settings.functions[select.dataset.valveFunction ?? '']);
    get('valveSettingsInitial').value = settings.initialPosition;
    preview();
    dialog.querySelector('#valveSettingsClose')?.addEventListener('click', close);
    dialog.querySelector('#valveSettingsCancel')?.addEventListener('click', close);
    dialog.querySelector('#valveSettingsFavorite')?.addEventListener('click', () => {
      preview();
      if (!candidate || !current()) return;
      const result = hooks.presets.toggle(candidate, componentId, get('valveSettingsName').value);
      syncFavorite();
      status(
        result.ok
          ? result.value === 'saved'
            ? '已收藏到元件库。'
            : '已取消收藏。'
          : result.diagnostics.map((item) => item.message).join('；'),
      );
    });
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-way],[data-positions]'))
      button.addEventListener('click', () => {
        if (button.dataset.way) get('valvePortCount').value = button.dataset.way;
        if (button.dataset.positions) get('valvePositionCount').value = button.dataset.positions;
        autoName = true;
        shape();
      });
    dialog.querySelector('#valveSettingsApply')?.addEventListener('click', () => {
      preview();
      if (!candidate || !current()) return;
      const selected = candidate;
      const selectedId = componentId;
      close();
      const metadataOnly = networkParameterRulesOnlyEdit(hooks.editor().document, selected);
      if (hooks.mutate({ ...selected, updatedAt: new Date().toISOString() }, !metadataOnly)) {
        hooks.selected(selectedId);
        hooks.toast(
          metadataOnly ? '方向阀参数约束已保存；物理参数和有效结果保持。' : '方向阀设置已应用，可撤销；需重新初始化。',
        );
      }
    });
    get('valvePositionCount').addEventListener('change', () => {
      autoName = true;
      shape();
    });
    get('valvePortCount').addEventListener('change', () => {
      autoName = true;
      shape();
    });
    dialog.showModal();
    if (!stagedProject) {
      const teaching = teachingDemoButton('teaching:directional-3-4');
      if (teaching) dialog.querySelector('#valveSettingsClose')?.before(teaching);
    }
  }
  function onInput(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (!target.closest('[data-rule-row]')) configurationEdited = true;
    if (target.dataset.valveDrive) autoName = true;
    if (target.id === 'valveSettingsName') autoName = false;
    if (target instanceof HTMLInputElement && target.dataset.valveAdvanced?.startsWith('spool.')) {
      const source = base(),
        component = source?.design.components.find((c) => c.id === componentId),
        initial = source?.design.initialConditions.find((v) => v.componentId === componentId);
      if (component && initial?.kind === 'valve') {
        const settings = directionalValveSettings(component, initial.positionId);
        if (settings) get('valveSettingsArea').value = String(settings.maximumAreaM2);
      }
    }
    if (target.id !== 'valvePositionCount' && target.id !== 'valvePortCount') preview();
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('input', onInput);
  return {
    open,
    openNew(position = hooks.placement()) {
      if (!hooks.canEdit()) {
        hooks.toast('请先暂停仿真，再添加换向阀。');
        return;
      }
      const definition = networkDefinition('teaching:directional-3-4', 2);
      if (!definition) throw new Error('Default directional valve missing');
      const project = hooks.editor().document,
        id = hooks.uid();
      const component = {
        id,
        typeId: 'valve',
        definition: { id: definition.id, version: definition.version },
        model: { id: definition.model.id, version: definition.model.version },
        label: '换向阀',
        valveActuation: defaultValveActuation,
        parameters: networkCreationParameters(definition, project.design.fluid.densityKgPerM3),
      };
      const staged = parseNetworkProject({
        ...project,
        design: {
          ...project.design,
          components: [...project.design.components, component],
          initialConditions: [
            ...project.design.initialConditions,
            { componentId: id, kind: 'valve', positionId: 'neutral' },
          ],
        },
        layout: { ...project.layout, components: [...project.layout.components, { componentId: id, ...position }] },
      });
      if (!staged.ok) {
        hooks.toast(staged.diagnostics.map((item) => item.message).join('；'));
        return;
      }
      open(id, staged.value);
    },
    close,
    invalidateIfChanged() {
      if (!preserveInputs && dialog.open && !current()) close();
    },
  };
}
