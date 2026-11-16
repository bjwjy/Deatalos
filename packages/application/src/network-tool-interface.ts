import { checkJson, ContractReader, diagnostic, immutable, type Result } from '@hyd/domain';
import { canonical } from './content.js';
import type { NetworkToolBase } from './network-tool-protocol.js';

export const networkToolSettingDefinitions = [
  { key: 'connectionRadius', label: '连线吸附范围（px）', kind: 'integer', minimum: 6, maximum: 24 },
  { key: 'branchRevealRadius', label: '支路提示范围（px）', kind: 'integer', minimum: 48, maximum: 160 },
  { key: 'drawingFormat', label: '原理图默认格式', kind: 'choice', values: ['pdf', 'svg'] },
  { key: 'curveFormat', label: '曲线默认格式', kind: 'choice', values: ['pdf', 'svg', 'csv', 'hydcurve'] },
  { key: 'bookFormat', label: '计算书默认格式', kind: 'choice', values: ['docx', 'pdf'] },
  { key: 'catalogFormat', label: '选型任务书默认格式', kind: 'choice', values: ['docx', 'md'] },
  { key: 'drawingPaper', label: '图纸纸幅', kind: 'choice', values: ['A4', 'A3', 'A2'] },
  { key: 'drawingOrientation', label: '图纸方向', kind: 'choice', values: ['portrait', 'landscape'] },
  { key: 'componentNames', label: '元件名称显示', kind: 'choice', values: ['selected', 'always', 'hidden'] },
  { key: 'portLabels', label: '油口标签显示', kind: 'choice', values: ['selected', 'always', 'hidden'] },
  {
    key: 'curveRange',
    label: '曲线初始范围（秒，all为全部）',
    kind: 'choice',
    values: ['all', '1', '5', '10', '30', '60'],
  },
  {
    key: 'recoveryInterval',
    label: '恢复副本间隔（秒，0为关闭）',
    kind: 'choice',
    values: ['0', '30', '60', '120', '300', '600'],
  },
  {
    key: 'recoveryCopies',
    label: '恢复副本保留份数（降低会按原策略淘汰旧副本）',
    kind: 'choice',
    values: ['3', '5', '10', '20'],
  },
  {
    key: 'exportDirectory',
    label: '默认导出目录（choose在本机选择，project随工程归档）',
    kind: 'choice',
    values: ['choose', 'project'],
  },
  {
    key: 'theme',
    label: '界面配色（neutral默认、silver银白、oat姜黄、coral夜间）',
    kind: 'choice',
    values: ['neutral', 'silver', 'oat', 'coral'],
  },
] as const;
type Definition = (typeof networkToolSettingDefinitions)[number];
export type NetworkToolSettingKey = Definition['key'];
export type NetworkToolSettingChange =
  | { readonly key: 'connectionRadius' | 'branchRevealRadius'; readonly value: number }
  | { readonly key: Exclude<NetworkToolSettingKey, 'connectionRadius' | 'branchRevealRadius'>; readonly value: string };
export type NetworkToolSettingsSnapshot = Readonly<Record<NetworkToolSettingKey, string | number | null>>;
export interface NetworkToolSettingOutcome {
  readonly key: NetworkToolSettingKey;
  readonly applied: boolean;
  readonly persisted: boolean | null;
  readonly value: string | number | null;
  readonly message: string;
}
export const networkToolSettingSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 15,
  items: {
    oneOf: networkToolSettingDefinitions.map((definition) => ({
      type: 'object',
      additionalProperties: false,
      required: ['key', 'value'],
      properties: {
        key: { const: definition.key },
        value:
          definition.kind === 'integer'
            ? { type: 'integer', minimum: definition.minimum, maximum: definition.maximum }
            : { enum: definition.values },
      },
    })),
  },
};
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/settings', message)],
});
export function parseNetworkToolSettingChanges(input: unknown): Result<readonly NetworkToolSettingChange[]> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const reader = new ContractReader(),
    changes: NetworkToolSettingChange[] = [];
  const rows = reader.array(input, '/changes', 15);
  if (!rows.length) return fail('SETTINGS_INVALID', '至少需要一项本机设置变更。');
  const keys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const field = '/changes/' + index,
      value = reader.object(row, field, ['key', 'value']);
    const definition = networkToolSettingDefinitions.find((entry) => entry.key === value.key);
    if (!definition || keys.has(definition.key)) return fail('SETTINGS_INVALID', '设置名称未知或在同批中重复。');
    keys.add(definition.key);
    if (definition.kind === 'integer') {
      const number = reader.number(value.value, field + '/value', definition.minimum, definition.maximum);
      if (!Number.isSafeInteger(number)) reader.fail('SETTINGS_INVALID', field + '/value', '范围设置须为整数。');
      changes.push({ key: definition.key, value: number });
    } else {
      const selected = definition.values.find((option) => option === value.value);
      if (selected === undefined) return fail('SETTINGS_INVALID', '设置值不在当前选项内；不接受任意路径或脚本。');
      changes.push({ key: definition.key, value: selected });
    }
  }
  return reader.finish(changes);
}
export interface NetworkToolSettingsOperation {
  readonly operationId: string;
  readonly operationKey: string;
  readonly base: NetworkToolBase;
  readonly changes: readonly NetworkToolSettingChange[];
  readonly before: NetworkToolSettingsSnapshot;
  readonly state: 'awaiting-confirmation' | 'applying' | 'completed' | 'partial' | 'cancelled' | 'stale';
  readonly outcomes?: readonly NetworkToolSettingOutcome[];
}
const sameDocument = (a: NetworkToolBase, b: NetworkToolBase) =>
  a.documentSessionId === b.documentSessionId && a.revision === b.revision && a.physicsRevision === b.physicsRevision;
/** Bounded confirmation policy only. Existing preference owners perform and report each side effect. */
export class NetworkToolSettings {
  #operations = new Map<string, NetworkToolSettingsOperation>();
  prepare(
    base: NetworkToolBase,
    current: NetworkToolBase,
    operationKey: string,
    changes: readonly NetworkToolSettingChange[],
    before: NetworkToolSettingsSnapshot,
    id: string,
  ): Result<NetworkToolSettingsOperation> {
    const prior = [...this.#operations.values()].find((operation) => operation.operationKey === operationKey);
    if (prior)
      return canonical({ base, changes }) === canonical({ base: prior.base, changes: prior.changes })
        ? { ok: true, value: prior }
        : fail('OPERATION_KEY_CONFLICT', '设置操作编号已用于其他请求。');
    if (!sameDocument(base, current)) return fail('RESPONSE_STALE', '当前工程已变化，请重新捕获后更新设置。');
    const parsed = parseNetworkToolSettingChanges(changes);
    if (!parsed.ok) return parsed;
    if (
      [...this.#operations.values()].some(
        (operation) => operation.state === 'awaiting-confirmation' || operation.state === 'applying',
      )
    )
      return fail('SETTINGS_BUSY', '已有设置请求等待确认或正在应用。');
    if (this.#operations.size >= 16 || this.#operations.has(id))
      return fail('SETTINGS_LIMIT', '此连接设置操作已满或身份重复，请查询原回执。');
    const operation: NetworkToolSettingsOperation = immutable({
      operationId: id,
      operationKey,
      base,
      changes: parsed.value,
      before,
      state: 'awaiting-confirmation',
    });
    this.#operations.set(id, operation);
    return { ok: true, value: operation };
  }
  status(id: string): Result<NetworkToolSettingsOperation> {
    const value = this.#operations.get(id);
    return value ? { ok: true, value } : fail('SETTINGS_NOT_FOUND', '设置操作不存在或连接已退役。');
  }
  confirm(
    id: string,
    current: NetworkToolBase,
    actual: NetworkToolSettingsSnapshot,
  ): Result<NetworkToolSettingsOperation> {
    const found = this.status(id);
    if (!found.ok) return found;
    const operation = found.value;
    if (operation.state !== 'awaiting-confirmation') return fail('SETTINGS_RETIRED', '设置操作已确认或退役。');
    if (
      !sameDocument(operation.base, current) ||
      operation.changes.some((change) => actual[change.key] !== operation.before[change.key])
    ) {
      this.#operations.set(id, immutable({ ...operation, state: 'stale' }));
      return fail('SETTINGS_CONFLICT', '工程或待修改设置已变化；本次未应用。');
    }
    const value = immutable({ ...operation, state: 'applying' as const });
    this.#operations.set(id, value);
    return { ok: true, value };
  }
  complete(id: string, outcomes: readonly NetworkToolSettingOutcome[]): void {
    const operation = this.#operations.get(id);
    if (!operation || operation.state !== 'applying') return;
    const complete =
      outcomes.length === operation.changes.length &&
      outcomes.every(
        (outcome, index) =>
          outcome.key === operation.changes[index]?.key && outcome.applied && outcome.persisted === true,
      );
    this.#operations.set(id, immutable({ ...operation, state: complete ? 'completed' : 'partial', outcomes }));
  }
  cancel(id: string): Result<NetworkToolSettingsOperation> {
    const found = this.status(id);
    if (!found.ok) return found;
    if (found.value.state === 'applying') return fail('SETTINGS_BUSY', '设置已开始应用，请核对逐项真实回执。');
    const value =
      found.value.state === 'awaiting-confirmation'
        ? immutable({ ...found.value, state: 'cancelled' as const })
        : found.value;
    this.#operations.set(id, value);
    return { ok: true, value };
  }
  invalidate(current: NetworkToolBase | null): void {
    for (const [id, operation] of this.#operations)
      if (operation.state === 'awaiting-confirmation' && (!current || !sameDocument(operation.base, current)))
        this.#operations.set(id, immutable({ ...operation, state: 'stale' }));
  }
}
