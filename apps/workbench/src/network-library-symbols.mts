import {
  isPressureControlType,
  isLoadControlType,
  isTeachingActuatorType,
  directionalValveSpec,
  networkDefaultParameters,
  type NetworkDefinition,
} from '@hyd/domain';
import { networkSymbol } from './network-symbols.mjs';

import { approvedLibrarySymbol } from './network-library-approved.mjs';

const secondBatchSymbols = new Set(['two-pressure-valve', 'pilot-check-close', 'pressure-reducing-relieving']);

const explanations = new Map<string, string>([
  ['pump', '按排量和转速向回路供油'],
  ['motor', '将液压能转换为旋转运动'],
  ['tank', '作为回油边界，压力以参数设定为准'],
  ['flow-meter', '双油口串联测量，A到B为正；线性阻力产生实际压降，可拖到管线上自动接入'],
  ['return-filter', '串联回油，按额定流量和压降设定滤芯阻力'],
  ['differential-pressure-gauge', '两个独立测压口，显示 A 口减 B 口的有符号压差'],
  ['flow-divider-combiner', 'P→A/B 按比例分流，A/B→P 按比例集流；支路受阻时总流量受限'],
  ['three-way-flow-control', 'P 向 A 供油，内部压差补偿将多余流量旁通至 T'],
  ['shock-makeup-valve', 'A、B 各自相对 T 溢流，低压工作口从 T 单向补油'],
  ['pressure-intensifier', 'IN 供油、H 高压输出、R 回油；按增压比和有限流量计算'],
  ['adjustable-pressure-switch', 'H 口取压，升至动作值时触点闭合，降至复位值时断开'],
  ['pilot-unloading-valve', 'X 口远程取压，达到动作值时 P 通 T 卸荷，降至复位值后关闭'],
  ['synchronizing-flow-divider', 'P 与 A/B 双向按比例分配流量，一侧受阻时以有限旁通流量纠偏'],
  ['pressure-source', '保持设定供油压力的理想边界'],
  ['accumulator', '预充气体压缩储能，单口充放油；排空关闭，气液状态来自内核'],
  ['volume', '表示可压缩液体的容积'],
  ['dynamic-controller', '无油口；双击配置换向阀位或变量泵／马达的排量给定，可按时间和测量条件换步'],
  ['cylinder', '将液压能转换为直线往复运动'],
  ['single-acting-cylinder', 'A 口供油伸出，弹簧推动复位'],
  ['cushioned-cylinder', '双作用单杆缸，两端缓冲长度和排油开口分别可调'],
  ['cushioned-double-rod-cylinder', '双出杆等有效面积，两端缓冲独立可调'],
  ['limited-rotary-actuator', 'A/B 驱动有限转角，保护支路默认接内置油箱，可改用外接 T 口'],
  ['valve', '切换各油口之间的通路'],
  ['check-valve', '允许油液沿规定方向流动'],
  ['pressure-reducing', '按出口相对Y压力关小主通路；非溢流结构'],
  ['sequence-valve', '按入口相对Y压力开启；可显式配置反向旁通'],
  ['pilot-check', 'A到B自由流，X相对Y先导解锁B到A'],
  ['counterbalance', 'A到B单向旁路，负载B和X先导控制B到A连续调节；A回压影响开启'],
  ['pressure-compensated-flow', 'P到A压差足够时补偿，不足时降流；A到P反向非补偿'],
  ['throttle', '手动调整开口，或根据实测流量调节至目标'],
  ['manual-shutoff', '手动全开或关闭；全开有压降，关闭双向隔离'],
  ['shuttle-valve', 'A、B 两路中较高压力通向 C；低压侧隔离，C 口回压阻止反流'],
  ['two-pressure-valve', 'A、B 都达到开启条件后，高压侧向 C 供油'],
  ['pilot-check-close', 'A→B 单向导通，X 口先导压力足够时关闭'],
  ['pressure-reducing-relieving', '正常时 P→A 减压，A 口超压时向 T 泄放'],
  ['one-way-throttle', '一个方向节流，反方向经单向旁路流动'],
  ['relief', '压力达到设定条件时向回油侧泄流'],
]);

export function libraryExplanation(definition: NetworkDefinition): string {
  if (definition.control === 'displacement') return '运行中可在手动控制卡调排量，或由动态控制器给定百分比';
  if (definition.id === 'teaching:pilot-check-internal')
    return '常用三口式：A到B自由流，X控制B到A解锁，A口回压影响先导需求';
  const explanation = explanations.get(definition.typeId);
  if (!explanation) throw new Error(`Missing library explanation for registered type ${definition.typeId}`);
  return explanation;
}

/** Both selection views use the exact user-approved R1 geometry. Canvas/export stay independent. */
export function libraryPictogram(definition: NetworkDefinition): string {
  const passiveSymbol = [
    'return-filter',
    'differential-pressure-gauge',
    'flow-divider-combiner',
    'three-way-flow-control',
    'shock-makeup-valve',
    'pressure-intensifier',
    'adjustable-pressure-switch',
    'pilot-unloading-valve',
    'synchronizing-flow-divider',
  ].includes(definition.typeId);
  const variableDisplacement = definition.control === 'displacement';
  if (
    directionalValveSpec(definition.id) ||
    isPressureControlType(definition.typeId) ||
    isLoadControlType(definition.typeId) ||
    definition.typeId === 'accumulator' ||
    definition.typeId === 'flow-meter' ||
    passiveSymbol ||
    variableDisplacement ||
    definition.typeId === 'manual-shutoff' ||
    definition.typeId === 'shuttle-valve' ||
    secondBatchSymbols.has(definition.typeId) ||
    isTeachingActuatorType(definition.typeId) ||
    definition.role === 'controller'
  ) {
    const parameters = networkDefaultParameters(definition.id, definition.version);
    if (!parameters) throw new Error('Directional library defaults missing');
    const bounds = definition.drawingBounds;
    const viewBox =
      isPressureControlType(definition.typeId) ||
      isLoadControlType(definition.typeId) ||
      definition.typeId === 'accumulator' ||
      definition.typeId === 'flow-meter' ||
      passiveSymbol ||
      variableDisplacement ||
      definition.typeId === 'manual-shutoff' ||
      definition.typeId === 'shuttle-valve' ||
      secondBatchSymbols.has(definition.typeId) ||
      isTeachingActuatorType(definition.typeId) ||
      definition.role === 'controller'
        ? [bounds.left - 6, bounds.top - 6, bounds.right - bounds.left + 12, bounds.bottom - bounds.top + 12].join(' ')
        : '-250 -100 500 200';
    return (
      '<svg viewBox="' +
      viewBox +
      '" aria-hidden="true" focusable="false">' +
      networkSymbol(
        {
          id: 'library-directional',
          typeId: definition.typeId,
          definition: { id: definition.id, version: definition.version },
          model: definition.model,
          label: '',
          parameters,
        },
        [],
        [],
        { labels: false, details: false },
      ) +
      '</svg>'
    );
  }
  if (definition.id === 'teaching:pump' && definition.version === 3) return approvedLibrarySymbol(definition.id, 2);
  return approvedLibrarySymbol(definition.id, definition.version);
}
