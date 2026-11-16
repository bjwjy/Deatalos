import {
  parseNetworkProject,
  networkDefinition,
  networkDrawingScale,
  networkTeachingPreset,
  applyNetworkTeachingPreset,
  networkModelAssumptions,
  physicalPipeModel,
  physicalPipeParameters,
  networkDefaultParameters,
  networkCreationDefinitions,
  networkDisplacementRange,
  defaultExternalMotorDisplacementCurve,
  defaultMotorDisplacementCurve,
  configurePumpRelief,
  enableIntensifierOutletRelief,
  enableCompensatedFlowStorage,
  type NetworkProject,
  type NetworkConnection,
  type MotorDisplacementCurve,
  networkComponentPresentationBounds,
  initialNetworkControls,
} from '@hyd/domain';
import { physicalPipeMappingSupport } from '@hyd/engine';
import {
  combinedDutyPipeEligible,
  pressurizedControlDrainPipeEligible,
  sharedPumpReturnPipeEligible,
  steadyDutyPipeEligible,
} from '@hyd/engineering';
import {
  componentDisplayName,
  enableRotaryWorkProtection,
  parameterDisplayName,
  unitDisplayName,
  networkObjectDisplayName,
} from '@hyd/domain';

import { element as $, escapeHtml as esc } from './network-dom.mjs';
import { networkParameterRulesOnlyEdit, planNetworkParameterLock, type NetworkDraftSession } from '@hyd/application';
import { parameterRuleField, bindParameterRuleFields } from './network-parameter-rules.mjs';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { NetworkFeedback } from './network-feedback.mjs';
import { componentEditingPolicy } from './network-component-editing.mjs';
import { networkSymbol } from './network-symbols.mjs';
import { bindNetworkMotorCurve } from './network-motor-curve.mjs';
import { componentTeachingReference, teachingDemoButton } from './network-teaching-demo.mjs';
interface PropertyHooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  feedback: NetworkFeedback;
  mutate(candidate: unknown, physical?: boolean): boolean;
  render(): void;
  toast(message: string): void;
}
export const networkNumericInitialFields = [
  'positionM',
  'velocityMPerS',
  'capPressurePa',
  'rodPressurePa',
  'angleRad',
  'angularSpeedRadPerS',
  'pressurePa',
  'openingAreaM2',
  'oilVolumeM3',
] as const;
export function networkInitialFieldUnit(key: string): string {
  return key.endsWith('Pa')
    ? 'Pa'
    : key.endsWith('MPerS')
      ? 'm/s'
      : key.endsWith('M3')
        ? 'm³'
        : key.endsWith('M2')
          ? 'm²'
          : key.endsWith('RadPerS')
            ? 'rad/s'
            : key.endsWith('Rad')
              ? 'rad'
              : 'm';
}
function controlPressureFields(range: { readonly lowPa: number; readonly highPa: number } | undefined): string {
  return `<div data-control-pressure-range>
    <label><span>压力下限 <small>MPa</small></span><input type="number" step="any" data-control-low value="${(range?.lowPa ?? 1e6) / 1e6}"></label>
    <label><span>压力上限 <small>MPa</small></span><input type="number" step="any" data-control-high value="${(range?.highPa ?? 5e6) / 1e6}"></label>
  </div>`;
}
function selectedMotorMode(root: HTMLElement): string | undefined {
  return root.querySelector<HTMLElement>('[data-motor-mode][aria-pressed="true"]')?.dataset.motorMode;
}
function readControlPressureRange(root: HTMLElement) {
  const value = (selector: string) => {
    const text = root.querySelector<HTMLInputElement>(selector)?.value;
    return text?.trim() ? Number(text) * 1e6 : null;
  };
  return { lowPa: value('[data-control-low]'), highPa: value('[data-control-high]') };
}
export function createNetworkProperties(hooks: PropertyHooks) {
  const propertyFooter = document.createElement('div');
  propertyFooter.className = 'white-property-actions v13-dialog-footer';
  let propertyDocument: NetworkProject | null = null,
    propertySelection = '';
  let preserveInputs = false;
  let motorCurveDraft: MotorDisplacementCurve | undefined;
  function acceptedFields(): void {
    const selected = hooks.canvas.selected;
    if (selected?.kind === 'component')
      document.dispatchEvent(
        new CustomEvent('network-property-fields-accepted', {
          detail: { componentId: selected.id, documentSessionId: hooks.editor().documentSessionId },
        }),
      );
  }
  function persistLock(componentId: string, group: string, key: string, locked: boolean): 'persisted' | false {
    if (
      !hooks.canvas.editable ||
      hooks.canvas.selected?.kind !== 'component' ||
      hooks.canvas.selected.id !== componentId
    )
      return false;
    const candidate = planNetworkParameterLock(hooks.editor().document, { componentId, group, key, locked });
    if (!candidate.ok) {
      hooks.feedback.show(candidate.diagnostics);
      return false;
    }
    preserveInputs = true;
    let changed = false;
    try {
      changed = hooks.mutate(candidate.value, false);
    } finally {
      preserveInputs = false;
    }
    if (changed) hooks.toast(locked ? '参数已锁定。' : '参数已解锁。');
    return changed ? 'persisted' : false;
  }
  function drawingFields(componentId: string): string {
    const component = hooks.editor().document.design.components.find((c) => c.id === componentId);
    const placement = hooks.editor().document.layout.components.find((p) => p.componentId === componentId);
    if (!component || !placement) return '';
    return `<details data-property-drawing><summary>图形尺寸</summary><label>比例（50%～150%）<input data-drawing-scale type="number" min="50" max="150" step="5" aria-label="图形比例" value="${networkDrawingScale(component, placement) * 100}"></label><button data-increase-drawing-scale type="button">放大 +5%</button> <button data-apply-drawing-scale type="button">应用尺寸</button></details>`;
  }
  function bindDrawingFields(componentId: string): void {
    const owner = hooks.editor();
    const properties = $('properties');
    const input = properties.querySelector<HTMLInputElement>('[data-drawing-scale]');
    const increase = properties.querySelector<HTMLButtonElement>('[data-increase-drawing-scale]');
    const button = properties.querySelector<HTMLButtonElement>('[data-apply-drawing-scale]');
    if (!input || !increase || !button) return;
    const max = Number(input.max);
    const updateIncrease = () => {
      const scale = input.valueAsNumber;
      increase.disabled = !hooks.canvas.editable || !Number.isFinite(scale) || scale >= max;
    };
    input.addEventListener('input', updateIncrease);
    increase.addEventListener('click', () => {
      if (!hooks.canvas.editable) return;
      input.valueAsNumber = Math.min(max, Math.max(Number(input.min), input.valueAsNumber + Number(input.step)));
      updateIncrease();
    });
    updateIncrease();
    button.disabled = !hooks.canvas.editable;
    button.addEventListener('click', () => {
      // The current property context also advances on our own lock-only transaction, preserving input buffers.
      if (
        owner !== hooks.editor() ||
        owner.document !== propertyDocument ||
        hooks.canvas.selected?.kind !== 'component' ||
        hooks.canvas.selected.id !== componentId ||
        !hooks.canvas.editable
      ) {
        hooks.toast('工程或编辑状态已变化，请重新选择元件。');
        return;
      }
      const scale = input.valueAsNumber / 100;
      const candidate = parseNetworkProject({
        ...owner.document,
        layout: {
          ...owner.document.layout,
          components: owner.document.layout.components.map((p) =>
            p.componentId === componentId ? { ...p, scale } : p,
          ),
        },
      });
      if (!candidate.ok) {
        hooks.feedback.show(candidate.diagnostics);
        return;
      }
      if (hooks.mutate(candidate.value, false)) hooks.toast('图形尺寸已应用，可撤销；物理参数保持。');
    });
  }
  function fieldsForSelected() {
    const selected = hooks.canvas.selected;
    $('openConnectionProperties').hidden = !(
      selected?.kind === 'connection' &&
      (hooks.editor().document.design.connections.some((connection) => connection.id === selected.id) ||
        hooks.canvas.pendingPipe?.id === selected.id)
    );
    const canInspect =
      hooks.canvas.selected?.kind === 'component' &&
      hooks.editor().document.design.components.some((component) => component.id === hooks.canvas.selected?.id);
    for (const id of ['openProperties', 'openResultData']) {
      const button = $(id);
      if (!(button instanceof HTMLButtonElement)) throw new Error('Component menu command must be a button');
      const inspectable =
        canInspect ||
        (id === 'openResultData' &&
          selected?.kind === 'connection' &&
          hooks.editor().document.design.connections.some((c) => c.id === selected.id)) ||
        (id === 'openResultData' &&
          selected?.kind === 'node' &&
          hooks.editor().document.design.nodes.some((n) => n.id === selected.id));
      button.disabled = !inspectable;
      button.title = inspectable ? '' : '请先选择元件或管路';
      const wrapper = button.parentElement;
      if (wrapper) {
        if (inspectable) wrapper.removeAttribute('data-selection-hint');
        else wrapper.dataset.selectionHint = '请先选择元件';
      }
    }
    const selection = hooks.canvas.selected ? `${hooks.canvas.selected.kind}:${hooks.canvas.selected.id}` : '';
    if (preserveInputs) {
      propertyDocument = hooks.editor().document;
      propertySelection = selection;
      return;
    }
    if (propertyDocument === hooks.editor().document && propertySelection === selection) return;
    propertyDocument = hooks.editor().document;
    propertySelection = selection;
    motorCurveDraft = undefined;
    propertyFooter.replaceChildren();
    propertyFooter.hidden = true;
    if (hooks.canvas.selected?.kind === 'connection') {
      connectionFields(hooks.canvas.selected.id);
      return;
    }
    if (hooks.canvas.selected?.kind !== 'component') {
      $('properties').innerHTML =
        '<strong>元件属性</strong><p class="muted">选择一个元件后查看已注册参数和设计初态。</p>';
      return;
    }
    const component = hooks.editor().document.design.components.find((c) => c.id === hooks.canvas.selected!.id);
    if (!component) return;
    const def = networkDefinition(component.definition.id, component.definition.version)!;
    const initial = hooks.editor().document.design.initialConditions.find((v) => v.componentId === component.id);
    const editing = componentEditingPolicy(component.typeId);
    const motorRange = def.id === 'teaching:variable-motor' ? networkDisplacementRange(component) : null;
    const external = component.externalMotorControl;
    if (editing.propertyPanel === 'valve') {
      $('properties').innerHTML =
        `<strong>${esc(component.label)} · ${esc(componentDisplayName(component.typeId, def.id))}</strong><p class="muted">仿真未运行时，双击画布上的阀，打开位数、通数、逐位机能和参数设置。</p>${drawingFields(component.id)}`;
      bindDrawingFields(component.id);
      return;
    }
    const paramFields = Object.entries(def.groups)
      .filter(
        ([group]) =>
          group !== 'relief' &&
          group !== 'workProtection' &&
          group !== 'protectionReturn' &&
          group !== 'outletRelief' &&
          !(component.typeId === 'pressure-compensated-flow' && group === 'storage'),
      )
      .flatMap(([group, specs]) =>
        specs.map((spec) => {
          const displacement = def.control === 'displacement' && spec.unit === 'm³/rev';
          const title =
            displacement && spec.key === 'displacementM3PerRev' ? '初始排量' : parameterDisplayName(spec.key);
          const value = component.parameters[group]?.[spec.key];
          const shown = value === undefined ? '' : displacement ? value * 1e6 : value;
          const rangeFields =
            motorRange && spec.key === 'inertiaKgM2'
              ? controlPressureFields(external?.lowPa === undefined ? undefined : external)
              : '';
          return `${rangeFields}<label><span>${esc(title)}${parameterRuleField(component, group, spec.key)} <small>${esc(displacement ? 'cm³/rev' : unitDisplayName(spec.unit))}</small></span><input type="number" step="any" aria-label="${esc(title)}" data-param="${esc(group)}.${esc(spec.key)}" ${displacement ? 'data-displacement-unit' : ''} value="${shown}"></label>`;
        }),
      )
      .join('');
    const flowStorage = component.typeId === 'pressure-compensated-flow' ? component.parameters.storage : undefined;
    const flowStorageFields = flowStorage
      ? `<fieldset><legend>A 口内置油液容积</legend><label><span>油液容积 ${parameterRuleField(component, 'storage', 'portVolumeM3')} <small>L</small></span><input type="number" step="any" data-param="storage.portVolumeM3" data-param-scale="0.001" value="${Number(flowStorage.portVolumeM3) * 1000}"></label><label><span>初始压力 ${parameterRuleField(component, 'storage', 'initialPressurePa')} <small>MPa</small></span><input type="number" step="any" data-param="storage.initialPressurePa" data-param-scale="1000000" value="${Number(flowStorage.initialPressurePa) / 1e6}"></label><p class="muted">A 口可直接串接节流负载。初压按工程压力基准解释。</p></fieldset>`
      : component.typeId === 'pressure-compensated-flow'
        ? '<fieldset><legend>A 口内置油液容积</legend><label><input type="checkbox" data-upgrade-flow-storage>启用内置油液容积</label><p class="muted">应用后增加 A 口储油。已有外接容积继续参与计算。</p></fieldset>'
        : '';
    const protection = def.groups.workProtection;
    const protectionReturn = component.parameters.protectionReturn;
    const rotaryReturnFields = protectionReturn
      ? `<label>保护回油<select data-param="protectionReturn.internalTank"><option value="1" ${protectionReturn.internalTank === 1 ? 'selected' : ''}>内置油箱</option><option value="0" ${protectionReturn.internalTank === 0 ? 'selected' : ''}>外接 T 口</option></select></label><label>内置油箱压力 <small>MPa</small><input type="number" step="any" data-param="protectionReturn.pressurePa" data-param-scale="1000000" value="${Number(protectionReturn.pressurePa) / 1e6}"></label><p class="muted">内置油箱只给保护支路补油和回油。选外接时，将 T 口接至实际回油箱。</p>`
      : '<label><input type="checkbox" data-upgrade-rotary-protection>改用内置油箱</label><p class="muted">当前使用外接 T 口。</p>';
    const rotaryProtectionFields = protection
      ? `<fieldset><legend>内置冲击溢流补油</legend><label><input type="checkbox" data-param="workProtection.enabled" ${component.parameters.workProtection?.enabled === 1 ? 'checked' : ''}>启用内置保护</label>${protection
          .filter(({ key }) => key !== 'enabled')
          .map(({ key, unit }) => {
            const title = key === 'maximumAreaM2' ? '溢流最大开口' : parameterDisplayName(key);
            const scale = unit === 'Pa' ? 1e6 : unit === 'm²' ? 1e-6 : 1;
            return `<label><span>${esc(title)}${parameterRuleField(component, 'workProtection', key)} <small>${unit === 'Pa' ? 'MPa' : unit === 'm²' ? 'mm²' : ''}</small></span><input type="number" step="any" data-param="workProtection.${key}" data-param-scale="${scale}" aria-label="${esc(title)}" value="${Number(component.parameters.workProtection?.[key]) / scale}"></label>`;
          })
          .join('')}${rotaryReturnFields}</fieldset>`
      : component.typeId === 'limited-rotary-actuator'
        ? '<fieldset><legend>内置冲击溢流补油</legend><label><input type="checkbox" data-upgrade-rotary-protection>启用内置保护和油箱</label><p class="muted">应用后可在内置油箱和外接 T 口之间切换。</p></fieldset>'
        : '';
    const outlet = component.parameters.outletRelief;
    const outletFields = outlet
      ? `<fieldset><legend>增压器高压侧内置溢流</legend><label><input type="checkbox" data-param="outletRelief.enabled" ${outlet.enabled === 1 ? 'checked' : ''}>启用 H → R 溢流</label>${[
          { key: 'settingDifferentialPa', label: 'H 相对 R 的溢流开启压差', unit: 'MPa', scale: 1e6 },
          { key: 'maximumAreaM2', label: '溢流最大开口', unit: 'mm²', scale: 1e-6 },
          { key: 'flowCoefficient', label: '流量系数', unit: '', scale: 1 },
        ]
          .map(
            ({ key, label, unit, scale }) =>
              `<label><span>${label} <small>${unit}</small></span><input type="number" step="any" data-param="outletRelief.${key}" data-param-scale="${scale}" aria-label="${label}" value="${Number(outlet[key]) / scale}"></label>`,
          )
          .join('')}<p class="muted">默认开启压差 60 MPa。R 口接实际回油，H 侧储油容积在模型参数中调整。</p></fieldset>`
      : component.typeId === 'pressure-intensifier'
        ? '<fieldset><legend>增压器高压侧内置溢流</legend><label><input type="checkbox" data-upgrade-intensifier>启用内置溢流和储油</label></fieldset>'
        : '';
    let initialFields = '';
    for (const key of networkNumericInitialFields)
      if (initial && key in initial) {
        if (component.typeId === 'single-acting-cylinder' && key === 'rodPressurePa') continue;
        if (component.typeId === 'manual-shutoff' && initial.kind === 'throttle' && key === 'openingAreaM2') {
          initialFields += `<label>初始状态<select data-initial="openingAreaM2" aria-label="截止阀初始状态"><option value="closed" ${initial.openingAreaM2 === 0 ? 'selected' : ''}>关闭</option><option value="open" ${initial.openingAreaM2 > 0 ? 'selected' : ''}>全开</option></select></label>`;
          continue;
        }
        const unit = networkInitialFieldUnit(key);
        initialFields += `<label><span>${esc(parameterDisplayName(key))} <small>${unit}</small></span><input type="number" step="any" aria-label="${esc(parameterDisplayName(key))}" data-initial="${key}" value="${Object.entries(initial).find(([field]) => field === key)?.[1] ?? ''}" placeholder="留空表示未知"></label>`;
      }
    const assumptions = networkModelAssumptions(component)
      .map((note) => `<p class="muted">${esc(note)}</p>`)
      .join('');
    const reliefDefinition = networkCreationDefinitions.find(
      (definition) =>
        definition.id === component.definition.id && definition.typeId === 'pump' && definition.groups.relief,
    );
    const relief =
      component.parameters.relief ??
      (reliefDefinition && networkDefaultParameters(reliefDefinition.id, reliefDefinition.version)?.relief);
    const reliefControls = relief
      ? `<fieldset><legend>泵内置溢流</legend><label><input type="checkbox" data-relief="enabled" aria-label="内置溢流阀" ${relief.enabled === 1 ? 'checked' : ''}>内置溢流阀${parameterRuleField(component, 'relief', 'enabled')}</label>${[
          ['settingDifferentialPa', '开启压差', 'Pa'],
          ['maximumAreaM2', '最大开口面积', 'm²'],
          ['flowCoefficient', '流量系数', '无量纲'],
        ]
          .map(
            ([key, label, unit]) =>
              `<label><span>${label}${key ? parameterRuleField(component, 'relief', key) : ''} <small>${unit}</small></span><input data-relief="${key}" aria-label="内置溢流${label}" type="number" step="any" value="${key ? relief[key] : ''}"></label>`,
          )
          .join(
            '',
          )}<p class="muted">开启条件取 P 与 S 的压差，泄放从 P 流向 S。新建泵默认开启压差为 60 MPa，可在这里修改。旧泵勾选后点应用，即可升级为带内置溢流的模型。</p><button id="previewPumpRelief" type="button">预览内置溢流</button><button id="cancelPumpRelief" type="button">取消未应用修改</button><p id="pumpReliefPreview" role="status"></p></fieldset>`
      : '';
    const preset = networkTeachingPreset(component, hooks.editor().document.design.fluid.densityKgPerM3);
    const reference = hooks.editor().document.design.pressureReference;
    const pressureControls = editing.projectPressureReference
      ? `<fieldset><legend>工程压力基准</legend><label>液压压力参数的基准<select data-project-pressure-kind aria-label="工程压力基准"><option value="kernel-numeric" ${reference.kind === 'kernel-numeric' ? 'selected' : ''}>内核数值（未声明绝压）</option><option value="gauge" ${reference.kind === 'gauge' ? 'selected' : ''}>表压</option></select></label><label>绝压参考 / Pa<input data-absolute-reference type="number" step="any" min="1" aria-label="工程绝压参考" value="${reference.absoluteReferencePa ?? ''}"></label><p class="muted">蓄能器需要选择表压并明确填写绝压参考。应用后本工程所有液压压力参数按此基准解释，预充参数始终为绝压；需要重新初始化。</p></fieldset>`
      : '';
    const presetControl = preset ? '<button id="applyTeachingPreset" type="button">恢复默认值</button>' : '';
    const bounds = networkComponentPresentationBounds(component, { componentId: component.id, x: 0, y: 0, scale: 1 });
    const symbol = bounds
      ? `<svg viewBox="${bounds.left - 12} ${bounds.top - 12} ${bounds.right - bounds.left + 24} ${bounds.bottom - bounds.top + 24}" aria-label="元件符号">${networkSymbol(component, [], initialNetworkControls(hooks.editor().document), { labels: false, details: false })}</svg>`
      : '';
    const output = component.pressureSwitchOutput;
    const controlSettings = motorRange
      ? `<div class="compact-choice-row"><span>排量给定</span><div class="compact-choice" role="group" aria-label="马达排量给定来源">
        ${[
          ['local', '原有给定'],
          ['pressure', '压力 X'],
          ['voltage', '电压 U'],
        ]
          .map(
            ([mode, text]) =>
              `<button type="button" data-motor-mode="${mode}" aria-pressed="${mode === (external?.kind ?? 'local')}">${text}</button>`,
          )
          .join('')}
      </div></div>`
      : component.typeId === 'adjustable-pressure-switch'
        ? `<fieldset><legend>OUT 电压输出</legend>
          <label>输出模式<select data-pressure-switch-mode>
            <option value="switch">开关量 · 0 / 10 V</option>
            <option value="analog"${output?.mode === 'analog' ? ' selected' : ''}>模拟量 · 0～10 V</option>
          </select></label>
          ${controlPressureFields(output)}
        </fieldset>`
        : '';
    const curveButton = motorRange ? '<button id="openMotorCurve" type="button">编辑排量曲线</button>' : '';
    const curveDialog = motorRange
      ? `<dialog id="motorCurveDialog" class="motor-curve-dialog" aria-labelledby="motorCurveTitle">
        <div class="dialog-head"><strong id="motorCurveTitle">压力—排量曲线</strong></div>
        <div class="dialog-body" data-motor-curve></div>
        <div class="dialog-foot"><button type="button" data-curve-defaults>恢复默认值</button><span class="grow"></span>
        <button type="button" data-curve-dismiss>取消</button><button type="button" class="primary" data-curve-accept>确定</button></div>
      </dialog>`
      : '';
    $('properties').innerHTML =
      `<div class="white-property-overview">${symbol}<strong>${esc(component.label)} · ${esc(componentDisplayName(component.typeId, def.id))}</strong></div><label><span>名称</span><input data-label value="${esc(component.label)}" maxlength="60"></label>${pressureControls}${controlSettings}<details open><summary>模型参数</summary>${paramFields}</details>${reliefControls}${rotaryProtectionFields}${outletFields}${flowStorageFields}<details><summary>设计初始条件</summary>${initialFields || '<p class="muted">此元件没有独立动态初态。</p>'}</details><details><summary>定义与模型技术详情</summary>${assumptions}<pre>${esc(def.id)} / ${def.version}\n${esc(component.model.id)} / ${esc(component.model.version)}</pre></details>${drawingFields(component.id)}<div class="white-property-actions">${presetControl}${curveButton}<button id="applyProperties" class="primary" type="button">应用</button></div>${curveDialog}`;
    const root = $('properties');
    const teaching = teachingDemoButton(componentTeachingReference(hooks.editor().document, component));
    if (teaching) root.querySelector('.white-property-overview')?.append(teaching);
    const curveRoot = root.querySelector<HTMLElement>('[data-motor-curve]');
    const dialog = root.querySelector<HTMLDialogElement>('#motorCurveDialog');
    const rangeFields = root.querySelector<HTMLElement>('[data-control-pressure-range]');
    if (dialog && curveRoot && motorRange && rangeFields) {
      const choices = root.querySelectorAll<HTMLButtonElement>('[data-motor-mode]');
      const updateMode = () => {
        rangeFields.hidden = selectedMotorMode(root) === 'local';
      };
      for (const button of choices)
        button.addEventListener('click', () => {
          for (const choice of choices) choice.setAttribute('aria-pressed', String(choice === button));
          updateMode();
        });
      updateMode();
      let editor: ReturnType<typeof bindNetworkMotorCurve> | undefined;
      $('openMotorCurve').addEventListener('click', () => {
        const externalMode = selectedMotorMode(root) !== 'local';
        const pressure = readControlPressureRange(root);
        const min =
          Number(root.querySelector<HTMLInputElement>('[data-param="hydraulic.minimumDisplacementM3PerRev"]')?.value) /
          1e6;
        const max =
          Number(root.querySelector<HTMLInputElement>('[data-param="hydraulic.maximumDisplacementM3PerRev"]')?.value) /
          1e6;
        if (!(min > 0 && max > min && max <= 0.01)) {
          hooks.feedback.show([{ code: 'PARAMETER_INVALID', message: '请先填写有效的最小和最大排量。' }]);
          return;
        }
        if (
          externalMode &&
          (pressure.lowPa === null ||
            pressure.highPa === null ||
            !(pressure.highPa > pressure.lowPa && pressure.highPa <= 70e6 && pressure.lowPa >= -1e8))
        ) {
          hooks.feedback.show([{ code: 'PARAMETER_INVALID', message: '请先填写有效的控制压力下限和上限。' }]);
          return;
        }
        const range = { min, max };
        const defaults =
          externalMode && pressure.lowPa !== null && pressure.highPa !== null
            ? defaultExternalMotorDisplacementCurve(range, { lowPa: pressure.lowPa, highPa: pressure.highPa })
            : defaultMotorDisplacementCurve(range);
        curveRoot.replaceChildren();
        editor = bindNetworkMotorCurve(
          curveRoot,
          motorCurveDraft ?? component.motorDisplacementCurve,
          range,
          defaults,
          externalMode,
        );
        dialog.showModal();
      });
      dialog.querySelector('[data-curve-defaults]')?.addEventListener('click', () => editor?.restoreDefaults());
      dialog.querySelector('[data-curve-dismiss]')?.addEventListener('click', () => dialog.close());
      dialog.querySelector('[data-curve-accept]')?.addEventListener('click', () => {
        const result = editor?.value();
        if (!result?.ok) return;
        motorCurveDraft = result.curve;
        dialog.close();
      });
    }
    const controlMode = root.querySelector<HTMLSelectElement>('[data-pressure-switch-mode]');
    if (controlMode && rangeFields) {
      const showMode = () => {
        rangeFields.hidden = controlMode.value !== 'analog';
        for (const field of $('properties').querySelectorAll(
          '[data-param="hydraulic.tripPressurePa"], [data-param="hydraulic.resetPressurePa"]',
        )) {
          const row = field.closest('label');
          if (row) row.hidden = controlMode.value === 'analog';
        }
      };
      controlMode.addEventListener('change', showMode);
      showMode();
    }
    bindDrawingFields(component.id);
    bindParameterRuleFields($('properties'), (group, key, locked) => persistLock(component.id, group, key, locked));
    $('applyProperties').addEventListener('click', () => applyProperties());
    if (reliefControls) {
      $('previewPumpRelief').addEventListener('click', () => {
        const candidate = propertyCandidate();
        if (!candidate) return;
        const selected = candidate.design.components.find((c) => c.id === component.id);
        const config = selected?.parameters.relief;
        $('pumpReliefPreview').textContent =
          config?.enabled === 1
            ? `预览：P→S；开启压差${config.settingDifferentialPa} Pa，最大开口${config.maximumAreaM2} m²，流量系数${config.flowCoefficient}。尚未应用。`
            : '预览：内置溢流关闭，尚未应用。';
      });
      $('cancelPumpRelief').addEventListener('click', () => {
        propertyDocument = null;
        hooks.render();
      });
    }
    if (preset)
      $('applyTeachingPreset').addEventListener('click', () => {
        const before = hooks.editor().document;
        const candidate = applyNetworkTeachingPreset(hooks.editor().document, component.id);
        if (!candidate.ok) {
          hooks.feedback.show(candidate.diagnostics);
          return;
        }
        if (hooks.mutate({ ...candidate.value, updatedAt: new Date().toISOString() })) {
          // A no-op transaction keeps the document identity; explicit defaults must still replace input buffers.
          propertyDocument = null;
          hooks.render();
          acceptedFields();
          hooks.toast(
            hooks.editor().document === before
              ? '当前教学默认值已显示；工程参数未改变。'
              : '当前教学默认值已应用，可撤销；需重新初始化。',
          );
        }
      });
    const actions = $('properties').querySelector('.white-property-actions');
    if (actions) {
      propertyFooter.append(...actions.childNodes);
      actions.remove();
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => {
        const dialog = $('propertiesDialog');
        if (dialog instanceof HTMLDialogElement) dialog.close();
      });
      propertyFooter.insertBefore(cancel, propertyFooter.lastChild);
      propertyFooter.hidden = false;
      $('propertiesDialog').append(propertyFooter);
    }
  }
  function connectionFields(id: string): void {
    const edge = hooks.editor().document.design.connections.find((edge) => edge.id === id);
    const draft = hooks.canvas.pendingPipe?.id === id ? hooks.canvas.pendingPipe : null;
    if (!edge && !draft) {
      $('properties').textContent = '所选连接已不存在。';
      return;
    }
    const title = edge ? networkObjectDisplayName(hooks.editor().document, 'connection', id) : '待确认物理管';
    if (edge?.kind === 'signal') {
      $('properties').innerHTML =
        '<strong>OUT → U · 0～10 V 信号线</strong><p>传送压力开关的输出电压，用于变量马达的外部电压给定。线路可随图面整理和撤销。</p>';
      return;
    }
    if (edge?.kind === 'ideal') {
      $('properties').innerHTML =
        `<strong>${esc(title)} · 理想连接</strong><p>两端等压，忽略管损，没有真实管长参数。需要管损时，请手动新建物理管；不会把已有连接自动换模型。</p><p class="muted">按Del删除，撤销可恢复。绘图路径只影响布局。</p>`;
      return;
    }
    const original = edge?.kind === 'pipe' ? edge.parameters : null;
    const support = original && physicalPipeMappingSupport(original, `/design/connections/${id}`);
    const steadyEligible = (project: NetworkProject) =>
      steadyDutyPipeEligible(project, id) ||
      sharedPumpReturnPipeEligible(project, id) ||
      pressurizedControlDrainPipeEligible(project, id) ||
      combinedDutyPipeEligible(project, id);
    const steadySupport = original && steadyEligible(hooks.editor().document);
    $('properties').innerHTML =
      `<strong>${esc(title)} · 物理管参数</strong><p>${draft ? '虚线为待提交草稿，不进入保存或计算。请填写来源明确的实际数值。' : '以下为已保存原值；预览或取消不会修改工程。'}</p><details open><summary>稳态核算与仿真条件</summary><p>在已支持的单泵管路、双泵共用回油干线或双泵合流母线接线完整后，可保存实际粗糙度和 K，用于当前设计稳态核算。瞬态仿真仍要求 L&gt;0、K=0、Re&lt;2000。绘图长度不作管长。</p></details>${support && !support.ok && !steadySupport ? '<p class="error">原值超出当前管路支持域，待核。</p>' : ''}${physicalPipeParameters.map((spec) => `<label><span>${esc(parameterDisplayName(spec.key))} <small>${esc(unitDisplayName(spec.unit))}</small></span><input type="number" step="any" data-pipe-param="${esc(spec.key)}" aria-label="${esc(parameterDisplayName(spec.key))}" min="${spec.minimum}" max="${spec.maximum}" value="${original?.[spec.key] ?? ''}" placeholder="实际值"></label>`).join('')}<button id="previewPipe" class="wide">预览参数</button><p id="pipePreview" role="status">尚未预览；不会修改当前运行。</p><button id="applyPipe" class="wide primary" disabled>${draft ? '确认建立物理管' : '应用物理管参数'}</button><button id="cancelPipe" class="wide">取消修改</button><p class="muted">确认应用才增加物理修订、使旧结果失效；可撤销。不改变端点、模型与绘图路径。</p>`;
    const document = hooks.editor().document,
      documentSession = hooks.editor().documentSessionId,
      physicsRevision = hooks.editor().physicsRevision;
    let preview: NetworkProject | null = null;
    const validContext = () =>
      hooks.editor().document === document &&
      hooks.editor().documentSessionId === documentSession &&
      hooks.editor().physicsRevision === physicsRevision;
    const apply = $('applyPipe') as HTMLButtonElement;
    for (const input of $('properties').querySelectorAll<HTMLInputElement>('[data-pipe-param]'))
      input.addEventListener('input', () => {
        preview = null;
        apply.disabled = true;
        $('pipePreview').textContent = '参数已编辑；请重新预览，当前工程尚未修改。';
      });
    $('previewPipe').addEventListener('click', () => {
      hooks.feedback.clear();
      preview = null;
      apply.disabled = true;
      if (!validContext()) {
        hooks.feedback.show([{ code: 'RESPONSE_STALE', message: '工程已改变，请重新选择管路后预览。' }], '管路预览');
        return;
      }
      const parameters: Record<string, number> = {};
      for (const input of $('properties').querySelectorAll<HTMLInputElement>('[data-pipe-param]')) {
        const key = input.dataset.pipeParam!,
          spec = physicalPipeParameters.find((spec) => spec.key === key)!;
        const value = input.value === '' ? NaN : Number(input.value);
        if (!Number.isFinite(value) || value < spec.minimum || value > spec.maximum) {
          $('pipePreview').textContent =
            `${parameterDisplayName(key)}需填写${spec.minimum}～${spec.maximum} ${unitDisplayName(spec.unit)}的有限实际值；未修改工程。`;
          hooks.feedback.show(
            [
              {
                code: 'PARAMETER_INVALID',
                field: `/design/connections/${id}/parameters/${key}`,
                message: $('pipePreview').textContent!,
              },
            ],
            '管路预览',
          );
          input.focus();
          return;
        }
        parameters[key] = value;
      }
      const supported = physicalPipeMappingSupport(parameters, `/design/connections/${id}`);
      const replacement: NetworkConnection = {
        id,
        kind: 'pipe',
        from: (edge ?? draft)!.from,
        to: (edge ?? draft)!.to,
        model: edge?.kind === 'pipe' ? edge.model : physicalPipeModel,
        parameters,
      };
      const candidate = parseNetworkProject({
        ...hooks.editor().document,
        updatedAt: new Date().toISOString(),
        design: {
          ...hooks.editor().document.design,
          connections: draft
            ? [...hooks.editor().document.design.connections, replacement]
            : hooks.editor().document.design.connections.map((item) => (item.id === id ? replacement : item)),
        },
        layout: draft
          ? {
              ...hooks.editor().document.layout,
              routes: [...hooks.editor().document.layout.routes, { connectionId: id, mode: 'auto' }],
            }
          : hooks.editor().document.layout,
      });
      if (!candidate.ok) {
        $('pipePreview').textContent = '工程验证未通过，请检查诊断。';
        hooks.feedback.show(candidate.diagnostics, '管路预览');
        return;
      }
      if (!supported.ok && !steadyEligible(candidate.value)) {
        $('pipePreview').textContent = supported.diagnostics.map((d) => d.message).join('；');
        hooks.feedback.show(supported.diagnostics, '管路预览');
        return;
      }
      preview = candidate.value;
      apply.disabled = false;
      $('pipePreview').textContent =
        physicalPipeParameters
          .map(
            (spec) =>
              `${parameterDisplayName(spec.key)}：${original?.[spec.key] ?? '未设置'} → ${parameters[spec.key]} ${unitDisplayName(spec.unit)}`,
          )
          .join('；') +
        (supported.ok
          ? '。参数检查通过。完整接线与 Re 由相应计算入口校核。尚未应用。'
          : '。可用于当前接法的管路稳态核算。该参数组合超出瞬态仿真管路域。尚未应用。');
      hooks.feedback.render();
    });
    $('applyPipe').addEventListener('click', () => {
      if (!preview || !validContext()) {
        hooks.feedback.show([{ code: 'RESPONSE_STALE', message: '预览失效，请重新选择管路并预览。' }], '管路应用');
        return;
      }
      const candidate = preview;
      // Preserve no-op edits as no-ops, including their engineering timestamp.
      const replacement = candidate.design.connections.find((item) => item.id === id);
      if (
        edge?.kind === 'pipe' &&
        replacement?.kind === 'pipe' &&
        JSON.stringify(edge.parameters) === JSON.stringify(replacement.parameters)
      ) {
        hooks.feedback.clear();
        propertyDocument = null;
        hooks.render();
        hooks.toast('参数未改变；运行与物理修订保持。');
        return;
      }
      hooks.canvas.confirmPending();
      if (hooks.mutate(candidate)) {
        propertyDocument = null;
        hooks.render();
        $('connectHint').textContent = '物理管已应用；需重新初始化，可撤销。';
      }
    });
    $('cancelPipe').addEventListener('click', cancelPipeEdit);
  }
  function cancelPipeEdit(): void {
    hooks.canvas.cancelPending();
    propertyDocument = null;
    if (hooks.feedback.source === '管路预览') hooks.feedback.clear();
    $('connectHint').textContent = '已取消物理管修改；工程与运行保持。';
    hooks.render();
  }
  function propertyCandidate(root: HTMLElement = $('properties')): NetworkProject | undefined {
    if (hooks.canvas.selected?.kind !== 'component') return;
    const id = hooks.canvas.selected.id,
      c = hooks.editor().document.design.components.find((v) => v.id === id);
    if (!c) return;
    const params: Record<string, Record<string, number>> = Object.fromEntries(
      Object.keys(c.parameters).map((group) => [group, { ...c.parameters[group] }]),
    );
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-param]')) {
      const [group, key] = input.dataset.param!.split('.');
      const value =
        input instanceof HTMLInputElement && input.type === 'checkbox'
          ? Number(input.checked)
          : input.value === ''
            ? NaN
            : Number(input.value);
      const groupParams = params[group!];
      if (!Number.isFinite(value) || !groupParams) {
        hooks.feedback.show([
          { code: 'PARAMETER_INVALID', field: `/components/${id}/${group}/${key}`, message: '参数必须为有限数值。' },
        ]);
        input.focus();
        return;
      }
      const scale = input.hasAttribute('data-displacement-unit') ? 1e-6 : Number(input.dataset.paramScale ?? 1);
      groupParams[key!] = value * scale;
    }
    const initials: unknown[] = [...hooks.editor().document.design.initialConditions];
    const idx = hooks.editor().document.design.initialConditions.findIndex((v) => v.componentId === id),
      initial = hooks.editor().document.design.initialConditions[idx];
    if (initial) {
      const next: Record<string, unknown> = { ...initial };
      for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-initial]')) {
        const key = input.dataset.initial!;
        next[key] =
          c.typeId === 'manual-shutoff' && key === 'openingAreaM2'
            ? input.value === 'closed'
              ? 0
              : input.value === 'open'
                ? params.hydraulic?.maximumAreaM2
                : null
            : input.value === ''
              ? null
              : input instanceof HTMLSelectElement
                ? input.value
                : Number(input.value);
        if (typeof next[key] === 'number' && !Number.isFinite(next[key])) {
          hooks.feedback.show([
            {
              code: 'INITIAL_CONDITION_INVALID',
              field: `/initialConditions/${id}/${key}`,
              message: '初始条件须为有限数值或明确留空。',
            },
          ]);
          input.focus();
          return;
        }
      }
      initials[idx] = next;
    }
    const label = (root.querySelector<HTMLInputElement>('[data-label]')?.value ?? c.label).trim();
    const motorMode = selectedMotorMode(root);
    const outputMode = root.querySelector<HTMLSelectElement>('[data-pressure-switch-mode]')?.value;
    const pressureRange = readControlPressureRange(root);
    const upgradeRotary = root.querySelector<HTMLInputElement>('[data-upgrade-rotary-protection]')?.checked;
    const upgradeIntensifier = root.querySelector<HTMLInputElement>('[data-upgrade-intensifier]')?.checked;
    const upgradeFlowStorage = root.querySelector<HTMLInputElement>('[data-upgrade-flow-storage]')?.checked;
    const useExternal = motorMode === 'pressure' || motorMode === 'voltage';
    const components = hooks.editor().document.design.components.map((v) => {
      if (v.id !== id) return v;
      const original = upgradeRotary
        ? enableRotaryWorkProtection(v)
        : upgradeIntensifier
          ? enableIntensifierOutletRelief(v)
          : upgradeFlowStorage
            ? enableCompensatedFlowStorage(v)
            : v;
      const { externalMotorControl, ...base } = original;
      const curve = (root === $('properties') ? motorCurveDraft : undefined) ?? v.motorDisplacementCurve;
      const savedCurve = useExternal && curve ? { ...curve, enabled: false } : curve;
      return {
        ...base,
        label,
        parameters: { ...original.parameters, ...params },
        ...(savedCurve ? { motorDisplacementCurve: savedCurve } : {}),
        ...(useExternal
          ? {
              externalMotorControl: { kind: motorMode, ...pressureRange },
            }
          : motorMode === undefined && externalMotorControl
            ? { externalMotorControl }
            : {}),
        ...(outputMode === 'analog' || (outputMode === 'switch' && v.pressureSwitchOutput)
          ? { pressureSwitchOutput: { mode: outputMode, ...pressureRange } }
          : {}),
      };
    });
    const parsed = parseNetworkProject({
      ...hooks.editor().document,
      updatedAt: new Date().toISOString(),
      design: {
        ...hooks.editor().document.design,
        components,
        initialConditions: initials,
        ...(root.querySelector('[data-project-pressure-kind]')
          ? {
              pressureReference: {
                kind: root.querySelector<HTMLSelectElement>('[data-project-pressure-kind]')?.value,
                absoluteReferencePa: root.querySelector<HTMLInputElement>('[data-absolute-reference]')?.value.trim()
                  ? Number(root.querySelector<HTMLInputElement>('[data-absolute-reference]')?.value)
                  : null,
              },
            }
          : {}),
      },
    });
    if (!parsed.ok) {
      hooks.feedback.show(parsed.diagnostics);
      return;
    }
    const checkbox = root.querySelector<HTMLInputElement>('[data-relief="enabled"]');
    if (!checkbox) return parsed.value;
    const numeric = (key: string) =>
      Number(root.querySelector<HTMLInputElement>(`[data-relief="${key}"]`)?.value || NaN);
    const candidate = configurePumpRelief(parsed.value, id, {
      enabled: checkbox.checked,
      settingDifferentialPa: numeric('settingDifferentialPa'),
      maximumAreaM2: numeric('maximumAreaM2'),
      flowCoefficient: numeric('flowCoefficient'),
    });
    if (!candidate.ok) {
      hooks.feedback.show(candidate.diagnostics);
      return;
    }
    return candidate.value;
  }
  function applyProperties(root: HTMLElement = $('properties')): boolean {
    if (!hooks.canvas.editable) return false;
    const candidate = propertyCandidate(root);
    if (!candidate) return false;
    const metadataOnly = networkParameterRulesOnlyEdit(hooks.editor().document, candidate);
    const changed = hooks.mutate(candidate, !metadataOnly);
    if (changed) hooks.toast(metadataOnly ? '参数未改变；有效结果保持。' : '参数已应用；需重新初始化后运行。');
    if (changed) acceptedFields();
    return changed;
  }
  return {
    render: fieldsForSelected,
    applyFields: applyProperties,
    lockField: persistLock,
    cancelPipeEdit,
    closeDialog() {
      motorCurveDraft = undefined;
      propertyDocument = null;
      if (hooks.canvas.pendingPipe) cancelPipeEdit();
    },
    invalidate() {
      propertyDocument = null;
    },
  };
}
