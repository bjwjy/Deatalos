import { arrow, label, node, oilRoute, symbol, wire } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

const sense = (path: string, active: boolean) => wire(path, active ? 'teaching-sense-active' : 'teaching-pilot-idle');

function pilotCheckDrawing(pilot: boolean, kind: 'internal' | 'external' | 'close'): string {
  const closing = kind === 'close';
  const open = closing ? !pilot : pilot;
  return [
    closing
      ? open
        ? oilRoute('M67 119H254', 'supply')
        : wire('M67 119H254', 'supply')
      : open
        ? oilRoute('M254 119H67', 'return')
        : wire('M67 119H254'),
    closing
      ? open
        ? oilRoute('M326 119H513', 'supply')
        : wire('M326 119H513')
      : open
        ? oilRoute('M513 119H326', 'supply')
        : wire('M326 119H513', 'supply'),
    open
      ? closing
        ? arrow('M121 119H191', 'supply') + arrow('M393 119H462', 'supply')
        : arrow('M191 119H121', 'return') + arrow('M462 119H393', 'supply')
      : '',
    symbol(open ? 'check' : 'check-closed', 290, 119, 90),
    '<rect class="teaching-valve-cell" x="265" y="173" width="50" height="38" rx="3"/>',
    `<path class="wire teaching-pilot-pin" data-pilot="${pilot ? 'on' : 'off'}" d="M273 190h34m-17 0v-55"/>`,
    sense('M506 192H315', pilot),
    kind === 'external'
      ? sense('M82 228H251V202H265', false) + label(156, 256, 'Y 独立外泄口')
      : kind === 'internal'
        ? sense('M218 119V202H265', false) + node(218, 119) + label(156, 256, '内部参考接 A 口')
        : '',
    label(210, 97, 'A'),
    label(369, 97, 'B'),
    label(484, 177, 'X'),
    label(407, 226, pilot ? (closing ? '加压关闭' : '加压解锁') : '先导压力较低'),
    label(290, 50, closing ? (open ? 'A → B 通流' : 'A → B 截止') : open ? 'B → A 解锁回油' : 'B → A 锁止'),
  ].join('');
}

function lockPairDrawing(direction: 'locked' | 'extend' | 'retract'): string {
  const locked = direction === 'locked';
  const extend = direction === 'extend';
  return [
    '<rect class="teaching-cylinder-shell" x="148" y="45" width="287" height="43"/>',
    `<g class="teaching-lock-travel" data-travel="${direction}"><rect class="teaching-piston-metal" x="249" y="46" width="7" height="41"/><rect class="teaching-piston-metal" x="256" y="62" width="187" height="9"/></g>`,
    locked
      ? wire('M195 88V124M385 88V124', 'supply')
      : extend
        ? oilRoute('M195 124V88', 'supply') + oilRoute('M385 88V124', 'return')
        : oilRoute('M195 88V124', 'return') + oilRoute('M385 124V88', 'supply'),
    locked
      ? wire('M195 196V269M385 196V269')
      : extend
        ? oilRoute('M195 269V196', 'supply') + oilRoute('M385 196V269', 'return')
        : oilRoute('M195 196V269', 'return') + oilRoute('M385 269V196', 'supply'),
    locked
      ? ''
      : extend
        ? arrow('M195 257V234', 'supply') + arrow('M385 209V233', 'return')
        : arrow('M195 205V228', 'return') + arrow('M385 257V232', 'supply'),
    symbol(locked ? 'check-closed' : 'check', 195, 160),
    symbol(locked ? 'check-closed' : 'check', 385, 160),
    sense('M195 228H340V161H366', extend),
    sense('M385 249H122V161H176', direction === 'retract'),
    node(195, 228),
    node(385, 249),
    label(280, 31, locked ? '两腔锁止' : extend ? '液压缸伸出 →' : '← 液压缸缩回'),
    label(179, 108, 'B'),
    label(402, 108, 'B'),
    label(174, 215, 'A'),
    label(404, 215, 'A'),
    label(145, 151, 'X'),
    label(352, 151, 'X'),
    label(195, 289, locked ? '左 A 无供压' : extend ? '左 A 供油' : '左 A 回油'),
    label(385, 289, locked ? '右 A 无供压' : extend ? '右 A 回油' : '右 A 供油'),
    label(286, 211, '交叉先导', true),
  ].join('');
}

function balanceDrawing(lowering: boolean): string {
  return [
    '<rect class="teaching-cylinder-shell" x="354" y="44" width="68" height="83"/>',
    `<g class="teaching-load-travel" data-lowering="${lowering}"><rect class="teaching-piston-metal" x="355" y="72" width="66" height="8"/><rect class="teaching-piston-metal" x="384" y="30" width="8" height="43"/><rect class="teaching-valve-cell" x="371" y="20" width="34" height="12" rx="2"/></g>`,
    '<rect class="teaching-valve-cell" x="234" y="154" width="96" height="46" rx="3"/>',
    lowering ? oilRoute('M388 127V177H330', 'return', 'slow') : wire('M388 127V177H330', 'supply'),
    lowering ? oilRoute('M234 177H70', 'return', 'slow') : wire('M70 177H234'),
    lowering
      ? arrow('M324 177H241', 'return') + arrow('M190 177H125', 'return') + arrow('M442 72V112', '')
      : wire('M330 177h-27m0-7v14M234 177h27m0-7v14'),
    wire('M220 177V121H247M319 121H345V177'),
    symbol('check-closed', 283, 121, 90),
    node(220, 177),
    node(345, 177),
    sense('M292 257V200', lowering),
    wire('M330 194h6l5-6 5 12 5-12 5 6'),
    label(176, 158, 'A'),
    label(358, 160, 'B'),
    label(314, 242, 'X'),
    label(478, 50, '垂直负载'),
    label(280, 95, 'A → B 单向旁路', true),
    label(122, 215, '去回油路', true),
    label(413, 246, lowering ? 'B → A 节制回油' : '阀关闭，保持负载'),
  ].join('');
}

function unloadingDrawing(unloading: boolean): string {
  return [
    unloading ? oilRoute('M65 104H165V179H206', 'supply') : oilRoute('M65 104H249', 'supply'),
    unloading ? wire('M165 104H249M321 104H434V82', 'supply') : oilRoute('M321 104H434V82', 'supply'),
    '<rect class="teaching-valve-cell" x="206" y="154" width="129" height="50" rx="3"/>',
    unloading ? oilRoute('M335 179H354V231', 'return') : wire('M165 104V179H206M335 179H354V231'),
    unloading
      ? arrow('M214 179H327', 'return') + arrow('M354 200V225', 'return')
      : wire('M206 179h30m0-8v16M335 179h-30m0-8v16') + arrow('M350 104H398', 'supply'),
    sense('M434 104V142H290V154', unloading),
    symbol(unloading ? 'check-closed' : 'check', 285, 104, 90),
    symbol('tank', 354, 261),
    '<rect class="teaching-reservoir-body" x="418" y="24" width="32" height="58" rx="16"/>',
    wire('M421 51q13-8 26 0'),
    node(165, 104),
    node(434, 104),
    arrow('M86 104H132', 'supply'),
    label(113, 84, '泵出口'),
    label(289, 82, '单向阀', true),
    label(489, 52, '蓄能器'),
    label(312, 139, 'X'),
    label(195, 168, 'P'),
    label(374, 212, 'T'),
    label(127, 238, unloading ? 'P → T 卸荷' : '旁路关闭'),
    label(468, 253, unloading ? '单向阀阻止倒流' : '向蓄能器充油', true),
  ].join('');
}

export const pilotTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:pilot-check-internal',
    name: '内泄液控单向阀',
    category: '方向控制',
    topic: '先导顶开阀芯，让负载侧回油',
    ports: [
      ['A', '正向入口兼内部参考'],
      ['B', '负载侧'],
      ['X', '先导取压口'],
    ],
    condition: 'X 压力不足，B → A 锁止',
    summary: 'A → B 可正向通油。负载从 B 侧反压时，阀芯就座，回油被挡住。',
    action: '提高 X 口压力',
    observation: '内泄结构以 A 口压力为参考。A 口回压会影响解锁。',
    drawing: pilotCheckDrawing(false, 'internal'),
    alternate: {
      condition: 'X 加压，B → A 解锁回油',
      summary: 'X 相对 A 的压力足以顶开阀芯后，油从 B 回到 A。',
      action: '撤去先导压力',
      observation: '看顶杆和向左的回油箭头。虚线表示取压与内部参考。',
      drawing: pilotCheckDrawing(true, 'internal'),
    },
  },
  {
    id: 'teaching:pilot-check',
    name: '外泄液控单向阀',
    category: '方向控制',
    topic: '用独立 Y 口作为先导参考',
    ports: [
      ['A / B', '正向入口 / 负载侧'],
      ['X', '先导取压口'],
      ['Y', '独立外泄口'],
    ],
    condition: 'X 压力不足，B → A 锁止',
    summary: 'B 侧反压使阀芯关闭。这个结构的先导参考来自独立的 Y 口。',
    action: '提高 X 口压力',
    observation: '沿左下虚线找到 Y 口，接到合适的外泄回油路。',
    drawing: pilotCheckDrawing(false, 'external'),
    alternate: {
      condition: 'X 加压，B → A 解锁回油',
      summary: 'X 相对 Y 的压力足以顶开阀芯后，B 侧油从 A 口回流。',
      action: '撤去先导压力',
      observation: '主回油箭头走 B → A。Y 口用于外泄和先导参考。',
      drawing: pilotCheckDrawing(true, 'external'),
    },
  },
  {
    id: 'teaching:pilot-check-close',
    name: '液控关闭单向阀',
    category: '方向控制',
    topic: '先导加压后切断正向通流',
    ports: [
      ['A', '正向入口'],
      ['B', '正向出口'],
      ['X', '加压关闭口'],
    ],
    condition: 'X 压力较低，A → B 通流',
    summary: '先导压力较低时，A 侧压力足以打开阀芯，油流向 B。',
    action: '给 X 口加压',
    observation: '注意先导动作是压住阀芯，关掉原先的正向油路。',
    drawing: pilotCheckDrawing(false, 'close'),
    alternate: {
      condition: 'X 压力足够，A → B 截止',
      summary: 'X 口先导压力达到关闭条件，阀芯就座，正向流动停止。',
      action: '撤去先导压力',
      observation: 'A 侧仍供压，B 侧没有穿过阀口的流量。',
      drawing: pilotCheckDrawing(true, 'close'),
    },
  },
  {
    id: 'assembly:pilot-lock-pair',
    name: '双向液压锁组合',
    category: '方向控制',
    topic: '一边供油，解锁另一边回油',
    ports: [
      ['A', '两只阀的换向阀侧'],
      ['B', '各接液压缸一腔'],
      ['X', '交叉连接对侧 A'],
    ],
    condition: '两侧无先导，两腔锁止',
    summary: '两只液控单向阀分别挡住两腔的回油，液压缸保持位置。',
    action: '左侧供油',
    observation: '看交叉虚线。每边 A 口同时控制另一只阀的 X 口。',
    drawing: lockPairDrawing('locked'),
    alternate: {
      condition: '左侧供油，右侧解锁回油',
      summary: '左阀正向供油，左 A 同时给右 X 加压。右阀解锁后，有杆腔回油。',
      action: '换到右侧供油',
      observation: '红线进油，蓝线回油。高亮虚线表示先导压力传递。',
      drawing: lockPairDrawing('extend'),
    },
    additional: [
      {
        condition: '右侧供油，左侧解锁回油',
        summary: '右阀正向供油，右 A 给左 X 加压。左阀解锁，无杆腔回油。',
        action: '回到锁止',
        observation: '对照左右两次。供油和被解锁的回油侧互换。',
        drawing: lockPairDrawing('retract'),
      },
    ],
  },
  {
    id: 'teaching:counterbalance',
    name: '平衡阀',
    category: '压力控制',
    topic: '保持负载，并节制下降回油',
    ports: [
      ['A', '回油侧 / 反向供油侧'],
      ['B', '接负载油腔'],
      ['X', '先导取压口'],
    ],
    condition: '开启条件不足，保持负载',
    summary: '负载压在 B 侧，B → A 的受控回油通路关闭，负载保持。',
    action: '给 X 口加压下降',
    observation: '另一方向 A → B 可通过上方单向旁路给负载腔进油。',
    drawing: balanceDrawing(false),
    alternate: {
      condition: 'X 辅助开启，负载受控下降',
      summary: 'X 的先导压力辅助打开受控通路，B → A 的油经阀口节制排出。',
      action: '撤去先导压力',
      observation: '对照向下的负载箭头和向左的回油。A 侧回压也影响开启。',
      drawing: balanceDrawing(true),
    },
  },
  {
    id: 'teaching:pilot-unloading-valve',
    name: '液压外控卸荷阀',
    category: '压力控制',
    topic: '由远端取压决定泵是否卸荷',
    ports: [
      ['P', '接泵出口'],
      ['T', '卸荷回油口'],
      ['X', '远端取压口'],
    ],
    condition: '取压较低，泵给蓄能器充油',
    summary: 'X 相对 T 的压力较低，卸荷旁路关闭，泵经单向阀充油。',
    action: '使取压达到动作值',
    observation: 'X 接单向阀下游，只取压。泵出口和储能侧由单向阀隔开。',
    drawing: unloadingDrawing(false),
    alternate: {
      condition: '达到动作压差，P → T 卸荷',
      summary: 'X − T 达到动作值后，泵经 P → T 卸荷，单向阀阻止蓄能器倒流。',
      action: '降到复位压差',
      observation: '蓝色箭头表示卸荷回油。压差下降到较低的复位值时才重新充油。',
      drawing: unloadingDrawing(true),
    },
  },
];
