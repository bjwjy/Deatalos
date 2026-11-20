import { bindEngineeringInputs, engineeringInputValue } from './network-engineering-inputs.mjs';
import {
  previewIndependentNetworkGoal,
  previewCombinedNetworkGoal,
  dutyCombinedSections,
  previewNetworkGoal,
  type NetworkDraftSession,
  type NetworkGoalCandidatePreview,
} from '@hyd/application';
import {
  networkGoalOptions,
  isDutySupplyDemand,
  networkSelectionPolicy,
  parseNetworkDutyRequest,
  type IndependentGoalGroup,
  type CombinedDutyCoverage,
  type NetworkDutyPlan,
  type NetworkDutyRequest,
  type NetworkGoalSelection,
} from '@hyd/engineering';
import { engineeringValueText, fromSI, toSI, parameterDisplayName, isLinearActuatorType } from '@hyd/domain';
import { escapeHtml as esc } from './network-dom.mjs';
interface GoalHooks {
  editor(): NetworkDraftSession;
  readDuty(): unknown | null;
  readIndependent(): readonly IndependentGoalInput[] | null;
  readCombined(): unknown | null;
  combined(): boolean;
  apply(preview: NetworkGoalCandidatePreview, index: number): boolean;
}
export type IndependentGoalInput = { readonly pumpId: string } & (
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly reason: string }
  | { readonly kind: 'ready'; readonly duty: NetworkDutyRequest }
);
const pressure = (value: number) => fromSI('pressure', value).toPrecision(6);
const flow = (value: number) => fromSI('flow', value).toPrecision(5);
export function dutyLimits(plan: NetworkDutyPlan): string {
  const name = (id: string) => plan.document.design.components.find((item) => item.id === id)?.label ?? id;
  const constraints = plan.constraints.map((item) => {
    const budget = item.kind === 'pressure-budget';
    return `<li>${esc(item.phase)} · ${esc(budget ? '供油预算' : name(item.componentId) + ' 溢流压差')}，需求 ${pressure(item.requiredPa)} MPa，限制 ${pressure(item.limitPa)} MPa，${budget ? '差 ' + pressure(item.requiredPa - item.limitPa) + ' MPa' : '达到或超过开启值'}。</li>`;
  });
  for (const phase of plan.phases) {
    if (phase.boundaryAssessment) {
      if (!phase.boundaryAssessment.satisfied)
        constraints.push(`<li>${esc(phase.name)} · ${esc(phase.boundaryAssessment.summary)}</li>`);
      continue;
    }
    if (phase.springReturn) {
      if (phase.springReturn.forceMarginN < 0)
        constraints.push(
          `<li>${esc(phase.name)} · 回程力不足 ${(-phase.springReturn.forceMarginN).toPrecision(5)} N。</li>`,
        );
      continue;
    }
    const difference = phase.flowM3PerS - (phase.availableFlowM3PerS ?? plan.availableFlowM3PerS);
    if (phase.supplyBalanceIssue) constraints.push(`<li>${esc(phase.name)} · ${esc(phase.supplyBalanceIssue)}</li>`);
    else if (difference > phase.flowM3PerS * 1e-10)
      constraints.push(`<li>${esc(phase.name)} · 供油流量少 ${flow(difference)} L/min。</li>`);
  }
  const relief = plan.reliefLimits.map(
    (item) =>
      `${item.phase} · ${name(item.componentId)} ${item.kind === 'internal' ? '内置' : '外置'}溢流开启压差 ${pressure(item.differentialPa)} MPa`,
  );
  return (
    (constraints.length ? '<ul class="goal-constraints">' + constraints.join('') + '</ul>' : '') +
    `<p class="muted">实际溢流边界 · ${relief.length ? relief.map(esc).join('；') : '未识别到已接通的溢流边界'}</p>`
  );
}
export function demandRows(plan: NetworkDutyPlan, powerUnit: 'W' | 'kW' = 'W'): string {
  return plan.phases
    .map((phase) =>
      phase.boundaryAssessment
        ? `<tr><td>${esc(phase.name)}</td><td colspan="3">${esc(phase.boundaryAssessment.summary)}</td></tr>`
        : phase.springReturn
          ? `<tr><td>${esc(phase.name)}</td><td>A 腔 ${pressure(phase.springReturn.backPressurePa)}</td><td>回油 ${flow(phase.springReturn.flowM3PerS)}</td><td>力裕量 ${phase.springReturn.forceMarginN.toPrecision(5)} N${phase.springReturn.forceMarginN < 0 ? '（不足）' : ''}</td></tr>`
          : `<tr><td>${esc(phase.name)}</td><td>${pressure(phase.pressurePa)}</td><td>${flow(phase.flowM3PerS)}</td><td>${(phase.shaftPowerW / (powerUnit === 'kW' ? 1000 : 1)).toPrecision(6)}</td></tr>`,
    )
    .join('');
}
function cylinderSizes(plan: NetworkDutyPlan): string {
  const ids = new Set(plan.request.phases.flatMap((phase) => phase.actions.map((action) => action.componentId)));
  return plan.document.design.components
    .flatMap((item) => {
      const cap = item.parameters.geometry?.capAreaM2,
        annulus = item.parameters.geometry?.rodSideAreaM2;
      if (!ids.has(item.id) || !isLinearActuatorType(item.typeId)) return [];
      const equal = item.parameters.geometry?.equalAnnularAreaM2;
      if (equal !== undefined) return [esc(item.label) + ' 两腔各 ' + (equal * 1e6).toPrecision(4) + ' mm²'];
      if (cap === undefined) return [];
      const diameter = (area: number) => (2000 * Math.sqrt(area / Math.PI)).toPrecision(4);
      if (annulus === undefined) return [esc(item.label) + ' 缸径 ' + diameter(cap) + ' mm'];
      return [esc(item.label) + ' ' + diameter(cap) + ' / ' + diameter(cap - annulus) + ' mm'];
    })
    .join('；');
}
function componentSummary(plan: NetworkDutyPlan): string {
  const ids = new Set(plan.request.phases.flatMap((phase) => phase.actions.map((action) => action.componentId)));
  const components = plan.document.design.components.filter((item) => ids.has(item.id));
  return (
    components.filter((item) => isLinearActuatorType(item.typeId)).length +
    ' 缸 · ' +
    components.filter((item) => item.typeId === 'motor').length +
    ' 马达 · 1 泵'
  );
}
function componentDetails(plan: NetworkDutyPlan): string {
  const ids = new Set([
    plan.request.pumpId,
    ...plan.request.phases.flatMap((phase) => phase.actions.map((action) => action.componentId)),
  ]);
  const motors = plan.document.design.components.filter((item) => ids.has(item.id) && item.typeId === 'motor');
  const pumps = plan.document.design.components.filter((item) => ids.has(item.id) && item.typeId === 'pump');
  const displacement = (value: number | undefined) =>
    value === undefined ? '待补充' : fromSI('displacement', value).toPrecision(5) + ' cm³/rev';
  return (
    '<div class="goal-component-details">' +
    (cylinderSizes(plan) ? '<section><h4>液压缸 · 保存几何</h4><p>' + cylinderSizes(plan) + '</p></section>' : '') +
    motors
      .map(
        (item) =>
          '<section><h4>液压马达 · ' +
          esc(item.label) +
          '</h4><p>排量 ' +
          displacement(item.parameters.hydraulic?.displacementM3PerRev) +
          '</p></section>',
      )
      .join('') +
    pumps
      .map(
        (item) =>
          '<section><h4>泵 · ' +
          esc(item.label) +
          '</h4><p>排量 ' +
          displacement(item.parameters.hydraulic?.displacementM3PerRev) +
          ' · 转速 ' +
          fromSI('angularSpeed', plan.request.angularSpeedRadPerS).toPrecision(5) +
          ' r/min</p></section>',
      )
      .join('') +
    '</div><details><summary>各工况动作与目标</summary>' +
    plan.request.phases
      .map(
        (phase) =>
          '<h4>' +
          esc(phase.name) +
          '</h4>' +
          phase.actions
            .map((action) => {
              const item = plan.document.design.components.find((component) => component.id === action.componentId);
              const motor = item?.typeId === 'motor';
              return (
                '<p>' +
                esc(item?.label ?? action.componentId) +
                ' · ' +
                (action.direction === 'forward' ? (motor ? '正转' : '伸出') : motor ? '反转' : '缩回') +
                ' · ' +
                fromSI(motor ? 'angularSpeed' : 'linearSpeed', action.speed).toPrecision(5) +
                (motor ? ' r/min · ' : ' mm/s · ') +
                fromSI(motor ? 'torque' : 'force', action.resistingLoad).toPrecision(5) +
                (motor ? ' N·m' : ' kN') +
                '</p>'
              );
            })
            .join(''),
      )
      .join('') +
    '</details>'
  );
}
function groupResult(group: IndependentGoalGroup): string {
  if (group.kind === 'idle') return '本次未参与动作';
  if (group.kind === 'pending') return '待核 · ' + group.reason;
  return (group.satisfied ? '稳态供油条件满足' : '当前供油有缺口') + (group.note ? ' · ' + group.note : '');
}
function groupSummary(groups: readonly IndependentGoalGroup[]): string {
  return groups
    .map((group) => {
      const driven = group.kind === 'evaluated' ? group.analysis.phases.filter(isDutySupplyDemand) : [];
      const metrics =
        driven.length && group.kind === 'evaluated'
          ? ' · ' +
            pressure(Math.max(...driven.map((p) => p.pressurePa))) +
            ' MPa · ' +
            flow(Math.max(...driven.map((p) => p.flowM3PerS))) +
            ' / ' +
            flow(group.analysis.availableFlowM3PerS) +
            ' L/min · ' +
            Math.max(...driven.map((p) => p.shaftPowerW)).toPrecision(5) +
            ' W'
          : '';
      return (
        '<p data-independent-goal-group><strong>' +
        esc(group.pumpLabel) +
        '</strong> · ' +
        esc(groupResult(group) + metrics) +
        '</p>'
      );
    })
    .join('');
}
function analysisDetails(plan: NetworkDutyPlan): string {
  return (
    componentDetails(plan) +
    '<h4>工况需求</h4><table class="metric-table"><thead><tr><th>工况</th><th>压力 / MPa</th><th>流量 / L/min</th><th>轴功率 / W 或回程力</th></tr></thead><tbody>' +
    demandRows(plan) +
    '</tbody></table>' +
    dutyLimits(plan)
  );
}
function groupDetails(groups: readonly IndependentGoalGroup[]): string {
  return groups
    .map(
      (group) =>
        '<section data-independent-goal-detail><h4>' +
        esc(group.pumpLabel) +
        '</h4><p>' +
        esc([group.actuatorLabel, group.tankLabel, groupResult(group)].filter(Boolean).join(' · ')) +
        '</p>' +
        (group.kind === 'evaluated'
          ? '<p>试算预算 ' +
            pressure(group.analysis.request.pressureLimitPa) +
            ' MPa · 估计供给 ' +
            flow(group.analysis.availableFlowM3PerS) +
            ' L/min</p>' +
            analysisDetails(group.analysis)
          : '') +
        '</section>',
    )
    .join('');
}

function combinedSummary(coverage: CombinedDutyCoverage): string {
  return coverage.phases
    .map((phase) => {
      const power = phase.pumps.reduce<number | null>(
        (sum, pump) =>
          sum === null || pump.kind !== 'solved' || pump.shaftPowerW === undefined ? null : sum + pump.shaftPowerW,
        0,
      );
      return (
        '<p data-combined-goal-phase><strong>' +
        esc(phase.name) +
        '</strong> · ' +
        esc(
          phase.kind === 'pending'
            ? '待核 · ' + phase.reason
            : '母线 ' +
                pressure(phase.busPa) +
                ' MPa · ' +
                phase.loads.filter((load) => load.matchesTarget).length +
                '/' +
                phase.loads.length +
                ' 个执行器达标 · ' +
                (phase.matchesTarget ? '各泵预算满足' : '工况有缺口') +
                ' · ' +
                (power === null ? '总轴功率待核' : '总轴功率 ' + power.toPrecision(5) + ' W'),
        ) +
        '</p>'
      );
    })
    .join('');
}

function combinedDetails(coverage: CombinedDutyCoverage): string {
  return dutyCombinedSections(coverage)
    .map(
      (section) =>
        '<section data-combined-goal-detail><h4>' +
        esc(section.heading) +
        '</h4>' +
        section.paragraphs.map((line) => '<p>' + esc(line) + '</p>').join('') +
        '<table class="metric-table"><tbody>' +
        (section.rows ?? [])
          .map(
            (row, index) =>
              '<tr>' +
              row.map((cell) => (index === 0 ? '<th>' + esc(cell) + '</th>' : '<td>' + esc(cell) + '</td>')).join('') +
              '</tr>',
          )
          .join('') +
        '</tbody></table></section>',
    )
    .join('');
}

/** Goal UI owns only form buffers and a captured preview; all calculations/permissions live in core modules. */
export function createNetworkGoal(root: HTMLElement, hooks: GoalHooks) {
  let owner: NetworkDraftSession['document'] | null = null,
    preview: NetworkGoalCandidatePreview | null = null,
    selected = 0;
  let detail: number | null = null;
  let confirming = false;
  root.className = 'goal-tools';
  root.innerHTML =
    '<h3>方案比较</h3><p class="muted">比较关键指标，查看每个元件的参数与工况。</p><div class="goal-budget"><label>供油预算<select data-goal-budget><option value="source">沿用输入来源</option><option value="fixed">固定试算值</option><option value="range">指定范围</option></select></label><div data-goal-range hidden><label>下限 / MPa<input type="number" step="any" data-goal-budget-min></label><label>上限 / MPa<input type="number" step="any" data-goal-budget-max></label></div></div><details data-goal-advanced><summary>允许调整的参数与范围</summary><div data-goal-variables></div></details><div class="goal-actions"><button type="button" data-goal-check>校核当前设计</button><button type="button" data-goal-solve class="primary">自动选配</button><button type="button" data-goal-apply disabled>应用所选方案</button><button type="button" data-goal-cancel disabled hidden>取消候选</button><span data-goal-apply-hint>先计算得到有效方案</span></div><p data-goal-status role="status"></p><div data-goal-result></div>';
  const node = (selector: string): HTMLElement => {
    const e = root.querySelector<HTMLElement>(selector);
    if (!e) throw new Error('Goal view element missing: ' + selector);
    return e;
  };
  function invalidate(message = ''): void {
    preview = null;
    selected = 0;
    detail = null;
    confirming = false;
    node('[data-goal-apply]').setAttribute('disabled', '');
    node('[data-goal-cancel]').setAttribute('disabled', '');
    node('[data-goal-status]').textContent = message;
    node('[data-goal-result]').textContent = '';
    node('[data-goal-apply-hint]').textContent = message || '先计算得到有效方案';
    node('[data-goal-apply]').title = '没有有效方案，请使用自动选配';
  }
  function calculate(mode: 'check' | 'solve'): void {
    invalidate();
    const number = (row: Element, selector: string) => {
      const input = row.querySelector<HTMLInputElement>(selector);
      return input?.value.trim() ? engineeringInputValue(input) : null;
    };
    const combined = hooks.readCombined();
    if (combined !== null) {
      const variables =
        mode === 'check'
          ? []
          : [...root.querySelectorAll<HTMLElement>('[data-goal-variable]')]
              .filter((row) => row.querySelector<HTMLInputElement>('[data-goal-selected]')?.checked)
              .map((row) => ({
                componentId: row.dataset.component,
                minimum: number(row, '[data-goal-min]'),
                maximum: number(row, '[data-goal-max]'),
              }));
      const result = previewCombinedNetworkGoal(hooks.editor(), { mode, duty: combined, variables });
      if (!result.ok) {
        node('[data-goal-status]').textContent = result.diagnostics.map((d) => d.message).join('；');
        return;
      }
      preview = result.value;
      const { current, alternatives, reason } = result.value.plan;
      node('[data-goal-result]').innerHTML =
        '<div class="goal-comparison"><table class="metric-table"><thead><tr><th>方案</th><th>泵排量改动</th><th>合流工况</th><th></th></tr></thead><tbody>' +
        [current, ...alternatives.map((item) => item.analysis)]
          .map((item, index) => {
            const changes = alternatives[index - 1]?.changes
              .map((change) => {
                const part = result.value.sourceDocument.design.components.find(
                  (part) => part.id === change.componentId,
                );
                return (
                  '<p>' +
                  esc(part?.label || change.componentId) +
                  ' · ' +
                  Number((change.before * 1e6).toPrecision(6)) +
                  ' → ' +
                  Number((change.after * 1e6).toPrecision(6)) +
                  ' cm³/rev</p>'
                );
              })
              .join('');
            return (
              '<tr><td>' +
              comparisonChoice(index) +
              '</td><td>' +
              (changes || '工程保存参数') +
              '</td><td>' +
              combinedSummary(item) +
              '</td><td><button type="button" data-goal-detail="' +
              (index - 1) +
              '">查看详情</button></td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div><div data-goal-selected-detail></div>';
      node('[data-goal-status]').textContent = reason;
      finishComparison();
      return;
    }
    const goalInput = (duty: NetworkDutyRequest) => {
      const involved = new Set([
        duty.pumpId,
        ...duty.phases.flatMap((phase) => phase.actions.map((action) => action.componentId)),
      ]);
      const variables =
        mode === 'check'
          ? []
          : [...root.querySelectorAll<HTMLElement>('[data-goal-variable]')]
              .filter(
                (row) =>
                  involved.has(row.dataset.component ?? '') &&
                  row.querySelector<HTMLInputElement>('[data-goal-selected]')?.checked,
              )
              .map((row) => ({
                componentId: row.dataset.component,
                group: row.dataset.group,
                key: row.dataset.key,
                minimum: number(row, '[data-goal-min]'),
                maximum: number(row, '[data-goal-max]'),
              }));
      const automatic = budget === 'source' && duty.automaticFields?.includes('/pressureLimitPa');
      const selection: NetworkGoalSelection =
        budget === 'range' && minimum !== null && maximum !== null
          ? {
              version: networkSelectionPolicy.version,
              mode: 'range',
              minimumPa: toSI('pressure', minimum),
              maximumPa: toSI('pressure', maximum),
            }
          : { version: networkSelectionPolicy.version, mode: automatic ? 'automatic' : 'fixed' };
      return { duty, variables, ...(mode === 'solve' ? { selection } : {}) };
    };
    const budget = root.querySelector<HTMLSelectElement>('[data-goal-budget]')?.value;
    const minimum = number(root, '[data-goal-budget-min]'),
      maximum = number(root, '[data-goal-budget-max]');
    if (
      mode === 'solve' &&
      budget === 'range' &&
      (minimum === null || maximum === null || minimum <= 0 || maximum < minimum)
    ) {
      node('[data-goal-status]').textContent = '请填写有效的供油预算上下限。';
      return;
    }
    const groups = hooks.readIndependent();
    if (groups) {
      const result = previewIndependentNetworkGoal(hooks.editor(), {
        mode,
        groups: groups.map((group) =>
          group.kind === 'ready' ? { pumpId: group.pumpId, kind: group.kind, goal: goalInput(group.duty) } : group,
        ),
      });
      if (!result.ok) {
        node('[data-goal-status]').textContent = result.diagnostics.map((d) => d.message).join('；');
        return;
      }
      preview = result.value;
      const plan = result.value.plan;
      const rows = [plan.current, ...plan.alternatives.map((item) => item.groups)];
      node('[data-goal-result]').innerHTML =
        '<div class="goal-comparison"><table class="metric-table"><thead><tr><th>方案</th>' +
        '<th>各供油组 · 峰值需求压力、最大需求 / 估计供给、峰值轴功率</th><th></th></tr></thead><tbody>' +
        rows
          .map(
            (item, index) =>
              '<tr><td>' +
              comparisonChoice(index) +
              '</td><td>' +
              groupSummary(item) +
              '</td><td><button type="button" data-goal-detail="' +
              (index - 1) +
              '">查看详情</button></td></tr>',
          )
          .join('') +
        '</tbody></table></div><div data-goal-selected-detail></div>';
      node('[data-goal-status]').textContent =
        plan.status === 'candidate'
          ? '找到 ' + plan.alternatives.length + ' 个独立供油稳态候选。比较后选择应用。'
          : plan.status === 'current-satisfied'
            ? '各参与组的当前稳态供油条件满足。'
            : plan.status === 'pending'
              ? '缺少可核对的供油组或工况条件，见各组说明。'
              : '当前没有覆盖全部参与组的可行方案，见各组详情。';
      finishComparison();
      return;
    }
    const input = hooks.readDuty();
    if (input === null) {
      node('[data-goal-status]').textContent = '请先补齐工况。多泵合流、卸荷等接法请在工况页校核当前设计。';
      return;
    }
    const parsed = parseNetworkDutyRequest(input);
    if (!parsed.ok) {
      node('[data-goal-status]').textContent = parsed.diagnostics.map((item) => item.message).join('；');
      return;
    }
    const duty = parsed.value;
    const request = goalInput(duty);
    const result = previewNetworkGoal(hooks.editor(), { mode, ...request });
    if (!result.ok) {
      node('[data-goal-status]').textContent = result.diagnostics.map((d) => d.message).join('；');
      return;
    }
    preview = result.value;
    const plan = result.value.plan;
    const comparisons = [plan.current, ...plan.alternatives.map((item) => item.analysis)];
    node('[data-goal-result]').innerHTML =
      `<div class="goal-comparison"><table class="metric-table"><thead><tr><th>方案</th><th>涉及元件</th><th>试算预算 / MPa</th><th>峰值需求 / MPa</th><th>最大需求 / L/min</th><th>估计供给 / L/min</th><th>峰值轴功率 / kW</th><th></th></tr></thead><tbody>${comparisons
        .map((item, i) => {
          const driven = item.phases.filter(isDutySupplyDemand);
          const peak = (value: (phase: (typeof driven)[number]) => number, format: (number: number) => string) =>
            driven.length ? format(Math.max(...driven.map(value))) : '—';
          return `<tr><td>${comparisonChoice(i)}</td><td>${componentSummary(item)}</td><td>${pressure(item.request.pressureLimitPa)}</td><td>${peak((p) => p.pressurePa, pressure)}</td><td>${peak((p) => p.flowM3PerS, flow)}</td><td>${flow(item.availableFlowM3PerS)}</td><td>${peak(
            (p) => p.shaftPowerW,
            (p) => (p / 1000).toPrecision(5),
          )}</td><td><button type="button" data-goal-detail="${i - 1}">查看详情</button></td></tr>`;
        })
        .join(
          '',
        )}</tbody></table><details><summary>当前设计校核</summary>${dutyLimits(plan.current)}</details></div><div data-goal-selected-detail></div>`;
    node('[data-goal-status]').textContent =
      plan.status === 'candidate'
        ? `找到 ${plan.alternatives.length} 个稳态候选。比较后选择应用。`
        : plan.status === 'current-satisfied'
          ? '当前参数覆盖目标所需的稳态供油能力，无需自动改值；实际速度/流量分配仍需仿真。'
          : mode === 'check'
            ? '当前设计有缺口，见下方压力、溢流或流量条件。'
            : plan.budgetExhausted
              ? '本次搜索达到 1024 次上限，未找到候选。'
              : '当前推荐系列与约束下未找到候选。可核对锁定、指定范围及供油边界。';
    if (
      mode === 'solve' &&
      request.selection?.mode === 'automatic' &&
      new Set(plan.current.reliefLimits.map((item) => item.phaseIndex)).size < plan.current.phases.length
    )
      node('[data-goal-status]').textContent += ' 部分工况缺少已识别的溢流边界，自动预算保持原值。';
    finishComparison();
  }
  function comparisonChoice(index: number): string {
    return index
      ? `<label><input type="radio" name="${esc(root.parentElement?.id ?? 'goal')}-candidate" data-goal-candidate value="${index - 1}" ${index === 1 ? 'checked' : ''}>方案 ${index}</label>`
      : '当前';
  }
  function finishComparison(): void {
    const advanced = node('[data-goal-advanced]');
    if (advanced instanceof HTMLDetailsElement) advanced.open = false;
    renderSelection();
    node('[data-goal-cancel]').removeAttribute('disabled');
  }
  function renderSelection(): void {
    if (!preview) return;
    const index = detail ?? selected;
    const candidate = preview.plan.alternatives[index];
    const changes = candidate?.changes ?? [];
    const target = node('[data-goal-selected-detail]');
    const options = networkGoalOptions(preview.sourceDocument);
    const rows = changes
      .map((change) => {
        const option = options.find(
          (item) => item.componentId === change.componentId && item.group + '.' + item.key === change.parameter,
        );
        return (
          '<tr><td>' +
          esc(option?.label ?? change.componentId) +
          ' · ' +
          esc(parameterDisplayName(option?.key ?? change.parameter)) +
          '</td><td>' +
          change.before.toPrecision(6) +
          '</td><td>' +
          change.after.toPrecision(6) +
          '</td><td>' +
          esc(option?.unit ?? 'SI') +
          '</td></tr>'
        );
      })
      .join('');
    const table = rows
      ? '<h4>参数改动</h4><table class="metric-table"><thead><tr><th>元件与参数</th><th>当前值</th><th>建议值</th><th>单位</th></tr></thead><tbody>' +
        rows +
        '</tbody></table>'
      : '<p>本方案保留当前参数。</p>';
    target.hidden = detail === null;
    root.querySelector<HTMLElement>('.goal-comparison')?.toggleAttribute('hidden', detail !== null);
    target.innerHTML =
      '<div class="goal-detail-heading"><button type="button" data-goal-back>← 返回对比</button><h3>' +
      (index < 0 ? '当前设计' : '方案 ' + (index + 1)) +
      '</h3></div>' +
      ('kind' in preview
        ? preview.kind === 'combined'
          ? combinedDetails(preview.plan.alternatives[index]?.analysis ?? preview.plan.current)
          : groupDetails(preview.plan.alternatives[index]?.groups ?? preview.plan.current)
        : analysisDetails(preview.plan.alternatives[index]?.analysis ?? preview.plan.current)) +
      table +
      '<section class="goal-confirm" ' +
      (confirming ? '' : 'hidden') +
      '><p>确认将以上 ' +
      changes.length +
      ' 项参数变更应用到工程？</p><button type="button" data-goal-confirm>确认应用</button><button type="button" data-goal-dismiss>继续查看</button></section>';
    const apply = node('[data-goal-apply]');
    apply.toggleAttribute('disabled', !changes.length);
    apply.title = changes.length ? '查看参数变更后应用' : '没有可应用的参数变更，请使用自动选配';
    apply.textContent = detail === null ? '应用所选方案' : '应用此方案';
    node('[data-goal-apply-hint]').textContent = candidate
      ? '方案 ' + (index + 1) + ' · ' + changes.length + ' 项变更'
      : '当前没有需要应用的参数变更';
  }
  node('[data-goal-check]').addEventListener('click', () => calculate('check'));
  node('[data-goal-solve]').addEventListener('click', () => calculate('solve'));
  node('[data-goal-cancel]').addEventListener('click', () => invalidate('候选已取消；工程未改变。'));
  node('[data-goal-apply]').addEventListener('click', () => {
    if (!preview) return;
    if (detail === null) detail = selected;
    confirming = true;
    renderSelection();
    root.querySelector('[data-goal-confirm]')?.scrollIntoView({ block: 'nearest' });
  });
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null;
    if (!target) return;
    if (target.hasAttribute('data-goal-detail')) {
      detail = Number(target.dataset.goalDetail);
      confirming = false;
      renderSelection();
      root.querySelector<HTMLButtonElement>('[data-goal-back]')?.focus();
    } else if (target.hasAttribute('data-goal-back')) {
      const previous = detail;
      detail = null;
      confirming = false;
      renderSelection();
      root.querySelector<HTMLButtonElement>('[data-goal-detail="' + previous + '"]')?.focus();
    } else if (target.hasAttribute('data-goal-confirm')) {
      if (preview && detail !== null && hooks.apply(preview, detail)) invalidate('已应用方案，可通过撤销恢复。');
    } else if (target.hasAttribute('data-goal-dismiss')) {
      confirming = false;
      renderSelection();
    }
  });
  root.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-goal-candidate]')) return;
    invalidate('条件已改变，请重新选配。');
  });
  root.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-goal-candidate]')) {
      selected = Number(event.target.value);
      renderSelection();
      return;
    }
    node('[data-goal-range]').hidden = root.querySelector<HTMLSelectElement>('[data-goal-budget]')?.value !== 'range';
    invalidate('条件已改变，请重新选配。');
  });
  return {
    invalidate,
    solve() {
      calculate('solve');
    },
    exportPlan() {
      return preview && !('kind' in preview)
        ? (preview.plan.alternatives[detail ?? selected]?.analysis ?? preview.plan.current)
        : null;
    },
    exportSource() {
      if (preview && 'kind' in preview) return '当前设计 · 多泵方案可在应用后重新核算导出';
      return preview && preview.plan.alternatives[detail ?? selected]
        ? '方案 ' + ((detail ?? selected) + 1) + ' · 未应用'
        : '当前设计';
    },
    selectedPreview() {
      return preview && !('kind' in preview) && preview.plan.alternatives[detail ?? selected]
        ? { preview, index: detail ?? selected }
        : null;
    },
    render() {
      if (owner === hooks.editor().document) return;
      owner = hooks.editor().document;
      invalidate('工程已改变，请重新校核或求解。');
      const combined = hooks.combined();
      node('.goal-budget').hidden = combined;
      node('h3 + p').textContent = combined
        ? '按工况页填写的各泵压力预算校核。自动选配调整定量泵排量，逐个验证执行器。'
        : '比较关键指标，查看每个元件的参数与工况。';
      node('[data-goal-variables]').innerHTML =
        networkGoalOptions(owner)
          .filter((v) =>
            combined
              ? v.group === 'hydraulic' &&
                v.key === 'displacementM3PerRev' &&
                owner?.design.components.some(
                  (part) => part.id === v.componentId && part.definition.id === 'teaching:pump',
                )
              : v.key !== 'settingDifferentialPa',
          )
          .map(
            (v) =>
              `<div data-goal-variable data-component="${esc(v.componentId)}" data-group="${esc(v.group)}" data-key="${esc(v.key)}"><label class="goal-variable-name"><input type="checkbox" data-goal-selected ${v.locked ? 'disabled' : v.key === 'angularSpeedRadPerS' ? '' : 'checked'}>${esc(v.label)} / ${esc(parameterDisplayName(v.key))} ${v.locked ? '🔒 已锁定' : '🔓 未锁定'}</label><label class="goal-variable-min">下限 <small>${esc(v.unit)}</small><input data-engineering-unit="${esc(v.unit)}" data-goal-min type="number" step="any" value="${v.key === 'angularSpeedRadPerS' ? v.current : v.minimum}" ${v.locked ? 'disabled' : ''}></label><label class="goal-variable-max">上限 <small>${esc(v.unit)}</small><input data-engineering-unit="${esc(v.unit)}" data-goal-max type="number" step="any" value="${v.key === 'angularSpeedRadPerS' ? v.current : v.maximum}" ${v.locked ? 'disabled' : ''}></label><small>当前 ${esc(engineeringValueText(v.current, v.unit, v.key))}</small></div>`,
          )
          .join('') || '<p>当前没有本求解支持的变量；可校核支持的工况。</p>';
      bindEngineeringInputs(node('[data-goal-variables]'));
    },
  };
}
