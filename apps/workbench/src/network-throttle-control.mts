import type { NetworkDraftSession, NetworkFlowRegulatorView } from '@hyd/application';
import type { NetworkSnapshot, NetworkIdentity, Result } from '@hyd/domain';
import { throttleAreaMm2, throttleAreaFromInput } from './network-throttle-area.mjs';
interface Hooks {
  editor(): NetworkDraftSession;
  point(): NetworkSnapshot | null;
  regulators(): readonly NetworkFlowRegulatorView[];
  send(changes: unknown[], target: NetworkIdentity): Promise<Result<NetworkSnapshot>>;
}
/** Current-run control stays local to the selected throttle, using the existing control service. */
export function createNetworkThrottleControl(hooks: Hooks) {
  const dialog = document.createElement('dialog');
  dialog.id = 'throttleControl';
  dialog.setAttribute('aria-labelledby', 'throttleControlTitle');
  dialog.innerHTML =
    '<div class="dialog-head"><h2 id="throttleControlTitle">节流阀运行控制</h2><button id="throttleControlClose" aria-label="关闭节流阀控制">×</button></div><div class="dialog-body"><p id="throttleControlName"></p><label>控制模式<select id="throttleControlMode"><option value="manual">手动开口</option><option value="target-flow">目标流量闭环</option></select></label><label id="throttleControlAreaField">开口面积 mm²<input id="throttleControlArea" type="number" min="0" step="any"></label><label id="throttleControlFlowField" hidden>目标流量 L/min<input id="throttleControlFlow" type="number" step="any" min="-600000" max="600000"></label><p id="throttleControlFeedback" role="status"></p><p class="muted">目标以 A→B 为正；闭环受实际压差和最大开口限制。仅用于当前运行，复位后回到手动。</p><p id="throttleControlStatus" role="status"></p><button id="throttleControlApply">应用到当前运行</button></div>';
  const shutoffField = document.createElement('label');
  shutoffField.hidden = true;
  shutoffField.innerHTML =
    '截止阀状态<select id="throttleControlShutoff"><option value="closed">关闭</option><option value="open">全开</option></select>';
  dialog.querySelector('#throttleControlAreaField')?.after(shutoffField);
  document.body.append(dialog);
  const area = dialog.querySelector('#throttleControlArea'),
    mode = dialog.querySelector('#throttleControlMode'),
    flow = dialog.querySelector('#throttleControlFlow'),
    feedback = dialog.querySelector('#throttleControlFeedback'),
    shutoff = shutoffField.querySelector('select'),
    apply = dialog.querySelector('#throttleControlApply'),
    status = dialog.querySelector('#throttleControlStatus'),
    name = dialog.querySelector('#throttleControlName');
  if (
    !(area instanceof HTMLInputElement) ||
    !(flow instanceof HTMLInputElement) ||
    !(mode instanceof HTMLSelectElement) ||
    !(feedback instanceof HTMLElement) ||
    !shutoff ||
    !(apply instanceof HTMLButtonElement) ||
    !(status instanceof HTMLElement) ||
    !(name instanceof HTMLElement)
  )
    throw new Error('Throttle controls missing');
  let target: {
    owner: NetworkDraftSession;
    revision: number;
    run: string;
    identity: NetworkIdentity;
    id: string;
    maximum: number;
    binary: boolean;
  } | null = null;
  const renderMode = () => {
    const binary = target?.binary === true;
    shutoffField.hidden = !binary;
    mode.parentElement?.toggleAttribute('hidden', binary);
    dialog.querySelector('#throttleControlAreaField')?.toggleAttribute('hidden', binary || mode.value !== 'manual');
    dialog
      .querySelector('#throttleControlFlowField')
      ?.toggleAttribute('hidden', binary || mode.value !== 'target-flow');
    dialog.querySelector('.muted')?.toggleAttribute('hidden', binary);
  };
  mode.addEventListener('change', () => {
    if (mode.value === 'manual' && target) {
      const applied = hooks.point()?.appliedControls.find((c) => c.componentId === target?.id);
      if (applied?.kind === 'opening-area') area.value = String(throttleAreaMm2(applied.areaM2));
    }
    renderMode();
  });
  const current = () =>
    target &&
    target.owner === hooks.editor() &&
    target.revision === hooks.editor().physicsRevision &&
    target.run === hooks.point()?.identity.simulationSessionId;
  let generation = 0;
  const close = () => {
    generation++;
    target = null;
    dialog.close();
  };
  dialog.querySelector('#throttleControlClose')?.addEventListener('click', close);
  dialog.addEventListener('cancel', () => {
    generation++;
    target = null;
  });
  apply.addEventListener('click', () => {
    if (!target || !current()) return;
    const parsed = target.binary
      ? { ok: true as const, value: shutoff.value === 'open' ? target.maximum : 0 }
      : throttleAreaFromInput(area.value, target.maximum);
    const targetFlow = flow.value.trim() === '' ? NaN : Number(flow.value) / 60000;
    if (mode.value === 'target-flow' && (!Number.isFinite(targetFlow) || Math.abs(targetFlow) > 10)) {
      status.textContent = '请填写有限目标流量，范围 ±600000 L/min。';
      return;
    }
    if (mode.value === 'manual' && !parsed.ok) {
      status.textContent = parsed.diagnostics.map((d) => d.message).join('；');
      return;
    }
    const ticket = ++generation;
    const command =
      mode.value === 'target-flow'
        ? { componentId: target.id, kind: 'target-flow', targetM3PerS: targetFlow }
        : parsed.ok
          ? { componentId: target.id, kind: 'opening-area', areaM2: parsed.value }
          : null;
    if (!command) return;
    apply.disabled = true;
    status.textContent = '正在提交当前运行控制…';
    void hooks
      .send([command], hooks.point()?.identity ?? target.identity)
      .then((result) => {
        if (ticket === generation && current())
          status.textContent = result.ok
            ? '已应用到当前运行。'
            : (result.diagnostics.find((d) => d.code === 'PRESSURE_CONTROL_BLOCKED')?.message ??
              '控制未确认，请查看诊断。');
      })
      .catch((cause: unknown) => {
        if (ticket === generation && current()) status.textContent = '控制提交失败：' + String(cause).slice(0, 120);
      })
      .finally(() => {
        if (ticket === generation) apply.disabled = false;
      });
  });
  const renderFeedback = () => {
    if (target) {
      const regulator = hooks.regulators().find((r) => r.componentId === target?.id);
      const labels = {
        regulating: '正在调节',
        reached: '已达到目标',
        saturated: '已达最大开口，流量不足',
        'pressure-unavailable': '压差不足或流向相反',
        'measurement-unavailable': '反馈不可用，停止调整',
      };
      const control = hooks.point()?.appliedControls.find((c) => c.componentId === target?.id);
      const opening = control?.kind === 'opening-area' ? control.areaM2 : null;
      feedback.textContent = target.binary
        ? '当前：' + (opening === null ? '—' : opening === 0 ? '关闭' : '全开')
        : (regulator
            ? labels[regulator.status] +
              ' · 实测 ' +
              (regulator.actualM3PerS === null ? '—' : (regulator.actualM3PerS * 60000).toFixed(2)) +
              ' L/min · '
            : '手动开口 · ') + (opening === null ? '—' : throttleAreaMm2(opening).toFixed(3) + ' mm²');
    }
  };
  return {
    open(id: string) {
      const owner = hooks.editor(),
        point = hooks.point(),
        component = owner.document.design.components.find((c) => c.id === id),
        control = point?.appliedControls.find((c) => c.componentId === id);
      const maximum = component?.parameters.hydraulic?.maximumAreaM2;
      if (!component || !point || control?.kind !== 'opening-area' || maximum === undefined) return;
      generation++;
      apply.disabled = false;
      target = {
        owner,
        revision: owner.physicsRevision,
        run: point.identity.simulationSessionId,
        identity: point.identity,
        id,
        maximum,
        binary: component.typeId === 'manual-shutoff',
      };
      name.textContent = component.label;
      const title = dialog.querySelector('#throttleControlTitle');
      if (title) title.textContent = target.binary ? '手动截止阀运行控制' : '节流阀运行控制';
      shutoff.value = control.areaM2 === 0 ? 'closed' : 'open';
      area.value = String(throttleAreaMm2(control.areaM2));
      area.max = String(throttleAreaMm2(maximum));
      const regulator = hooks.regulators().find((r) => r.componentId === id);
      mode.value = regulator ? 'target-flow' : 'manual';
      const option = mode.querySelector('option[value="target-flow"]');
      if (option instanceof HTMLOptionElement) option.disabled = component.typeId !== 'throttle';
      flow.value = String((regulator?.targetM3PerS ?? 0) * 60000);
      renderMode();
      status.textContent = '';
      renderFeedback();
      if (!dialog.open) dialog.showModal();
    },
    invalidateIfChanged() {
      if (dialog.open && !current()) close();
      if (dialog.open) renderFeedback();
    },
  };
}
