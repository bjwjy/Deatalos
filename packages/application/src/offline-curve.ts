import type { Result } from '@hyd/domain';
import type { CurvePlan } from './network-curve-plan.js';
export interface OfflineCurve {
  readonly format: 'HydraulicOfflineCurve';
  readonly version: 1;
  readonly snapshotId: string;
  readonly label: string;
  readonly unit: string;
  readonly siUnit: string;
  readonly metadata: string;
  readonly samples: readonly {
    readonly index: number;
    readonly tick: number;
    readonly timeS: number;
    readonly value: number | null;
    readonly si: number | null;
    readonly reason: string;
  }[];
  readonly state: {
    readonly title: string;
    readonly paper: 'A4' | 'A3' | 'A2';
    readonly fromS: number;
    readonly toS: number;
    readonly keys: readonly {
      readonly sampleIndex: number;
      readonly label: string;
      readonly offsetX: number;
      readonly offsetY: number;
    }[];
  };
}
/** Portable data boundary. Its compiled function is embedded unchanged in the offline reader.
 * All runtime helpers deliberately live inside this function: no DOM, eval or imported runtime.
 * Resource/field checks mirror ContractReader locally to keep the exported reader self-contained.
 */
export function parseOfflineCurve(input: unknown): Result<OfflineCurve> {
  // Match the runtime record bound without imports so the offline reader stays self-contained.
  const sampleLimit = 6001;
  const errors: string[] = [];
  const object = (v: unknown, fields: readonly string[]): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    ) {
      errors.push('字段必须为普通对象');
      return {};
    }
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Object.getOwnPropertySymbols(v).length ||
      Object.entries(descriptors).some(([k, d]) => !fields.includes(k) || !('value' in d))
    ) {
      errors.push('存在未知字段或访问器');
      return {};
    }
    return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]));
  };
  const text = (v: unknown, max: number) => {
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) {
      errors.push('文字缺失、过长或含控制字符');
      return '';
    }
    return v;
  };
  const number = (v: unknown, min: number, max: number, integer = false) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) {
      errors.push('数值或序号无效');
      return 0;
    }
    return v;
  };
  const array = (v: unknown, max: number): readonly unknown[] => {
    if (!Array.isArray(v) || v.length > max) {
      errors.push('数据列表缺失或超出容量');
      return [];
    }
    return v;
  };
  const o = object(input, [
    'format',
    'version',
    'snapshotId',
    'label',
    'unit',
    'siUnit',
    'metadata',
    'samples',
    'state',
  ]);
  if (o.format !== 'HydraulicOfflineCurve' || o.version !== 1) errors.push('不是受支持的离线曲线格式或版本');
  const snapshotId = text(o.snapshotId, 80),
    label = text(o.label, 300),
    unit = text(o.unit, 80),
    siUnit = text(o.siUnit, 80),
    metadata = text(o.metadata, 2_000_000);
  if (!/^[-\w]{1,80}$/.test(snapshotId) || !label || !unit || !siUnit) errors.push('来源、量值或单位缺失');
  const samples = array(o.samples, sampleLimit).map((raw) => {
    const p = object(raw, ['index', 'tick', 'timeS', 'value', 'si', 'reason']);
    const reason = text(p.reason, 2000);
    const value = p.value === null ? null : number(p.value, -1e100, 1e100),
      si = p.si === null ? null : number(p.si, -1e100, 1e100);
    if ((value === null) !== (si === null) || (value === null && !reason)) errors.push('未知样本须保留原因，不能补零');
    return {
      index: number(p.index, 0, sampleLimit - 1, true),
      tick: number(p.tick, 0, Number.MAX_SAFE_INTEGER, true),
      timeS: number(p.timeS, 0, 1e12),
      value,
      si,
      reason,
    };
  });
  if (samples.length < 2) errors.push('离线交互至少需要两个采样点');
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    if (a && b && (a.index >= b.index || a.tick >= b.tick || a.timeS >= b.timeS))
      errors.push('样本索引、tick和时间必须严格递增');
  }
  // Cross-check exact frozen source samples, not just a loosely matching label.
  try {
    const m: unknown = JSON.parse(metadata),
      pending: { value: unknown; depth: number }[] = [{ value: m, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const entry = pending.pop();
      if (!entry) break;
      if (++nodes > 60000 || entry.depth > 32) {
        errors.push('来源元数据超过层数或节点预算');
        break;
      }
      if (entry.value && typeof entry.value === 'object')
        for (const [key, value] of Object.entries(entry.value)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) errors.push('来源含保留字段');
          pending.push({ value, depth: entry.depth + 1 });
        }
    }
    const source = object(m, [
      'format',
      'version',
      'snapshotId',
      'capturedAt',
      'sourceIdentity',
      'pointIdentity',
      'solver',
      'clock',
      'record',
      'selection',
      'request',
      'availableTimeS',
      'inputIndices',
      'selectedIndices',
      'mandatoryCount',
      'maximumRelativeError',
      'fidelity',
      'unit',
      'siUnit',
      'selectedSamples',
      'keys',
    ]);
    if (
      source.format !== 'HydraulicCurveExport' ||
      source.version !== 1 ||
      source.snapshotId !== snapshotId ||
      source.unit !== unit ||
      source.siUnit !== siUnit
    )
      errors.push('来源身份或单位不一致');
    for (const key of [
      'capturedAt',
      'sourceIdentity',
      'pointIdentity',
      'solver',
      'clock',
      'record',
      'selection',
      'request',
      'availableTimeS',
      'inputIndices',
      'mandatoryCount',
      'maximumRelativeError',
      'fidelity',
      'keys',
    ])
      if (source[key] === undefined) errors.push('来源字段缺失：' + key);
    for (const key of ['sourceIdentity', 'pointIdentity']) {
      const id = object(source[key], [
        'documentSessionId',
        'physicsRevision',
        'simulationSessionId',
        'tick',
        'timeS',
        'controlSequence',
        'requestSequence',
      ]);
      for (const field of ['documentSessionId', 'simulationSessionId'])
        if (!/^[-\w]{1,40}$/.test(text(id[field], 40))) errors.push('来源会话身份无效');
      for (const field of ['physicsRevision', 'tick', 'controlSequence', 'requestSequence'])
        number(id[field], 0, Number.MAX_SAFE_INTEGER, true);
      const time = number(id.timeS, 0, 1e12);
      if (key === 'pointIdentity' && samples.some((p) => p.tick > Number(id.tick) || p.timeS > time))
        errors.push('样本超过冻结结果时刻');
    }
    const solver = object(source.solver, ['id', 'version', 'modelSetVersion']),
      clock = object(source.clock, ['advanceIntervalS', 'nativeStepS']);
    for (const field of ['id', 'version', 'modelSetVersion'])
      if (!text(solver[field], 100)) errors.push('求解器或模型版本缺失');
    number(clock.advanceIntervalS, Number.MIN_VALUE, 1e12);
    number(clock.nativeStepS, Number.MIN_VALUE, 1e12);
    if (source.selection !== 'current' && source.selection !== 'history') errors.push('记录来源须为当前或历史');
    const selected = array(source.selectedIndices, sampleLimit),
      original = array(source.selectedSamples, sampleLimit);
    if (selected.length !== samples.length || original.length !== samples.length) errors.push('来源样本数不一致');
    samples.forEach((p, i) => {
      const q = object(original[i], ['index', 'tick', 'timeS', 'value', 'si', 'reason']);
      if (
        selected[i] !== p.index ||
        ['index', 'tick', 'timeS', 'value', 'si', 'reason'].some(
          (k) => q[k] !== Object.entries(p).find(([key]) => key === k)?.[1],
        )
      )
        errors.push('样本与冻结来源不一致');
    });
  } catch {
    errors.push('来源元数据不是有效JSON');
  }
  const s = object(o.state, ['title', 'paper', 'fromS', 'toS', 'keys']);
  const title = text(s.title, 160),
    paper = s.paper === 'A4' || s.paper === 'A3' || s.paper === 'A2' ? s.paper : 'A4';
  if (s.paper !== paper) errors.push('纸张须为A4/A3/A2');
  const fromS = number(s.fromS, 0, 1e12),
    toS = number(s.toS, 0, 1e12);
  const first = samples[0],
    last = samples.at(-1);
  if (!first || !last || fromS < first.timeS || toS > last.timeS || fromS >= toS)
    errors.push('视图时间范围无效或超出实际样本');
  const keys = array(s.keys, 16).map((raw) => {
    const k = object(raw, ['sampleIndex', 'label', 'offsetX', 'offsetY']);
    const sampleIndex = number(k.sampleIndex, 0, sampleLimit - 1, true);
    if (!samples.some((p) => p.index === sampleIndex && p.value !== null))
      errors.push('关键点必须引用同一曲线的真实已知样本');
    return {
      sampleIndex,
      label: text(k.label, 80),
      offsetX: number(k.offsetX, -300, 300),
      offsetY: number(k.offsetY, -300, 300),
    };
  });
  if (new Set(keys.map((k) => k.sampleIndex)).size !== keys.length) errors.push('关键点重复');
  if (errors.length)
    return {
      ok: false,
      diagnostics: [
        {
          code: 'OFFLINE_CURVE_INVALID',
          severity: 'error',
          field: '/offlineCurve',
          message: [...new Set(errors)].slice(0, 8).join('；'),
          suggestion: '保留当前文件，使用受支持的离线曲线JSON或重新导出。',
        },
      ],
    };
  const value: OfflineCurve = {
    format: 'HydraulicOfflineCurve',
    version: 1,
    snapshotId,
    label,
    unit,
    siUnit,
    metadata,
    samples,
    state: { title, paper, fromS, toS, keys },
  };
  for (const p of samples) Object.freeze(p);
  for (const k of keys) Object.freeze(k);
  Object.freeze(samples);
  Object.freeze(keys);
  Object.freeze(value.state);
  return { ok: true, value: Object.freeze(value) };
}
export function prepareOfflineCurve(plan: CurvePlan, paper: 'A4' | 'A3' | 'A2'): Result<OfflineCurve> {
  const samples = plan.samples.filter((p) => plan.indices.includes(p.index));
  let metadata: unknown;
  try {
    metadata = JSON.parse(plan.metadata);
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'OFFLINE_CURVE_INVALID',
          severity: 'error',
          field: '/offlineCurve/metadata',
          message: '曲线来源不是有效JSON。',
          suggestion: '重新捕获并整理曲线。',
        },
      ],
    };
  }
  const identity =
    metadata && typeof metadata === 'object' && 'snapshotId' in metadata ? metadata.snapshotId : undefined;
  return parseOfflineCurve({
    format: 'HydraulicOfflineCurve',
    version: 1,
    snapshotId: identity,
    label: plan.label,
    unit: plan.unit,
    siUnit: plan.siUnit,
    metadata: plan.metadata,
    samples,
    state: { title: plan.label, paper, fromS: samples[0]?.timeS, toS: samples.at(-1)?.timeS, keys: plan.request.keys },
  });
}
