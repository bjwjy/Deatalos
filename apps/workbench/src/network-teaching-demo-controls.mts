import { arrow, label, oilRoute, symbol, wire } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

function pumpDrawing(high: boolean): string {
  return [
    oilRoute('M107 216V130H248', 'return', high ? undefined : 'slow'),
    oilRoute('M332 130H511', 'supply', high ? undefined : 'slow'),
    arrow('M142 130H198', 'return'),
    arrow('M390 130H458', 'supply'),
    symbol('pump', 290, 130, 90),
    symbol('tank', 107, 246),
    `<path class="wire teaching-displacement-marker" data-high="${high}" d="M263 158l54-56m-12 2 12-2-2 12"/>`,
    label(229, 111, 'S'),
    label(351, 111, 'P'),
    label(290, 61, '转速保持 1000 r/min'),
    label(290, 205, high ? '排量 14 cm³/r' : '排量 6 cm³/r'),
    label(449, 165, high ? '理论流量 14 L/min' : '理论流量 6 L/min'),
    label(107, 281, '油箱', true),
  ].join('');
}

function motorDrawing(mode: 'X' | 'U', pressure: number, voltage: number): string {
  const displacement = pressure === 1 ? 10 : pressure === 3 ? 15 : 20;
  const x = pressure === 1 ? 80 : pressure === 3 ? 142 : 204;
  const y = pressure === 1 ? 193 : pressure === 3 ? 158 : 123;
  return [
    wire('M69 199V110M69 199H221M80 193l124-70', 'measure'),
    wire(`M${x} ${y}V199`, 'measure'),
    `<circle class="teaching-analog-point" cx="${x}" cy="${y}" r="5"/>`,
    label(139, 92, '示例压力—排量曲线'),
    label(80, 219, '1', true),
    label(142, 219, '3', true),
    label(204, 219, '5 MPa', true),
    label(145, 251, mode === 'X' ? `X · ${pressure} MPa` : `U · ${voltage} V → ${pressure} MPa`),
    wire('M220 161H374', mode === 'U' ? 'teaching-signal-analog' : 'measure'),
    oilRoute('M292 128H354', 'supply'),
    oilRoute('M430 128H511', 'return'),
    arrow('M306 128H338', 'supply'),
    arrow('M443 128H484', 'return'),
    '<circle class="teaching-valve-cell" cx="392" cy="128" r="38"/>',
    '<path fill="currentColor" d="M358 120l14 8-14 8zM426 120l-14 8 14 8z"/>',
    '<circle class="teaching-valve-cell" cx="392" cy="128" r="15"/>',
    `<path class="wire teaching-control-rotor" data-displacement="${displacement}" d="M392 128v-11m0 11-8 5m8-5 8 5"/>`,
    label(334, 109, 'A'),
    label(455, 109, 'B'),
    label(391, 191, `排量 ${displacement} cm³/r`),
    label(391, 224, '进油流量保持不变', true),
    label(391, 251, pressure === 1 ? '轴转得较快' : pressure === 3 ? '轴转速居中' : '轴转得较慢'),
  ].join('');
}

function controllerDrawing(phase: 'extend' | 'condition' | 'retract'): string {
  const extending = phase === 'extend';
  const ready = phase === 'condition';
  const a = 'M370 189V145H348V99';
  const b = 'M444 99V145H423V189';
  return [
    '<g class="teaching-controller-rig">',
    '<rect class="teaching-valve-cell" x="52" y="58" width="187" height="142" rx="7"/>',
    '<rect class="teaching-valve-cell is-active" x="67" y="120" width="157" height="48" rx="4"/>',
    label(145, 89, '动态控制器'),
    label(145, 149, phase === 'retract' ? '步骤 2 · 缩回' : '步骤 1 · 伸出'),
    label(146, 187, ready ? '到位条件已满足' : extending ? '等待缸到位' : '进入下一动作', true),
    wire('M239 181H320V212H345', ready ? 'teaching-pilot-idle' : 'teaching-controller-command'),
    wire('M348 104H270V82H239', ready ? 'teaching-signal-on' : 'teaching-pilot-idle'),
    label(283, 70, '读缸位移', true),
    label(291, 239, '发阀位命令', true),
    '<rect class="teaching-cylinder-shell" x="327" y="57" width="160" height="42"/>',
    `<g class="teaching-controller-piston" data-phase="${phase}"><rect class="teaching-piston-metal" x="354" y="58" width="6" height="40"/><rect class="teaching-piston-metal" x="360" y="75" width="134" height="8"/></g>`,
    '<rect class="teaching-valve-cell" x="345" y="189" width="103" height="48" rx="3"/>',
    ready ? wire(a, 'supply') : extending ? oilRoute(a, 'supply') : oilRoute('M348 99V145H370V189', 'return'),
    ready ? wire(b) : extending ? oilRoute(b, 'return') : oilRoute('M423 189V145H444V99', 'supply'),
    phase === 'retract'
      ? arrow('M370 232L423 195', 'supply') + arrow('M370 194L423 232', 'return')
      : arrow('M370 232V194', 'supply') + arrow('M423 194V232', 'return'),
    wire('M370 237V254M423 237V254'),
    label(396, 278, '换向阀'),
    '</g>',
  ].join('');
}

export const controlTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:variable-pump',
    name: '变量泵',
    category: '供油与回油',
    topic: '转速相同，排量改变供油量',
    ports: [
      ['S', '吸油口'],
      ['P', '供油口'],
    ],
    condition: '较小排量，供油较少',
    summary: '示例泵以 1000 r/min 转动，每转排出 6 cm³，理论供油量为 6 L/min。',
    action: '增大排量给定',
    observation: '看斜箭头和油流。排量是每转排出的体积，供油压力还取决于负载。',
    drawing: pumpDrawing(false),
    alternate: {
      condition: '排量增大，供油增加',
      summary: '每转排量增至 14 cm³。转速保持不变，理论供油量升到 14 L/min。',
      action: '减小排量给定',
      observation: '这里对照给定排量改变供油量，数值为忽略泄漏的示例。',
      drawing: pumpDrawing(true),
    },
  },
  {
    id: 'teaching:variable-motor',
    name: '变量液压马达',
    category: '执行元件',
    topic: '压力和电压共用排量曲线',
    ports: [
      ['A / B', '工作油口'],
      ['X', '外部取压'],
      ['U', '外部电压'],
    ],
    condition: 'X · 1 MPa，排量较小',
    summary: '取压口 X 接到 1 MPa 的测点，示例曲线给出较小排量。',
    action: '将 X 升到 3 MPa',
    observation: '保持工作油流量不变。排量较小时，每转需要的油量较少，转速较高。',
    drawing: motorDrawing('X', 1, 0),
    alternate: {
      condition: 'X · 3 MPa，示例排量 15 cm³/r',
      summary: 'X 的压力升到区间中点。工作点沿曲线上移，轴转速降低。',
      action: '换成 U · 5 V',
      observation: '接下来换输入方式，看同一个等效压力会落在曲线的哪一点。',
      drawing: motorDrawing('X', 3, 0),
    },
    additional: [
      {
        condition: 'U · 5 V 等效 3 MPa，排量相同',
        summary: '切到 U 电压模式。1～5 MPa 对应 0～10 V，5 V 等效 3 MPa。',
        action: '将 U 升到 10 V',
        observation: '曲线上还是同一个点，排量与 X 接 3 MPa 时一致。X 和 U 两种方式互斥。',
        drawing: motorDrawing('U', 3, 5),
      },
      {
        condition: 'U · 10 V 等效 5 MPa，排量增大',
        summary: 'U 升到 10 V，曲线上取到 5 MPa 的排量。进油量不变时转速更低。',
        action: '回到 X · 1 MPa',
        observation: '两种输入都按所设曲线取排量。图中曲线和压力区间是教学示例。',
        drawing: motorDrawing('U', 5, 10),
      },
    ],
  },
  {
    id: 'teaching:dynamic-controller',
    name: '动态控制器',
    category: '动态控制',
    topic: '条件满足后执行下一步动作',
    ports: [
      ['读取', '示例用缸位移判断'],
      ['命令', '示例向换向阀下发阀位'],
    ],
    condition: '步骤 1 · 伸出，等待到位',
    summary: '控制器发出伸出阀位命令，同时读取缸位移，等待到位条件。',
    action: '示意缸到位',
    observation: '点画线表示读取和命令，实线箭头表示液压流向。控制器无油口。',
    drawing: controllerDrawing('extend'),
    alternate: {
      condition: '伸出到位，换步条件满足',
      summary: '读取的缸位移达到示例阈值，控制器可以自动进入下一步。',
      action: '查看自动换步',
      observation: '绿色点画线提示条件成立。实际运行时由控制器判断并换步。',
      drawing: controllerDrawing('condition'),
    },
    additional: [
      {
        condition: '步骤 2 · 下发缩回阀位',
        summary: '控制器执行第二步的缩回命令。换向阀切换油路，液压缸缩回。',
        action: '重看伸出步骤',
        observation: '对照两步的阀位命令和油流方向。实际工况还可按时间或测量条件换步。',
        drawing: controllerDrawing('retract'),
      },
    ],
  },
];
