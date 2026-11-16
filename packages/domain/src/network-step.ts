import { immutable, diagnostic } from './reader.js';
import { isNetworkNativeStepS, networkStepCapability, type NetworkNativeStepS } from './network-registry.js';
import type { Result } from './model.js';
import type { NetworkProject } from './network-model.js';
export const networkStepPreferenceKey = 'metadata.hyd.native-step';
export const networkStepRunKey = 'metadata.hyd.native-step-run';
export type NetworkStepPreference =
  | { readonly version: 1; readonly mode: 'auto'; readonly manualStepS: null }
  | { readonly version: 1; readonly mode: 'manual'; readonly manualStepS: NetworkNativeStepS };
export function readNetworkStepPreference(project: NetworkProject): Result<NetworkStepPreference> {
  const input: unknown = project.extensions[networkStepPreferenceKey];
  if (input === undefined) return { ok: true, value: immutable({ version: 1, mode: 'auto', manualStepS: null }) };
  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    'version' in input &&
    input.version === 1 &&
    'mode' in input &&
    'manualStepS' in input &&
    Object.keys(input).every((key) => ['version', 'mode', 'manualStepS'].includes(key)) &&
    ((input.mode === 'auto' && input.manualStepS === null) ||
      (input.mode === 'manual' && isNetworkNativeStepS(input.manualStepS)))
  ) {
    if (input.mode === 'auto') return { ok: true, value: immutable({ version: 1, mode: 'auto', manualStepS: null }) };
    if (isNetworkNativeStepS(input.manualStepS))
      return { ok: true, value: immutable({ version: 1, mode: 'manual', manualStepS: input.manualStepS }) };
  }
  return {
    ok: false,
    diagnostics: [
      diagnostic(
        'CLOCK_CONFIG_INVALID',
        `/extensions/${networkStepPreferenceKey}`,
        '已保存的步长选择配置无效或版本不支持；保留原值，请明确选择自动或允许的手动步长。',
      ),
    ],
  };
}
export function prepareNetworkStepRun(
  project: NetworkProject,
): Result<{ readonly document: NetworkProject; readonly nativeStepS: NetworkNativeStepS }> {
  const preference = readNetworkStepPreference(project);
  if (!preference.ok) return preference;
  const capability = networkStepCapability(project.design.components);
  const nativeStepS = preference.value.mode === 'auto' ? capability.automaticStepS : preference.value.manualStepS;
  if (!capability.allowedSteps.some((step) => step === nativeStepS))
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'CLOCK_DOMAIN_EXCEEDED',
          '/mapping/nativeStepS',
          `手动配置${nativeStepS * 1e6} μs不适用；允许${capability.allowedSteps.map((step) => step * 1e6 + ' μs').join('、')}。请明确改选或恢复自动。${capability.reason}`,
        ),
      ],
    };
  const modelSet = [...new Set(project.design.components.map((c) => c.model.id + '@' + c.model.version))].sort();
  return {
    ok: true,
    value: immutable({
      nativeStepS,
      document: {
        ...project,
        extensions: {
          ...project.extensions,
          [networkStepRunKey]: {
            version: 1,
            mode: preference.value.mode,
            nativeStepS,
            policyVersion: capability.policyVersion,
            ruleId: capability.ruleId,
            modelSetVersion: capability.modelSetVersion,
            modelSet,
            allowedSteps: capability.allowedSteps,
            reason: capability.reason,
          },
        },
      },
    }),
  };
}
