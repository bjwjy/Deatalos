import { ContractReader, immutable, diagnostic } from './reader.js';
import type { Result } from './model.js';
import type { NetworkComponent, NetworkParameterRule, NetworkProject } from './network-model.js';
import type { NetworkDefinition } from './network-registry.js';
import { networkDefinition } from './network-registry.js';

/** Absent rules retain the prior unlocked behaviour. Rules never mutate or supply a physical value. */
export function readNetworkParameterRules(
  r: ContractReader,
  input: unknown,
  definition: NetworkDefinition | undefined,
  field: string,
): readonly NetworkParameterRule[] | undefined {
  if (input === undefined) return undefined;
  const rules = r.array(input, field, 300).map((item, i): NetworkParameterRule => {
    const p = field + '/' + i,
      raw = r.object(item, p, ['group', 'key', 'mode', 'minimum', 'maximum']);
    const group = r.text(raw.group, p + '/group', 1, 100),
      key = r.text(raw.key, p + '/key', 1, 100);
    const spec = definition?.groups[group]?.find((s) => s.key === key);
    if (!spec) r.fail('PARAMETER_RULE_INVALID', p, '约束须引用当前定义中的模型参数。');
    if (raw.mode === 'locked') {
      r.object(item, p, ['group', 'key', 'mode']);
      return { group, key, mode: 'locked' };
    }
    r.constant(raw.mode, 'variable', p + '/mode');
    const minimum = r.number(
        raw.minimum,
        p + '/minimum',
        spec?.minimum ?? -Number.MAX_VALUE,
        spec?.maximum ?? Number.MAX_VALUE,
      ),
      maximum = r.number(
        raw.maximum,
        p + '/maximum',
        spec?.minimum ?? -Number.MAX_VALUE,
        spec?.maximum ?? Number.MAX_VALUE,
      );
    if (minimum > maximum) r.fail('PARAMETER_RULE_INVALID', p, '可变范围下限不能大于上限。');
    return { group, key, mode: 'variable', minimum, maximum };
  });
  r.unique(
    rules.map((rule) => rule.group + '.' + rule.key),
    field,
  );
  return immutable(rules);
}
export function networkParameterRule(
  component: NetworkComponent,
  group: string,
  key: string,
): NetworkParameterRule | undefined {
  return component.parameterRules?.find((rule) => rule.group === group && rule.key === key);
}
/** Constraint metadata affects edit permissions, not hydraulic parameters or a physical result identity. */
export function networkPhysicalDesign(project: NetworkProject): NetworkProject['design'] {
  return {
    ...project.design,
    components: project.design.components
      .filter((c) => networkDefinition(c.definition.id, c.definition.version)?.role !== 'controller')
      .map((c) => {
        const { parameterRules: _rules, ...physical } = c;
        return physical;
      }),
  };
}
/** Assisted calculations/AI may neither unlock a rule nor change a locked value. Manual UI edits are separate. */
export function checkNetworkParameterRules(before: NetworkProject, after: NetworkProject): Result<true> {
  for (const component of before.design.components) {
    const next = after.design.components.find((c) => c.id === component.id);
    if (next && JSON.stringify(component.parameterRules ?? []) !== JSON.stringify(next.parameterRules ?? []))
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PARAMETER_RULE_PROTECTED',
            '/components/' + component.id,
            'AI或计算候选不能修改锁定/范围，请在参数窗口由用户调整。',
          ),
        ],
      };
    for (const rule of component.parameterRules ?? []) {
      const old = component.parameters[rule.group]?.[rule.key],
        value = next?.parameters[rule.group]?.[rule.key];
      if (value === old) continue;
      if (rule.mode === 'locked')
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              'PARAMETER_LOCKED',
              '/components/' + component.id + '/parameters/' + rule.group + '/' + rule.key,
              component.label + '：参数已锁定，候选不能改变或移除。',
            ),
          ],
        };
      if (value === undefined || value < rule.minimum || value > rule.maximum)
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              'PARAMETER_OUT_OF_RANGE',
              '/components/' + component.id + '/parameters/' + rule.group + '/' + rule.key,
              component.label + '：候选超出用户保存的可变范围。',
            ),
          ],
        };
    }
  }
  return { ok: true, value: true };
}
