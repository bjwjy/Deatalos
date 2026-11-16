import { componentNames, specs } from './registry.js';
import { directionalValveSpec, networkValveFunctionLabel } from './network-valve.js';
import type { NetworkComponent, NetworkProject } from './network-model.js';

/** Chinese presentation metadata only. Never rewrites IDs, user labels or SI data. */
export const networkTypeNames: Readonly<Record<string, string>> = Object.freeze({
  ...componentNames,
  'pressure-source': '恒压源',
  volume: '液压容腔',
  accumulator: '气囊式蓄能器',
  'dynamic-controller': '动态控制器',
  'flow-meter': '流量计（线性阻力）',
  'return-filter': '回油过滤器',
  'differential-pressure-gauge': '差压表',
  'flow-divider-combiner': '双向分流集流阀',
  'three-way-flow-control': '自力式三通压力补偿调速阀',
  'shock-makeup-valve': '冲击溢流补油阀组',
  'pressure-intensifier': '液压增压器',
  'adjustable-pressure-switch': '可调压力开关',
  'pilot-unloading-valve': '液压外控卸荷阀',
  'synchronizing-flow-divider': '同步分流集流阀',
  'manual-shutoff': '手动截止阀',
  'shuttle-valve': '液压梭阀',
  'two-pressure-valve': '双压阀',
  'pilot-check-close': '液控关闭单向阀',
  'pressure-reducing-relieving': '三通溢流减压阀',
  'single-acting-cylinder': '单作用缸（弹簧复位）',
  'cushioned-cylinder': '可调缓冲单杆缸',
  'cushioned-double-rod-cylinder': '可调缓冲双出杆缸',
  'limited-rotary-actuator': '有限角度摆动执行器',
  'check-valve': '单向阀',
  throttle: '可调节流阀',
  'one-way-throttle': '单向节流阀',
  'pressure-reducing': '减压阀（非溢流外泄）',
  'sequence-valve': '顺序阀（内控外泄）',
  'pilot-check': '液控单向阀',
  counterbalance: '平衡阀（三口内泄）',
  'pressure-compensated-flow': '压力补偿调速阀（二通）',
});
export function componentDisplayName(type: string, definition = ''): string {
  if (definition === 'teaching:variable-pump') return '变量泵';
  if (definition === 'teaching:variable-motor') return '变量液压马达';
  const directional = directionalValveSpec(definition);
  if (directional) return directional.label;
  if (definition === 'teaching:pilot-check-internal') return '液控单向阀（三口内泄）';
  if (definition === 'teaching:pilot-check') return '液控单向阀（四口外泄）';
  if (definition === 'teaching:pilot-relief') return '先导式溢流阀（内控内泄准静态）';
  if (definition === 'teaching:custom-o' || definition === 'teaching:custom-m')
    return '自定义三位四通阀 ' + (definition.endsWith('-m') ? 'M' : 'O') + '型基组';
  if (type === 'valve') return `三位四通换向阀 ${definition.endsWith('valve-m') ? 'M' : 'O'} 型`;
  return networkTypeNames[type] ?? '元件';
}
const parameters: Readonly<Record<string, string>> = Object.freeze({
  enabled: '内置溢流开关',
  internalTank: '内置油箱',
  pressurePa: '压力',
  controlSettingPa: '控制设定压差（相对Y）',
  reducingRelievingSettingPa: '减压设定压差（A 相对 T）',
  equalAnnularAreaM2: '两侧等有效面积',
  angularTravelRad: '最大摆角',
  sweptVolumeM3PerRad: '单位转角排量',
  returnSpringNPerM: '复位弹簧刚度',
  returnPreloadN: '复位弹簧预紧力',
  extendCushionLengthM: '伸出端缓冲长度',
  retractCushionLengthM: '缩回端缓冲长度',
  extendCushionAreaM2: '伸出端缓冲最小开口',
  retractCushionAreaM2: '缩回端缓冲最小开口',
  counterbalanceSettingPa: '平衡阀弹簧设定压差',
  meteringAreaM2: '调速节流口面积（0关闭）',
  compensationDifferentialPa: '补偿节流压差',
  regulationBandPa: '压力调节带',
  reverseBypassAreaM2: '反向旁通开口面积（0关闭）',
  pilotRatio: '先导活塞面积比',
  feedAreaM2: '先导供油节流孔面积',
  pilotAreaM2: '先导级等效开口面积',
  mainDiameterM: '主阀芯直径',
  mainSpringStiffnessNPerM: '主阀弹簧刚度',
  mainPreloadN: '主阀弹簧预紧力',
  mainMaximumTravelM: '主阀最大开度行程',
  extendFunction: '左位机能',
  neutralFunction: '中位机能',
  retractFunction: '右位机能',
  volumeM3: '容腔体积',
  totalVolumeM3: '蓄能器总容积',
  prechargeAbsolutePa: '气体预充绝压',
  polytropicExponent: '气体多变指数',
  minimumGasFraction: '最小气体容积分数（支持边界）',
  portResistancePaSPerM3: '油口线性阻力',
  meterResistancePaSPerM3: '流量计线性阻力（压降＝阻力×流量）',
  filterRatedFlowM3PerS: '滤芯额定流量',
  filterRatedDropPa: '额定流量下的滤芯压降',
  branchAFlowFraction: 'A 口流量份额（0.5 为等分）',
  tripPressurePa: '升压动作压力',
  resetPressurePa: '降压复位压力',
  correctionAreaM2: '末端纠偏开口面积',
  correctionDifferentialPa: '纠偏启动支路压差',
  correctionGateM3PerS: '允许纠偏的主通道流量上限',
  priorityFlowM3PerS: '工作支路标称流量',
  reliefASettingPa: 'A 相对 T 的溢流开启压差',
  reliefBSettingPa: 'B 相对 T 的溢流开启压差',
  makeupAreaM2: '单路补油最大开口',
  makeupCrackingPa: '补油单向阀开启压差',
  intensificationRatio: '增压比（相对回油 R）',
  boostResistancePaSPerM3: '增压支路等效阻力',
  bypassResistancePaSPerM3: '快速充油旁路阻力',
  bypassCrackingPa: '快速充油旁路开启压差',
  transitionPressurePa: '高压侧完全选通压差',
  minimumInletPressurePa: '双入口开启压力（工程基准）',
  activationBandPa: '双入口全开过渡压差',
  oilVolumeM3: '初始存油量',
  settingDifferentialPa: '溢流设定压差',
  commandTravelM: '控制指令行程',
  maximumTravelM: '阀芯最大行程',
  diameterM: '阀芯直径',
  overlapM: '阀口正遮盖量',
  frequencyRadPerS: '阀芯固有角频率',
  dampingRatio: '阀芯阻尼比',
  flowCoefficient: '流量系数',
  openingFraction: '中位卸荷开口比例',
  circumferenceFraction: '卸荷阀口周向比例',
  capAreaM2: '无杆腔有效面积',
  rodSideAreaM2: '有杆腔有效面积',
  strokeM: '液压缸行程',
  capDeadVolumeM3: '无杆腔死容积',
  rodDeadVolumeM3: '有杆腔死容积',
  massKg: '运动质量',
  loadDampingNsPerM: '负载黏性阻尼',
  pistonDampingNsPerM: '活塞黏性阻尼',
  externalForceN: '外加载荷（有符号）',
  internalLeakageM3PerSPa: '内部泄漏系数',
  maximumAreaM2: '最大阀口面积',
  openingDifferentialPa: '开启压差',
  reverseOpeningDifferentialPa: '反向旁通开启压差',
  displacementM3PerRev: '每转排量',
  minimumDisplacementM3PerRev: '最小排量',
  maximumDisplacementM3PerRev: '最大排量',
  leakageM3PerSPa: '泄漏系数',
  angularSpeedRadPerS: '角速度',
  inertiaKgM2: '转动惯量',
  viscousFrictionNmSPerRad: '转动黏性阻尼',
  externalTorqueNm: '外加转矩（有符号）',
  portVolumeM3: '每口内置油液容积',
  initialPressurePa: '内置油液初压',
  deliveryInitialPressurePa: '泵供油口内置油液初压',
  supplyPressurePa: '内置补油源压力',
  reverseMaximumAreaM2: '反向补偿旁通最大面积',
  positionM: '活塞初始位移',
  velocityMPerS: '活塞初始速度',
  capPressurePa: '无杆腔初始压力',
  rodPressurePa: '有杆腔初始压力',
  angleRad: '初始转角',
  openingAreaM2: '初始开口面积',
});
export function parameterDisplayName(key: string): string {
  if (parameters[key]) return parameters[key];
  for (const group of ['tank', 'pump', 'relief', 'valve', 'cylinder', 'motor', 'pipe', 'fluid']) {
    const spec = specs(group).find((p) => p.key === key);
    if (spec) return spec.label;
  }
  return '参数';
}
export function hasParameterDisplayName(key: string): boolean {
  return parameterDisplayName(key) !== '参数';
}
export const positionDisplayNames: Readonly<Record<string, string>> = Object.freeze({
  extend: '左位（P→A，B→T）',
  neutral: '中位',
  retract: '右位（P→B，A→T）',
});
export function positionDisplayName(value: string | null, component?: NetworkComponent): string {
  if (
    component &&
    directionalValveSpec(component.definition.id) &&
    (value === 'extend' || value === 'neutral' || value === 'retract')
  )
    return (
      (value === 'extend' ? '左位' : value === 'retract' ? '右位' : '中位') +
      '（' +
      networkValveFunctionLabel(component, value) +
      '）'
    );
  if (
    component?.definition.id.startsWith('teaching:custom-') &&
    (value === 'extend' || value === 'neutral' || value === 'retract')
  )
    return (
      (value === 'extend' ? '左位' : value === 'neutral' ? '中位' : '右位') +
      '（' +
      networkValveFunctionLabel(component, value) +
      '）'
    );
  return value === null ? '过渡中，尚无有效阀位' : (positionDisplayNames[value] ?? '阀位未知');
}
export function unitDisplayName(unit: string): string {
  return unit === '1' ? '无量纲' : unit;
}
export const quantityDisplayNames: Readonly<Record<string, string>> = Object.freeze({
  displacement: '当前排量',
  pressure: '压力',
  'differential-pressure': '差压（A − B）',
  'pressure-switch-state': '触点状态（0 断开，1 闭合）',
  'control-voltage': '控制电压',
  'unloading-state': '卸荷状态（0 关闭，1 卸荷）',
  'gas-pressure': '气体绝压',
  'gas-volume': '气体容积',
  'oil-volume': '存油量',
  'cavity-volume': '等效空穴体积',
  'compression-energy': '气体压缩功（相对排空态）',
  flow: '流量',
  force: '液压推力',
  torque: '转矩',
  power: '功率',
  position: '实际位移',
  velocity: '实际速度',
  'core-flow': '核心元件流量（不含内置储油）',
  'makeup-flow': '补油流量（流入为正）',
  'relief-flow': '溢流泄放流量（泄放方向为正）',
  angularPosition: '实际转角',
  angularVelocity: '实际角速度',
  'angular-position': '实际转角',
  'angular-velocity': '实际角速度',
});
export function quantityDisplayName(field: string): string {
  const [port, quantity] = field.split('.');
  return quantity ? `${port} 口${quantityDisplayNames[quantity] ?? '读数'}` : (quantityDisplayNames[field] ?? '读数');
}
export function networkObjectDisplayName(project: NetworkProject, kind: string, id: string): string {
  if (kind === 'component' || kind === 'port') {
    const component = project.design.components.find((c) => c.id === id);
    return component
      ? component.label || componentDisplayName(component.typeId, component.definition.id)
      : '未识别元件';
  }
  if (kind === 'node') {
    const index = project.design.nodes.findIndex((n) => n.id === id);
    return index >= 0 ? project.design.nodes[index]!.label || `分支节点 ${index + 1}` : '未识别分支节点';
  }
  const index = project.design.connections.findIndex((c) => c.id === id);
  return index >= 0 ? `管路 ${index + 1}` : '未识别管路';
}
const reasons: Readonly<Record<string, string>> = Object.freeze({
  NO_SHAFT_POWER_OR_EFFICIENCY_MODEL: '当前没有轴功率或效率模型，不能推测轴输入功率',
  NON_FINITE_DERIVATION: '派生计算没有得到有限数值',
  IDEAL_CYCLE_FLOW_UNDETERMINED: '理想连接闭环不能唯一确定各连接流量',
  TERMINAL_FLOW_UNKNOWN: '端口流量尚未得到有效读数',
  IDEAL_NODE_NOT_EQUALIZED: '理想节点压力尚未满足一致性要求',
  PORT_PRESSURE_NOT_EQUALIZED: '相连油口压力未满足一致性要求',
  NUMERICAL_STORAGE_NOT_BALANCED: '数值储能的流量尚未平衡',
  MISSING_PIPE_FLOW: '当前快照没有该管路的有效流量',
  RESULT_STATE_CONFLICT: '同一帧的状态与量值读数冲突，结果不可用',
  QUANTITY_AMBIGUOUS: '所选对象存在同名量，不能唯一确定',
  QUANTITY_UNAVAILABLE: '所选量尚未取得有效读数',
});
export function valueReasonDisplay(reason: string): string {
  if (reasons[reason]) return reasons[reason];
  if (reason.startsWith('MISSING_PARAMETER:')) return '该计算所需的模型参数缺失';
  if (reason.startsWith('MISSING')) return '当前快照缺少所需的有效读数';
  return '该量未知或不适用于当前模型；原始原因见技术详情';
}
export const csvColumnGuide = Object.freeze({
  section: '记录类别',
  object_id: '对象标识（技术字段）',
  tick: '计算步号',
  time_s: '仿真时间，单位秒',
  field: '量值或元数据键（技术字段）',
  label: '中文含义',
  unit: '单位',
  value: '数值或说明；未知量留空',
  reason: '未知或不适用的原始原因',
  source: '有效内核或派生计算来源',
  control_sequence: '生效控制批次序号',
  reference: '公式、输入、模型及原始国际单位数据',
});
const metadataNames: Readonly<Record<string, string>> = Object.freeze({
  format: '导出格式标识',
  version: '导出格式版本',
  snapshot_id: '捕获快照标识',
  captured_at: '捕获时间',
  app_version: '应用版本',
  selection: '所选记录类别',
  source_identity_json: '捕获时的有效来源身份',
  point_identity_json: '所选末步来源身份',
  solver_json: '求解器及模型版本',
  document_json: '原始工程数据',
  native_step_configuration_json: '所选记录实际步长与初始化选择依据',
  point_si_json: '所选末步国际单位数据',
  record_json: '记录窗口与截断信息',
  exported_range_json: '实际导出样本范围',
  record_scope: '记录完整性声明（技术值）',
  column_guide_zh: '表格列含义对照',
  reading_guide_zh: '表格读取说明',
  reason_guide_zh: '未知原因对照',
  identity_controls_json: '本步身份、实际控制与状态',
  point_source: '结果来源',
  title: '工程名称',
  note: '工程备注',
  project_id: '工程标识',
  document_session_id: '工程会话标识',
  document_revision: '文档修订',
  physics_revision: '物理修订',
  layout_revision: '布局修订',
  run_id: '运行标识',
  solver_id: '求解器标识',
  model_version: '模型版本',
  config_json: '仿真配置',
  point_state_json: '本步动态状态',
  point_result_si_json: '本步国际单位结果',
  samples_truncated: '样本是否截断',
  replay: '重放能力（技术值）',
  sample_count: '样本数量',
  manual_preview_count: '静态预览数量',
  csv_text_policy: '表格文本转义规则',
});
export function csvMetadataDisplayName(key: string): string {
  return metadataNames[key] ?? (key.startsWith('point_') ? '本步来源身份技术字段' : '导出技术元数据');
}
