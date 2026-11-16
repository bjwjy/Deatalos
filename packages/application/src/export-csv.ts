import {
  csvMetadataDisplayName,
  csvColumnGuide,
  diagnostic,
  fromSI,
  specs,
  unitScales,
  type Parameters,
  type PhysicalValue,
  type Quantity,
  type Result,
} from '@hyd/domain';
import type { Solution } from '@hyd/engine';
import type { ExportSnapshot } from './export-snapshot.js';

type Cell = string | number;
const header = [
  'section',
  'object_id',
  'tick',
  'time_s',
  'field',
  'label',
  'unit',
  'value',
  'reason',
  'source',
  'control_sequence',
  'reference',
];

// Treat text and physical numbers differently: a negative numeric flow stays numeric.
export function csvCell(value: Cell): string {
  let text = String(value);
  if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+@\-＝＋＠－]/u.test(text) || /^[\t\r\n]/.test(text)))
    text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

type MeasurementKey = { [K in keyof Solution]: Solution[K] extends number | PhysicalValue ? K : never }[keyof Solution];
const measurements: readonly [MeasurementKey, Quantity, string][] = [
  ['pumpGaugePressurePa', 'pressure', '泵出口压力'],
  ['suctionGaugePressurePa', 'pressure', '吸油表压'],
  ['pumpFlowM3PerS', 'flow', '泵总流量'],
  ['actuatorFlowM3PerS', 'flow', '执行器流量'],
  ['returnFlowM3PerS', 'flow', '回油流量'],
  ['bypassFlowM3PerS', 'flow', '溢流流量'],
  ['chamberAGaugePressurePa', 'pressure', 'A口压力'],
  ['chamberBGaugePressurePa', 'pressure', 'B口压力'],
  ['forceN', 'force', '有效推力'],
  ['torqueNm', 'torque', '有效转矩'],
  ['speedMPerS', 'linearSpeed', '活塞速度'],
  ['angularSpeedRadPerS', 'angularSpeed', '马达转速'],
  ['positionM', 'length', '活塞位置'],
  ['strokeM', 'length', '行程'],
  ['areaAM2', 'area', '无杆腔面积'],
  ['areaBM2', 'area', '有杆腔面积'],
  ['hydraulicPowerW', 'power', '液压功率'],
  ['shaftPowerW', 'power', '泵输入轴功率'],
  ['actuatorPowerW', 'power', '执行器功率'],
  ['lossPowerW', 'power', '估计损耗功率'],
];

/** Rectangular, versioned long-table CSV. All numbers derive from one SI snapshot. */
export function exportCsv(snapshot: ExportSnapshot): Result<string> {
  const point = snapshot.point;
  if (!point || !point.result.ok)
    return {
      ok: false,
      diagnostics: [
        diagnostic('EXPORT_RESULT_UNAVAILABLE', '/export', '当前没有可导出的计算结果；可改选有效历史或导出纯图。'),
        ...(!point || point.result.ok ? [] : point.result.diagnostics),
      ],
    };
  const rows: Cell[][] = [header];
  const row = (
    section: string,
    object: string,
    field: string,
    label: string,
    value: Cell,
    unit = '',
    reason = '',
    tick: Cell = '',
    time: Cell = '',
    source = '',
    sequence: Cell = '',
    reference = '',
  ) => rows.push([section, object, tick, time, field, label, unit, value, reason, source, sequence, reference]);
  const meta = (field: string, value: Cell, label = csvMetadataDisplayName(field)) =>
    row('metadata', '', field, label, value);
  meta('column_guide_zh', JSON.stringify(csvColumnGuide), '列含义对照');
  meta(
    'reading_guide_zh',
    'result为所选结果；sample为轨迹采样；manual-preview为静态预览。机器字段、来源和控制枚举保留；未知数值留空，不能按零计算。',
    '读取说明',
  );
  meta('format', snapshot.format);
  meta('version', snapshot.version);
  meta('snapshot_id', snapshot.snapshotId);
  meta('captured_at', snapshot.capturedAt);
  meta('app_version', snapshot.appVersion);
  meta('selection', snapshot.selection.kind);
  meta('point_source', point.source);
  meta('title', snapshot.document.title, '项目');
  meta('note', snapshot.document.note ?? '');
  meta('project_id', snapshot.document.projectId);
  meta('document_session_id', snapshot.documentSessionId);
  meta('document_revision', snapshot.documentRevision);
  meta('physics_revision', snapshot.physicsRevision);
  meta('layout_revision', snapshot.layoutRevision);
  meta('run_id', snapshot.runId);
  for (const [key, value] of Object.entries(point.identity)) meta('point_' + key, value);
  meta('solver_id', point.result.value.solverId);
  meta('model_version', point.result.value.modelVersion);
  meta('config_json', JSON.stringify(snapshot.config));
  meta('point_state_json', JSON.stringify(point.state));
  meta('point_result_si_json', JSON.stringify(point.result.value));
  meta('fixed_step_s', snapshot.config.stepSeconds, '固定步长 s');
  meta('sample_interval_s', snapshot.record.sampleIntervalSeconds, '运行采样间隔 s');
  meta('single_step_sampling', '每步一条', '单步采样');
  meta('sample_capacity', 2000, '采样容量');
  meta('samples_dropped', snapshot.record.samplesDropped, '已丢弃样本');
  meta('samples_truncated', String(snapshot.record.samplesTruncated));
  meta('events_truncated', snapshot.record.eventsTruncated ? '是' : '否', '控制日志已截断');
  meta('replay', snapshot.record.replay);
  meta('sample_count', snapshot.samples.length);
  meta('manual_preview_count', snapshot.manualPreviews.length);
  meta('csv_text_policy', '危险前导文本加单引号；带引号/换行字段保留。数值列不转文本；再次编辑另存的兼容性另验。');
  snapshot.assumptions.forEach((text, i) => row('assumption', '', String(i), '模型假设', text));
  snapshot.diagnostics.forEach((d) => row('diagnostic', '', d.code, d.severity, d.message, '', d.field));
  // Full original SI input/layout and initial conditions remain machine readable.
  row('input', '', 'document_json', '原始v2/SI输入与布局', JSON.stringify(snapshot.document));
  row('input', '', 'initial_state_json', '实例初态', JSON.stringify(snapshot.initialState));
  row('input', '', 'initial_controls_json', '实例初始控制', JSON.stringify(snapshot.initialControls));
  const parameters = (group: string, id: string, values: Parameters) => {
    for (const spec of specs(group)) {
      const value = values[spec.key];
      if (value === undefined) throw new Error('Validated export lost parameter');
      row('parameter', id, spec.key, spec.label, fromSI(spec.quantity, value), unitScales[spec.quantity].legacy);
    }
  };
  parameters('fluid', 'fluid', snapshot.document.design.fluid);
  for (const c of snapshot.document.design.components) {
    row('component', c.id, 'label', '元件名称', c.label);
    row('component', c.id, 'definition_id', '定义', c.definitionId);
    row('component', c.id, 'definition_version', '定义版本', c.definitionVersion);
    parameters(c.typeId, c.id, c.params);
  }
  for (const w of snapshot.document.design.connections) parameters('pipe', w.id, w.params);

  const measure = (
    section: string,
    object: string,
    key: string,
    label: string,
    quantity: Quantity,
    value: number | PhysicalValue,
    tick: number,
    time: number,
    source: string,
    sequence: number,
    reference = '',
  ) => {
    const known = typeof value === 'number' ? { kind: 'known' as const, value } : value;
    row(
      section,
      object,
      key,
      label,
      known.kind === 'known' ? fromSI(quantity, known.value) : '',
      unitScales[quantity].legacy,
      known.kind === 'unknown' ? known.reason : '',
      tick,
      time,
      source,
      sequence,
      reference,
    );
  };
  const r = point.result.value,
    state = point.state;
  row('result', '', 'status', '工况', r.status, '', '', state.tick, state.timeS, point.source, point.controlSequence);
  row(
    'result',
    '',
    'controls_json',
    '实际控制',
    JSON.stringify(point.controls),
    '',
    '',
    state.tick,
    state.timeS,
    point.source,
    point.controlSequence,
  );
  for (const [key, quantity, label] of measurements) {
    const value = r[key];
    if (typeof value === 'number' || (typeof value === 'object' && value !== null && 'kind' in value))
      measure('result', '', key, label, quantity, value, state.tick, state.timeS, point.source, point.controlSequence);
  }
  for (const w of snapshot.document.design.connections) {
    const value = r.wireValues[w.id];
    if (!value) continue;
    const reference = `${w.from.componentId}:${w.from.portId}→${w.to.componentId}:${w.to.portId}`;
    for (const [key, label, quantity] of [
      ['flowM3PerS', '有符号流量（相对起点→终点）', 'flow'],
      ['magnitudeM3PerS', '流量幅值', 'flow'],
      ['speedMPerS', '管流速幅值', 'pipeSpeed'],
      ['dropPa', '压降', 'pressure'],
      ['reynolds', '雷诺数 Re', 'coefficient'],
      ['darcyFactor', '达西摩擦因子', 'coefficient'],
    ] as const)
      measure(
        'wire',
        w.id,
        key,
        label,
        quantity,
        value[key],
        state.tick,
        state.timeS,
        point.source,
        point.controlSequence,
        reference,
      );
    row(
      'wire',
      w.id,
      'role',
      '管线角色',
      value.role,
      '',
      '',
      state.tick,
      state.timeS,
      point.source,
      point.controlSequence,
      reference,
    );
  }
  for (const event of snapshot.controlEvents)
    row(
      'control-event',
      event.componentId,
      'position',
      '阀位',
      event.positionId,
      '',
      '',
      event.tick,
      event.tick * snapshot.config.stepSeconds,
      event.phase,
      event.sequence,
      event.phase === 'step' ? '结束计算步所指积分区间的有效控制' : '静态边界预览，不是轨迹',
    );
  for (const event of snapshot.scheduledControls)
    row(
      'queued-control',
      event.componentId,
      'position',
      '尚未生效',
      event.positionId,
      '',
      '',
      event.tick,
      event.tick * snapshot.config.stepSeconds,
      'queued',
      event.sequence,
    );
  for (const [section, samples] of [
    ['sample', snapshot.samples],
    ['manual-preview', snapshot.manualPreviews],
  ] as const) {
    for (const s of samples) {
      const metric = (key: string, label: string, quantity: Quantity, value: number | PhysicalValue, id = '') =>
        measure(section, id, key, label, quantity, value, s.tick, s.timeS, s.source, s.controlSequence);
      metric('pumpGaugePressurePa', '泵出口压力', 'pressure', s.pumpGaugePressurePa);
      metric('actuatorFlowM3PerS', '执行器流量', 'flow', s.actuatorFlowM3PerS);
      metric('shaftPowerW', '输入轴功率', 'power', s.shaftPowerW);
      metric('angularSpeedRadPerS', '马达转速', 'angularSpeed', s.angularSpeedRadPerS);
      for (const a of s.actuatorStates)
        metric(
          a.kind === 'cylinder' ? 'positionM' : 'angleRad',
          a.kind === 'cylinder' ? '活塞位置' : '马达转角',
          a.kind === 'cylinder' ? 'length' : 'angle',
          a.kind === 'cylinder' ? a.positionM : a.angleRad,
          a.componentId,
        );
      row(
        section,
        '',
        'controls_json',
        '本样本实际控制',
        JSON.stringify(s.controls),
        '',
        '',
        s.tick,
        s.timeS,
        s.source,
        s.controlSequence,
      );
    }
  }
  return { ok: true, value: '\uFEFF' + rows.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n' };
}
