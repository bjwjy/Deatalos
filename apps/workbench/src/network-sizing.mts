import { bindEngineeringInputs } from './network-engineering-inputs.mjs';
import {
  previewNetworkSizing,
  exportCalculationCsv,
  type NetworkDraftSession,
  type NetworkSizingPreview,
  type NetworkDutyPreview,
  type NetworkGoalCandidatePreview,
  type NetworkCatalogPreview,
  type ExportArtifact,
} from '@hyd/application';
import type { CalculationRecord } from '@hyd/engineering';
import { engineeringValueText, networkDefinition, fromSI, toSI, type DisplayDiagnostic } from '@hyd/domain';
import { element, escapeHtml as esc } from './network-dom.mjs';
import { createNetworkDuty } from './network-duty.mjs';
import {
  seedCalculationInput,
  calculationUnitAttributes,
  calculationInputNumber,
  markCalculationOverride,
  showCalculationIssues,
  calculationAdvice,
  pumpSpeedSeed,
  sourcePressureSeed,
  type FormIssue,
} from './network-calculation-form.mjs';
interface SizingHooks {
  exportCatalog(preview: NetworkCatalogPreview): void;
  exportWord(record: CalculationRecord): void;
  editor(): NetworkDraftSession;
  apply(preview: NetworkSizingPreview): boolean;
  applyDuty(preview: NetworkDutyPreview): boolean;
  applyGoal(preview: NetworkGoalCandidatePreview, index: number): boolean;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
  exportArtifact(artifact: ExportArtifact): Promise<boolean>;
  uid(prefix: string): string;
}
const fields = [
  ['force', '目标伸出总负载', 'kN'],
  ['speed', '目标伸出速度', 'mm/s'],
  ['pressure', '设计压力预算', 'MPa'],
  ['stroke', '行程', 'mm'],
  ['rpm', '泵转速', 'r/min'],
  ['etaV', '初选容积效率', '0～1'],
  ['etaTotal', '初选总效率', '0～1'],
] as const;
function input(id: string): HTMLInputElement {
  const value = element('sizing-' + id);
  if (!(value instanceof HTMLInputElement)) throw new Error('Sizing input missing: ' + id);
  return value;
}
function select(id: string): HTMLSelectElement {
  const value = element(id);
  if (!(value instanceof HTMLSelectElement)) throw new Error('Sizing selector missing: ' + id);
  return value;
}
export function createNetworkSizing(hooks: SizingHooks) {
  const root = element('sizingForm');
  let previous: NetworkDraftSession['document'] | null = null,
    sessionId = '',
    preview: NetworkSizingPreview | null = null;
  root.innerHTML = `<label>计算项目<select id="sizingMode"><option value="existing">按现有回路核算需求（缸 / 马达）</option><option value="resize">单缸伸出尺寸初选</option></select></label><div id="basicDutyForm"></div><div id="sizingResize" hidden><p class="muted">只有此项目需要液压缸。已有行程/泵转速可带入；目标力、速度及效率仍需确认，预览不改工程。</p><label>目标液压缸<select id="sizingCylinder"></select></label><label>可选应用泵<select id="sizingPump"></select></label>${fields.map(([id, label, unit]) => '<label class="calculation-field"><span><span data-engineering-label>' + label + '</span> <small>' + unit + '</small></span><input ' + calculationUnitAttributes(unit) + ' id="sizing-' + id + '" data-sizing-field="' + id + '" type="number" step="any" aria-label="' + label + '"><small data-field-source>本次要求，请明确填写</small></label>').join('')}<details><summary>本尺寸初选的固定假设</summary><p>供油余量1 MPa、背压0.5 MPa、缸机械效率0.95、杆/缸径比0.6及离散教学规格；不是原生模型的实际效率。缩回/共源多工况请使用需求核算。</p></details><button id="previewSizing">预览尺寸初选与过程</button><button id="cancelSizing" disabled>取消预览</button><button id="applySizing" disabled>应用到所选对象</button><button id="exportSizing" disabled>导出初选与过程 CSV</button><button id="wordSizing" disabled>导出计算书…</button><div id="sizingStatus" role="status"></div><div id="sizingPreview"></div></div>`;
  bindEngineeringInputs(element('sizingResize'));
  const existing = createNetworkDuty(
    { ...hooks, apply: hooks.applyDuty },
    { rootId: 'basicDutyForm', prefix: 'basic', mode: 'single' },
  );
  function invalidate(message = '') {
    preview = null;
    for (const id of ['applySizing', 'cancelSizing', 'exportSizing', 'wordSizing'])
      element(id).setAttribute('disabled', '');
    element('sizingPreview').textContent = '';
    element('sizingStatus').textContent = message;
  }
  function seed(): void {
    const project = hooks.editor().document,
      c = project.design.components.find((c) => c.id === select('sizingCylinder').value && c.typeId === 'cylinder'),
      stroke = c?.parameters.geometry?.strokeM;
    seedCalculationInput(
      input('stroke'),
      stroke === undefined ? undefined : fromSI('length', stroke),
      c ? c.label + ' 的保存行程' : '未指定目标缸',
    );
    seedCalculationInput(input('rpm'), pumpSpeedSeed(project, select('sizingPump').value), '所选泵的保存转速');
    const pressure = sourcePressureSeed(project);
    seedCalculationInput(input('pressure'), pressure.value, pressure.source);
  }
  root.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-sizing-field'))
      markCalculationOverride(event.target);
    invalidate('输入已改变，请重新预览；工程未改变。');
  });
  root.addEventListener('change', (event) => {
    invalidate('目标或条件已改变，请重新预览。');
    if (event.target === select('sizingMode')) {
      const resize = select('sizingMode').value === 'resize';
      element('sizingResize').hidden = !resize;
      element('basicDutyForm').hidden = resize;
      existing.invalidate('计算项目已切换，请重新预览。');
    }
    if (event.target === select('sizingCylinder')) {
      delete input('stroke').dataset.edited;
      seed();
    }
    if (event.target === select('sizingPump')) {
      delete input('rpm').dataset.edited;
      seed();
    }
  });
  element('previewSizing').addEventListener('click', () => {
    invalidate();
    const issues: FormIssue[] = [];
    if (!select('sizingCylinder').value)
      issues.push({
        control: select('sizingCylinder'),
        message: '尺寸初选：请选择明确目标液压缸；马达请使用按现有回路核算。',
      });
    for (const [id, label] of fields) {
      const field = input(id);
      if (!field.value.trim() || !Number.isFinite(field.valueAsNumber))
        issues.push({ control: field, message: '尺寸初选 / ' + label + '：缺输入，请填写有限数值。' });
    }
    if (issues.length) {
      showCalculationIssues(element('sizingResize'), element('sizingStatus'), issues);
      return;
    }
    for (const field of root.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
    const value = (id: string) => calculationInputNumber(input(id));
    const result = previewNetworkSizing(hooks.editor(), {
      cylinderId: select('sizingCylinder').value,
      pumpId: select('sizingPump').value || null,
      requirements: {
        forceN: toSI('force', value('force')),
        speedMPerS: toSI('linearSpeed', value('speed')),
        pressureBudgetPa: toSI('pressure', value('pressure')),
        strokeM: toSI('length', value('stroke')),
        pumpAngularSpeedRadPerS: toSI('angularSpeed', value('rpm')),
        volumetricEfficiency: value('etaV'),
        totalEfficiency: value('etaTotal'),
      },
    });
    if (!result.ok) {
      hooks.diagnostics(result.diagnostics);
      element('sizingStatus').textContent = calculationAdvice(result.diagnostics);
      const mapping: Readonly<Record<string, string>> = {
        forceN: 'force',
        speedMPerS: 'speed',
        pressureBudgetPa: 'pressure',
        strokeM: 'stroke',
        pumpAngularSpeedRadPerS: 'rpm',
        volumetricEfficiency: 'etaV',
        totalEfficiency: 'etaTotal',
      };
      const key = result.diagnostics[0]?.field?.split('/').at(-1),
        field = key ? mapping[key] : undefined;
      if (field) {
        input(field).setAttribute('aria-invalid', 'true');
        input(field).focus();
      }
      return;
    }
    preview = result.value;
    const document = hooks.editor().document;
    const formatChange = (componentId: string, path: string, value: number) => {
      const component = document.design.components.find((item) => item.id === componentId);
      const [group, key] = path.split('.');
      const unit =
        component &&
        group &&
        networkDefinition(component.definition.id, component.definition.version)?.groups[group]?.find(
          (spec) => spec.key === key,
        )?.unit;
      return unit ? engineeringValueText(value, unit, key) : String(value);
    };
    const plan = preview.plan;
    element('sizingPreview').innerHTML =
      `<h3>${esc(plan.record.title)}</h3><p>工程修订 ${preview.revision}；以下均为初选，不是仿真。</p><table class="metric-table"><tr><th>指定参数</th><th>原值 → 候选值</th></tr>${plan.changes.map((change) => '<tr><td>' + esc(change.componentId + '.' + change.parameter) + '</td><td>' + esc(formatChange(change.componentId, change.parameter, change.before)) + ' → ' + esc(formatChange(change.componentId, change.parameter, change.after)) + '</td></tr>').join('')}</table>${plan.record.steps.map((step) => '<details><summary>' + esc(step.label) + '：' + (step.display.value.kind === 'known' ? step.display.value.value.toPrecision(7) : '未知') + ' ' + esc(step.display.unit) + '</summary><p>' + esc(step.formula) + '</p><p>' + esc(step.substitution) + '</p><p>' + esc(step.display.conversion) + '</p></details>').join('')}<details><summary>范围与假设</summary>${plan.record.assumptions.map((text) => '<p>' + esc(text) + '</p>').join('')}</details>`;
    element('sizingPreview').scrollIntoView({ block: 'start' });
    for (const id of ['applySizing', 'cancelSizing', 'exportSizing', 'wordSizing'])
      element(id).removeAttribute('disabled');
    element('sizingStatus').textContent = '预览完成；应用只修改上列指定参数，不会自动设置外载、压力源或溢流阀。';
  });
  element('cancelSizing').addEventListener('click', () => invalidate('已取消预览，工程与结果保留。'));
  element('applySizing').addEventListener('click', () => {
    if (preview && hooks.apply(preview)) invalidate('已应用；可一次撤销，需重新初始化。');
  });
  element('wordSizing').addEventListener('click', () => {
    if (preview) hooks.exportWord(preview.plan.record);
  });
  element('exportSizing').addEventListener('click', () => {
    if (!preview) return;
    const artifact = exportCalculationCsv(preview.plan.record, hooks.uid('sizing'), new Date().toISOString());
    if (artifact.ok) void hooks.exportArtifact(artifact.value);
    else hooks.diagnostics(artifact.diagnostics);
  });
  return {
    invalidate() {
      invalidate('窗口已关闭，预览已取消；工程保留。');
      existing.invalidate('窗口已关闭，预览已取消。');
    },
    render() {
      existing.render();
      const current = hooks.editor();
      if (previous === current.document) return;
      previous = current.document;
      invalidate('请确认本次要求并预览。');
      if (sessionId !== current.documentSessionId) {
        sessionId = current.documentSessionId;
        for (const [id] of fields) {
          input(id).value = '';
          delete input(id).dataset.edited;
        }
      }
      for (const [id, type] of [
        ['sizingCylinder', 'cylinder'],
        ['sizingPump', 'pump'],
      ] as const) {
        const control = select(id),
          old = control.value,
          candidates = current.document.design.components.filter((c) => c.typeId === type);
        control.innerHTML =
          '<option value="">' +
          (type === 'pump' ? '不应用泵参数' : '请选择目标液压缸') +
          '</option>' +
          candidates.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>').join('');
        if (candidates.some((c) => c.id === old)) control.value = old;
        else if (candidates.length === 1 && candidates[0]) control.value = candidates[0].id;
      }
      seed();
    },
  };
}
