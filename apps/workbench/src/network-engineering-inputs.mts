import { engineeringUnitChoices } from '@hyd/domain';
import { associateFieldLabel } from './network-dom.mjs';

interface NumericDraft {
  readonly si: number;
  readonly text: string;
  readonly scale: number;
}
const values = new WeakMap<HTMLInputElement, NumericDraft>();
const preferences = new Map<string, number>();
const unitViews = new WeakMap<HTMLElement, (index: number) => void>();

/** The properties, shortcut card and field picker share display units, each retaining its own value. */
function bindUnitPreference(view: HTMLElement, preference: string, show: (index: number) => void) {
  view.dataset.unitPreference = preference;
  unitViews.set(view, show);
  show(preferences.get(preference) ?? 0);
}

function unitFieldName(name: string, unit: string): string {
  if (unit === 'r/min') return name.replace('角速度', '转速');
  if (unit === 'Hz') return name.replace('角频率', '频率');
  if (unit === 'rad/s') return name.replace('转速', '角速度').replace(/(?<!角)频率/, '角频率');
  return name;
}

export function bindEngineeringFieldOption(view: HTMLElement, source: string, key: string, name: string) {
  const choices = engineeringUnitChoices(source, key);
  const title = view.querySelector('[data-engineering-label]');
  const unit = view.querySelector('small');
  if (!title || !unit || choices.length < 2) return;
  bindUnitPreference(view, source + ':' + key, (index) => {
    const choice = choices[index];
    if (!choice) return;
    title.textContent = unitFieldName(name, choice.label);
    unit.textContent = choice.label;
  });
}

export function engineeringInputValue(input: HTMLInputElement | null | undefined): number {
  if (!input || input.value === '' || input.validity.badInput) return NaN;
  const draft = values.get(input);
  return draft?.text === input.value ? draft.si : Number(input.value) * (draft?.scale ?? 1);
}

function displayNumber(input: HTMLInputElement, value: number): string {
  return String(Number(value.toPrecision(Number(input.dataset.engineeringPrecision ?? 14))));
}

export function setEngineeringInputValue(input: HTMLInputElement, si: number): void {
  const scale = values.get(input)?.scale ?? 1;
  input.value = Number.isFinite(si) ? displayNumber(input, si / scale) : '';
  values.set(input, { si, text: input.value, scale });
}

/** Input initially contains the model value in its declared source scale. An untouched draft round-trips exactly. */
export function bindEngineeringInputs(root: HTMLElement) {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type=number][data-engineering-unit]')) {
    if (values.has(input)) continue;
    const holder = input.closest('.c1-field') ?? input.closest('label');
    const caption = holder?.querySelector<HTMLElement>('small');
    if (!holder || !caption) continue;
    const source = input.dataset.engineeringUnit ?? '';
    const key =
      (
        input.dataset.param ??
        input.dataset.pipeParam ??
        input.dataset.valveAdvanced ??
        input.dataset.initial ??
        input.dataset.relief ??
        input.dataset.dutyField ??
        input.dataset.sizingField ??
        input.id
      )
        .split('.')
        .pop() ?? '';
    const choices = engineeringUnitChoices(source, key);
    const preference = source + ':' + key;
    const scale = Number(input.dataset.paramScale ?? 1);
    const original = input.value === '' ? NaN : Number(input.value) * scale;
    const positiveOnly = Number(input.min) === Number.MIN_VALUE;
    const bounds = {
      min: input.min === '' ? undefined : Number(input.min) * scale,
      max: input.max === '' ? undefined : Number(input.max) * scale,
    };
    const button = choices.length > 1 ? document.createElement('button') : null;
    const unitText = button?.appendChild(document.createElement('span'));
    const title = holder.querySelector('[data-engineering-label]');
    const originalName = title?.textContent ?? '';
    const accessibleName = input.getAttribute('aria-label');
    const lock = holder.querySelector<HTMLElement>('[data-rule-toggle]');
    let currentIndex = 0;
    const show = (index: number, si: number) => {
      const choice = choices[index];
      if (!choice) return;
      const format = (n: number) => displayNumber(input, n / choice.scale);
      input.value = Number.isFinite(si) ? format(si) : '';
      if (bounds.min !== undefined) input.min = positiveOnly ? String(Number.MIN_VALUE) : format(bounds.min);
      if (bounds.max !== undefined) input.max = format(bounds.max);
      values.set(input, { si, text: input.value, scale: choice.scale });
      input.dataset.displayUnit = choice.label;
      currentIndex = index;
      if (title && source === 'rad/s') {
        const name = unitFieldName(originalName, choice.label);
        title.textContent = name;
        if (accessibleName) input.setAttribute('aria-label', unitFieldName(accessibleName, choice.label));
        if (input.dataset.fieldLabel) input.dataset.fieldLabel = name;
        if (lock) {
          lock.dataset.fieldName = name;
          lock.setAttribute('aria-label', (lock.dataset.ruleMode === 'locked' ? '解锁' : '锁定') + name);
        }
      }
      if (button && unitText) {
        unitText.textContent = choice.label;
        button.setAttribute('aria-label', choice.label);
        button.title = '切换为 ' + choices[(index + 1) % choices.length]?.label;
      } else caption.textContent = choice.label === '1' ? '无量纲' : choice.label;
    };
    if (button) {
      const label = input.closest('label');
      if (label) associateFieldLabel(label);
      button.type = 'button';
      button.className = 'engineering-unit-toggle';
      button.dataset.pressFeedback = 'off';
      button.disabled = input.disabled;
      button.addEventListener('pointerdown', (event) => {
        if (event.button === 0) event.preventDefault();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (input.validity.badInput) {
          input.reportValidity();
          return;
        }
        const next = (currentIndex + 1) % choices.length;
        preferences.set(preference, next);
        for (const view of document.querySelectorAll<HTMLElement>(`[data-unit-preference="${CSS.escape(preference)}"]`))
          unitViews.get(view)?.(next);
      });
      caption.replaceChildren(button);
    }
    if (button) {
      bindUnitPreference(input, preference, (index) => {
        if (!input.validity.badInput) show(index, values.has(input) ? engineeringInputValue(input) : original);
      });
    } else show(0, original);
  }
}
