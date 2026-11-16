import { wire, arrow, oilRoute, label } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

const valveCells = ['extend', 'neutral', 'retract'] as const;
type ValvePosition = (typeof valveCells)[number];

function valveCell(x: number, position: ValvePosition, active: boolean): string {
  const feed = active ? 'supply' : '';
  const drain = active ? 'return' : '';
  const routes =
    position === 'neutral'
      ? wire('M22 0v13m-6 0h12M58 0v13m-6 0h12M22 48V35m-6 0h12M58 48V35m-6 0h12')
      : position === 'extend'
        ? arrow('M22 48V2', feed) + arrow('M58 0V46', drain)
        : arrow('M22 48L58 2', feed) + arrow('M22 0l36 46', drain);
  return `<g transform="translate(${x} 169)"><rect class="teaching-valve-cell${active ? ' is-active' : ''}" width="80" height="48"/>${routes}</g>`;
}

/** A fixed cylinder shell keeps both work ports in place throughout the stroke. */
function actuatorDrawing(extending: boolean, kind: 'double' | 'spring' | 'valve'): string {
  const single = kind === 'spring';
  const active = extending ? 'extend' : 'retract';
  const a = 'M262 169V133H143V94';
  const b = 'M328 94V133H298V169';
  const p = 'M262 252V217';
  const t = 'M298 217V252H365';
  const spring = single
    ? '<g transform="translate(353 0)"><path class="wire teaching-spring" d="M-179 82h8l10-6 10 12 10-12 10 12 10-12 10 12 10-12 10 12 10-12 10 12 10-12 10 12 10-12 10 12 10-12 10 12 10-6h1"/></g>'
    : '';
  const workingValve = single
    ? `<g transform="translate(240 169)"><rect class="teaching-valve-cell is-active" width="80" height="48"/>${
        extending
          ? arrow('M22 48V2', 'supply') + wire('M58 48V35m-6 0h12')
          : arrow('M22 0l36 46', 'return') + wire('M22 48V35m-6 0h12')
      }</g>`
    : kind === 'valve'
      ? valveCells
          .map((position, index) =>
            valveCell(240 + (index - valveCells.indexOf(active)) * 80, position, position === active),
          )
          .join('')
      : valveCell(240, active, true);
  return [
    `<g class="teaching-actuator" data-stroke="${active}">`,
    label(238, 29, single ? '单作用缸' : '双作用液压缸'),
    '<rect class="teaching-cylinder-shell" x="114" y="44" width="239" height="50"/>',
    spring,
    '<g class="teaching-piston" data-teaching-motion><rect class="teaching-piston-metal" x="0" y="45" width="7" height="48"/><rect class="teaching-piston-metal" x="7" y="62" width="194" height="10"/></g>',
    extending ? oilRoute(a, 'supply') : oilRoute('M143 94V133H262V169', 'return'),
    single ? '' : extending ? oilRoute(b, 'return') : oilRoute('M298 169V133H328V94', 'supply'),
    extending || !single ? oilRoute(p, 'supply') : wire(p),
    !extending || !single ? oilRoute(t, 'return') : wire(t),
    workingValve,
    label(129, 117, 'A'),
    single ? '' : label(343, 117, 'B'),
    label(247, 241, 'P'),
    label(313, 241, 'T'),
    label(262, 274, '来自泵出口', true),
    label(365, 274, '回油箱', true),
    kind === 'valve' ? '' : label(374, 198, single ? '三通阀工作位' : '换向阀工作位', true),
    '</g>',
  ].join('');
}

function motorDrawing(reversed: boolean): string {
  return [
    reversed ? oilRoute('M255 132H73', 'return') : oilRoute('M73 132H255', 'supply'),
    reversed ? oilRoute('M507 132H325', 'supply') : oilRoute('M325 132H507', 'return'),
    reversed ? arrow('M185 132H135', 'return') : arrow('M135 132H185', 'supply'),
    reversed ? arrow('M445 132H395', 'supply') : arrow('M395 132H445', 'return'),
    '<circle class="teaching-valve-cell" cx="290" cy="132" r="35"/>',
    '<path fill="currentColor" d="M261 123l16 9-16 9zM319 123l-16 9 16 9z"/>',
    wire('M290 167v20'),
    '<circle class="teaching-valve-cell" cx="290" cy="213" r="22"/>',
    `<path class="wire teaching-rotor${reversed ? ' is-reversed' : ''}" d="M290 213v-15m0 15-13 8m13-8 13 8"/>`,
    label(237, 112, 'A'),
    label(343, 112, 'B'),
    label(110, 172, reversed ? '回油' : '供油'),
    label(470, 172, reversed ? '供油' : '回油'),
    label(290, 262, reversed ? '输出轴反向旋转' : '输出轴正向旋转'),
  ].join('');
}

function shutoffDrawing(open: boolean): string {
  return [
    open ? oilRoute('M76 143H264', 'supply') : wire('M76 143H264', 'supply'),
    open ? oilRoute('M316 143H504', 'supply') : wire('M316 143H504'),
    open ? arrow('M145 143H201', 'supply') + arrow('M378 143H434', 'supply') : '',
    wire('M264 130l26 13-26 13zM316 130l-26 13 26 13zM290 143v-29'),
    wire(open ? 'M276 114h28' : 'M290 103v22'),
    open ? '' : '<path class="stop-mark" d="m285 173 10 10m0-10-10 10"/>',
    label(246, 124, 'A'),
    label(334, 124, 'B'),
    label(290, 218, open ? '截止阀全开' : '截止阀关闭'),
  ].join('');
}

function meterDrawing(reversed: boolean): string {
  return [
    reversed ? oilRoute('M255 143H76', 'supply') : oilRoute('M76 143H255', 'supply'),
    reversed ? oilRoute('M504 143H325', 'supply') : oilRoute('M325 143H504', 'supply'),
    reversed
      ? arrow('M205 143H145', 'supply') + arrow('M435 143H375', 'supply')
      : arrow('M145 143H205', 'supply') + arrow('M375 143H435', 'supply'),
    '<circle class="teaching-valve-cell" cx="290" cy="143" r="35"/>',
    wire('M273 156l28-28m-9 0h9v9'),
    label(282, 140, 'Q', true),
    label(238, 122, 'A'),
    label(342, 122, 'B'),
    label(290, 222, reversed ? '−6.0 L/min' : '+6.0 L/min'),
  ].join('');
}

export const basicTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:cylinder',
    name: '双作用液压缸',
    category: '执行元件',
    topic: '交替给两腔供油',
    ports: [
      ['A', '无杆腔'],
      ['B', '有杆腔'],
    ],
    condition: '伸出到位',
    summary: 'A 口供油，B 口回油，活塞杆向右伸出。',
    action: '换向缩回',
    observation: '到位后按箭头提示换向，比较两腔的供油和回油。',
    drawing: actuatorDrawing(true, 'double'),
    stroke: '伸出',
    alternate: {
      condition: '缩回到位',
      summary: 'B 口供油，A 口回油，活塞杆向左缩回。',
      action: '换向伸出',
      observation: '两次动作都由油压驱动。油液从另一腔排回油箱。',
      drawing: actuatorDrawing(false, 'double'),
      stroke: '缩回',
    },
  },
  {
    id: 'teaching:single-acting-cylinder',
    name: '单作用缸（弹簧复位）',
    category: '执行元件',
    topic: '油压伸出，弹簧复位',
    ports: [['A', '同一口进油和回油']],
    condition: '伸出到位',
    summary: 'A 口供油推动活塞伸出，同时压缩弹簧。',
    action: '切到回油',
    observation: '到位后让 A 口通油箱，观察弹簧怎样推动活塞。',
    drawing: actuatorDrawing(true, 'spring'),
    stroke: '伸出',
    alternate: {
      condition: '缩回到位',
      summary: 'A 口接通油箱，弹簧推动活塞杆缩回，油从 A 口排出。',
      action: '恢复供油',
      observation: '一个油口完成进油和回油。缩回时由弹簧做功。',
      drawing: actuatorDrawing(false, 'spring'),
      stroke: '缩回',
    },
  },
  {
    id: 'teaching:directional-3-4',
    name: '换向阀（三位四通示例）',
    category: '方向控制',
    topic: '切换工作口的供油与回油',
    ports: [
      ['P / T', '泵出口 / 回油箱'],
      ['A / B', '接液压缸两腔'],
    ],
    condition: '伸出到位',
    summary: '高亮的是当前工作位。P 给 A 供油，B 接 T，液压缸伸出。',
    action: '换向缩回',
    observation: '到位后点按钮。看高亮的工作位和 A、B 油路如何改变。',
    drawing: actuatorDrawing(true, 'valve'),
    stroke: '伸出',
    alternate: {
      condition: '缩回到位',
      summary: '换位后，P 给 B 供油，A 接 T，液压缸缩回。',
      action: '换向伸出',
      observation: '这里用中位封闭的三位四通阀演示两个工作位。',
      drawing: actuatorDrawing(false, 'valve'),
      stroke: '缩回',
    },
  },
  {
    id: 'teaching:motor',
    name: '液压马达',
    category: '执行元件',
    topic: '把油液能量变成轴的旋转',
    ports: [
      ['A', '工作口'],
      ['B', '工作口'],
    ],
    condition: 'A 口进油，正转',
    summary: '双向马达示例中，A 口进油、B 口回油，输出轴正转。',
    action: '反向供油',
    observation: '看轴端标记的转向。切换后，两个油口的作用互换。',
    drawing: motorDrawing(false),
    alternate: {
      condition: 'B 口进油，反转',
      summary: '供油改到 B 口，A 口回油，输出轴反转。',
      action: '恢复 A 口供油',
      observation: '流向改变，转向也改变。轴端标记用来指示方向。',
      drawing: motorDrawing(true),
    },
  },
  {
    id: 'teaching:manual-shutoff',
    name: '手动截止阀',
    category: '方向控制',
    topic: '手动接通或隔断油路',
    ports: [
      ['A', '图示供油侧'],
      ['B', '图示工作侧'],
    ],
    condition: '阀全开，油路接通',
    summary: '阀全开时，示意中的油从 A 口流向 B 口。',
    action: '关闭截止阀',
    observation: '关闭后比较阀前后。供油侧仍可能有压力。',
    drawing: shutoffDrawing(true),
    alternate: {
      condition: '阀关闭，油路隔断',
      summary: '关闭截止阀后，油不能从 A 通过阀口到达 B。',
      action: '打开截止阀',
      observation: '流动标记停止。红色线表示阀前一侧仍在供压。',
      drawing: shutoffDrawing(false),
    },
  },
  {
    id: 'teaching:flow-meter',
    name: '串联流量计',
    category: '测量仪表',
    topic: '测量实际穿过仪表的流量',
    ports: [
      ['A', '正向计量入口'],
      ['B', '正向计量出口'],
    ],
    condition: '正向流动，读数为正',
    summary: '流量计串在管路上，主油路的油从 A 口流经仪表到 B 口。',
    action: '切换流向',
    observation: '示例以 A 到 B 为正。通过仪表的油流会产生压降。',
    drawing: meterDrawing(false),
    alternate: {
      condition: '反向流动，读数为负',
      summary: '油从 B 口流向 A 口，流量大小相同，读数的符号反转。',
      action: '切回正向',
      observation: '对照箭头与正负号，可以判断油液实际流向。',
      drawing: meterDrawing(true),
    },
  },
];
