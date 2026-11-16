import { arrow, label, node, oilRoute, symbol, wire } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

function oneWayThrottleDrawing(reversed: boolean): string {
  return [
    reversed ? wire('M182 144H254M326 144H398') : oilRoute('M66 144H254', 'supply', 'slow'),
    reversed
      ? oilRoute('M514 144H398V76H326', 'supply') + oilRoute('M254 76H182V144H66', 'supply')
      : oilRoute('M326 144H514', 'supply', 'slow') + wire('M182 144V76H254M326 76H398V144'),
    reversed ? arrow('M389 76H340', 'supply') : arrow('M100 144H152', 'supply'),
    reversed ? arrow('M243 76H196', 'supply') : arrow('M429 144H478', 'supply'),
    symbol(reversed ? 'check' : 'check-closed', 290, 76, -90),
    symbol('throttle', 290, 144, 90),
    node(182, 144),
    node(398, 144),
    label(290, 43, '单向旁路'),
    label(290, 196, '可调节流口'),
    label(144, 124, 'A'),
    label(435, 124, 'B'),
    label(290, 250, reversed ? 'B → A：旁路通流' : 'A → B：节流通流'),
  ].join('');
}

function twoWayDrawing(underPressure: boolean): string {
  const pace = underPressure ? 'slow' : undefined;
  return [
    '<rect class="teaching-valve-cell" x="195" y="95" width="190" height="91" rx="6"/>',
    oilRoute('M64 142H213', 'supply', pace),
    oilRoute('M368 142H515', 'supply', pace),
    arrow('M102 142H154', 'supply'),
    arrow('M421 142H474', 'supply'),
    '<rect class="teaching-valve-cell" x="213" y="128" width="57" height="28"/>',
    arrow('M218 142H265', 'supply'),
    wire('M270 142h26m-62 14v7l5 4 6-4 6 4 6-4v-7'),
    symbol('throttle', 332, 142, 90),
    label(162, 119, 'P'),
    label(417, 119, 'A'),
    label(243, 118, '补偿阀芯', true),
    label(290, 220, underPressure ? 'A 口流量 3.0 L/min' : 'A 口流量 6.0 L/min'),
    label(290, 253, underPressure ? '负载压力 ↑ · P 到 A 的压差 ↓' : 'P 到 A 的压差满足补偿要求', true),
  ].join('');
}

function threeWayDrawing(extraSupply: boolean): string {
  const bypass = 'M252 183H333V254';
  return [
    '<rect class="teaching-valve-cell" x="204" y="84" width="175" height="129" rx="6"/>',
    oilRoute('M252 254V174', 'supply', extraSupply ? undefined : 'slow'),
    oilRoute('M252 103V46', 'supply'),
    oilRoute(bypass, 'return', extraSupply ? undefined : 'slow'),
    symbol('throttle', 252, 139),
    node(252, 183),
    arrow('M252 249V224', 'supply'),
    arrow('M252 80V52', 'supply'),
    arrow('M333 222V249', 'return'),
    label(231, 54, 'A'),
    label(252, 281, 'P'),
    label(333, 281, 'T'),
    label(370, 56, '工作流 6.0 L/min'),
    label(140, 247, extraSupply ? '供油 14.0 L/min' : '供油 10.0 L/min'),
    label(448, 247, extraSupply ? '旁通 8.0 L/min' : '旁通 4.0 L/min'),
    label(325, 153, '补偿旁通', true),
  ].join('');
}

function filterDrawing(higherResistance: boolean): string {
  return [
    oilRoute('M72 143H256', 'return'),
    oilRoute('M324 143H510', 'return'),
    arrow('M134 143H197', 'return'),
    arrow('M385 143H449', 'return'),
    '<path class="teaching-valve-cell" d="M256 143l34-34 34 34-34 34z"/>',
    '<path class="wire" d="M290 113v60" stroke-dasharray="4 4"/>',
    label(132, 103, higherResistance ? 'A 侧 0.40 MPa' : 'A 侧 0.20 MPa'),
    label(449, 103, 'B 侧 0.10 MPa'),
    label(126, 182, '来自回油路', true),
    label(459, 182, '去油箱', true),
    label(290, 216, higherResistance ? '滤芯压降 ↑ 0.30 MPa' : '滤芯压降 0.10 MPa'),
    label(290, 246, '示例回油流量 10.0 L/min', true),
  ].join('');
}

const differentialGaugeDrawing = [
  wire('M80 207H167V151H266V106M500 207H413V151H316V106', 'measure'),
  node(80, 207),
  node(500, 207),
  '<circle class="wire gauge-face" cx="291" cy="86" r="32"/>',
  wire('M268 75l4 2M291 58v5M314 75l-4 2'),
  '<path class="wire gauge-needle" d="M291 86V64"/>',
  node(291, 86),
  label(291, 40, '差压表'),
  label(246, 129, 'A'),
  label(337, 129, 'B'),
  '<text x="291" y="197" text-anchor="middle" data-gauge-reading></text>',
  label(291, 226, 'Δp = pA − pB', true),
  '<text x="111" y="243" text-anchor="middle" data-gauge-sample-a></text>',
  '<text x="469" y="243" text-anchor="middle" data-gauge-sample-b></text>',
].join('');

function pressureSourceDrawing(openWide: boolean): string {
  const pace = openWide ? undefined : 'slow';
  return [
    '<circle class="teaching-valve-cell" cx="107" cy="140" r="33"/>',
    label(107, 145, '恒压'),
    oilRoute('M140 140H252', 'supply', pace),
    oilRoute('M324 140H474V216', 'return', pace),
    arrow('M167 140H221', 'supply'),
    arrow('M369 140H425', 'return'),
    arrow('M474 168V204', 'return'),
    symbol('throttle', 288, 140, 90),
    symbol('tank', 474, 246),
    label(166, 88, 'P = 3.0 MPa'),
    label(288, 189, openWide ? '阀口较大' : '阀口较小'),
    label(288, 232, openWide ? '流量 8.0 L/min' : '流量 4.0 L/min'),
    label(474, 285, '油箱', true),
  ].join('');
}

export const flowPressureTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:one-way-throttle',
    name: '单向节流阀',
    category: '流量控制',
    topic: '一侧节流，反向走旁路',
    ports: [
      ['A', '正向节流入口'],
      ['B', '反向旁路入口'],
    ],
    condition: 'A → B，经过节流口',
    summary: 'A 侧供油时，单向旁路关着，油从可调节流口通过。',
    action: '切换供油方向',
    observation: '先看中间节流口。换成 B 侧供油后，再看上方旁路。',
    drawing: oneWayThrottleDrawing(false),
    alternate: {
      condition: 'B → A，单向旁路开启',
      summary: 'B 侧供油时，单向阀开启，油主要经上方旁路返回 A。',
      action: '切回 A 侧供油',
      observation: '上方箭头向左。旁路绕开节流口，反向阻力通常更小。',
      drawing: oneWayThrottleDrawing(true),
    },
  },
  {
    id: 'teaching:pressure-compensated-flow',
    name: '二通压力补偿调速阀',
    category: '流量控制',
    topic: '压差足够时维持设定流量',
    ports: [
      ['P', '供油入口'],
      ['A', '工作出口'],
    ],
    condition: '压差充足，流量接近设定值',
    summary: 'P 到 A 的压差足够时，补偿阀芯调节节流口两侧压差。',
    action: '提高负载压力',
    observation: '示例目标为 6.0 L/min。保持供油压力，试着提高 A 口负载。',
    drawing: twoWayDrawing(false),
    alternate: {
      condition: '压差不足，工作流量下降',
      summary: '负载压力升高，P 到 A 的可用压差变小，流量低于设定值。',
      action: '降低负载压力',
      observation: '供油方向没变。看 A 口读数和变慢的流动标记。',
      drawing: twoWayDrawing(true),
    },
  },
  {
    id: 'teaching:three-way-flow-control',
    name: '自力式三通压力补偿调速阀',
    category: '流量控制',
    topic: '优先给 A 口，多余油回 T 口',
    ports: [
      ['P', '接泵出口'],
      ['A', '优先工作口'],
      ['T', '旁通回油口'],
    ],
    condition: 'A 口保持工作流量',
    summary: '补偿条件满足时，A 口按设定流量供油，多余流量从 T 回油箱。',
    action: '提高泵供油量',
    observation: '对照红色工作流和蓝色旁通流。图中为两组示例流量。',
    drawing: threeWayDrawing(false),
    alternate: {
      condition: '供油增加，T 口旁通增加',
      summary: '泵供油从 10 增至 14 L/min，A 口仍是 6 L/min，增量流向 T。',
      action: '恢复原供油量',
      observation: '沿 T 口箭头看，多出的 4 L/min 都进入回油支路。',
      drawing: threeWayDrawing(true),
    },
  },
  {
    id: 'teaching:return-filter',
    name: '回油过滤器',
    category: '供油与回油',
    topic: '回油经过滤芯，前后产生压降',
    ports: [
      ['A', '滤芯上游'],
      ['B', '滤芯下游'],
    ],
    condition: '同一回油流量，正常压降',
    summary: '过滤器串在回油路上。油穿过滤芯，A 侧压力比 B 侧略高。',
    action: '增大滤芯阻力',
    observation: '对比 A、B 两侧压力。这个示意保持回油流量不变。',
    drawing: filterDrawing(false),
    alternate: {
      condition: '阻力增大，滤芯压降升高',
      summary: '模拟滤芯堵塞后的阻力增加。同样的流量需要更大的压差。',
      action: '恢复正常阻力',
      observation: '蓝色箭头的方向和流量不变。注意滤芯上游压力的升高。',
      drawing: filterDrawing(true),
    },
  },
  {
    id: 'teaching:differential-pressure-gauge',
    name: '差压表',
    category: '测量仪表',
    topic: '读取两个测点的压力差',
    ports: [
      ['A', '差压的正端'],
      ['B', '差压的负端'],
    ],
    condition: 'A 侧压力较高，差压为正',
    summary: '差压等于 A 口压力减 B 口压力。3.0 − 2.0 = +1.0 MPa。',
    action: '对调两点压力',
    observation: '两条线只取压。对调压力后，看表针和读数的符号。',
    gauge: { reading: '+1.0', angle: 38, samples: ['3.0', '2.0'] },
    gaugeDrawing: differentialGaugeDrawing,
    alternate: {
      condition: 'B 侧压力较高，差压为负',
      summary: 'A 口降到 2.0 MPa，B 口升到 3.0 MPa，读数变为 −1.0 MPa。',
      action: '恢复原测点压力',
      observation: '表针向零线另一侧转动。负号表示 B 的压力更高。',
      gauge: { reading: '−1.0', angle: -38, samples: ['2.0', '3.0'] },
      gaugeDrawing: differentialGaugeDrawing,
    },
  },
  {
    id: 'teaching:pressure-source',
    name: '恒压源',
    category: '供油与回油',
    topic: '出口压力固定，流量随回路变',
    ports: [['P', '恒压出口']],
    condition: '出口 3.0 MPa，流量较小',
    summary: '恒压源把 P 口压力维持在设定值。阀口较小时，流量较小。',
    action: '开大下游阀口',
    observation: '同时看 P 口压力和油流。图中压力、流量均为示例值。',
    drawing: pressureSourceDrawing(false),
    alternate: {
      condition: '出口仍为 3.0 MPa，流量增加',
      summary: '下游阀口开大，阻力变小，流量增加。P 口仍保持 3.0 MPa。',
      action: '关小下游阀口',
      observation: '流动标记变快，压力读数不动。这是理想恒压边界的示意。',
      drawing: pressureSourceDrawing(true),
    },
  },
];
