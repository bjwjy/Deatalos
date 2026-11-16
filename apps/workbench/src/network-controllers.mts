import { planNetworkSequence, planNetworkProbe, type NetworkDraftSession } from '@hyd/application';
import {
  networkDefinition,
  networkValvePositions,
  networkProbeName,
  isLinearActuatorType,
  sequenceConditionText,
  type SequenceLeafCondition,
  type NetworkSequenceStep,
  type NetworkProject,
} from '@hyd/domain';
import type { NetworkRuntime } from './network-runtime-controller.mjs';
import { element as $, escapeHtml as esc } from './network-dom.mjs';
import { teachingDemoButton } from './network-teaching-demo.mjs';

interface Hooks {
  editor(): NetworkDraftSession;
  simulation: NetworkRuntime;
  apply(project: NetworkProject): boolean;
}
/** Form buffers only. Validation, persistence, history and execution belong to the application/session. */
export function createNetworkControllers(hooks: Hooks) {
  const dialog = (() => {
    const element = $('controllerDialog');
    if (!(element instanceof HTMLDialogElement)) throw new Error('Controller editor requires a dialog');
    return element;
  })();
  const form = $('controllerForm');
  const teaching = teachingDemoButton('teaching:dynamic-controller');
  let id = '',
    sessionId = '',
    physicalRevision = -1,
    saved = '',
    dirty = false;
  const number = (value: unknown, unit = '') =>
    `<input type="number" step="any" value="${esc(value)}" aria-label="${esc(unit)}">`;
  const select = (options: readonly { value: string; label: string }[], selected: string) =>
    `<select>${options.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  const choices = (items: readonly { id: string; label: string }[]) =>
    items.map((c) => ({ value: c.id, label: c.label }));
  const kinds = [
    { value: 'time', label: '本步时间 / s' },
    { value: 'position', label: '缸位置 / mm' },
    { value: 'probe-pressure', label: '压力表 / MPa' },
    { value: 'pressure-switch', label: '压力开关触点' },
    { value: 'pressure', label: '已有油口表压 / MPa' },
    { value: 'flow', label: '流量计／油口流量 / L/min' },
  ];
  function inputValue(root: ParentNode, name: string): string {
    const input = root.querySelector(`[data-field="${name}"] input, [data-field="${name}"] select`);
    return input instanceof HTMLInputElement || input instanceof HTMLSelectElement ? input.value : '';
  }
  function numeric(root: ParentNode, name: string): number | null {
    const v = inputValue(root, name).trim();
    return v && Number.isFinite(Number(v)) ? Number(v) : null;
  }
  const field = (key: string, content: string) => `<span data-field="${key}">${content}</span>`;
  function conditionRow(c?: SequenceLeafCondition): string {
    const kind = c?.kind ?? 'time',
      project = hooks.editor().document;
    if (c?.kind === 'pressure-switch') {
      const switches = project.design.components.filter((item) => item.typeId === 'adjustable-pressure-switch');
      return `<div class="controller-condition" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0">
        ${field('kind', select(kinds, kind))}
        ${field('source', select(choices(switches), c.componentId || switches[0]?.id || ''))}
        ${field(
          'contact',
          select(
            [
              { value: 'closed', label: '触点闭合' },
              { value: 'open', label: '触点断开' },
            ],
            c.contact,
          ),
        )}
        <label>连续满足 / s ${field('hold', number(c.holdS, '连续满足 s'))}</label>
        <button type="button" data-remove-condition>删除条件</button>
      </div>`;
    }
    if (c?.kind === 'probe-pressure')
      return `<div class="controller-condition" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0">${field('kind', select(kinds, c.kind))}${field(
        'source',
        select(
          (project.controlProbes ?? []).map((p) => ({ value: p.id, label: networkProbeName(project, p) })),
          c.probeId,
        ),
      )}${field(
        'comparison',
        select(
          [
            { value: 'gte', label: '≥' },
            { value: 'lte', label: '≤' },
          ],
          c.comparison,
        ),
      )}${field('value', number(c.thresholdPa / 1e6, '表压 MPa'))}<label>连续满足 / s ${field('hold', number(c.holdS, '连续满足 s'))}</label><button type="button" data-remove-condition>删除条件</button></div>`;
    const components =
      kind === 'position'
        ? project.design.components.filter((c) => isLinearActuatorType(c.typeId))
        : project.design.components
            .filter((c) =>
              networkDefinition(c.definition.id, c.definition.version)?.ports.some((p) => p.domain === 'hydraulic'),
            )
            .sort((a, b) => Number(b.typeId === 'flow-meter') - Number(a.typeId === 'flow-meter'));
    const componentId = (c && c.kind !== 'time' ? c.componentId : '') || components[0]?.id || '';
    const component = project.design.components.find((v) => v.id === componentId);
    const ports = component
      ? (networkDefinition(component.definition.id, component.definition.version)
          ?.ports.filter((p) => p.domain === 'hydraulic')
          .map((p) => ({ value: p.id, label: p.id })) ?? [])
      : [];
    return `<div class="controller-condition" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0">
      ${field('kind', select(kinds, kind))}
      ${
        kind === 'time'
          ? field('value', number(c?.kind === 'time' ? c.durationS : 1, '本步时间 s'))
          : `${field('source', select(choices(components), componentId))}${kind === 'pressure' || kind === 'flow' ? field('port', select(ports, c?.kind === 'pressure' || c?.kind === 'flow' ? c.portId : (ports[0]?.value ?? ''))) : ''}${field(
              'comparison',
              select(
                [
                  { value: 'gte', label: '≥' },
                  { value: 'lte', label: '≤' },
                ],
                c && c.kind !== 'time' ? c.comparison : 'gte',
              ),
            )}${field('value', number(c?.kind === 'position' ? c.thresholdM * 1000 : c?.kind === 'pressure' ? c.thresholdPa / 1e6 : c?.kind === 'flow' ? c.thresholdM3PerS * 60000 : '', kind === 'position' ? '位置 mm' : kind === 'flow' ? '有符号流量 L/min' : '表压 MPa'))}${kind === 'flow' ? '<span>流入油口为正；流量计A口表示A→B</span>' : ''}<label>连续满足 / s ${field('hold', number(c && c.kind !== 'time' ? c.holdS : 0.02, '连续满足 s'))}</label>`
      }
      <button type="button" data-remove-condition>删除条件</button></div>`;
  }
  const targetComponent = () =>
    hooks.editor().document.design.components.find((c) => c.id === inputValue(form, 'target'));
  const displacementTarget = () => {
    const c = targetComponent();
    return c && networkDefinition(c.definition.id, c.definition.version)?.control === 'displacement';
  };
  function commandField(command?: NetworkSequenceStep['commands'][number]): string {
    if (displacementTarget())
      return (
        '排量给定 / % ' +
        field('displacement', number(command?.kind === 'displacement' ? command.value * 100 : '', '排量给定 %'))
      );
    const valve = targetComponent();
    const positions = valve ? networkValvePositions(valve) : [];
    const names = { extend: '前进位', neutral: '中位', retract: '退回位' };
    return (
      '阀位 ' +
      field(
        'position',
        select(
          positions.map((p) => ({ value: p, label: names[p] })),
          command?.kind === 'position' ? command.positionId : (positions[0] ?? ''),
        ),
      )
    );
  }
  function actionRow(step?: NetworkSequenceStep): string {
    const condition = step?.until;
    const leaves =
      condition?.kind === 'all' || condition?.kind === 'any'
        ? condition.conditions
        : condition
          ? [condition]
          : [undefined];
    return `<fieldset class="controller-action" data-step-id="${esc(step?.id ?? crypto.randomUUID())}" style="margin:12px 0"><legend>动作</legend>
      <label>名称 ${field('name', `<input value="${esc(step?.name ?? '新动作')}" maxlength="80">`)}</label>
      <label data-command-field>${commandField(step?.commands[0])}</label>
      <label>等待超时 / s ${field('timeout', number(step?.timeoutS ?? 5, '等待超时 s'))}</label>
      <label>条件关系 ${field(
        'mode',
        select(
          [
            { value: 'all', label: '全部满足（且）' },
            { value: 'any', label: '任一满足（或）' },
          ],
          condition?.kind === 'any' ? 'any' : 'all',
        ),
      )}</label>
      <div class="controller-conditions">${leaves.map(conditionRow).join('')}</div>
      <button type="button" data-add-condition>添加条件</button> <button type="button" data-up-action>上移</button> <button type="button" data-down-action>下移</button> <button type="button" data-remove-action>删除动作</button>
    </fieldset>`;
  }
  function message(text: string): void {
    $('controllerMessage').textContent = text;
  }
  function open(componentId: string): void {
    const editor = hooks.editor(),
      component = editor.document.design.components.find((c) => c.id === componentId);
    if (!component || component.typeId !== 'dynamic-controller') return;
    id = componentId;
    sessionId = editor.documentSessionId;
    physicalRevision = editor.physicsRevision;
    saved = JSON.stringify(component.controller);
    dirty = !component.controller;
    $('controllerTitle').textContent = component.label;
    const targets = editor.document.design.components.filter((c) => {
      const control = networkDefinition(c.definition.id, c.definition.version)?.control;
      return control === 'position' || (control === 'displacement' && !c.motorDisplacementCurve?.enabled);
    });
    form.innerHTML = `<label>控制器名称 ${field('controllerName', `<input maxlength="60" value="${esc(component.label)}">`)}</label><label>控制目标 ${field('target', select([{ value: '', label: '请选择换向阀或变量泵／马达' }, ...choices(targets)], component.controller?.steps.flatMap((s) => s.commands)[0]?.componentId ?? ''))}</label> <label>循环次数（1～100） ${field('cycles', number(component.controller?.cycles ?? 1, '循环次数'))}</label><div id="controllerActions"></div><button type="button" id="addControllerAction">添加动作</button><p>保存配置后，关闭本窗口并使用顶部“运行”启动；暂停后再次点“运行”继续。</p>`;
    $('controllerActions').innerHTML = (component.controller?.steps ?? [undefined]).map(actionRow).join('');
    message(
      component.controller
        ? '配置已载入；顶部运行会执行所有已放置的控制器。'
        : '填写控制目标和动作后保存配置。默认时间仅为可编辑初稿。',
    );
    if (teaching && !teaching.isConnected) $('closeController').before(teaching);
    if (!dialog.open) dialog.showModal();
    render();
  }
  function leaf(row: Element): unknown {
    const kind = inputValue(row, 'kind'),
      value = numeric(row, 'value');
    if (kind === 'time') return { kind, durationS: value };
    if (kind === 'pressure-switch')
      return {
        kind,
        componentId: inputValue(row, 'source'),
        contact: inputValue(row, 'contact'),
        holdS: numeric(row, 'hold'),
      };
    if (kind === 'probe-pressure')
      return {
        kind,
        probeId: inputValue(row, 'source'),
        comparison: inputValue(row, 'comparison'),
        holdS: numeric(row, 'hold'),
        thresholdPa: value === null ? null : value * 1e6,
      };
    return {
      kind,
      componentId: inputValue(row, 'source'),
      comparison: inputValue(row, 'comparison'),
      holdS: numeric(row, 'hold'),
      ...(kind === 'position'
        ? { thresholdM: value === null ? null : value / 1000 }
        : kind === 'flow'
          ? { portId: inputValue(row, 'port'), thresholdM3PerS: value === null ? null : value / 60000 }
          : { portId: inputValue(row, 'port'), thresholdPa: value === null ? null : value * 1e6 }),
    };
  }
  async function save(): Promise<void> {
    const editor = hooks.editor(),
      revision = editor.revision,
      documentSession = editor.documentSessionId;
    const target = inputValue(form, 'target');
    const displacement = displacementTarget();
    const program = {
      version: 1,
      cycles: numeric(form, 'cycles'),
      steps: [...form.querySelectorAll('.controller-action')].map((row) => ({
        id: row.getAttribute('data-step-id'),
        name: inputValue(row, 'name'),
        commands: [
          displacement
            ? { componentId: target, kind: 'displacement', source: 'controller', value: percentFraction(row) }
            : { componentId: target, kind: 'position', positionId: inputValue(row, 'position') },
        ],
        until: {
          kind: inputValue(row, 'mode'),
          conditions: [...row.querySelectorAll('.controller-condition')].map(leaf),
        },
        timeoutS: numeric(row, 'timeout'),
      })),
    };
    const renamed = planNetworkProbe(editor.document, {
      kind: 'rename-controller',
      id,
      name: inputValue(form, 'controllerName'),
    });
    if (!renamed.ok) {
      message(renamed.diagnostics.map((d) => d.message).join('；'));
      return;
    }
    const plan = planNetworkSequence(renamed.value, id, program);
    if (!plan.ok) {
      message(plan.diagnostics.map((d) => d.message).join('；'));
      return;
    }
    await hooks.simulation.controllerAction('sequence-stop');
    if (editor !== hooks.editor() || editor.revision !== revision || documentSession !== sessionId || !dialog.open) {
      message('工程已改变，请重新双击控制器载入配置。');
      return;
    }
    // Save only after the old automatic writer has acknowledged stopping.
    if (['running', 'paused', 'failed'].includes(hooks.simulation.runtime?.sequence?.status ?? '')) {
      message('旧控制器尚未确认停止，保留当前输入，请重试停止。');
      return;
    }
    const previous = saved;
    saved = JSON.stringify(plan.value.design.components.find((c) => c.id === id)?.controller);
    if (!hooks.apply(plan.value)) {
      saved = previous;
      return;
    }
    dirty = false;
    message('配置已应用到工程；请保存工程文件。');
  }
  function percentFraction(row: Element): number | null {
    const percent = numeric(row, 'displacement');
    return percent === null ? null : percent / 100;
  }
  function render(): void {
    $('saveController').textContent = dirty ? '保存配置 *' : '保存配置';
    if (dialog.open) {
      const e = hooks.editor(),
        c = e.document.design.components.find((c) => c.id === id);
      if (
        e.documentSessionId !== sessionId ||
        e.physicsRevision !== physicalRevision ||
        !c ||
        JSON.stringify(c.controller) !== saved
      ) {
        dialog.close();
        return;
      }
      $('controllerTitle').textContent = c.label;
      for (const option of form.querySelectorAll('option')) {
        const probe = e.document.controlProbes?.find((p) => p.id === option.value);
        if (probe) option.textContent = networkProbeName(e.document, probe);
      }
    }
    const views = hooks.simulation.invalidated ? [] : (hooks.simulation.runtime?.controllers ?? []);
    const status = { running: '运行中', paused: '已暂停', completed: '已完成', stopped: '已停止', failed: '故障' };
    if (dialog.open) {
      const content =
        views
          .map((v) => {
            const owner = hooks.editor().document.design.components.find((c) => c.id === v.componentId),
              step = owner?.controller?.steps[v.stepIndex];
            return `<p><strong>${esc(owner?.label ?? v.label)} · ${status[v.status]}</strong> 第 ${v.cycle}/${v.cycles} 轮 · 动作 ${v.stepIndex + 1}：${esc(v.stepName)} · ${v.elapsedS.toFixed(2)} s<br>${esc(step ? sequenceConditionText(step.until, hooks.editor().document) : v.condition)}<br>${esc(v.message)}</p>`;
          })
          .join('') || '<p>控制器尚未启动。</p>';
      if ($('controllerRuntime').innerHTML !== content) $('controllerRuntime').innerHTML = content;
    }
    const summary = views
      .map((v) => `${v.label}：${status[v.status]}，${v.stepName} (${v.cycle}/${v.cycles})`)
      .join('；');
    if ($('controllerSummary').textContent !== summary) $('controllerSummary').textContent = summary;
  }
  function setup(): void {
    $('closeController').addEventListener('click', () => dialog.close());
    $('saveController').addEventListener('click', () => {
      void save();
    });
    $('stopControllers').addEventListener('click', () => {
      void hooks.simulation.controllerAction('sequence-stop');
    });
    form.addEventListener('input', () => {
      dirty = true;
    });
    form.addEventListener('change', (event) => {
      dirty = true;
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      if (target.closest('[data-field="target"]')) {
        for (const field of form.querySelectorAll('[data-command-field]')) field.innerHTML = commandField();
      }
      const row = target.closest('.controller-condition');
      if (row && target.closest('[data-field="kind"]')) {
        const kind = target.value;
        const holder = document.createElement('div');
        holder.innerHTML = conditionRow(
          kind === 'pressure-switch'
            ? { kind, componentId: '', contact: 'closed', holdS: 0.02 }
            : kind === 'probe-pressure'
              ? {
                  kind,
                  probeId: hooks.editor().document.controlProbes?.[0]?.id ?? '',
                  comparison: 'gte',
                  thresholdPa: 0,
                  holdS: 0.02,
                }
              : kind === 'position'
                ? { kind, componentId: '', comparison: 'gte', thresholdM: 0, holdS: 0.02 }
                : kind === 'flow'
                  ? { kind, componentId: '', portId: '', comparison: 'gte', thresholdM3PerS: 0, holdS: 0.02 }
                  : kind === 'pressure'
                    ? { kind, componentId: '', portId: '', comparison: 'gte', thresholdPa: 0, holdS: 0.02 }
                    : { kind: 'time', durationS: 1 },
        );
        const replacement = holder.firstElementChild;
        if (replacement) {
          const value = replacement.querySelector('[data-field="value"] input');
          if (kind !== 'time' && value instanceof HTMLInputElement) value.value = '';
          row.replaceWith(replacement);
        }
      }
      if (row && target.closest('[data-field="source"]')) {
        const c = hooks.editor().document.design.components.find((c) => c.id === target.value),
          port = row.querySelector('[data-field="port"]');
        if (port)
          port.innerHTML = select(
            networkDefinition(c?.definition.id ?? '', c?.definition.version ?? 0)
              ?.ports.filter((p) => p.domain === 'hydraulic')
              .map((p) => ({ value: p.id, label: p.id })) ?? [],
            '',
          );
      }
    });
    form.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const b = event.target.closest('button');
      if (!b) return;
      dirty = true;
      const row = b.closest('.controller-action');
      if (b.id === 'addControllerAction' && form.querySelectorAll('.controller-action').length < 50)
        $('controllerActions').insertAdjacentHTML('beforeend', actionRow());
      if (b.hasAttribute('data-remove-action')) row?.remove();
      if (b.hasAttribute('data-up-action') && row?.previousElementSibling)
        row.parentElement?.insertBefore(row, row.previousElementSibling);
      if (b.hasAttribute('data-down-action') && row?.nextElementSibling)
        row.parentElement?.insertBefore(row.nextElementSibling, row);
      if (b.hasAttribute('data-remove-condition')) b.closest('.controller-condition')?.remove();
      if (b.hasAttribute('data-add-condition') && row && row.querySelectorAll('.controller-condition').length < 8)
        row.querySelector('.controller-conditions')?.insertAdjacentHTML('beforeend', conditionRow());
    });
  }
  return { open, render, setup };
}
