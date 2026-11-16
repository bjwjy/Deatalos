import {
  previewNetworkDuty,
  previewNetworkGoal,
  prepareNetworkDutyCalculation,
  prepareIndependentDutyCalculation,
  prepareCombinedDutyCalculation,
  dutyGroupSections,
  dutyCombinedSections,
  dutyFlowSplitSections,
  dutyCoverageSections,
  exportCalculationCsv,
  type NetworkDraftSession,
  type NetworkDutyPreview,
  type NetworkGoalCandidatePreview,
  type NetworkCatalogPreview,
  type ExportArtifact,
} from '@hyd/application';
import {
  fromSI,
  isLinearActuatorType,
  isNetworkActuatorType,
  toSI,
  positionDisplayName,
  networkValvePositions,
  type DisplayDiagnostic,
  type NetworkComponent,
  type Quantity,
} from '@hyd/domain';
import type { CalculationRecord } from '@hyd/engineering';
import {
  checkNetworkDuty,
  independentDutyGroups,
  isCombinedSupplyCandidate,
  isDutySupplyDemand,
  parallelFlowTargets,
  returnTreeLimits,
  networkDutyAutomaticDefaults,
  dutyControlValveTypes,
  hasControlDrain,
  dutyMultiPortValveTypes,
  dutyLogicValveTypes,
  dutyDividerTypes,
  dutyProtectionTypes,
  networkGoalSupplySatisfied,
  type DutyAutomaticNumber,
  type DutyPendingPhase,
  type DutyPhase,
  type DutySupplyGroup,
  type NetworkDutyReportRequest,
  parseNetworkDutyRequest,
  parseNetworkDutyPhases,
} from '@hyd/engineering';
import { element, escapeHtml as esc } from './network-dom.mjs';
import { createNetworkGoal, demandRows, dutyLimits, type IndependentGoalInput } from './network-goal.mjs';
import { createNetworkCatalog } from './network-catalog.mjs';
import {
  calculationNumber as numeric,
  seedCalculationInput,
  markCalculationOverride,
  readCalculationNumber,
  showCalculationIssues,
  calculationAdvice,
  pumpSpeedSeed,
  sourcePressureSeed,
  validateCalculationInput,
  type FormIssue,
} from './network-calculation-form.mjs';
interface DutyHooks {
  exportCatalog(preview: NetworkCatalogPreview): void;
  exportWord(record: CalculationRecord): void;
  editor(): NetworkDraftSession;
  apply(preview: NetworkDutyPreview): boolean;
  applyGoal(preview: NetworkGoalCandidatePreview, index: number): boolean;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
  exportArtifact(artifact: ExportArtifact): Promise<boolean>;
  uid(prefix: string): string;
}
interface DutyFormOptions {
  readonly rootId: string;
  readonly prefix: string;
  readonly mode: 'single' | 'multiple';
}
const defaultOptions: DutyFormOptions = { rootId: 'dutyForm', prefix: 'duty', mode: 'multiple' };
function motorDutyInput(component: NetworkComponent) {
  if (component.definition.id !== 'teaching:variable-motor') return undefined;
  if (component.externalMotorControl?.kind === 'pressure')
    return { kind: 'pilot', label: 'X 口工况先导压力', unit: 'MPa', maximum: 70 };
  if (component.externalMotorControl?.kind === 'voltage')
    return { kind: 'voltage', label: 'U 口工况给定电压', unit: 'V', maximum: 10 };
  if (component.motorDisplacementCurve?.enabled)
    return { kind: 'differential', label: 'A/B 工况压差', unit: 'MPa', maximum: 70 };
  return { kind: 'command', label: '工况马达排量指令（留空用保存排量）', unit: '%', maximum: 100 };
}
export function createNetworkDuty(hooks: DutyHooks, options: DutyFormOptions = defaultOptions) {
  const root = element(options.rootId),
    id = (name: string) => options.prefix + name;
  const el = (name: string) => element(id(name));
  let previous: NetworkDraftSession['document'] | null = null,
    sessionId = '',
    signature = '',
    preview: NetworkDutyPreview | null = null,
    calculationRecord: CalculationRecord | null = null,
    phaseCount = 0;
  let supplyGroups: readonly DutySupplyGroup[] = [];
  let combinedMode = false;
  let boundaryMode = false;
  root.innerHTML = `<p class="calculation-intro">选择本次工况与参与动作，填写目标要求。</p><label><input id="${id('Automatic')}" type="checkbox" checked>自动补全未填写参数</label><button id="${id('RestoreAutomatic')}" type="button">恢复全部自动配置</button><p class="muted">自动值逐项标明工程来源或教学假设，可直接修改；清空数值恢复自动。缺少可靠来源的项目仍需填写，自动配置不修改回路。</p><label><span data-duty-source-label>指定泵</span><select id="${id('Pump')}"></select></label><div id="${id('PumpFields')}">${numeric('rpm', '要求泵转速', 'r/min', Number.MIN_VALUE)}${numeric('etaV', '泵初选容积效率', '0～1', Number.MIN_VALUE, 1)}${numeric('etaTotal', '泵初选总效率', '0～1', Number.MIN_VALUE, 1)}${numeric('limit', '供油限压预算', 'MPa', Number.MIN_VALUE, 70)}</div><p id="${id('SavedBoundary')}" class="muted"></p><div id="${id('Phases')}"></div><button id="${id('AddPhase')}" type="button">＋ 新增工况</button><button id="${id('Preview')}">核算当前设计</button><button id="${id('Cancel')}" disabled>取消预览</button><button id="${id('Apply')}" disabled>应用到指定泵</button><button id="${id('Export')}" disabled>导出计算过程 CSV</button><button id="${id('Word')}" disabled>导出计算书…</button><div id="${id('Status')}" role="status"></div><div id="${id('Result')}"></div>`;
  const invalidate = (message = '') => {
    catalog.invalidate('工况或输入已改变，请重新筛选目录。');
    preview = null;
    calculationRecord = null;
    for (const name of ['Cancel', 'Apply', 'Export', 'Word']) el(name).setAttribute('disabled', '');
    el('Result').textContent = '';
    el('Status').textContent = message;
  };
  const enterSelection = document.createElement('button');
  enterSelection.id = id('Select');
  enterSelection.type = 'button';
  enterSelection.textContent = '自动选配';
  el('Cancel').before(enterSelection);
  const advancedSupply = document.createElement('details');
  const groupFields = document.createElement('div');
  const supplyTitle = document.createElement('summary');
  supplyTitle.textContent = '计算条件与参数来源';
  advancedSupply.className = 'calculation-conditions';
  advancedSupply.append(supplyTitle);
  el('Phases').after(advancedSupply);
  const automaticNote = el('RestoreAutomatic').nextElementSibling;
  if (automaticNote)
    automaticNote.textContent = '保留当前默认配置。已修改或清空的数值不会自动回填；需要时可恢复自动配置。';
  for (const node of [
    el('Automatic').closest('label'),
    el('RestoreAutomatic'),
    automaticNote,
    el('Pump').closest('label'),
    el('PumpFields'),
    el('SavedBoundary'),
  ])
    if (node) advancedSupply.append(node);
  advancedSupply.append(groupFields);
  const pumpFieldsFor = (pumpId: string) =>
    [...groupFields.querySelectorAll<HTMLElement>('[data-supply-pump]')].find(
      (node) => node.dataset.supplyPump === pumpId,
    );
  const sources = document.createElement('details');
  sources.innerHTML = '<summary>查看参数来源</summary><div data-calculation-sources></div>';
  advancedSupply.append(sources);
  sources.addEventListener('toggle', () => {
    if (!sources.open) return;
    const list = sources.querySelector('[data-calculation-sources]');
    if (list)
      list.innerHTML = [...root.querySelectorAll<HTMLInputElement>('[data-duty-field]')]
        .map(
          (input) =>
            `<p>${esc(input.dataset.fieldLabel ?? '')} · ${esc(input.dataset.source ?? '本次输入')}${input.dataset.edited === 'true' ? '（已修改）' : ''}</p>`,
        )
        .join('');
  });
  const catalogRoot = document.createElement('section');
  root.append(catalogRoot);
  const catalog = createNetworkCatalog(catalogRoot, {
    editor: hooks.editor,
    readDuty: readDutyReport,
    source: () => goal.exportSource(),
    selectedGoal: () => goal.selectedPreview(),
    exportCalculation: () => exportDutyBook(true),
    exportCatalog: hooks.exportCatalog,
    uid: hooks.uid,
  });
  const goalRoot = document.createElement('section');
  root.append(goalRoot);
  const goal = createNetworkGoal(goalRoot, {
    editor: hooks.editor,
    readDuty: readDutyRequest,
    readIndependent: readIndependentGoal,
    readCombined: () => (combinedMode ? combinedInput() : null),
    combined: () => combinedMode,
    apply: hooks.applyGoal,
  });
  for (const button of [el('AddPhase'), el('RestoreAutomatic')])
    button.addEventListener('click', () => goal.invalidate('计算条件已改变，请重新选配。'));
  root.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.matches('[data-remove-phase]'))
      goal.invalidate('工况已移除，请重新选配。');
  });
  enterSelection.addEventListener('click', () => {
    const modal = root.closest('dialog');
    if (modal && !modal.open) modal.showModal();
    modal?.querySelector<HTMLButtonElement>('[data-tab="goal"]')?.click();
    goal.solve();
  });
  for (const event of ['input', 'change'])
    root.addEventListener(event, (e) => {
      catalog.invalidate('输入已改变，请重新筛选目录。');
      if (e.target instanceof Node && !goalRoot.contains(e.target) && !catalogRoot.contains(e.target))
        goal.invalidate('工况输入已改变，请重新校核或求解。');
    });
  const selector = (scope: Element, query: string): string => {
    const value = scope.querySelector(query);
    return value instanceof HTMLSelectElement ? value.value : '';
  };
  const phaseLayout = document.createElement('div');
  phaseLayout.className = 'calculation-phase-layout';
  const phaseNavigation = document.createElement('nav');
  phaseNavigation.className = 'calculation-phase-navigation';
  phaseNavigation.setAttribute('aria-label', '计算工况');
  el('Phases').before(phaseLayout);
  const phaseSidebar = document.createElement('aside');
  phaseSidebar.className = 'calculation-phase-sidebar';
  phaseSidebar.append(phaseNavigation, el('AddPhase'));
  phaseLayout.append(phaseSidebar, el('Phases'));
  let visiblePhase = '';
  function refreshPhaseNavigation(): void {
    const phases = [...el('Phases').querySelectorAll<HTMLElement>('[data-duty-phase]')];
    if (!phases.some((phase) => phase.dataset.dutyPhase === visiblePhase))
      visiblePhase = phases[0]?.dataset.dutyPhase ?? '';
    phaseNavigation.replaceChildren();
    for (const phase of phases) {
      const button = document.createElement('button');
      const name = phase.querySelector<HTMLInputElement>('[data-duty-name]')?.value || '未命名工况';
      const included = phase.querySelector<HTMLInputElement>('[data-duty-included]')?.checked;
      button.type = 'button';
      button.textContent = name + (included ? '' : ' · 未纳入');
      button.setAttribute('aria-current', String(phase.dataset.dutyPhase === visiblePhase));
      phase.hidden = phase.dataset.dutyPhase !== visiblePhase;
      button.addEventListener('click', () => {
        visiblePhase = phase.dataset.dutyPhase ?? '';
        refreshPhaseNavigation();
      });
      phaseNavigation.append(button);
    }
  }
  function savedText(c: NetworkComponent): string {
    const geometry = c.parameters.geometry;
    const length = (value: number | undefined) =>
      value === undefined ? '未提供' : Number((value * 1000).toPrecision(7)) + ' mm';
    if (!isLinearActuatorType(c.typeId))
      return `保存排量 ${c.parameters.hydraulic?.displacementM3PerRev} m³/rev。请填写目标总阻矩。`;
    const shape =
      c.typeId === 'cushioned-double-rod-cylinder'
        ? `两腔有效环形面积均为 ${geometry?.equalAnnularAreaM2} m²`
        : `A 腔面积 ${geometry?.capAreaM2} m²` +
          (c.typeId === 'single-acting-cylinder' ? '' : `，B 腔面积 ${geometry?.rodSideAreaM2} m²`);
    const cushions = c.typeId.startsWith('cushioned-')
      ? `。缩回端缓冲 ${length(c.parameters.cushion?.retractCushionLengthM)}，伸出端缓冲 ${length(c.parameters.cushion?.extendCushionLengthM)}`
      : '';
    return `保存几何 ${shape}，行程 ${length(geometry?.strokeM)}${cushions}。`;
  }
  function addPhase(): void {
    const project = hooks.editor().document,
      container = document.createElement('fieldset');
    container.dataset.dutyPhase = String(++phaseCount);
    container.className = 'calculation-phase';
    const actuators = project.design.components.filter((c) => isNetworkActuatorType(c.typeId));
    const storage =
      boundaryMode && actuators.length === 0 && project.design.components.some((c) => c.typeId === 'accumulator');
    const variablePump =
      !supplyGroups.length && project.design.components.some((c) => c.definition.id === 'teaching:variable-pump');
    const splitAvailable =
      !supplyGroups.length && actuators.length >= 2 && actuators.every((c) => c.typeId === 'cylinder');
    const hasMeteredLoss = project.design.components.some(
      (c) => c.typeId === 'flow-meter' || c.typeId === 'return-filter',
    );
    const hasControlValve = project.design.components.some((c) => dutyControlValveTypes.has(c.typeId));
    const hasPressureDrain = project.design.components.some(hasControlDrain);
    const multiPortValve = project.design.components.find((c) => dutyMultiPortValveTypes.has(c.typeId));
    const logicValve = project.design.components.find((c) => dutyLogicValveTypes.has(c.typeId));
    const protection = project.design.components.find((c) => dutyProtectionTypes.has(c.typeId));
    const hasBypassValve = multiPortValve?.typeId === 'three-way-flow-control';
    const valveHint = protection
      ? (protection.typeId === 'counterbalance'
          ? '平衡阀 B 接有杆腔、A 接换向阀 B、X 取无杆腔压力。'
          : '保护阀 A/B 分别接无杆腔/有杆腔，T 接同一油箱。') +
        '按目标缸速计入换向阀压降，其余供油压降填 0，回油基准取油箱压力。'
      : logicValve
        ? logicValve.typeId === 'pilot-check-close'
          ? '液控关闭单向阀 A 接缸排油腔、B 回油箱，X 取泵口或油箱。请选择工况阀位，回油基础压力填油箱压力。'
          : 'A、B 入口按工况接泵或油箱，C 接进油缸腔。请选择各入口换向阀位，回油基础压力填油箱压力。'
        : hasBypassValve
          ? '三通调速阀的其余供油压降从 A 口算到缸腔。软件按当前泵排量、核算转速和效率检查工作流量与旁通流量。'
          : multiPortValve?.typeId === 'pilot-check'
            ? '液控单向阀的 B 口接缸腔。四口外泄型支持可求解的串并联回油，Y 口可经取压支路接回油节点或独立泄油箱。回油基础压力须扣除软件已算的回油损失。'
            : multiPortValve
              ? '三通溢流减压阀进油时，其余供油压降填到 P 口。A→T 泄放时，回油基础压力填油箱压力。'
              : hasPressureDrain
                ? '减压阀或顺序阀 Y 接主回油取压时，回油基础压力填油箱压力，缸容积效率填 1。软件按缸排油量计算取压点与回油腔压力。'
                : '';
    const shutoffs = project.design.components
      .filter((c) => c.typeId === 'manual-shutoff')
      .map(
        (c) =>
          `<div data-duty-shutoff-setting><label>${esc(c.label || c.id)}<select data-duty-shutoff="${esc(c.id)}"><option value="">按工程初态</option><option value="open">全开</option><option value="closed">关闭</option><option value="partial">中间有效开口</option></select></label><div data-duty-shutoff-area hidden>${numeric('shutoffArea', (c.label || c.id) + ' 有效开口', 'mm²', 1e-6, 1e6)}</div></div>`,
      )
      .join('');
    container.innerHTML = `<legend>工况 ${phaseCount}</legend><div class="calculation-phase-heading"><label>工况名称<input data-duty-name value="工况 ${phaseCount}" maxlength="80"></label><label class="phase-included"><input type="checkbox" data-duty-included checked>纳入本次计算</label><button type="button" data-remove-phase>删除工况</button></div><p class="muted">同一工况内的勾选动作同时发生。先后动作请分到不同工况。</p>${project.design.components
      .filter((c) => c.typeId === 'valve')
      .map(
        (c) =>
          `<label>${esc(c.label)}<select data-duty-valve="${esc(c.id)}" data-field-label="${esc(c.label)} 阀位"><option value="">自动识别阀位</option>${networkValvePositions(
            c,
          )
            .map((v) => '<option value="' + v + '">' + esc(positionDisplayName(v, c)) + '</option>')
            .join('')}</select></label>`,
      )
      .join(
        '',
      )}${shutoffs}${hasControlValve ? '<p class="muted">控制阀正向串联在主供油路，P 口通过理想油路或串联流量计接泵。阀后其余压降从 A 口算至缸进油腔，流量计和控制阀压降分别核算。</p>' : ''}${valveHint ? '<p class="muted">' + valveHint + '</p>' : ''}${hasMeteredLoss ? '<p class="muted">供油其余压降和回油基础压力请填写未包含流量计、滤芯压降的数值。回油附件按容积效率 1 核算。</p>' : ''}${actuators
      .map((c) => {
        const checked =
          actuators.length === 1 ||
          (supplyGroups.length > 0 &&
            (c.typeId === 'cylinder' || (combinedMode && c.definition.id === 'teaching:motor')));
        const linear = isLinearActuatorType(c.typeId);
        const single = c.typeId === 'single-acting-cylinder';
        const rotary = c.typeId === 'limited-rotary-actuator';
        const motor = motorDutyInput(c);
        const position = rotary
          ? numeric('rotaryAngle', '核算摆角（自零端）', '°', 0, 360)
          : linear && c.typeId !== 'cylinder'
            ? numeric('position', '核算位置（自完全缩回端）', 'mm', 0)
            : '';
        const reverse = single ? '弹簧回程（A回油）' : linear ? '缩回（B供油）' : '反转（B供油）';
        const loss = single
          ? '伸出供油压降（回程不用）'
          : hasControlValve || hasBypassValve
            ? '阀后其余供油压降'
            : hasMeteredLoss || multiPortValve || logicValve || protection || combinedMode
              ? '供油其余压降'
              : '供油阀管总压降';
        const ret = combinedMode
          ? '阀 T 侧回油背压'
          : single
            ? '回程 A 腔压力（伸出不用）'
            : hasMeteredLoss || hasPressureDrain || logicValve || protection || (multiPortValve && !hasBypassValve)
              ? '回油基础压力'
              : '回油腔压力';
        return `<section data-duty-action="${esc(c.id)}" data-action-label="${esc(c.label)}"><label><input type="checkbox" data-duty-active ${checked ? 'checked' : ''}>参与动作：${esc(c.label)}</label><div data-action-fields ${checked ? '' : 'hidden'}><p data-duty-saved="${esc(c.id)}" class="muted">${esc(savedText(c))}</p><label>方向<select data-duty-direction><option value="forward">${linear ? '伸出' : '正转'}（A供油）</option><option value="reverse">${reverse}</option></select></label>${position}${motor ? numeric('motorSetting', motor.label, motor.unit, 0, motor.maximum) : ''}${numeric('speed', linear ? '目标速度' : '目标转速', linear ? 'mm/s' : 'r/min', Number.MIN_VALUE)}${numeric('load', single ? '总阻性负载（不含缸内弹簧）' : linear ? '总阻性负载' : rotary ? '外部阻性扭矩（另计黏性阻矩）' : '阻性扭矩', linear ? 'kN' : 'N·m')}${numeric('loss', loss, 'MPa', 0, 70)}${numeric('return', ret, 'MPa', 0, 70)}${numeric('etaM', '执行器机械效率', '0～1', Number.MIN_VALUE, 1)}${numeric('etaV', '执行器容积效率', '0～1', Number.MIN_VALUE, 1)}</div></section>`;
      })
      .join('')}`;
    if (storage) {
      const state = document.createElement('div');
      state.innerHTML =
        numeric('accumulatorOil', '蓄能器起始／指定油量', 'L', 0, 1000) +
        '<label><input type="checkbox" data-accumulator-transfer>核算充放油时间</label>' +
        '<div data-accumulator-target hidden><p class="muted">限独立恒压边界直连蓄能器。填写从上方油量到达的目标油量。</p>' +
        numeric('accumulatorTargetOil', '蓄能器目标油量', 'L', 0, 1000) +
        '</div>';
      const transfer = state.querySelector<HTMLInputElement>('[data-accumulator-transfer]');
      const target = state.querySelector<HTMLElement>('[data-accumulator-target]');
      transfer?.addEventListener('change', () => {
        if (target) target.hidden = !transfer.checked;
      });
      container.querySelector('.calculation-phase-heading')?.after(state);
    }
    for (const wrapper of container.querySelectorAll('[data-duty-shutoff-setting]')) {
      const select = wrapper.querySelector<HTMLSelectElement>('[data-duty-shutoff]');
      const area = wrapper.querySelector<HTMLElement>('[data-duty-shutoff-area]');
      select?.addEventListener('change', () => {
        if (area) area.hidden = select.value !== 'partial';
      });
    }
    if (variablePump) {
      const setting = document.createElement('div');
      setting.innerHTML =
        numeric('pumpCommand', '工况泵排量指令（留空用保存排量）', '%', 0, 100) +
        '<label><input type="checkbox" data-pump-pressure-control>按工况压力调节排量</label>' +
        '<div data-pump-pressure-settings hidden><p class="muted">只用于本工况稳态核算。输入泵 P 与 S 的截压压差和调节带。</p>' +
        numeric('pumpCutoff', '截压压差', 'MPa', Number.MIN_VALUE, 70) +
        numeric('pumpPressureBand', '调节带', 'MPa', Number.MIN_VALUE, 70) +
        '</div>';
      const automatic = setting.querySelector<HTMLInputElement>('[data-pump-pressure-control]');
      const fields = setting.querySelector<HTMLElement>('[data-pump-pressure-settings]');
      const manual = setting.querySelector<HTMLInputElement>('[data-duty-field="pumpCommand"]');
      automatic?.addEventListener('change', () => {
        if (fields) fields.hidden = !automatic.checked;
        if (manual) manual.disabled = automatic.checked;
      });
      container.querySelector('.calculation-phase-heading')?.after(setting);
    }
    if (!combinedMode && supplyGroups.some((group) => group.result.kind === 'ready' && group.cylinders.length > 1)) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = '同一供油组勾选多只油缸时，自动核算组内实际分流。各组供油分别计算。';
      container.querySelector('.calculation-phase-heading')?.after(note);
    }
    if (splitAvailable) {
      const split = document.createElement('label');
      split.innerHTML = '<input type="checkbox" data-duty-flow-split checked>各缸同时动作时核算实际分流';
      container.querySelector('.calculation-phase-heading')?.after(split);
      const note = document.createElement('p');
      note.className = 'muted';
      note.dataset.flowSplitHint = '';
      split.after(note);
      const filters = project.design.components.filter((part) => part.typeId === 'return-filter');
      const [filter] = filters;
      if (filter && filters.length === 1 && actuators.length === 2) {
        const settings = document.createElement('div');
        settings.innerHTML =
          `<label><input type="checkbox" data-duty-filter-bypass="${esc(filter.id)}">核算共用滤芯内置旁通</label>` +
          '<div data-filter-bypass-fields hidden><p class="muted">使用本工况滤芯在额定流量下的压降及旁通开启参数。有效面积为流量系数乘几何面积。</p>' +
          numeric('filterRatedDrop', '工况滤芯额定压降', 'kPa', Number.MIN_VALUE, 70000) +
          numeric('filterCracking', '内置旁通开启压差', 'kPa', 0, 70000) +
          numeric('filterBypassArea', '内置旁通有效面积', 'mm²', 1e-6, 1e6) +
          '</div>';
        const checked = settings.querySelector<HTMLInputElement>('[data-duty-filter-bypass]');
        const fields = settings.querySelector<HTMLElement>('[data-filter-bypass-fields]');
        checked?.addEventListener('change', () => {
          if (fields) fields.hidden = !checked.checked;
        });
        note.after(settings);
      }
      if (project.design.components.some((part) => part.typeId === 'synchronizing-flow-divider')) {
        const end = document.createElement('div');
        end.innerHTML = `<label>末端纠偏到位缸<select data-divider-end><option value="">两缸均在行程内</option>${actuators.map((part) => `<option value="${esc(part.id)}">${esc(part.label || part.id)}</option>`).join('')}</select></label><div data-divider-end-pressure hidden>${numeric('dividerEndPressure', '停缸无杆腔压力', 'MPa', 0, 70)}</div>`;
        note.after(end);
      }
    }
    el('Phases').append(container);
    visiblePhase = container.dataset.dutyPhase ?? '';
    refreshPhaseNavigation();
    for (const action of container.querySelectorAll('[data-action-fields]')) {
      const advanced = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = '压降、回油与效率';
      advanced.className = 'calculation-action-conditions';
      const grid = document.createElement('div');
      grid.className = 'calculation-condition-grid';
      advanced.append(heading);
      for (const input of action.querySelectorAll(
        '[data-duty-field]:not([data-duty-field="speed"], [data-duty-field="load"], [data-duty-field="position"], [data-duty-field="rotaryAngle"], [data-duty-field="motorSetting"])',
      )) {
        const label = input.closest('label');
        if (label) grid.append(label);
      }
      advanced.append(grid);
      action.append(advanced);
    }
    refreshSplitFields(container);
    seedAutomatic();
    invalidate('请确认阀位和动作方向；可只改关心的数值，再预览。');
  }
  function splitEnabled(phase: Element): boolean {
    return (
      phase.querySelector<HTMLInputElement>('[data-duty-flow-split]')?.checked === true &&
      phase.querySelectorAll('[data-duty-active]:checked').length ===
        phase.querySelectorAll('[data-duty-active]').length
    );
  }
  function refreshSplitFields(phase: Element): void {
    if (supplyGroups.length && !combinedMode) {
      for (const group of supplyGroups) {
        if (group.result.kind !== 'ready' || (group.cylinders.length < 2 && !group.sharedReturnPipeId)) continue;
        const active = phase.querySelectorAll<HTMLElement>('[data-duty-action]');
        const actions = [...active].filter((action) => group.componentIds.has(action.dataset.dutyAction ?? ''));
        const split = actions.filter((action) => action.querySelector('[data-duty-active]:checked')).length > 1;
        const { design } = group.result.project;
        const physicalReturn =
          design.connections.some((edge) => edge.kind === 'pipe') ||
          design.components.some((part) => part.typeId === 'return-filter' || part.typeId === 'flow-meter');
        for (const action of actions)
          refreshLossLabels(
            action,
            split || !!group.sharedReturnPipeId,
            (split && physicalReturn) || !!group.sharedReturnPipeId,
          );
      }
      return;
    }
    if (!phase.querySelector('[data-duty-flow-split]')) return;
    const active = splitEnabled(phase);
    const { design } = hooks.editor().document;
    const divider = design.components.some((part) => dutyDividerTypes.has(part.typeId));
    const endPressure = phase.querySelector<HTMLElement>('[data-divider-end-pressure]');
    if (endPressure) {
      const stopped = selector(phase, '[data-divider-end]');
      endPressure.hidden = !stopped;
      for (const action of phase.querySelectorAll<HTMLElement>('[data-duty-action]')) {
        const input = action.querySelector<HTMLInputElement>('[data-duty-field="speed"]');
        if (input) input.disabled = action.dataset.dutyAction === stopped;
      }
    }
    const physicalReturn =
      active &&
      (design.connections.some((edge) => edge.kind === 'pipe') ||
        design.components.some((part) => part.typeId === 'return-filter' || part.typeId === 'flow-meter'));
    const hint = phase.querySelector('[data-flow-split-hint]');
    if (hint)
      hint.textContent = divider
        ? '按保存比例核算分流或集流。两缸方向须相同，其余供油压降填 0，回油基准取油箱。末端纠偏须指定到位缸及其压力。'
        : physicalReturn
          ? '按接线识别回油树，回油基准取油箱压力。单泵双缸的物理供油干线与支管也可联算，相应手填供油压降为 0。回油树支持 ' +
            returnTreeLimits.cylinders +
            ' 缸以内，工程总连线最多 ' +
            returnTreeLimits.connections +
            ' 条。'
          : '勾选各缸后，按各阀保存开口求分流。供油只填其余压降，回油背压填换向阀 T 侧等效压力。';
    refreshLossLabels(phase, active, divider || physicalReturn);
  }
  function refreshLossLabels(scope: Element, active: boolean, tankReturn: boolean): void {
    for (const [key, name] of [
      ['loss', active ? '其余供油压降' : '供油阀管总压降'],
      ['return', tankReturn ? '回油基准（油箱压力）' : active ? '阀 T 侧回油背压' : '回油腔压力'],
    ] as const) {
      for (const input of scope.querySelectorAll<HTMLInputElement>(`[data-duty-field="${key}"]`)) {
        input.dataset.fieldLabel = name;
        input.setAttribute('aria-label', name);
        const caption = input.closest('label')?.querySelector('span');
        if (caption?.firstChild) caption.firstChild.textContent = name + ' ';
      }
    }
  }
  function automaticEnabled(): boolean {
    const control = el('Automatic');
    return control instanceof HTMLInputElement && control.checked;
  }
  function seedAutomatic(): void {
    if (!automaticEnabled()) return;
    const fill = (scope: Element, key: string, value: DutyAutomaticNumber, quantity: Quantity) => {
      const input = scope.querySelector(`[data-duty-field="${key}"]`);
      if (!(input instanceof HTMLInputElement)) throw new Error('Automatic calculation field missing: ' + key);
      seedCalculationInput(
        input,
        value.kind === 'unavailable' ? undefined : fromSI(quantity, value.value),
        value.source,
        value.kind === 'project' ? 'automatic-project' : 'automatic-assumption',
      );
    };
    const contexts = supplyGroups.length
      ? supplyGroups.flatMap((group) => {
          const fields = pumpFieldsFor(group.pump.id);
          if (!fields) return [];
          if (combinedMode) return [{ document: hooks.editor().document, pumpId: group.pump.id, fields }];
          return group.result.kind === 'ready'
            ? [{ document: group.result.project, pumpId: group.pump.id, fields }]
            : [];
        })
      : [{ document: hooks.editor().document, pumpId: selector(root, '#' + id('Pump')), fields: el('PumpFields') }];
    for (const context of contexts) {
      const defaults = networkDutyAutomaticDefaults(context.document, context.pumpId);
      fill(context.fields, 'rpm', defaults.global.angularSpeedRadPerS, 'angularSpeed');
      fill(context.fields, 'etaV', defaults.global.pumpVolumetricEfficiency, 'ratio');
      fill(context.fields, 'etaTotal', defaults.global.totalEfficiency, 'ratio');
      fill(context.fields, 'limit', defaults.global.pressureLimitPa, 'pressure');
      for (const action of root.querySelectorAll<HTMLElement>('[data-duty-action]')) {
        const preset = defaults.actions.find((entry) => entry.componentId === action.dataset.dutyAction);
        if (!preset) continue;
        const component = context.document.design.components.find((c) => c.id === preset.componentId);
        const linear = component !== undefined && isLinearActuatorType(component.typeId);
        fill(action, 'speed', preset.speed, linear ? 'linearSpeed' : 'angularSpeed');
        fill(action, 'load', preset.resistingLoad, linear ? 'force' : 'torque');
        fill(action, 'loss', preset.supplyLossPa, 'pressure');
        fill(action, 'return', preset.returnPressurePa, 'pressure');
        fill(action, 'etaM', preset.mechanicalEfficiency, 'ratio');
        fill(action, 'etaV', preset.volumetricEfficiency, 'ratio');
      }
    }
  }
  function seedPump(): void {
    if (supplyGroups.length) {
      for (const { pump } of supplyGroups) {
        const input = pumpFieldsFor(pump.id)?.querySelector('[data-duty-field="rpm"]');
        if (input instanceof HTMLInputElement)
          seedCalculationInput(input, pumpSpeedSeed(hooks.editor().document, pump.id), '本组泵的保存转速');
      }
      return;
    }
    const input = el('PumpFields').querySelector('[data-duty-field="rpm"]');
    if (input instanceof HTMLInputElement)
      seedCalculationInput(
        input,
        pumpSpeedSeed(hooks.editor().document, selector(root, '#' + id('Pump'))),
        '所选泵的保存转速',
      );
  }
  root.addEventListener('input', (event) => {
    if (event.target instanceof Node && (catalogRoot.contains(event.target) || goalRoot.contains(event.target))) return;
    markCalculationOverride(event.target);
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-duty-name]')) refreshPhaseNavigation();
    invalidate('输入已改变，请重新预览；工程未改变。');
  });
  root.addEventListener('focusout', (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.matches('[data-duty-field]') &&
      (event.target.value || !['pumpCommand', 'motorSetting'].includes(event.target.dataset.dutyField ?? ''))
    )
      validateCalculationInput(event.target);
  });
  root.addEventListener('change', (event) => {
    if (event.target instanceof Node && (catalogRoot.contains(event.target) || goalRoot.contains(event.target))) return;
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-duty-included]'))
      refreshPhaseNavigation();
    if (
      event.target instanceof Element &&
      event.target.matches('[data-duty-active], [data-duty-flow-split], [data-divider-end]')
    ) {
      const phase = event.target.closest('[data-duty-phase]');
      if (phase) refreshSplitFields(phase);
    }
    if (event.target instanceof HTMLSelectElement && event.target.matches('[data-duty-valve]')) {
      delete event.target.dataset.autoMatch;
      event.target.title = '';
    }
    if (
      event.target instanceof Element &&
      event.target.matches('[data-duty-direction], [data-duty-active], [data-duty-shutoff]')
    ) {
      for (const valve of event.target.closest('fieldset')?.querySelectorAll<HTMLSelectElement>('[data-auto-match]') ??
        []) {
        valve.value = '';
        valve.title = '';
        delete valve.dataset.autoMatch;
      }
    }
    if (event.target === el('Automatic') && !automaticEnabled()) {
      for (const input of root.querySelectorAll<HTMLInputElement>('[data-duty-field][data-automatic="true"]')) {
        input.value = '';
        delete input.dataset.automatic;
        delete input.dataset.source;
        const note = input.closest('label')?.querySelector('[data-field-source]');
        if (note) note.textContent = '自动配置已关闭，请填写';
      }
      seedPump();
      const boundary = sourcePressureSeed(hooks.editor().document);
      const limit = el('PumpFields').querySelector('[data-duty-field="limit"]');
      if (limit instanceof HTMLInputElement) seedCalculationInput(limit, boundary.value, boundary.source);
    }
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-duty-active]')) {
      const body = event.target.closest('[data-duty-action]')?.querySelector('[data-action-fields]');
      if (body instanceof HTMLElement) body.hidden = !event.target.checked;
    }
    if (event.target === el('Pump')) {
      const rpm = el('PumpFields').querySelector('[data-duty-field="rpm"]');
      if (rpm instanceof HTMLInputElement) delete rpm.dataset.edited;
      seedPump();
    }
    seedAutomatic();
    invalidate('条件已改变，请重新预览。');
  });
  el('RestoreAutomatic').addEventListener('click', () => {
    const control = el('Automatic');
    if (control instanceof HTMLInputElement) control.checked = true;
    for (const input of root.querySelectorAll<HTMLInputElement>('[data-duty-field]')) delete input.dataset.edited;
    seedAutomatic();
    invalidate('已恢复全部自动配置；请确认动作及阀位后重新预览。');
  });
  root.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.matches('[data-remove-phase]')) {
      event.target.closest('fieldset')?.remove();
      refreshPhaseNavigation();
      invalidate('工况已移除，请重新预览。');
    }
  });
  el('AddPhase').addEventListener('click', () => {
    if (el('Phases').childElementCount >= 24) invalidate('最多24个工况。');
    else addPhase();
  });
  function readDutyReport(
    useGoal = true,
    group?: DutySupplyGroup,
    collectCombined?: (phases: readonly DutyPhase[]) => void,
  ): NetworkDutyReportRequest {
    const pendingPhases: DutyPendingPhase[] = [];
    for (const phase of el('Phases').querySelectorAll<HTMLElement>('[data-duty-phase]')) {
      const name =
        phase.querySelector<HTMLInputElement>('[data-duty-name]')?.value.trim() || '工况 ' + phase.dataset.dutyPhase;
      if (!phase.querySelector<HTMLInputElement>('[data-duty-included]')?.checked) {
        pendingPhases.push({ name, kind: 'excluded', reason: '本次未勾选纳入计算。' });
      } else if (group) {
        const active = phaseActions(phase);
        if (!active.length) pendingPhases.push({ name, kind: 'incomplete', reason: '本工况未勾选执行器。' });
        else if (!active.some((id) => group.componentIds.has(id)))
          pendingPhases.push({ name, kind: 'excluded', reason: '本工况未指定本组动作，本组供油及阀位未核算。' });
      }
    }
    const duty =
      (useGoal ? goal.exportPlan()?.request : undefined) ??
      readDutyRequest(pendingPhases, group, collectCombined, group ? 'participating' : 'all');
    return { duty, pendingPhases };
  }
  function independentRecord() {
    return prepareIndependentDutyCalculation(
      hooks.editor(),
      supplyGroups.flatMap((group) =>
        group.result.kind === 'ready' ? [{ pumpId: group.pump.id, ...readDutyReport(false, group) }] : [],
      ),
    );
  }
  function phaseActions(phase: HTMLElement): string[] {
    return [...phase.querySelectorAll<HTMLElement>('[data-duty-action]')].flatMap((action) =>
      action.dataset.dutyAction && action.querySelector<HTMLInputElement>('[data-duty-active]')?.checked
        ? [action.dataset.dutyAction]
        : [],
    );
  }
  function readIndependentGoal(): readonly IndependentGoalInput[] | null {
    if (combinedMode || !supplyGroups.length) return null;
    const included = [...el('Phases').querySelectorAll<HTMLElement>('[data-duty-phase]')]
      .filter((phase) => phase.querySelector<HTMLInputElement>('[data-duty-included]')?.checked)
      .map(phaseActions);
    const active = new Set(included.flat());
    const uncovered = [...active].filter((id) => !supplyGroups.some((group) => group.componentIds.has(id)));
    return supplyGroups.map((group) => {
      const pumpId = group.pump.id;
      if (group.result.kind === 'blocked') return { pumpId, kind: 'pending', reason: group.result.reason };
      if (uncovered.length)
        return { pumpId, kind: 'pending', reason: '有已勾选的执行器无法归入现有供油组：' + uncovered.join('、') };
      if (!included.length || included.some((actions) => !actions.length))
        return { pumpId, kind: 'pending', reason: '请纳入至少一个工况，并为每个纳入的工况勾选动作。' };
      if (![...active].some((id) => group.componentIds.has(id))) return { pumpId, kind: 'idle' };
      const pending: DutyPendingPhase[] = [];
      const duty = readDutyRequest(pending, group, undefined, 'participating');
      if (!duty || pending.length) {
        const reason = pending.map((phase) => phase.name + ' · ' + phase.reason).join('；');
        return { pumpId, kind: 'pending', reason: reason ? reason.slice(0, 1550) : '请补齐本组工况。' };
      }
      return { pumpId, kind: 'ready', duty };
    });
  }
  function combinedInput() {
    seedAutomatic();
    const pumps = supplyGroups.flatMap(({ pump }) => {
      const fields = pumpFieldsFor(pump.id);
      if (!fields) return [];
      const issues: FormIssue[] = [];
      const read = (key: string) => readCalculationNumber(fields, key, pump.label || pump.id, issues);
      const rpm = read('rpm'),
        budget = read('limit');
      return [
        {
          pumpId: pump.id,
          speed: rpm === null ? null : toSI('angularSpeed', rpm),
          etaV: read('etaV'),
          etaTotal: read('etaTotal'),
          budget: budget === null ? null : toSI('pressure', budget),
        },
      ];
    });
    let phases: readonly DutyPhase[] = [];
    const { pendingPhases } = readDutyReport(false, undefined, (ready) => {
      phases = ready;
    });
    return { pumps, phases, pendingPhases };
  }
  function combinedRecord() {
    return prepareCombinedDutyCalculation(hooks.editor(), combinedInput());
  }
  function exportDutyBook(useGoal: boolean): void {
    if (supplyGroups.length) {
      const result = combinedMode ? combinedRecord() : independentRecord();
      if (result.ok) hooks.exportWord(result.value);
      else el('Status').textContent = calculationAdvice(result.diagnostics);
      return;
    }
    const { duty, pendingPhases } = readDutyReport(useGoal);
    const record = prepareNetworkDutyCalculation(
      hooks.editor(),
      duty,
      pendingPhases,
      useGoal ? (goal.selectedPreview() ?? undefined) : undefined,
    );
    if (record.ok) hooks.exportWord(record.value);
    else el('Status').textContent = record.diagnostics.map((item) => item.message).join('；');
  }
  function readDutyRequest(
    report?: DutyPendingPhase[],
    group?: DutySupplyGroup,
    collectCombined?: (phases: readonly DutyPhase[]) => void,
    scope: 'all' | 'participating' = 'all',
  ): NetworkDutyReportRequest['duty'] {
    if (supplyGroups.length && !group && !collectCombined) return null;
    const project = group?.result.kind === 'ready' ? group.result.project : hooks.editor().document;
    const belongs = (componentId: string | undefined) =>
      !group || (componentId !== undefined && group.componentIds.has(componentId));
    seedAutomatic();
    const issues: FormIssue[] = [];
    const automaticFields: string[] = [];
    const missingValves: { control: HTMLSelectElement; message: string }[] = [];
    const read = (scope: Element, key: string, context: string, path: string) => {
      const value = readCalculationNumber(scope, key, context, issues);
      const input = scope.querySelector(`[data-duty-field="${key}"]`);
      if (automaticEnabled() && input instanceof HTMLInputElement && input.dataset.automatic === 'true')
        automaticFields.push(path);
      return value;
    };
    const groupPump = group?.pump.id;
    const global = groupPump ? pumpFieldsFor(groupPump) : el('PumpFields');
    if (!global) return null;
    const skipPump = collectCombined || boundaryMode;
    const rpm = skipPump ? null : read(global, 'rpm', '泵与供油', '/angularSpeedRadPerS'),
      etaV = skipPump ? null : read(global, 'etaV', '泵与供油', '/pumpVolumetricEfficiency'),
      etaTotal = skipPump ? null : read(global, 'etaTotal', '泵与供油', '/totalEfficiency'),
      limit = skipPump ? null : read(global, 'limit', '泵与供油', '/pressureLimitPa');
    const pump = el('Pump');
    if (!collectCombined && !groupPump && pump instanceof HTMLSelectElement && !pump.value)
      issues.push({ control: pump, message: '请选择明确的核算供油元件。' });
    const phaseElements = [...el('Phases').querySelectorAll<HTMLElement>('[data-duty-phase]')].filter(
      (phase) =>
        phase.querySelector<HTMLInputElement>('[data-duty-included]')?.checked &&
        (scope === 'all' || phaseActions(phase).some(belongs)),
    );
    if (!phaseElements.length) issues.push({ control: el('Phases'), message: '请纳入至少一个工况。' });
    const phases = phaseElements.map((phase, index) => {
      const name = phase.querySelector('[data-duty-name]'),
        title = name instanceof HTMLInputElement ? name.value.trim() : '';
      if (!title && name instanceof HTMLElement)
        issues.push({ control: name, message: '工况 ' + (index + 1) + '：请填写工况名称。' });
      const valves = [...phase.querySelectorAll<HTMLSelectElement>('[data-duty-valve]')]
        .filter((v) => belongs(v.dataset.dutyValve))
        .map((v) => {
          if (!v.value)
            missingValves.push({ control: v, message: title + ' / ' + v.dataset.fieldLabel + '：请选择阀位。' });
          return { componentId: v.dataset.dutyValve, positionId: v.value };
        });
      const shutoffs = [...phase.querySelectorAll<HTMLSelectElement>('[data-duty-shutoff]')]
        .filter((control) => control.value && belongs(control.dataset.dutyShutoff))
        .map((control) => {
          const setting = { componentId: control.dataset.dutyShutoff, state: control.value };
          const wrapper = control.closest('[data-duty-shutoff-setting]');
          if (control.value !== 'partial' || !wrapper) return setting;
          const area = readCalculationNumber(wrapper, 'shutoffArea', title, issues);
          return { ...setting, openingAreaM2: area === null ? null : area * 1e-6 };
        });
      const active = [...phase.querySelectorAll<HTMLElement>('[data-duty-action]')].filter((a) => {
        const check = a.querySelector('[data-duty-active]');
        return belongs(a.dataset.dutyAction) && check instanceof HTMLInputElement && check.checked;
      });
      const storage = phase.querySelector('[data-duty-field="accumulatorOil"]');
      const oil = storage ? readCalculationNumber(phase, 'accumulatorOil', title, issues) : undefined;
      const targetOil = phase.querySelector('[data-accumulator-transfer]:checked')
        ? readCalculationNumber(phase, 'accumulatorTargetOil', title, issues)
        : undefined;
      if (!active.length && !storage) {
        const target = phase.querySelector<HTMLElement>('[data-duty-active]') ?? phase;
        issues.push({ control: target, message: title + '：请勾选至少一个参与动作。' });
      }
      const endCylinder = selector(phase, '[data-divider-end]');
      const endPressure = endCylinder ? readCalculationNumber(phase, 'dividerEndPressure', title, issues) : null;
      const commandInput = phase.querySelector<HTMLInputElement>('[data-duty-field="pumpCommand"]');
      const pressureEnabled = phase.querySelector<HTMLInputElement>('[data-pump-pressure-control]')?.checked;
      const cutoff = pressureEnabled ? readCalculationNumber(phase, 'pumpCutoff', title, issues) : null;
      const band = pressureEnabled ? readCalculationNumber(phase, 'pumpPressureBand', title, issues) : null;
      const pumpCommand =
        !pressureEnabled && (commandInput?.value || commandInput?.validity.badInput)
          ? readCalculationNumber(phase, 'pumpCommand', title, issues)
          : undefined;
      const split = group ? active.length > 1 : splitEnabled(phase);
      const bypass = phase.querySelector<HTMLInputElement>('[data-duty-filter-bypass]:checked');
      const filterField = (key: string, factor: number) => {
        const value = readCalculationNumber(phase, key, title, issues);
        return value === null ? null : value * factor;
      };
      if (bypass && !split) issues.push({ control: bypass, message: title + '：滤芯内置旁通须启用两缸实际分流。' });
      const filterBypass = bypass
        ? {
            componentId: bypass.dataset.dutyFilterBypass,
            ratedDropPa: filterField('filterRatedDrop', 1000),
            crackingPressurePa: filterField('filterCracking', 1000),
            effectiveAreaM2: filterField('filterBypassArea', 1e-6),
          }
        : undefined;
      return {
        name: title,
        valves,
        ...(oil === undefined ? {} : { accumulatorOilVolumeM3: oil === null ? null : oil / 1000 }),
        ...(targetOil === undefined
          ? {}
          : { accumulatorTargetOilVolumeM3: targetOil === null ? null : targetOil / 1000 }),
        ...(pumpCommand === undefined ? {} : { pumpCommandPercent: pumpCommand }),
        ...(pressureEnabled
          ? {
              pumpPressureControl: {
                cutoffDifferentialPa: cutoff === null ? null : toSI('pressure', cutoff),
                bandPa: band === null ? null : toSI('pressure', band),
              },
            }
          : {}),
        ...(split ? { flowSplit: true } : {}),
        ...(filterBypass ? { filterBypass } : {}),
        ...(endCylinder
          ? {
              dividerEnd: {
                componentId: endCylinder,
                pressurePa: endPressure === null ? null : toSI('pressure', endPressure),
              },
            }
          : {}),
        ...(shutoffs.length ? { shutoffs } : {}),
        actions: active.map((a, actionIndex) => {
          const componentId = a.dataset.dutyAction,
            c = project.design.components.find((c) => c.id === componentId),
            context = title + ' / ' + a.dataset.actionLabel;
          const path = `/phases/${index}/actions/${actionIndex}/`;
          const linear = c !== undefined && isLinearActuatorType(c.typeId);
          const position =
            linear && c.typeId !== 'cylinder' ? readCalculationNumber(a, 'position', context, issues) : undefined;
          const angle =
            c?.typeId === 'limited-rotary-actuator'
              ? readCalculationNumber(a, 'rotaryAngle', context, issues)
              : undefined;
          const motor = c && motorDutyInput(c);
          const motorInput = a.querySelector<HTMLInputElement>('[data-duty-field="motorSetting"]');
          const setting =
            motor && (motorInput?.value || motorInput?.validity.badInput)
              ? readCalculationNumber(a, 'motorSetting', context, issues)
              : undefined;
          const speed = endCylinder && endCylinder === componentId ? 0 : read(a, 'speed', context, path + 'speed'),
            load = read(a, 'load', context, path + 'resistingLoad'),
            loss = read(a, 'loss', context, path + 'supplyLossPa'),
            ret = read(a, 'return', context, path + 'returnPressurePa');
          return {
            componentId,
            direction: selector(a, '[data-duty-direction]'),
            speed: speed === null ? null : toSI(linear ? 'linearSpeed' : 'angularSpeed', speed),
            resistingLoad: load === null ? null : linear ? toSI('force', load) : load,
            ...(position === undefined ? {} : { positionM: position === null ? null : toSI('length', position) }),
            ...(angle === undefined ? {} : { rotaryAngleRad: angle === null ? null : (angle * Math.PI) / 180 }),
            ...(motor && setting !== undefined
              ? {
                  motorSetting: {
                    kind: motor.kind,
                    value: setting === null ? null : motor.unit === 'MPa' ? toSI('pressure', setting) : setting,
                  },
                }
              : {}),
            supplyLossPa: loss === null ? null : toSI('pressure', loss),
            returnPressurePa: ret === null ? null : toSI('pressure', ret),
            mechanicalEfficiency: read(a, 'etaM', context, path + 'mechanicalEfficiency'),
            volumetricEfficiency: read(a, 'etaV', context, path + 'volumetricEfficiency'),
          };
        }),
      };
    });
    const request = {
      pumpId: groupPump ?? selector(root, '#' + id('Pump')),
      ...(boundaryMode ? { boundary: true } : {}),
      angularSpeedRadPerS: rpm === null ? null : toSI('angularSpeed', rpm),
      pumpVolumetricEfficiency: etaV,
      totalEfficiency: etaTotal,
      pressureLimitPa: limit === null ? null : toSI('pressure', limit),
      phases,
      automaticFields,
    };
    const phaseOf = (issue: FormIssue) => issue.control.closest<HTMLElement>('[data-duty-phase]');
    const globalIssues = issues.filter((issue) => !phaseOf(issue));
    if (!collectCombined && (report ? !globalIssues.length : !issues.length)) {
      for (const [phaseIndex, phase] of phases.entries()) {
        if (report && issues.some((issue) => phaseOf(issue) === phaseElements[phaseIndex])) continue;
        const missing = missingValves.filter(
          (item) => item.control.closest('[data-duty-phase]') === phaseElements[phaseIndex],
        );
        if (!missing.length) continue;
        let combinations: { componentId: string; positionId: string }[][] = [[]];
        for (const item of missing) {
          const positions = [...item.control.options].map((option) => option.value).filter(Boolean);
          if (combinations.length * positions.length > 81) {
            combinations = [];
            break;
          }
          combinations = combinations.flatMap((entries) =>
            positions.map((positionId) => [
              ...entries,
              { componentId: item.control.dataset.dutyValve ?? '', positionId },
            ]),
          );
        }
        const attempts = combinations.map((entries) => ({
          entries,
          result: checkNetworkDuty(project, {
            ...request,
            automaticFields: [],
            phases: [
              {
                ...phase,
                valves: phase.valves.map(
                  (valve) => entries.find((entry) => entry.componentId === valve.componentId) ?? valve,
                ),
              },
            ],
          }),
        }));
        const matches = attempts.filter((attempt) => attempt.result.ok).map((attempt) => attempt.entries);
        const match = matches.length === 1 ? matches[0] : undefined;
        if (!match) {
          if (
            report &&
            attempts.length &&
            attempts.every(
              ({ result }) =>
                !result.ok && result.diagnostics.some((item) => item.code === 'DUTY_COMPONENT_UNSUPPORTED'),
            )
          ) {
            for (const item of missing)
              item.message = phase.name + ' / ' + item.control.dataset.fieldLabel + '：阀位尚未确认。';
            continue;
          }
          const reasons = [
            ...new Set(
              attempts.flatMap((attempt) =>
                attempt.result.ok ? [] : attempt.result.diagnostics.map((diagnostic) => diagnostic.message),
              ),
            ),
          ];
          const explanation = !combinations.length
            ? '自动识别组合超过81种，请先手动指定部分阀位。'
            : matches.length > 1
              ? '存在多个可行阀位，请手动选择本工况阀位。'
              : '未识别到可计算阀位，请核对工况数值与接线，或手动指定后核算。' + reasons.join('；');
          for (const item of missing)
            item.message = phase.name + ' / ' + item.control.dataset.fieldLabel + '：' + explanation;
          continue;
        }
        for (const item of missing) {
          const resolved = match.find((entry) => entry.componentId === item.control.dataset.dutyValve);
          const valve = phase.valves.find((entry) => entry.componentId === resolved?.componentId);
          if (!resolved || !valve) continue;
          valve.positionId = resolved.positionId;
          item.control.value = resolved.positionId;
          item.control.dataset.autoMatch = 'true';
          item.control.title = '已识别 · 当前动作与接线下唯一可行的阀位';
          missingValves.splice(missingValves.indexOf(item), 1);
        }
      }
    }
    if (report) {
      const ready: typeof phases = [];
      const phaseIndexes = new Map<number, number>();
      for (const [index, phase] of phases.entries()) {
        const element = phaseElements[index];
        const problems = [
          ...globalIssues,
          ...[...issues, ...missingValves].filter((issue) => phaseOf(issue) === element),
        ];
        if (!problems.length) {
          phaseIndexes.set(index, ready.length);
          ready.push(phase);
          continue;
        }
        const messages = [...new Set(problems.map((problem) => problem.message))];
        const reason =
          messages.slice(0, 4).join('；') + (messages.length > 4 ? `；另有 ${messages.length - 4} 项条件需核对。` : '');
        const partial = phase.flowSplit
          ? parallelFlowTargets(project, phase.actions).map(
              (target) =>
                `${target.label} 目标 ${fromSI('flow', target.targetFlowM3PerS).toPrecision(5)} L/min，${fromSI('linearSpeed', target.targetSpeedMPerS).toPrecision(5)} mm/s`,
            )
          : [];
        report.push({
          name: phase.name || '工况 ' + element?.dataset.dutyPhase,
          kind: 'incomplete',
          reason:
            (reason.length > 1100 ? reason.slice(0, 1100) + '…（其余条件见工况输入）' : reason) +
            (partial.length ? '。实际分流待核。已知目标：' + partial.join('；') + '。' : ''),
        });
      }
      if (!ready.length) return null;
      if (collectCombined) {
        const parsed = parseNetworkDutyPhases(ready);
        if (parsed.ok) collectCombined(parsed.value);
        else {
          const reason = parsed.diagnostics.map((item) => item.message).join('；');
          for (const phase of ready) report.push({ name: phase.name, kind: 'incomplete', reason });
        }
        return null;
      }
      const parsed = parseNetworkDutyRequest({
        ...request,
        phases: ready,
        automaticFields: automaticFields.flatMap((path) => {
          const match = /^\/phases\/(\d+)\/(.*)$/.exec(path);
          if (!match) return [path];
          const index = phaseIndexes.get(Number(match[1]));
          return index === undefined ? [] : [`/phases/${index}/${match[2]}`];
        }),
      });
      if (parsed.ok) return parsed.value;
      const reason = parsed.diagnostics.map((item) => item.message).join('；');
      for (const phase of ready) report.push({ name: phase.name, kind: 'incomplete', reason });
      return null;
    }
    if (issues.length || missingValves.length) {
      root.dispatchEvent(new Event('calculation:invalid'));
      const first = [...issues, ...missingValves][0]?.control.closest<HTMLElement>('[data-duty-phase]');
      if (first) {
        visiblePhase = first.dataset.dutyPhase ?? '';
        refreshPhaseNavigation();
      }
      showCalculationIssues(root, el('Status'), [...issues, ...missingValves]);
      return null;
    }
    for (const input of root.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
    const parsed = parseNetworkDutyRequest(request);
    if (!parsed.ok) {
      el('Status').textContent = parsed.diagnostics.map((item) => item.message).join('；');
      return null;
    }
    return parsed.value;
  }
  el('Preview').addEventListener('click', () => {
    goal.invalidate();
    invalidate();
    if (supplyGroups.length) {
      const result = combinedMode ? combinedRecord() : independentRecord();
      if (!result.ok) {
        el('Status').textContent = calculationAdvice(result.diagnostics);
        return;
      }
      calculationRecord = result.value;
      const groups = result.value.dutyGroups ?? [];
      const sections = result.value.dutyCombined
        ? dutyCombinedSections(result.value.dutyCombined)
        : dutyGroupSections(groups);
      el('Result').innerHTML = sections
        .map(
          ({ heading, paragraphs, rows }) =>
            `<section data-independent-duty-group><h3>${esc(heading)}</h3>${paragraphs.map((line) => '<p>' + esc(line) + '</p>').join('')}${rows.length ? '<table class="metric-table">' + rows.map((row, index) => '<tr>' + row.map((cell) => (index === 0 ? '<th>' + esc(cell) + '</th>' : '<td>' + esc(cell) + '</td>')).join('') + '</tr>').join('') + '</table>' : ''}</section>`,
        )
        .join('');
      el('Status').textContent = combinedMode ? '已列出母线与各泵结果或待核原因。' : '各组分别列出本次结果和待核条件。';
      for (const name of ['Cancel', 'Word']) el(name).removeAttribute('disabled');
      if (result.value.steps.length) el('Export').removeAttribute('disabled');
      el('Result').scrollIntoView({ block: 'start' });
      return;
    }
    const pressurePhases = [...el('Phases').querySelectorAll('[data-duty-phase]')].some(
      (phase) =>
        phase.querySelector('[data-duty-included]:checked') &&
        phase.querySelector('[data-pump-pressure-control]:checked'),
    );
    const bypassPhases = el('Phases').querySelector('[data-duty-filter-bypass]:checked') !== null;
    if (pressurePhases || bypassPhases) {
      const { duty, pendingPhases } = readDutyReport(false);
      const result = prepareNetworkDutyCalculation(hooks.editor(), duty, pendingPhases);
      if (!result.ok) {
        el('Status').textContent = calculationAdvice(result.diagnostics);
        return;
      }
      calculationRecord = result.value;
      const coverage = result.value.dutyCoverage;
      const sections = coverage ? dutyCoverageSections(coverage) : [];
      el('Result').innerHTML = sections
        .map(
          ({ heading, paragraphs, rows }) =>
            `<section data-pump-pressure-result><h3>${esc(heading)}</h3>${paragraphs.map((line) => '<p>' + esc(line) + '</p>').join('')}${rows.length ? '<table class="metric-table">' + rows.map((row, index) => '<tr>' + row.map((cell) => (index === 0 ? '<th>' + esc(cell) + '</th>' : '<td>' + esc(cell) + '</td>')).join('') + '</tr>').join('') + '</table>' : ''}</section>`,
        )
        .join('');
      el('Status').textContent = pressurePhases
        ? '已列出压力调节稳态工作点和待核工况。'
        : '已列出滤芯内置旁通和待核工况。';
      for (const name of ['Cancel', 'Word']) el(name).removeAttribute('disabled');
      if (result.value.steps.length) el('Export').removeAttribute('disabled');
      enterSelection.disabled = true;
      el('Result').scrollIntoView({ block: 'start' });
      return;
    }
    if (boundaryMode) {
      const { duty, pendingPhases } = readDutyReport(false);
      const report = prepareNetworkDutyCalculation(hooks.editor(), duty, pendingPhases);
      if (!report.ok) {
        el('Status').textContent = calculationAdvice(report.diagnostics);
        return;
      }
      calculationRecord = report.value;
      const rows = report.value.dutyCoverage?.phases ?? [];
      const details = report.value.steps.map(
        (step) =>
          '<li>' +
          esc(step.label) +
          ' · ' +
          (step.display.value.kind === 'known' ? Number(step.display.value.value.toPrecision(6)) : '待核') +
          ' ' +
          esc(step.display.unit) +
          '</li>',
      );
      el('Result').innerHTML =
        '<h3>供压、储能与增压工况</h3>' +
        rows
          .map(
            (row) =>
              '<p><strong>' +
              esc(row.name) +
              '</strong> · ' +
              esc(row.kind === 'calculated' ? (row.demand.boundaryAssessment?.summary ?? '') : row.reason) +
              '</p>',
          )
          .join('') +
        (details.length ? '<details open><summary>分项结果</summary><ul>' + details.join('') + '</ul></details>' : '');
      el('Status').textContent = '已列出边界核算结果及待核条件。';
      el('Cancel').removeAttribute('disabled');
      el('Word').removeAttribute('disabled');
      if (details.length) el('Export').removeAttribute('disabled');
      el('Result').scrollIntoView({ block: 'start' });
      return;
    }
    const input = readDutyRequest();
    el('Word').removeAttribute('disabled');
    if (input === null) return;
    const checked = previewNetworkGoal(hooks.editor(), { mode: 'check', duty: input, variables: [] });
    if (!checked.ok) {
      hooks.diagnostics(checked.diagnostics);
      invalidate(calculationAdvice(checked.diagnostics));
      el('Word').removeAttribute('disabled');
      return;
    }
    const candidate = checked.value.plan.current;
    const splits = candidate.phases.flatMap((phase) =>
      isDutySupplyDemand(phase) && phase.flowSplit ? dutyFlowSplitSections(phase.name, phase.flowSplit) : [],
    );
    const hasReturn = candidate.phases.some((phase) => phase.springReturn);
    const workLines = candidate.phases.some(
      (phase) => phase.flowSplit?.kind === 'solved' && phase.flowSplit.workingSegments,
    );
    const satisfied = networkGoalSupplySatisfied(candidate);
    const perPhasePump = candidate.request.phases.some((phase) => phase.pumpCommandPercent !== undefined);
    const pumpSupply = perPhasePump
      ? '变量泵估计供流按工况列在计算过程中。'
      : '核算转速下泵估计供给 ' + fromSI('flow', candidate.availableFlowM3PerS).toPrecision(5) + ' L/min。';
    calculationRecord = candidate.record;
    const plan = previewNetworkDuty(hooks.editor(), input);
    if (plan.ok) preview = plan.value;
    el('Result').dataset.satisfied = String(satisfied);
    el('Result').innerHTML =
      `<h3>校核当前设计</h3><p class="calculation-result-status">${hasReturn ? (satisfied ? '所列稳态供油及回程力条件满足。' : '存在供油或回程力缺口，请查看限制。') : satisfied ? '当前参数满足本次稳态供油条件。' : splits.length ? '当前分流工况待核或未达目标，请查看各支路结果。' : '当前设计有供油缺口，请查看限制或使用自动选配。'}</p><p>供油预算 ${fromSI('pressure', candidate.request.pressureLimitPa).toPrecision(5)} MPa · ${candidate.request.automaticFields?.includes('/pressureLimitPa') ? '自动试算起点' : '手动条件'}；${pumpSupply}</p>${dutyLimits(candidate)}<details><summary>计算过程与假设</summary>${candidate.record.steps.map((step) => '<details><summary>' + esc(step.label) + '：' + (step.display.value.kind === 'known' ? step.display.value.value.toPrecision(7) : '未知') + ' ' + esc(step.display.unit) + '</summary><p>' + esc(step.formula) + '</p><p>' + esc(step.substitution) + '</p><p>' + esc(step.display.conversion) + '</p></details>').join('')}${candidate.record.assumptions.map((s) => '<p>' + esc(s) + '</p>').join('')}</details>`;
    const overview = document.createElement('div');
    overview.innerHTML =
      `${splits.length && !workLines ? '<p>以下基础目标表未计入实际分流的阀口和干线压降，实际值见分支结果。</p>' : ''}<table class="metric-table"><thead><tr><th>工况</th><th>压力 MPa</th><th>流量 L/min</th><th>${hasReturn ? '轴功率 kW 或回程力' : '轴功率估计 kW'}</th></tr></thead><tbody>` +
      demandRows(candidate, 'kW') +
      '</tbody></table>';
    el('Result').querySelector('.calculation-result-status')?.after(overview);
    let previousSection: Element = overview;
    for (const { heading, paragraphs, rows } of splits) {
      const section = document.createElement('section');
      section.dataset.flowSplitResult = '';
      section.innerHTML = `<h3>${esc(heading)}</h3>${paragraphs.map((text) => '<p>' + esc(text) + '</p>').join('')}<table class="metric-table">${rows.map((row, index) => '<tr>' + row.map((cell) => (index ? '<td>' + esc(cell) + '</td>' : '<th>' + esc(cell) + '</th>')).join('') + '</tr>').join('')}</table>`;
      previousSection.after(section);
      previousSection = section;
    }
    el('Result').scrollIntoView({ block: 'start' });
    el('Status').textContent = el('Result').querySelector('.calculation-result-status')?.textContent ?? '';
    if (preview) el('Apply').removeAttribute('disabled');
    for (const name of ['Cancel', 'Export', 'Word']) el(name).removeAttribute('disabled');
    enterSelection.disabled = splits.length > 0;
  });
  el('Cancel').addEventListener('click', () => invalidate('已取消预览；工程保留。'));
  el('Apply').addEventListener('click', () => {
    if (preview && hooks.apply(preview)) invalidate('已应用指定泵；可一次撤销，阀位/负载未改，需重新初始化。');
  });
  el('Word').addEventListener('click', () => {
    exportDutyBook(false);
  });
  el('Export').addEventListener('click', () => {
    if (!calculationRecord) return;
    const artifact = exportCalculationCsv(calculationRecord, hooks.uid('duty'), new Date().toISOString());
    if (artifact.ok)
      void hooks.exportArtifact({
        ...artifact.value,
        suggestedName: options.mode === 'single' ? '现有回路需求与过程.csv' : '多工况需求与过程.csv',
      });
    else hooks.diagnostics(artifact.diagnostics);
  });
  return {
    invalidate(message = '') {
      invalidate(message);
      catalog.invalidate('窗口已关闭，请重新筛选目录。');
    },
    render() {
      const current = hooks.editor();
      if (previous === current.document) return;
      previous = current.document;
      const pumps = current.document.design.components.filter((c) => c.typeId === 'pump');
      const sources = current.document.design.components.filter((c) => c.typeId === 'pressure-source');
      const selectable = pumps.length
        ? pumps
        : sources.length
          ? sources
          : current.document.design.components.filter((c) => c.typeId === 'accumulator');
      boundaryMode = pumps.length === 0 && selectable.length > 0;
      supplyGroups = pumps.length > 1 ? independentDutyGroups(current.document) : [];
      combinedMode = isCombinedSupplyCandidate(current.document);
      goal.render();
      const groupMode = supplyGroups.length > 0;
      const pumpLabel = el('Pump').closest('label');
      if (pumpLabel) pumpLabel.hidden = groupMode;
      el('PumpFields').hidden = groupMode || boundaryMode;
      const sourceLabel = pumpLabel?.querySelector('[data-duty-source-label]');
      if (sourceLabel) sourceLabel.textContent = boundaryMode ? '核算边界' : '指定泵';
      enterSelection.disabled =
        boundaryMode ||
        supplyGroups.some((group) => group.sharedReturnPipeId) ||
        (combinedMode && current.document.design.components.some((part) => part.typeId === 'pilot-unloading-valve'));
      catalog.invalidate('工程或约束已改变，请重新筛选目录。');
      invalidate('工程已改变，请重新预览；本次要求不自动写入工程。');
      const sig = current.document.design.components.map((c) => c.id + ':' + c.typeId + ':' + c.label).join('|');
      if (sessionId !== current.documentSessionId || signature !== sig) {
        catalog.reset();
        sessionId = current.documentSessionId;
        signature = sig;
        phaseCount = 0;
        el('Phases').textContent = '';
        groupFields.innerHTML = supplyGroups
          .map(
            ({ pump }) =>
              `<fieldset data-supply-pump="${esc(pump.id)}"><legend>${esc(pump.label || pump.id)} [${esc(pump.id)}]</legend><div class="calculation-condition-grid">${el('PumpFields').innerHTML}</div></fieldset>`,
          )
          .join('');
        const intro = root.querySelector('.calculation-intro');
        if (intro)
          intro.textContent = combinedMode
            ? current.document.design.components.some((c) => c.typeId === 'pilot-unloading-valve')
              ? '高低压双泵按母线先导压差核算卸荷，每个工况从卸荷阀关闭开始。请填写各泵条件和单缸目标，选择换向阀工作位。'
              : '多泵合流按各泵转速、效率及实际止回阀核算。请填写参与执行器的目标和各换向阀位置。'
            : groupMode
              ? supplyGroups.some((group) => group.sharedReturnPipeId)
                ? '两泵各自供油、共用有损回油。请在同一工况勾选两缸，手填供油损失为 0，回油基准取油箱压力。'
                : '独立供油按实际接线分组。在计算条件中分别填写各泵转速、效率和预算，再选择各缸工况。'
              : boundaryMode
                ? '使用保存的恒压源参数或指定蓄能器油量，按工况查看供油、储能和增压结果。'
                : '选择本次工况与参与动作，填写目标要求。';
        el('Pump').innerHTML =
          '<option value="">请选择核算元件</option>' +
          selectable.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.label || c.id) + '</option>').join('');
        const pumpControl = el('Pump');
        if (selectable.length === 1 && selectable[0] && pumpControl instanceof HTMLSelectElement)
          pumpControl.value = selectable[0].id;
        for (const input of root.querySelectorAll<HTMLInputElement>('[data-duty-field]')) {
          input.value = '';
          delete input.dataset.edited;
        }
        addPhase();
      }
      for (const phase of el('Phases').querySelectorAll('[data-duty-phase]')) refreshSplitFields(phase);
      if (automaticEnabled()) seedAutomatic();
      else {
        seedPump();
        const boundary = sourcePressureSeed(current.document),
          limit = el('PumpFields').querySelector('[data-duty-field="limit"]');
        if (limit instanceof HTMLInputElement) seedCalculationInput(limit, boundary.value, boundary.source);
      }
      el('SavedBoundary').textContent =
        current.document.design.components
          .filter((c) => c.typeId === 'relief' || c.typeId === 'tank')
          .map((c) => {
            const pressure =
              c.typeId === 'relief'
                ? c.parameters.hydraulic?.settingDifferentialPa
                : c.parameters.hydraulic?.pressurePa;
            return (
              c.label +
              '：' +
              (c.typeId === 'relief' ? '开启压差 ' : '油箱压力 ') +
              (pressure === undefined ? '未指定' : fromSI('pressure', pressure) + ' MPa')
            );
          })
          .join('；') + '。保存值与自动假设分别标注；手动条件优先，预算不改变实际供油能力。';
      for (const node of root.querySelectorAll<HTMLElement>('[data-duty-saved]')) {
        const c = current.document.design.components.find((c) => c.id === node.dataset.dutySaved);
        if (c) node.textContent = savedText(c);
      }
    },
  };
}
