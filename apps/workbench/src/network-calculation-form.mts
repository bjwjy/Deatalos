import { fromSI, type DisplayDiagnostic, type NetworkProject } from '@hyd/domain';
import { escapeHtml as esc } from './network-dom.mjs';

export interface FormIssue {
  readonly control: HTMLElement;
  readonly message: string;
}
export function calculationNumber(key: string, label: string, unit: string, minimum = 0, maximum?: number): string {
  return `<label class="calculation-field"><span>${esc(label)} <small>${esc(unit)}</small></span><small data-field-error hidden></small><input data-duty-field="${key}" data-field-label="${esc(label)}" type="number" step="any" min="${minimum}"${maximum === undefined ? '' : ` max="${maximum}"`} aria-label="${esc(label)}"><small data-field-source hidden>本次要求，请明确填写</small></label>`;
}
export function seedCalculationInput(
  input: HTMLInputElement,
  value: number | undefined,
  source: string,
  origin: 'project' | 'automatic-project' | 'automatic-assumption' = 'project',
): void {
  if (input.dataset.edited === 'true') return;
  input.value = value === undefined ? '' : String(value);
  if (input.hasAttribute('aria-invalid')) validateCalculationInput(input);
  input.dataset.source = source;
  if (origin === 'project') delete input.dataset.automatic;
  else input.dataset.automatic = 'true';
  const note = input.closest('label')?.querySelector('[data-field-source]');
  if (note)
    note.textContent =
      value === undefined
        ? source + '；请明确填写'
        : (origin === 'automatic-assumption'
            ? '自动假设：'
            : origin === 'automatic-project'
              ? '自动复用工程：'
              : '来自当前工程：') + source;
}
export function markCalculationOverride(target: EventTarget | null): void {
  if (!(target instanceof HTMLInputElement) || !target.matches('[data-duty-field], [data-sizing-field]')) return;
  target.dataset.edited = 'true';
  delete target.dataset.automatic;
  target.removeAttribute('aria-invalid');
  const error = target.closest('label')?.querySelector<HTMLElement>('[data-field-error]');
  if (error) error.hidden = true;
  const note = target.closest('label')?.querySelector('[data-field-source]');
  if (note) note.textContent = '本次输入/覆盖' + (target.dataset.source ? '；原来源：' + target.dataset.source : '');
}
export function readCalculationNumber(
  scope: Element,
  key: string,
  context: string,
  issues: FormIssue[],
): number | null {
  const input = scope.querySelector(`[data-duty-field="${key}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error('Calculation field missing: ' + key);
  if (input.value.trim() === '' || !Number.isFinite(input.valueAsNumber) || !input.checkValidity()) {
    issues.push({
      control: input,
      message: `${context} / ${input.dataset.fieldLabel}：${calculationInputError(input)}`,
    });
    return null;
  }
  return input.valueAsNumber;
}
function calculationInputError(input: HTMLInputElement): string {
  if (input.validity.badInput) return '请输入有效数字';
  if (input.value.trim() === '') return '请填写数值';
  if (input.validity.rangeUnderflow)
    return Number(input.min) === Number.MIN_VALUE ? '必须大于0' : `不能小于${input.min}`;
  if (input.validity.rangeOverflow) return `不能大于${input.max}`;
  return '请输入范围内的有效数值';
}
export function validateCalculationInput(input: HTMLInputElement): boolean {
  const valid = input.value.trim() !== '' && Number.isFinite(input.valueAsNumber) && input.checkValidity();
  input.toggleAttribute('aria-invalid', !valid);
  if (!valid) input.setAttribute('aria-invalid', 'true');
  const error = input.closest('label')?.querySelector<HTMLElement>('[data-field-error]');
  if (error) {
    error.textContent = valid ? '' : calculationInputError(input);
    error.hidden = valid;
  }
  return valid;
}
export function showCalculationIssues(root: HTMLElement, status: HTMLElement, issues: readonly FormIssue[]): void {
  function reveal(control: HTMLElement) {
    for (let parent = control.parentElement; parent && parent !== root; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    control.scrollIntoView({ block: 'center' });
    control.focus();
  }
  for (const input of root.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
  for (const error of root.querySelectorAll<HTMLElement>('[data-field-error]')) error.hidden = true;
  status.replaceChildren();
  const list = document.createElement('ul');
  for (const issue of issues) {
    issue.control.setAttribute('aria-invalid', 'true');
    if (issue.control instanceof HTMLInputElement && issue.control.matches('[data-duty-field]'))
      validateCalculationInput(issue.control);
    const item = document.createElement('li'),
      button = document.createElement('button');
    button.type = 'button';
    button.textContent = issue.message;
    button.addEventListener('click', () => reveal(issue.control));
    item.append(button);
    list.append(item);
  }
  status.append(list);
  const first = issues[0];
  if (first) reveal(first.control);
}
export function calculationAdvice(items: readonly DisplayDiagnostic[]): string {
  const message = items.map((d) => d.message).join('；');
  if (/阀位|供回油|吸油|未列入动作|接通供油/.test(message))
    return message + ' 建议：核对本工况阀位、动作方向和实际接线，列全同时接通的执行器。';
  if (/供油压力需求|压力需求超过|溢流|力预算/.test(message))
    return (
      message +
      ' 建议：核对负载、回油腔压力、缸面积及真实限压能力；本稳态缸压力公式不随目标速度降低，不自动提高压力或降低手动要求。'
    );
  if (/规格|候选范围/.test(message)) return message + ' 建议：核对目标要求与已支持规格范围，不自动改变工程。';
  if (/效率/.test(message)) return message + ' 建议：确认0＜总效率≤容积效率≤1，效率是初选假设，不是原生泄漏参数。';
  if (/1.5/.test(message))
    return message + ' 建议：本尺寸初选要求预算大于1.5 MPa；核对实际供油能力，或改用现有回路需求核算。';
  return message + ' 请核对已声明支持范围和必填条件；本次未改变工程，不将缺输入或不支持统称为无解。';
}
export function pumpSpeedSeed(project: NetworkProject, pumpId: string): number | undefined {
  const speed = project.design.components.find((c) => c.id === pumpId && c.typeId === 'pump')?.parameters.drive
    ?.angularSpeedRadPerS;
  return speed === undefined ? undefined : fromSI('angularSpeed', speed);
}
export function sourcePressureSeed(project: NetworkProject): {
  readonly value: number | undefined;
  readonly source: string;
} {
  const sources = project.design.components.filter((c) => c.typeId === 'pressure-source');
  const source = sources.length === 1 ? sources[0] : undefined;
  const pressure = source?.parameters.hydraulic?.pressurePa;
  return {
    value: pressure === undefined ? undefined : fromSI('pressure', pressure),
    source: source
      ? `${source.label} 的压力设定（预算可覆盖，非实际供油保证）`
      : '没有唯一同基准压力源；预算不能由溢流开启压差直接代替',
  };
}
