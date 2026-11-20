import { networkDefinition, networkParameterRule, parameterDisplayName, type NetworkComponent } from '@hyd/domain';
import { associateFieldLabel, escapeHtml as esc } from './network-dom.mjs';
import { networkUiIcon } from './network-v13-icons.mjs';

export type ParameterLockChange = (group: string, key: string, locked: boolean) => 'persisted' | 'staged' | false;
/** One inline icon after the original Chinese parameter label. No range editor or extra layout. */
export function parameterRuleField(component: NetworkComponent, group: string, key: string): string {
  const spec = networkDefinition(component.definition.id, component.definition.version)?.groups[group]?.find(
    (s) => s.key === key,
  );
  if (!spec) return '';
  const locked = networkParameterRule(component, group, key)?.mode === 'locked';
  return `<button type="button" class="parameter-lock" data-rule-row data-rule-toggle data-rule-group="${esc(group)}" data-rule-key="${esc(key)}" data-rule-mode="${locked ? 'locked' : 'none'}" aria-pressed="${locked}" aria-label="${locked ? '解锁' : '锁定'}${esc(parameterDisplayName(key))}" title="${locked ? '已锁定，计算和AI不可改变；点击解锁' : '未锁定，点击锁定'}">${networkUiIcon(locked ? 'lock' : 'unlock')}</button>`;
}
export function bindParameterRuleFields(root: HTMLElement, change?: ParameterLockChange): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-rule-toggle]')) {
    const label = button.closest('label');
    if (label) associateFieldLabel(label);
    // Repeated pointer presses on a label must toggle the control, not start word/paragraph selection.
    // Keep keyboard activation on the native button's click path.
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const group = button.dataset.ruleGroup,
        key = button.dataset.ruleKey;
      if (!group || !key || !root.contains(button)) return;
      const locked = button.dataset.ruleMode !== 'locked';
      const outcome = change ? change(group, key, locked) : 'staged';
      if (outcome === false) return;
      button.dataset.ruleMode = locked ? 'locked' : 'none';
      button.dataset.ruleModified = String(outcome === 'staged');
      button.innerHTML = networkUiIcon(locked ? 'lock' : 'unlock');
      button.setAttribute('aria-pressed', String(locked));
      button.setAttribute(
        'aria-label',
        (locked ? '解锁' : '锁定') + (button.dataset.fieldName ?? parameterDisplayName(key)),
      );
      button.title = locked ? '已锁定，计算和AI不可改变；点击解锁' : '未锁定，点击锁定';
    });
  }
}
/** Only a not-yet-added valve stages locks; existing components persist each icon click immediately. */
export function readParameterRuleFields(
  root: HTMLElement,
  component: NetworkComponent,
): readonly unknown[] | undefined {
  const changed = [...root.querySelectorAll<HTMLButtonElement>('[data-rule-toggle]')].filter(
    (button) => button.dataset.ruleModified === 'true',
  );
  if (!changed.length) return undefined;
  let rules: readonly unknown[] = component.parameterRules ?? [];
  for (const button of changed) {
    const group = button.dataset.ruleGroup,
      key = button.dataset.ruleKey;
    rules = rules.filter(
      (rule) =>
        !(
          rule &&
          typeof rule === 'object' &&
          'group' in rule &&
          'key' in rule &&
          rule.group === group &&
          rule.key === key
        ),
    );
    if (button.dataset.ruleMode === 'locked') rules = [...rules, { group, key, mode: 'locked' }];
  }
  return rules;
}
