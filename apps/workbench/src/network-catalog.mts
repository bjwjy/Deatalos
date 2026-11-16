import {
  previewNetworkCatalog,
  type NetworkCatalogPreview,
  type NetworkDraftSession,
  type NetworkGoalPreview,
} from '@hyd/application';
import { componentDisplayName, networkProbeName } from '@hyd/domain';
import type { NetworkDutyReportRequest } from '@hyd/engineering';
import { escapeHtml as esc } from './network-dom.mjs';
interface CatalogHooks {
  editor(): NetworkDraftSession;
  readDuty(): NetworkDutyReportRequest;
  source(): string;
  selectedGoal(): { readonly preview: NetworkGoalPreview; readonly index: number } | null;
  exportCalculation(): void;
  exportCatalog(preview: NetworkCatalogPreview): void;
  uid(prefix: string): string;
}
/** Form buffers only. The application owns calculations, locks and frozen exports. */
export function createNetworkCatalog(root: HTMLElement, hooks: CatalogHooks) {
  let preview: NetworkCatalogPreview | null = null;
  root.className = 'catalog-tools';
  root.innerHTML =
    '<h3>选型与导出</h3><p data-catalog-source></p><div data-catalog-components></div><label>导出内容<select data-catalog-kind><option value="catalog">选型检索任务书</option><option value="calculation">计算书</option></select></label><details class="catalog-settings"><summary>产品检索设置</summary><div class="calculation-condition-grid"><label>采购地区<input data-catalog-region value="中国" maxlength="80"></label><label>油液<select data-catalog-fluid><option value="unconfirmed">尚未确认</option><option value="mineral">矿物液压油</option><option value="HFA">HFA水基介质</option></select></label><label>产品检索偏好<select data-catalog-custom><option value="standard-only">优先标准目录产品</option><option value="allow-custom">允许询问定制</option></select></label><label>本次目标泵的规格备选数<select data-catalog-limit><option selected>1</option><option>2</option></select></label></div></details><p data-catalog-status role="status"></p><div data-catalog-result></div><div class="calculation-main-actions"><button type="button" data-catalog-preview class="primary">导出</button><button type="button" data-catalog-word hidden disabled>导出已生成资料</button></div>';

  function node(selector: string): HTMLElement {
    const e = root.querySelector<HTMLElement>(selector);
    if (!e) throw new Error('Catalog view element missing: ' + selector);
    return e;
  }
  const text = (selector: string) => {
    const e = node(selector);
    return e instanceof HTMLInputElement || e instanceof HTMLSelectElement ? e.value : '';
  };
  function invalidate(message = '') {
    preview = null;
    node('[data-catalog-word]').setAttribute('disabled', '');
    node('[data-catalog-result]').textContent = '';
    node('[data-catalog-status]').textContent = message;
  }
  node('[data-catalog-preview]').addEventListener('click', () => {
    invalidate();
    if (text('[data-catalog-kind]') === 'calculation') {
      hooks.exportCalculation();
      return;
    }
    const result = previewNetworkCatalog(
      hooks.editor(),
      {
        ...hooks.readDuty(),
        region: text('[data-catalog-region]'),
        fluid: text('[data-catalog-fluid]'),
        customization: text('[data-catalog-custom]'),
        limit: Number(text('[data-catalog-limit]')),
      },
      { snapshotId: hooks.uid('selection'), capturedAt: new Date().toISOString() },
      hooks.selectedGoal() ?? undefined,
    );
    if (!result.ok) {
      node('[data-catalog-status]').textContent = result.diagnostics.map((d) => d.message).join('；');
      return;
    }
    preview = result.value;
    const p = preview.plan;
    const returnOnly = p.duty?.phases.every((phase) => phase.springReturn !== undefined);
    node('[data-catalog-status]').textContent = p.coverage.complete
      ? returnOnly
        ? '本次只有弹簧回程，任务书保留回程和元件条件。'
        : `已准备 ${p.candidates.length} 个泵规格备选，其他元件条件列在任务书中。`
      : `可导出 ${p.targets.length} 个元件或测点的参数与待核项。工况尚未完整核算，泵规格待复核。`;
    node('[data-catalog-result]').innerHTML =
      '<table class="metric-table"><thead><tr><th>检索目标</th><th>排量 cm³/rev</th><th>公称压力目标 MPa</th><th>估计流量 L/min</th></tr></thead><tbody>' +
      p.candidates
        .map(
          (c) =>
            `<tr><td>${esc(c.code)}</td><td>${(c.displacementM3PerRev * 1e6).toPrecision(5)}</td><td>${c.nominalPressurePa / 1e6}</td><td>${(c.estimatedFlowM3PerS * 60000).toPrecision(5)}</td></tr>`,
        )
        .join('') +
      '</tbody></table>' +
      (p.coverage.complete && !returnOnly && !p.candidates.length
        ? '<p>无已验证的标准目标。两种任务书仍可交接原始需求与待查项。</p>'
        : '') +
      '<details><summary>选型核查提示</summary>' +
      p.rejected
        .slice(0, 3)
        .map((c) => `<p>${esc(c.code)}：${esc(c.reasons.join('；'))}</p>`)
        .join('') +
      '<ul>' +
      p.missing.map((s) => '<li>' + esc(s) + '</li>').join('') +
      '</ul></details>';
    node('[data-catalog-word]').removeAttribute('disabled');
    hooks.exportCatalog(preview);
  });
  node('[data-catalog-word]').addEventListener('click', () => {
    if (preview) hooks.exportCatalog(preview);
  });
  function refreshSource(): void {
    node('[data-catalog-source]').textContent = '资料来源 · ' + hooks.source();
    const selected = hooks.selectedGoal();
    const project = selected?.preview.plan.alternatives[selected.index]?.document ?? hooks.editor().document;
    node('[data-catalog-components]').innerHTML =
      '<div class="catalog-component-list">' +
      project.design.components
        .map((item) => '<span>' + esc(item.label || componentDisplayName(item.typeId, item.definition.id)) + '</span>')
        .join('') +
      (project.controlProbes ?? [])
        .map((probe) => '<span>' + esc(networkProbeName(project, probe)) + '</span>')
        .join('') +
      '</div>';
  }
  root.addEventListener('calculation:catalog', refreshSource);
  return {
    invalidate,
    reset() {
      invalidate();
      const region = node('[data-catalog-region]');
      if (region instanceof HTMLInputElement) region.value = '中国';
      for (const [selector, value] of [
        ['[data-catalog-fluid]', 'unconfirmed'],
        ['[data-catalog-custom]', 'standard-only'],
        ['[data-catalog-limit]', '1'],
      ]) {
        if (!selector || !value) continue;
        const e = node(selector);
        if (e instanceof HTMLSelectElement) e.value = value;
      }
    },
  };
}
