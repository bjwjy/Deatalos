import { arrow, label, node, oilRoute, symbol, wire } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

function shuttleDrawing(fromA: boolean): string {
  return [
    '<rect class="teaching-valve-cell" x="220" y="122" width="140" height="58" rx="4"/>',
    fromA ? oilRoute('M70 151H290V66', 'supply') : oilRoute('M510 151H290V66', 'supply'),
    fromA ? wire('M360 151H510M360 151h-21') : wire('M70 151H220h21'),
    wire('M245 140l12 11-12 11M335 140l-12 11 12 11'),
    `<circle class="teaching-valve-cell teaching-shuttle-ball" data-source="${fromA ? 'a' : 'b'}" cx="290" cy="151" r="9"/>`,
    fromA ? arrow('M125 151H186', 'supply') : arrow('M455 151H394', 'supply'),
    arrow('M290 113V74', 'supply'),
    label(326, 77, 'C 输出'),
    label(139, 123, fromA ? 'A · 5 MPa' : 'A · 2 MPa'),
    label(441, 123, fromA ? 'B · 2 MPa' : 'B · 5 MPa'),
    label(290, 225, fromA ? 'A → C · B 侧隔离' : 'B → C · A 侧隔离'),
  ].join('');
}

function twoPressureDrawing(enabled: boolean): string {
  return [
    '<rect class="teaching-valve-cell" x="218" y="117" width="144" height="72" rx="5"/>',
    enabled ? oilRoute('M70 153H290V66', 'supply') : wire('M70 153H218h23m0-7v14', 'supply'),
    wire('M510 153H337m0-7v14', enabled ? 'supply' : ''),
    enabled ? arrow('M118 153H177', 'supply') + arrow('M290 110V75', 'supply') : wire('M290 66v72m-7 0h14'),
    `<text class="teaching-and-gate" data-enabled="${enabled}" x="290" y="180" text-anchor="middle">&amp;</text>`,
    label(324, 78, 'C'),
    label(132, 121, 'A · 已达条件'),
    label(448, 121, enabled ? 'B · 已达条件' : 'B · 压力不足'),
    label(290, 234, enabled ? '两路均满足 · 高压侧 A 向 C 供油' : '仅一路满足 · C 无输出流量'),
  ].join('');
}

function shockDrawing(active: boolean): string {
  const relief = 'M150 65V148H290';
  const makeup = 'M290 148H430V65';
  return [
    '<rect class="teaching-valve-cell" x="111" y="105" width="358" height="89" rx="6"/>',
    active ? oilRoute(relief, 'supply') : wire(relief),
    active ? oilRoute(makeup, 'return') : wire(makeup),
    active
      ? arrow('M150 76V100', 'supply') +
        arrow('M202 148H248', 'supply') +
        arrow('M430 100V76', 'return') +
        arrow('M335 148H383', 'return')
      : '',
    '<rect class="teaching-valve-cell" x="177" y="124" width="28" height="48" rx="2"/>',
    active ? arrow('M181 148H201', 'supply') : wire('M177 148h17m0-7v14'),
    wire('M191 124v-7l5-4 5 8 5-8 5 4'),
    symbol(active ? 'check' : 'check-closed', 387, 148, 90),
    node(290, 148),
    wire('M290 148V232'),
    symbol('tank', 290, 262),
    label(150, 47, active ? 'A · 瞬时高压' : 'A · 工作口'),
    label(430, 47, active ? 'B · 压力偏低' : 'B · 工作口'),
    label(175, 216, 'A 侧溢流支路', true),
    label(405, 216, 'B 侧补油支路', true),
    label(312, 228, 'T'),
    label(347, 280, '油箱', true),
  ].join('');
}

function switchDrawing(
  pressure: number,
  closed: boolean,
  analogVoltage?: number,
  transition?: 'open' | 'close',
): string {
  const analog = analogVoltage !== undefined;
  const y = analogVoltage === 10 ? 91 : 123;
  const x = analogVoltage === 10 ? 337 : 288;
  return [
    '<rect class="teaching-valve-cell" x="195" y="67" width="170" height="121" rx="6"/>',
    wire('M280 188V230', 'measure'),
    wire('M365 123H507', analog ? 'teaching-signal-analog' : closed ? 'teaching-signal-on' : 'teaching-signal-off'),
    analog
      ? wire('M231 162V86M231 162H344M239 155L337 91', 'measure') +
        `<circle class="teaching-analog-point" cx="${x}" cy="${y}" r="5"/>` +
        label(243, 180, '1 MPa', true) +
        label(327, 180, '5 MPa', true)
      : [
          node(243, 123),
          node(320, 123),
          `<path class="wire teaching-switch-contact" data-closed="${closed}"${transition ? ` data-transition="${transition}"` : ''} d="M243 123H320"/>`,
          label(281, 169, closed ? '触点闭合' : '触点断开'),
        ].join(''),
    label(305, 217, 'H'),
    label(279, 260, `取压 ${pressure.toFixed(1)} MPa`),
    label(434, 104, 'OUT'),
    label(435, 154, `${analogVoltage ?? (closed ? 10 : 0)} V`),
    label(280, 43, analog ? '模拟量 · 1～5 MPa 对应 0～10 V' : '开关量 · 动作 4 MPa / 复位 3 MPa'),
  ].join('');
}

export const logicTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:shuttle-valve',
    name: '液压梭阀',
    category: '液压逻辑',
    topic: '把较高压力的一侧接到 C',
    ports: [
      ['A / B', '两路液压输入'],
      ['C', '选压输出'],
    ],
    condition: 'A 压力较高，A → C',
    summary: 'A 侧压力较高，阀芯移向 B 侧并隔离 B，A 给 C 供油。',
    action: '换成 B 侧高压',
    observation: '本例 C 接较低压力的用油端。看阀芯和通向 C 的箭头。',
    drawing: shuttleDrawing(true),
    alternate: {
      condition: 'B 压力较高，B → C',
      summary: 'B 侧压力较高，阀芯移向 A 侧，C 的供油切换到 B。',
      action: '换回 A 侧高压',
      observation: '较低压力的一侧被隔离，两路供油口不会直接串通。',
      drawing: shuttleDrawing(false),
    },
  },
  {
    id: 'teaching:two-pressure-valve',
    name: '双压阀',
    category: '液压逻辑',
    topic: '两侧压力都满足才有输出',
    ports: [
      ['A / B', '两个压力条件'],
      ['C', '条件满足后的输出'],
    ],
    condition: '只有 A 达到条件，C 截止',
    summary: 'A 侧已有压力，B 侧压力不足。双压阀的两个条件还未同时满足。',
    action: '提高 B 侧压力',
    observation: '符号中的 & 表示“且”。先看 C 口处于截止状态。',
    drawing: twoPressureDrawing(false),
    alternate: {
      condition: 'A 和 B 均达条件，C 通流',
      summary: '两侧都达到开启条件后，示例中压力较高的 A 向 C 供油。',
      action: '降低 B 侧压力',
      observation: 'B 在本例提供开启条件。任一路压力不足，C 的通流就停止。',
      drawing: twoPressureDrawing(true),
    },
  },
  {
    id: 'teaching:shock-makeup-valve',
    name: '冲击溢流补油阀组',
    category: '压力控制',
    topic: '高压侧卸压，低压侧补油',
    ports: [
      ['A / B', '两个工作口'],
      ['T', '回油及补油来源'],
    ],
    condition: '两侧压力正常，保护支路关闭',
    summary: 'A、B 都在正常范围时，示例中的冲击溢流和补油支路都关闭。',
    action: '模拟 A 侧压力冲击',
    observation: '切换后观察两个方向。阀组对两侧都提供相同保护。',
    drawing: shockDrawing(false),
    alternate: {
      condition: 'A → T 溢流，T → B 补油',
      summary: 'A 侧超压向 T 泄放。B 侧压力低于补油条件时，T 的油进入 B。',
      action: '恢复正常压力',
      observation: '红箭头标高压卸流，蓝箭头标低压补油。T 处是共同回油边界。',
      drawing: shockDrawing(true),
    },
  },
  {
    id: 'teaching:adjustable-pressure-switch',
    name: '可调压力开关',
    category: '测量仪表',
    topic: '同一个 OUT 输出两种电压信号',
    ports: [
      ['H', '取压口'],
      ['OUT', '开关量或模拟量电压'],
    ],
    condition: '开关量 · 低压，OUT 0 V',
    summary: '示例动作值 4 MPa，复位值 3 MPa。低压时触点断开。',
    action: '升过动作值',
    observation: '红色点画线表示开关量断开。加压后观察触点和 OUT。',
    drawing: switchDrawing(2.5, false),
    alternate: {
      condition: '开关量 · 动作，OUT 10 V',
      summary: '压力升过 4 MPa，触点闭合，OUT 从 0 V 切到 10 V。',
      action: '降到回差区',
      observation: '绿色点画线表示触点闭合。再降一点压力，看看它是否复位。',
      drawing: switchDrawing(5, true, undefined, 'close'),
    },
    additional: [
      {
        condition: '开关量 · 回差区，仍为 10 V',
        summary: '压力降到 3.5 MPa，低于动作值，但还高于 3 MPa 的复位值。',
        action: '降到复位值以下',
        observation: '触点保持闭合，OUT 仍是 10 V。这个区间避免触点来回跳。',
        drawing: switchDrawing(3.5, true),
      },
      {
        condition: '开关量 · 复位，OUT 0 V',
        summary: '压力降到 2.5 MPa，触点重新断开，OUT 回到 0 V。',
        action: '查看模拟量模式',
        observation: '接下来用同一个 OUT 对照模拟量，压力与电压之间连续变化。',
        drawing: switchDrawing(2.5, false, undefined, 'open'),
      },
      {
        condition: '模拟量 · 3 MPa 对应 5 V',
        summary: '示例把 1～5 MPa 映射到 0～10 V，中点 3 MPa 输出 5 V。',
        action: '升到 5 MPa',
        observation: '看斜线上的工作点。OUT 仍然输出电压，数值随压力连续变化。',
        drawing: switchDrawing(3, false, 5),
      },
      {
        condition: '模拟量 · 5 MPa 对应 10 V',
        summary: '压力到达区间上限，OUT 输出 10 V。区间下限 1 MPa 对应 0 V。',
        action: '返回开关量模式',
        observation: '压力范围可在属性中设置，示例演示区间内的线性映射。',
        drawing: switchDrawing(5, false, 10),
      },
    ],
  },
];
