import { networkDefinition, networkDisplacementCommandRange, type NetworkControl } from '@hyd/domain';
import { element } from './network-dom.mjs';
import { throttleAreaMm2, throttleAreaFromInput } from './network-throttle-area.mjs';
import { createThrottleRequests } from './network-throttle-requests.mjs';
import type { NetworkDraftSession } from '@hyd/application';
import type { NetworkRuntime } from './network-runtime-controller.mjs';
interface Hooks {
  editor(): NetworkDraftSession;
  simulation: NetworkRuntime;
  showCard(): void;
}
type Command = Extract<NetworkControl, { kind: 'opening-area' | 'displacement' }>;
const inCm3 = (value: number) => Number((value * 1e6).toPrecision(15));
const matches = (accepted: NetworkControl | null | undefined, command: Command): boolean =>
  command.kind === 'opening-area'
    ? accepted?.kind === 'opening-area' && accepted.areaM2 === command.areaM2
    : accepted?.kind === 'displacement' && accepted.source === command.source && accepted.value === command.value;
interface Row {
  componentId: string;
  node: HTMLDivElement;
  select: HTMLSelectElement;
  amount: HTMLInputElement;
  slider: HTMLInputElement;
  apply: HTMLButtonElement;
  caption: HTMLSpanElement;
  unit: HTMLElement;
  minimum: HTMLSpanElement;
  maximum: HTMLSpanElement;
  accepted: HTMLSpanElement;
  status: HTMLSpanElement;
  stop: HTMLButtonElement;
  draft: boolean;
}
/** Shared rows for current-run opening area and displacement. */
export function createNetworkInstanceControls(hooks: Hooks) {
  const root = element('instanceControls'),
    rowsHost = document.createElement('div');
  const add = document.createElement('button'),
    empty = document.createElement('p');
  add.type = 'button';
  add.className = 'throttle-add';
  add.textContent = '＋';
  add.setAttribute('aria-label', '添加手动控制行');
  add.dataset.throttleAdd = '';
  empty.className = 'muted';
  empty.textContent = '当前工程没有可在线调节的节流阀、变量泵或变量马达。';
  root.replaceChildren(add, rowsHost, empty);
  let rows: Row[] = [],
    owner = '',
    context = '',
    nextRow = 0,
    hadComponents = false;
  const available = () =>
    hooks
      .editor()
      .document.design.components.filter(
        (c) =>
          c.typeId !== 'manual-shutoff' &&
          (networkDefinition(c.definition.id, c.definition.version)?.control === 'opening-area' ||
            networkDisplacementCommandRange(c) !== null),
      );
  function current() {
    const state = hooks.simulation.runtime,
      editor = hooks.editor();
    if (
      state?.status !== 'ready' ||
      !state.identity ||
      !state.point ||
      hooks.simulation.invalidated ||
      state.identity.documentSessionId !== editor.documentSessionId ||
      state.identity.physicsRevision !== editor.physicsRevision
    )
      return null;
    return { identity: state.identity, point: state.point };
  }
  function controllerTargets(): ReadonlySet<string> {
    const active = new Set(
      hooks.simulation.runtime?.controllers
        ?.filter((view) => view.status === 'running' || view.status === 'paused')
        .map((view) => view.componentId),
    );
    return new Set(
      hooks
        .editor()
        .document.design.components.flatMap((c) =>
          active.has(c.id)
            ? (c.controller?.steps.flatMap((step) =>
                step.commands.flatMap((cmd) => (cmd.kind === 'displacement' ? [cmd.componentId] : [])),
              ) ?? [])
            : [],
        ),
    );
  }
  const requests = createThrottleRequests<Command>({
    identity: () => current()?.identity ?? null,
    send: (command, target) => hooks.simulation.applyControl([command], target),
    settled(command, result) {
      const row = rows.find((row) => row.componentId === command.componentId);
      if (!row) return;
      const accepted = result.ok
        ? result.value.appliedControls.find((c) => c.componentId === command.componentId)
        : null;
      const confirmed = matches(accepted, command);
      row.draft = !confirmed;
      row.status.textContent = confirmed ? '已应用' : '未确认，请查看诊断后重试。';
      render();
    },
  });
  function submit(row: Row) {
    if (hooks.simulation.runtime?.flowRegulators?.some((r) => r.componentId === row.componentId)) return;
    const component = available().find((c) => c.id === row.componentId);
    const state = current();
    if (!component || !state) {
      row.status.textContent = '请先运行初始化。';
      return;
    }
    const range = networkDisplacementCommandRange(component);
    const accepted = state.point.appliedControls.find((c) => c.componentId === row.componentId);
    let command: Command;
    if (range) {
      if (controllerTargets().has(row.componentId)) return;
      const amount = row.amount.valueAsNumber,
        min = inCm3(range.min),
        max = inCm3(range.max);
      if (!Number.isFinite(amount) || amount < min || amount > max) {
        row.status.textContent = `排量须在 ${min}～${max} cm³/rev 之间。`;
        return;
      }
      const value = amount === min ? range.min : amount === max ? range.max : amount / 1e6;
      command = { componentId: row.componentId, kind: 'displacement', source: 'manual', value };
    } else {
      const maximum = component.parameters.hydraulic?.maximumAreaM2;
      if (maximum === undefined) return;
      const parsed = throttleAreaFromInput(row.amount.value, maximum);
      if (!parsed.ok) {
        row.status.textContent = parsed.diagnostics.map((d) => d.message).join('；');
        return;
      }
      command = { componentId: row.componentId, kind: 'opening-area', areaM2: parsed.value };
    }
    row.slider.value = row.amount.value;
    if (!requests.hasPending(row.componentId) && matches(accepted, command)) {
      row.draft = false;
      row.status.textContent = command.kind === 'opening-area' ? '当前已是该开口' : '当前已是该排量';
      return;
    }
    row.status.textContent = '正在提交…';
    requests.request(command);
  }
  function makeRow(componentId: string): Row {
    const node = document.createElement('div'),
      top = document.createElement('div'),
      field = document.createElement('label');
    const select = document.createElement('select'),
      amount = document.createElement('input'),
      slider = document.createElement('input');
    const apply = document.createElement('button'),
      remove = document.createElement('button');
    const accepted = document.createElement('span'),
      status = document.createElement('span'),
      bottom = document.createElement('div');
    node.className = 'throttle-row c2-throttle-row';
    node.dataset.throttleRow = String(++nextRow);
    top.className = 'throttle-choice c2-throttle-object';
    select.setAttribute('aria-label', '选择控制元件 ' + nextRow);
    select.dataset.throttleSelect = '';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '移除控制行 ' + nextRow);
    remove.dataset.throttleRemove = '';
    top.append(select, remove);
    field.className = 'throttle-precise c2-throttle-input';
    const caption = document.createElement('span');
    caption.textContent = '开口面积';
    field.append(caption);
    amount.type = 'number';
    amount.min = '0';
    amount.step = 'any';
    amount.setAttribute('aria-label', '开口面积 mm²');
    const unit = document.createElement('small');
    unit.textContent = 'mm²';
    apply.type = 'button';
    apply.className = 'c1-apply';
    apply.textContent = '应用';
    apply.dataset.throttleApply = '';
    field.append(amount, unit, apply);
    slider.type = 'range';
    slider.className = 'c2-slider';
    slider.min = '0';
    slider.step = 'any';
    slider.setAttribute('aria-label', '连续调节开口面积 mm²');
    bottom.className = 'throttle-feedback c2-slider-labels';
    accepted.className = 'throttle-accepted sr-only';
    accepted.dataset.throttleConfirmed = '';
    status.setAttribute('role', 'status');
    const minimum = document.createElement('span'),
      maximum = document.createElement('span');
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'c1-link';
    stop.textContent = '停止自动控制组';
    stop.hidden = true;
    stop.addEventListener('click', () => {
      void hooks.simulation.controllerAction('sequence-stop');
    });
    bottom.append(minimum, status, maximum);
    node.append(top, field, slider, bottom, accepted, stop);
    rowsHost.append(node);
    const row: Row = {
      componentId,
      node,
      select,
      amount,
      slider,
      apply,
      caption,
      unit,
      minimum,
      maximum,
      accepted,
      status,
      stop,
      draft: false,
    };
    amount.addEventListener('input', () => {
      // A numeric draft supersedes earlier slider intent, including its late UI receipt.
      requests.cancel(row.componentId);
      row.draft = true;
      status.textContent = '';
    });
    amount.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        submit(row);
      }
    });
    apply.addEventListener('click', () => submit(row));
    for (const event of ['input', 'change'])
      slider.addEventListener(event, () => {
        row.draft = true;
        amount.value = slider.value;
        submit(row);
      });
    select.addEventListener('change', () => {
      if (rows.some((other) => other !== row && other.componentId === select.value)) {
        render();
        return;
      }
      requests.cancel(row.componentId);
      row.componentId = select.value;
      row.draft = false;
      status.textContent = '';
      render();
    });
    remove.addEventListener('click', () => {
      requests.cancel(row.componentId);
      rows = rows.filter((other) => other !== row);
      node.remove();
      render();
    });
    return row;
  }
  add.addEventListener('click', () => {
    const spare = available().find((c) => !rows.some((row) => row.componentId === c.id));
    if (spare) open(spare.id);
  });
  function open(id: string) {
    if (!available().some((c) => c.id === id)) return;
    render();
    const row = rows.find((row) => row.componentId === id) ?? makeRow(id);
    if (!rows.includes(row)) rows.push(row);
    hooks.showCard();
    render();
    row.node.scrollIntoView({ block: 'nearest' });
    (row.amount.disabled ? row.select : row.amount).focus({ preventScroll: true });
  }
  function render() {
    const editor = hooks.editor(),
      state = current(),
      components = available();
    if (owner !== editor.documentSessionId) {
      requests.clear();
      rows.forEach((row) => row.node.remove());
      rows = [];
      owner = editor.documentSessionId;
      hadComponents = false;
    }
    rows = rows.filter((row) => {
      if (components.some((c) => c.id === row.componentId)) return true;
      requests.cancel(row.componentId);
      row.node.remove();
      return false;
    });
    if (!hadComponents && components[0] && !rows.length) rows.push(makeRow(components[0].id));
    hadComponents = components.length > 0;
    const key = state
      ? `${state.identity.documentSessionId}/${state.identity.physicsRevision}/${state.identity.simulationSessionId}`
      : '';
    if (context !== key) {
      requests.clear();
      rows.forEach((row) => {
        row.draft = false;
        row.status.textContent = '';
      });
      context = key;
    }
    empty.hidden = components.length > 0;
    add.disabled = rows.length >= components.length;
    const controlled = state ? controllerTargets() : new Set<string>();
    for (const row of rows) {
      const choices = components.filter((c) => !rows.some((other) => other !== row && other.componentId === c.id));
      const stamp = JSON.stringify(choices.map((c) => [c.id, c.label]));
      if (row.select.dataset.choices !== stamp) {
        row.select.replaceChildren(
          ...choices.map((c) => {
            const option = document.createElement('option');
            option.value = c.id;
            option.textContent = c.label;
            return option;
          }),
        );
        row.select.dataset.choices = stamp;
      }
      row.select.value = row.componentId;
      const component = components.find((c) => c.id === row.componentId);
      const range = component && networkDisplacementCommandRange(component);
      const areaMaximum = component?.parameters.hydraulic?.maximumAreaM2;
      const maximum = range ? inCm3(range.max) : areaMaximum === undefined ? undefined : throttleAreaMm2(areaMaximum);
      row.select.title = component?.label ?? '';
      const accepted = state?.point.appliedControls.find((c) => c.componentId === row.componentId);
      const displacement =
        range &&
        state?.point.readings.find(
          (r) =>
            r.location.kind === 'component' &&
            r.location.componentId === row.componentId &&
            r.quantity === 'displacement',
        );
      const amount =
        displacement && displacement.value.kind === 'known'
          ? inCm3(displacement.value.value)
          : accepted?.kind === 'opening-area'
            ? throttleAreaMm2(accepted.areaM2)
            : undefined;
      const known = amount !== undefined && maximum !== undefined;
      const regulator =
        state && hooks.simulation.runtime?.flowRegulators?.find((r) => r.componentId === row.componentId);
      const locked = controlled.has(row.componentId);
      row.node.dataset.controlKind = range ? 'displacement' : 'opening-area';
      row.amount.dataset.throttle = row.componentId;
      row.slider.dataset.throttleSlider = row.componentId;
      row.node.dataset.throttleTarget = row.componentId;
      row.accepted.dataset.throttleConfirmed = row.componentId;
      row.amount.disabled = !known || !!regulator || locked;
      row.apply.disabled = row.amount.disabled;
      row.slider.disabled = row.amount.disabled || maximum === 0;
      row.slider.hidden = !known;
      row.stop.hidden = !locked;
      row.caption.textContent = range ? '排量' : '开口面积';
      row.unit.textContent = range ? 'cm³/rev' : 'mm²';
      row.amount.setAttribute('aria-label', `${row.caption.textContent} ${row.unit.textContent}`);
      row.slider.setAttribute('aria-label', `连续调节${row.caption.textContent} ${row.unit.textContent}`);
      row.amount.min = row.slider.min = String(range ? inCm3(range.min) : 0);
      row.minimum.textContent = range ? `${row.amount.min}` : '关闭';
      row.maximum.textContent = range ? `${maximum}` : '全开';
      if (maximum !== undefined) {
        row.amount.max = String(maximum);
        row.slider.max = row.amount.max;
      }
      row.accepted.classList.toggle('sr-only', !range);
      const given =
        accepted?.kind === 'displacement' && accepted.source === 'controller'
          ? `控制器 ${Number((accepted.value * 100).toPrecision(12))}% · `
          : '';
      row.accepted.textContent = amount === undefined ? '' : `${given}当前 ${amount} ${row.unit.textContent}`;
      const autoHint = '目标流量模式；双击元件切换';
      const controlHint = '由动态控制器给定';
      if (regulator || locked) {
        requests.cancel(row.componentId);
        row.draft = false;
        row.status.textContent = regulator ? autoHint : controlHint;
      } else if (!known) row.status.textContent = '未初始化';
      else if (['未初始化', autoHint, controlHint].includes(row.status.textContent ?? '')) row.status.textContent = '';
      if (!row.draft) {
        row.amount.value = amount === undefined ? '' : String(amount);
        if (known) row.slider.value = row.amount.value;
      }
    }
  }
  return { render, open };
}
