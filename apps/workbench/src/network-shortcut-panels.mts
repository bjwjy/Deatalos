import { networkObjectDisplayName, valueReasonDisplay } from '@hyd/domain';
import { displayNetworkQuantity } from '@hyd/engineering';
import type { NetworkDraftSession } from '@hyd/application';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { NetworkRuntime } from './network-runtime-controller.mjs';
import { element, escapeHtml as esc } from './network-dom.mjs';

interface Hooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  simulation: NetworkRuntime;
  refresh(): Promise<unknown>;
  notify(message: string): void;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}
/** Compact views consume the existing capture and calculation form; they own no calculations or history. */
export function createNetworkShortcutPanels(hooks: Hooks) {
  const data = element('shortcutResults'),
    sizing = element('shortcutSizing');
  const dataChoices = document.createElement('details');
  dataChoices.className = 'shortcut-field-picker';
  element('resultData').append(dataChoices);
  const readoutChoices = new Map<string, string[]>();
  let readoutKey = '';
  const run = document.createElement('div');
  run.id = 'shortcutControllerProgress';
  element('runStatusPanel').append(run);
  const task = document.createElement('select');
  task.id = 'shortcutCalculationTask';
  task.className = 'c2-task';
  task.setAttribute('aria-label', '已配置核算任务');
  const basicFields = document.createElement('div'),
    basicSummary = document.createElement('dl'),
    basicStatus = document.createElement('span');
  basicFields.className = 'shortcut-basic-fields';
  basicSummary.className = 'c2-readouts c2-demand-results';
  basicStatus.id = 'shortcutCalculationStatus';
  basicStatus.setAttribute('role', 'status');
  const basicActions = document.createElement('footer');
  basicActions.className = 'c2-calculation-actions';
  const calculate = button('核算', () => {
    element('basicPreview').click();
    renderBasicSummary();
  });
  calculate.className = 'c1-apply';
  calculate.dataset.shortcutCalculate = '';
  const select = button('自动选配', () => element('basicSelect').click());
  select.className = 'c1-link';
  select.hidden = true;
  basicActions.append(basicStatus, select, calculate);
  sizing.append(task, basicFields, basicSummary, basicActions);
  let lastData = '',
    lastRun = '',
    selectedTask = '';
  let mirrors: { source: HTMLInputElement; view: HTMLInputElement }[] = [];
  function renderBasicSummary(): void {
    const result = element('basicResult');
    const table = result.querySelector('table');
    const row = table?.querySelector('tbody tr');
    const values = row ? [...row.querySelectorAll('td')] : [];
    basicSummary.innerHTML =
      '<div><dt>需求压力</dt><dd><span></span><small>MPa</small></dd></div><div><dt>需求流量</dt><dd><span></span><small>L/min</small></dd></div><div><dt>轴功率估计</dt><dd><span></span><small>kW</small></dd></div>';
    const output = [...basicSummary.querySelectorAll('dd span')];
    if (output[0]) output[0].textContent = values[1]?.textContent ?? '—';
    if (output[1]) output[1].textContent = values[2]?.textContent ?? '—';
    if (output[2]) output[2].textContent = values[3]?.textContent ?? '—';
    const message = element('basicStatus').textContent ?? '';
    basicStatus.textContent = table
      ? result.dataset.satisfied === 'true'
        ? '已核算'
        : '有供油缺口'
      : message.includes('请选择') || message.includes('请填写')
        ? '请补齐条件'
        : message.includes('超过') || message.includes('不支持')
          ? '未通过核算'
          : '尚未核算';
    basicStatus.title = message;
    basicSummary.dataset.valid = String(!!table);
    select.hidden = !table;
  }
  function taskOptions() {
    return [...element('basicPhases').querySelectorAll<HTMLElement>('[data-duty-action]')].flatMap((action) => {
      const direction = action.querySelector<HTMLSelectElement>('[data-duty-direction]');
      const active = action.querySelector<HTMLInputElement>('[data-duty-active]');
      if (!direction || !active) return [];
      return [...direction.options].map((option) => ({
        action,
        direction,
        active,
        value: option.value,
        key: (action.dataset.dutyAction ?? '') + ':' + option.value,
        label:
          (action.dataset.actionLabel ?? '执行器') +
          ' · ' +
          (hooks.editor().document.design.components.find((component) => component.id === action.dataset.dutyAction)
            ?.typeId === 'cylinder'
            ? option.value === 'forward'
              ? '前进'
              : '后退'
            : option.value === 'forward'
              ? '正转'
              : '反转'),
      }));
    });
  }
  function renderBasicFields(): void {
    const source = element('basicDutyForm');
    const options = taskOptions();
    const markup =
      '<option value="">' +
      (options.length ? '请选择执行器与动作' : '暂无执行器') +
      '</option>' +
      options.map((option) => '<option value="' + esc(option.key) + '">' + esc(option.label) + '</option>').join('');
    if (task.innerHTML !== markup) task.innerHTML = markup;
    if (
      !options.some(
        (option) => option.key === selectedTask && option.active.checked && option.direction.value === option.value,
      )
    )
      selectedTask =
        options.find((option) => option.active.checked && option.direction.value === option.value)?.key ?? '';
    task.value = selectedTask;
    const action = options.find((option) => option.key === selectedTask)?.action;
    const inputs = ['speed', 'load'].flatMap((key) => {
      const input = action?.querySelector<HTMLInputElement>('[data-duty-field="' + key + '"]');
      return input ? [input] : [];
    });
    if (inputs.length !== mirrors.length || inputs.some((input, index) => mirrors[index]?.source !== input)) {
      mirrors = [];
      basicFields.replaceChildren();
      for (const [index, input] of inputs.entries()) {
        const row = document.createElement('div'),
          label = document.createElement('label'),
          copy = document.createElement('input'),
          unit = document.createElement('small');
        row.className = 'c2-input-line';
        copy.type = 'number';
        copy.step = 'any';
        copy.id = 'shortcut-basic-' + index;
        label.htmlFor = copy.id;
        label.textContent = input.dataset.fieldLabel ?? '需求';
        unit.textContent = input.closest('label')?.querySelector('small')?.textContent ?? '';
        copy.setAttribute('aria-label', '快捷核算 ' + label.textContent + ' ' + unit.textContent);
        for (const key of ['min', 'max']) {
          const value = input.getAttribute(key);
          if (value !== null) copy.setAttribute(key, value);
        }
        copy.addEventListener('input', () => {
          if (!source.contains(input)) return;
          input.value = copy.value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          renderBasicSummary();
        });
        copy.addEventListener('change', () => input.dispatchEvent(new Event('change', { bubbles: true })));
        row.append(label, copy, unit);
        basicFields.append(row);
        mirrors.push({ source: input, view: copy });
      }
    }
    for (const { source, view } of mirrors) if (document.activeElement !== view) view.value = source.value;
    calculate.disabled = inputs.length === 0;
    renderBasicSummary();
  }
  task.addEventListener('change', () => {
    const options = taskOptions();
    const chosen = options.find((option) => option.key === task.value);
    if (chosen) {
      for (const active of new Set(options.map((option) => option.active))) {
        const checked = active === chosen.active;
        if (active.checked !== checked) {
          active.checked = checked;
          active.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (chosen.direction.value !== chosen.value) {
        chosen.direction.value = chosen.value;
        chosen.direction.dispatchEvent(new Event('change', { bubbles: true }));
      }
      selectedTask = chosen.key;
    }
    renderBasicFields();
  });
  function renderData(): void {
    const editor = hooks.editor(),
      capture = hooks.simulation.capture,
      runtime = hooks.simulation.runtime;
    const chosen = hooks.canvas.selections.length === 1 ? hooks.canvas.selections[0] : undefined;
    const valid =
      capture &&
      runtime?.status === 'ready' &&
      !hooks.simulation.invalidated &&
      capture.view.point.identity.documentSessionId === editor.documentSessionId &&
      capture.view.point.identity.physicsRevision === editor.physicsRevision &&
      (capture.selection === 'history' ||
        capture.view.point.identity.simulationSessionId === runtime?.identity?.simulationSessionId)
        ? capture
        : null;
    const stamp = JSON.stringify([chosen, valid?.snapshotId, editor.documentSessionId, editor.physicsRevision]);
    if (stamp === lastData) return;
    lastData = stamp;
    const available = chosen
      ? (valid?.view.quantities.filter((q) => q.objectKind === chosen.kind && q.objectId === chosen.id) ?? [])
      : [];
    const component =
      chosen?.kind === 'component' ? editor.document.design.components.find((c) => c.id === chosen.id) : undefined;
    readoutKey = component ? component.definition.id + ':' + component.definition.version : (chosen?.kind ?? '');
    const preferred: Readonly<Record<string, readonly string[]>> = {
      cylinder: ['position', 'velocity', 'A.pressure'],
      motor: ['angularVelocity', 'idealHydraulicTorque', 'A.pressure'],
      pump: ['P.flow', 'P.pressure'],
    };
    if (available.length && !readoutChoices.has(readoutKey)) {
      const defaults = (preferred[component?.typeId ?? ''] ?? []).filter((field) =>
        available.some((q) => q.field === field),
      );
      let fields = defaults.length
        ? defaults
        : available.slice(0, chosen?.kind === 'connection' ? 4 : 3).map((q) => q.field);
      try {
        const saved = localStorage.getItem('hydraulic-shortcut-readouts-v1:' + readoutKey);
        if (saved !== null) {
          const raw: unknown = JSON.parse(saved);
          if (
            Array.isArray(raw) &&
            raw.length <= available.length &&
            raw.every((field) => typeof field === 'string' && available.some((q) => q.field === field))
          )
            fields = raw.filter((field): field is string => typeof field === 'string');
        }
      } catch {
        hooks.notify('无法读取卡片数据字段偏好，已使用常用读数。');
      }
      readoutChoices.set(readoutKey, fields);
    }
    const quantities = (readoutChoices.get(readoutKey) ?? []).flatMap((field) => {
      const value = available.find((q) => q.field === field);
      return value ? [value] : [];
    });
    dataChoices.hidden = !chosen;
    dataChoices.innerHTML =
      '<summary>高级：卡片显示项</summary><div class="shortcut-field-options">' +
      available
        .map(
          (q) =>
            '<label><input type="checkbox" data-shortcut-readout="' +
            esc(q.field) +
            '" ' +
            (readoutChoices.get(readoutKey)?.includes(q.field) ? 'checked' : '') +
            '>' +
            esc(q.label) +
            '</label>',
        )
        .join('') +
      '</div>' +
      (available.length ? '' : '<p class="muted">取得有效捕获后可选择显示项。</p>');
    const name = chosen ? networkObjectDisplayName(editor.document, chosen.kind, chosen.id) : '';
    const title = element('statusPanels').querySelector<HTMLElement>('[data-status-panel="results"] .c1-move');
    if (title) {
      title.textContent = '运行数据' + (name ? ' · ' + name : '');
      title.title = title.textContent;
    }
    data.innerHTML = `<div class="c2-readout-toolbar"><span>${valid ? `${valid.selection === 'history' ? '历史捕获' : '当前捕获'} · ${valid.view.point.identity.timeS.toPrecision(5)} s` : ''}</span><button type="button" class="c1-link" data-shortcut-refresh>刷新</button></div><dl class="c2-readouts">${
      quantities
        .map((q) => {
          const display = displayNetworkQuantity(q);
          const value =
            display.value.kind === 'known'
              ? display.value.value.toPrecision(5)
              : (display.value.kind === 'unknown' ? '未知' : '不适用') +
                '：' +
                valueReasonDisplay(display.value.reason);
          return `<div><dt>${esc(q.label)}</dt><dd><span>${esc(value)}</span><small>${esc(display.unit)}</small></dd></div>`;
        })
        .join('') || `<p class="c1-empty">${chosen ? '暂无可显示的运行量' : '选择元件或管路'}</p>`
    }</dl>`;
    data.dataset.snapshotId = valid?.snapshotId ?? '';
    data.dataset.objectId = chosen?.id ?? '';
    data
      .querySelector('[data-shortcut-refresh]')
      ?.addEventListener('click', () => element('refreshCurvePreview').click());
  }
  function render(): void {
    renderData();
    renderBasicFields();
    const runtime = hooks.simulation.runtime,
      editor = hooks.editor();
    const views =
      !hooks.simulation.invalidated &&
      runtime?.identity?.documentSessionId === editor.documentSessionId &&
      runtime.identity.physicsRevision === editor.physicsRevision
        ? (runtime.controllers ?? [])
        : [];
    const configured = editor.document.design.components.filter((c) => c.controller);
    const phase =
      runtime?.status === 'ready' && !hooks.simulation.invalidated
        ? runtime.running
          ? 'running'
          : views.length > 0 && views.every((v) => v.status === 'completed')
            ? 'completed'
            : 'paused'
        : 'empty';
    const phaseLabel = { running: '运行中', paused: '已暂停', completed: '已完成', empty: '未初始化' }[phase];
    if (run.dataset.phase !== phase) run.dataset.phase = phase;
    if (run.dataset.phaseLabel !== phaseLabel) run.dataset.phaseLabel = phaseLabel;
    const phaseNode = document.getElementById('shortcutRunPhase');
    if (phaseNode) {
      if (phaseNode.textContent !== phaseLabel) phaseNode.textContent = phaseLabel;
      if (phaseNode.dataset.phase !== phase) phaseNode.dataset.phase = phase;
    }
    const runStamp = JSON.stringify([
      configured.map((component) => [
        component.id,
        component.label,
        component.controller?.cycles,
        component.controller?.steps.length,
      ]),
      views.map((view) => [view.componentId, view.status, view.cycle, view.cycles, view.stepName, view.stepIndex]),
      phase,
    ]);
    if (runStamp !== lastRun) {
      lastRun = runStamp;
      const names = { running: '运行中', paused: '已暂停', completed: '已完成', stopped: '已停止', failed: '故障' };
      run.innerHTML =
        configured
          .map((component) => {
            const config = component.controller;
            if (!config) return '';
            const view = views.find((v) => v.componentId === component.id);
            return `<div class="c1-controller"><div class="c1-controller-line"><strong>${esc(component.label)}</strong><span>${view ? names[view.status] : '未启动'}（${view ? view.cycle : '—'} / ${view ? view.cycles : config.cycles}）</span></div><div class="c1-controller-line"><span>${esc(view?.stepName ?? '等待启动')}</span><span>动作 ${view ? view.stepIndex + 1 : '—'} / ${config.steps.length}</span></div></div>`;
          })
          .join('') || '<p class="c1-empty">暂无动态控制器</p>';
      element('controllerSummary').hidden = true;
    }
  }
  new MutationObserver(renderBasicSummary).observe(element('basicResult'), { childList: true, subtree: true });
  dataChoices.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.dataset.shortcutReadout) return;
    const fields = [...dataChoices.querySelectorAll<HTMLInputElement>('[data-shortcut-readout]:checked')].flatMap(
      (input) => (input.dataset.shortcutReadout ? [input.dataset.shortcutReadout] : []),
    );
    readoutChoices.set(readoutKey, fields);
    try {
      localStorage.setItem('hydraulic-shortcut-readouts-v1:' + readoutKey, JSON.stringify(fields));
    } catch {
      hooks.notify('卡片显示已调整，但本机偏好无法保存。');
    }
    lastData = '';
    renderData();
  });
  for (const event of ['input', 'change'])
    element('basicDutyForm').addEventListener(event, () => {
      for (const { source, view } of mirrors) if (document.activeElement !== view) view.value = source.value;
      renderBasicSummary();
    });
  return { render };
}
