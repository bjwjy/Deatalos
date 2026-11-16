import {
  networkNativeSteps,
  networkStepCapability,
  readNetworkStepPreference,
  networkStepRunKey,
  type NetworkSnapshot,
  type NetworkProject,
} from '@hyd/domain';

import { valueReasonDisplay, networkObjectDisplayName, type DisplayDiagnostic } from '@hyd/domain';
import { displayNetworkQuantity } from '@hyd/engineering';

import { element as $, escapeHtml as esc } from './network-dom.mjs';
import type { NetworkDraftSession, NetworkExportCapture } from '@hyd/application';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { NetworkRuntime } from './network-runtime-controller.mjs';
interface ResultHooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  simulation: NetworkRuntime;
  failed(): boolean;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
}
export function createNetworkResults(hooks: ResultHooks) {
  let recordsStamp = '';
  let displayed:
    { capture: NetworkExportCapture | null; document: NetworkProject; scope: string; selection: string } | undefined;
  let stepDisplay:
    | {
        document: NetworkProject;
        run: string | undefined;
        actual: number | null | undefined;
        history: NetworkExportCapture | null;
      }
    | undefined;
  function text(id: string, value: string): void {
    const node = $(id);
    if (node.textContent !== value) node.textContent = value;
  }
  function visiblePoint(): NetworkSnapshot | null {
    if (
      hooks.simulation.runtime?.status !== 'ready' ||
      hooks.simulation.runtime.identity?.documentSessionId !== hooks.editor().documentSessionId ||
      hooks.simulation.runtime.identity.physicsRevision !== hooks.editor().physicsRevision
    )
      return null;
    return hooks.simulation.capture?.selection === 'history'
      ? hooks.simulation.capture.view.point
      : hooks.simulation.runtime.point;
  }
  function renderRecords() {
    const stamp = JSON.stringify([
      hooks.simulation.runtime?.historicalRuns?.map((h) => h.last?.identity),
      hooks.simulation.runtime?.running,
      hooks.simulation.capture?.snapshotId,
      hooks.editor().documentSessionId,
      hooks.editor().physicsRevision,
    ]);
    if (recordsStamp === stamp) return;
    recordsStamp = stamp;
    const select = $('exportHistory') as HTMLSelectElement;
    const previous = select.value || 'current';
    const runs =
      hooks.simulation.runtime?.identity?.documentSessionId === hooks.editor().documentSessionId &&
      hooks.simulation.runtime.identity.physicsRevision === hooks.editor().physicsRevision
        ? (hooks.simulation.runtime.historicalRuns ?? [])
        : [];
    select.innerHTML =
      '<option value="current">当前运行</option>' +
      runs
        .map((h, i) =>
          h.last
            ? `<option value="${esc(h.last.identity.simulationSessionId)}">历史运行 ${i + 1} · 第 ${h.last.identity.tick} 步 · ${h.record.count} 样本</option>`
            : '',
        )
        .join('');
    select.value = [...select.options].some((o) => o.value === previous) ? previous : 'current';
  }
  function renderResults() {
    const point = visiblePoint(),
      candidate = hooks.simulation.capture;
    const capture =
      point &&
      candidate &&
      candidate.view.point.identity.documentSessionId === hooks.editor().documentSessionId &&
      candidate.view.point.identity.physicsRevision === hooks.editor().physicsRevision &&
      (candidate.selection === 'history' ||
        candidate.view.point.identity.simulationSessionId === hooks.simulation.runtime?.identity?.simulationSessionId)
        ? candidate
        : null;
    const valid = capture?.view.point ?? null;
    const current =
      hooks.simulation.runtime?.identity?.documentSessionId === hooks.editor().documentSessionId &&
      hooks.simulation.runtime.identity.physicsRevision === hooks.editor().physicsRevision;
    const tick = current ? String(hooks.simulation.runtime!.identity!.tick) : '';
    if ($('clock').dataset.tick !== tick) $('clock').dataset.tick = tick;
    text(
      'clock',
      current
        ? `计算步 ${hooks.simulation.runtime!.identity!.tick} · ${hooks.simulation.runtime!.identity!.timeS.toFixed(2)} s`
        : '未初始化',
    );
    const document = hooks.editor().document,
      scope = ($('resultScope') as HTMLSelectElement).value,
      selection = hooks.canvas.selections,
      chosen = selection.length === 1 ? selection[0] : null,
      selectionKey = chosen ? chosen.kind + ':' + chosen.id : String(selection.length);
    // A frozen capture is shared by data/curve/export. Live ticks update the
    // clock, not the same table and its user's expanded details every 100ms.
    if (
      displayed?.capture === capture &&
      displayed.document === document &&
      displayed.scope === scope &&
      displayed.selection === selectionKey
    )
      return;
    displayed = { capture, document, scope, selection: selectionKey };
    text('resultHeading', capture?.selection === 'history' ? '元件数据 · 历史捕获' : '元件数据 · 当前捕获');
    text(
      'identity',
      valid
        ? `工程会话 ${valid.identity.documentSessionId} · 物理修订 ${valid.identity.physicsRevision} · 仿真会话 ${valid.identity.simulationSessionId} · 控制 ${valid.identity.controlSequence} · Hopsan ${valid.solver.version} · 瞬态初始化，未认证稳态`
        : '没有属于当前修订的有效结果',
    );
    if (!valid) {
      $('results').dataset.simulationSessionId = '';
      $('results').dataset.tick = '';
      $('results').dataset.timeS = '';
      $('results').innerHTML = '<p class="muted">无有效捕获。请运行或读取 / 刷新曲线；失败或缺失量不会补零。</p>';
      return;
    }
    if (!capture) return;
    const all = scope === 'all';
    const quantities = capture.view.quantities.filter(
      (q) => all || (chosen?.kind === q.objectKind && chosen.id === q.objectId),
    );
    $('results').dataset.simulationSessionId = valid.identity.simulationSessionId;
    $('results').dataset.tick = String(valid.identity.tick);
    $('results').dataset.timeS = String(valid.identity.timeS);
    if (!all && !chosen) {
      $('results').textContent =
        selection.length > 1
          ? '已选多项；请单选一个对象查看数据，或切换全图数据。'
          : '点击一个元件查看数据；也可选择节点、管路或切换全图数据。';
      return;
    }
    const rows = quantities
      .map((q) => {
        const d = displayNetworkQuantity(q),
          value =
            d.value.kind === 'known'
              ? `${d.value.value.toPrecision(6)} ${d.unit}`
              : `${d.value.kind === 'unknown' ? '未知' : '不适用'}：${valueReasonDisplay(d.value.reason)}`;
        const isPortFlow = q.objectKind === 'component' && q.field.endsWith('.flow');
        const isLineFlow = q.objectKind === 'connection' && q.field === 'flow';
        let direction = '';
        if (d.value.kind === 'known' && (isPortFlow || isLineFlow)) {
          const flow = d.value.value;
          if (flow === 0) direction = '无流动';
          else if (isPortFlow) direction = flow > 0 ? '流入油口' : '流出油口';
          else direction = flow > 0 ? '起点 → 终点' : '终点 → 起点';
        }
        return `<tr data-result-object-kind="${q.objectKind}" data-result-object-id="${esc(q.objectId)}" data-result-field="${esc(q.field)}"><td>${esc(networkObjectDisplayName(hooks.editor().document, q.objectKind, q.objectId))} · ${esc(q.label)}<br><small>${q.source === 'kernel' ? '有效内核读数' : '同源派生计算'}</small></td><td>${esc(value)}${direction ? `<br><small>${esc(direction)}</small>` : ''}</td></tr>`;
      })
      .join('');
    const assumptions = capture.view.assumptions.map((v) => `<li>${esc(v)}</li>`).join('');
    $('results').innerHTML =
      `<p class="muted" id="resultSnapshotStamp">${capture.selection === 'history' ? '历史' : '当前捕获'} · ${valid.identity.timeS.toFixed(6)} s · 第 ${valid.identity.tick} 步。与曲线共用此捕获；读取 / 刷新取得新值，画布当前运行仍实时更新。</p>${!quantities.length ? '<p class="muted">此对象在当前捕获中没有可用量值；不补零。</p>' : ''}<table class="metric-table"><thead><tr><th>对象、量值与来源</th><th>同源值</th></tr></thead><tbody>${rows}</tbody></table><details><summary>来源、公式假设与模型</summary><ul class="muted">${assumptions}</ul><p class="muted">逐帧量来自有效内核快照，原始技术字段和公式可在导出文件中核对。模型版本及未知原因见下方技术详情。</p><details><summary>模型标识与未知原因（可复制）</summary><pre>${esc(
        JSON.stringify(
          {
            models: hooks
              .editor()
              .document.design.components.filter((c) => all || (chosen?.kind === 'component' && chosen.id === c.id))
              .map((c) => ({ id: c.id, definition: c.definition, model: c.model })),
            unavailable: quantities.filter((q) => q.value.kind !== 'known'),
          },
          null,
          2,
        ),
      )}</pre></details></details>`;
  }
  function renderStepOptions(): void {
    const document = hooks.editor().document,
      runtime = hooks.simulation.runtime,
      actual =
        runtime?.identity?.documentSessionId === hooks.editor().documentSessionId &&
        runtime.identity.physicsRevision === hooks.editor().physicsRevision
          ? runtime.clock?.nativeStepS
          : null,
      run = runtime?.identity?.simulationSessionId,
      history = hooks.simulation.capture?.selection === 'history' ? hooks.simulation.capture : null;
    if (
      stepDisplay?.document === document &&
      stepDisplay.run === run &&
      stepDisplay.actual === actual &&
      stepDisplay.history === history
    )
      return;
    stepDisplay = { document, run, actual, history };
    const select = $('nativeStep') as HTMLSelectElement,
      capability = networkStepCapability(hooks.editor().document.design.components);
    const choices = capability.allowedSteps,
      automatic = capability.automaticStepS,
      preference = readNetworkStepPreference(hooks.editor().document);
    if (!select.dataset.stepsBuilt) {
      select.innerHTML =
        '<option value="auto">自动</option>' +
        networkNativeSteps.map((step) => `<option value="${step}">${step * 1e6} μs</option>`).join('');
      select.dataset.stepsBuilt = 'true';
    }
    let invalid = select.querySelector<HTMLOptionElement>('option[value="invalid"]');
    if (!preference.ok && !invalid) {
      invalid = globalThis.document.createElement('option');
      invalid.value = 'invalid';
      invalid.disabled = true;
      invalid.textContent = '配置无效，请明确选择';
      select.append(invalid);
    }
    if (preference.ok) invalid?.remove();
    select.value = preference.ok
      ? preference.value.mode === 'auto'
        ? 'auto'
        : String(preference.value.manualStepS)
      : 'invalid';
    for (const option of [...select.options]) {
      option.disabled = option.value !== 'auto' && !choices.some((step) => step === Number(option.value));
      if (option.value === 'auto') option.textContent = `自动（${automatic * 1e6} μs）`;
    }
    const desired = preference.ok
      ? preference.value.mode === 'auto'
        ? automatic
        : preference.value.manualStepS
      : null;
    const applicable = desired !== null && choices.some((step) => step === desired);
    const historyStep =
      hooks.simulation.capture?.selection === 'history' ? hooks.simulation.capture.view.point.clock.nativeStepS : null;
    $('stepSummary').textContent = actual ? `步长：${actual * 1e6} μs` : '步长：未初始化';
    $('stepStatus').textContent =
      `${actual ? `当前运行实际 ${actual * 1e6} μs；` : '尚无当前运行；'}${historyStep ? `所选历史实际 ${historyStep * 1e6} μs；` : ''}下次初始化：${desired === null ? '配置无效' : `${preference.ok && preference.value.mode === 'auto' ? '自动' : '手动'} ${desired * 1e6} μs${applicable ? '' : '（不适用，需明确改选）'}`}。修改选择不会改变当前运行；选择“自动”恢复自动。`;
    $('stepBasisText').textContent =
      `允许：${choices.map((step) => step * 1e6 + ' μs').join('、')}。${capability.reason}规则${capability.policyVersion}/${capability.ruleId}；模型集${capability.modelSetVersion}。步长允许不代表完整图或旧模型已可计算。当前运行配置：${actual ? JSON.stringify(hooks.simulation.runtime?.document?.extensions?.[networkStepRunKey] ?? '未记录选择模式') : '无'}。${historyStep ? `历史配置：${JSON.stringify(hooks.simulation.capture?.view.document.extensions[networkStepRunKey] ?? '未记录选择模式')}` : ''}`;
  }
  return { visiblePoint, renderRecords, renderResults, renderStepOptions };
}
