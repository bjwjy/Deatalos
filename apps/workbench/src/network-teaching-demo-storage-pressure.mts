import { arrow, label, motion, node, oilRoute, symbol, wire } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

const liquidDots = [92, 121, 150]
  .flatMap((y) => [241, 265, 290, 315, 339].map((x) => `<circle cx="${x}" cy="${y}" r="3"/>`))
  .join('');

function storageDrawing(charging: boolean, bladder: boolean): string {
  return [
    `<g class="teaching-storage" data-charge="${charging ? 'in' : 'out'}">`,
    bladder
      ? [
          '<rect class="teaching-reservoir-body" x="242" y="50" width="96" height="139" rx="48"/>',
          '<path class="teaching-gas-bladder" d="M264 82Q290 49 316 82V124Q290 166 264 124Z"/>',
          label(290, 90, '氮气'),
          label(290, 175, '液压油', true),
          label(407, 112, charging ? '气囊压缩 ↓' : '气囊膨胀 ↑'),
        ].join('')
      : [
          '<rect class="teaching-reservoir-body" x="212" y="59" width="156" height="130" rx="5"/>',
          `<g class="teaching-liquid-dots">${liquidDots}</g>`,
          label(290, 39, '定容腔 · 始终充满油液'),
          label(290, 175, '油液可压缩', true),
          label(438, 120, charging ? '腔压升高 ↑' : '腔压降低 ↓'),
        ].join(''),
    charging ? oilRoute('M79 228H290V189', 'supply') : oilRoute('M290 189V228H79', 'supply'),
    charging ? arrow('M144 228H215', 'supply') : arrow('M215 228H144', 'supply'),
    label(309, 213, 'H'),
    label(137, 261, charging ? '接较高压力油路' : '接较低压力油路'),
    label(387, 258, charging ? '油液流入 H 口' : '油液从 H 口流出', true),
    '</g>',
  ].join('');
}

function reductionDrawing(overpressure: boolean, relieving: boolean): string {
  return [
    '<rect class="teaching-valve-cell" x="229" y="110" width="122" height="59" rx="3"/>',
    overpressure ? wire('M66 140H229') : oilRoute('M66 140H229', 'supply'),
    overpressure
      ? relieving
        ? oilRoute('M514 140H351', 'supply')
        : wire('M351 140H514', 'supply')
      : oilRoute('M351 140H514', 'supply'),
    overpressure
      ? wire('M229 140h26m0-8v16')
      : arrow('M115 140H172', 'supply') + arrow('M241 140H340', 'supply') + arrow('M402 140H466', 'supply'),
    relieving
      ? [
          overpressure
            ? arrow('M452 140H398', 'supply') + arrow('M348 140H290V168', 'return') + oilRoute('M290 169V224', 'return')
            : wire('M290 224V155m-8 0h16'),
          symbol('tank', 290, 254),
          label(308, 204, 'T'),
          label(384, 246, overpressure ? 'A → T 泄压' : 'T 口泄压通路关闭', true),
        ].join('')
      : [
          overpressure ? wire('M351 140h-26m0-8v16') : '',
          '<path class="wire measure" d="M290 169v54" stroke-dasharray="4 4"/>',
          label(308, 198, 'Y'),
          label(290, 253, '外泄参考口', true),
        ].join(''),
    '<path class="wire measure" d="M370 140V93H329V110" stroke-dasharray="4 4"/>',
    wire('M245 110V99l7-6 7 12 7-12 7 6V89'),
    label(186, 124, 'P'),
    label(398, 124, 'A'),
    overpressure
      ? '<text class="teaching-pressure-rise" x="445" y="186" text-anchor="middle">外力推高 A 口压力 ↑</text>'
      : label(434, 188, relieving ? 'A 口减压供油' : '按 A−Y 调节出口压力'),
  ].join('');
}

function sequenceDrawing(open: boolean): string {
  return [
    '<rect class="teaching-valve-cell" x="251" y="145" width="94" height="50" rx="3"/>',
    oilRoute('M67 169H251', 'supply'),
    arrow('M97 169H134', 'supply'),
    open ? wire('M170 169V84H251', 'supply') : oilRoute('M170 169V84H251', 'supply'),
    node(170, 169),
    open
      ? arrow('M261 169H335', 'supply') + oilRoute('M345 169H516', 'supply') + arrow('M398 169H456', 'supply')
      : wire('M251 169h24m0-7v14M345 169h-24m0-7v14M345 169H516') + arrow('M170 133V95', 'supply'),
    '<path class="wire measure" d="M208 169v-37h56v13M297 195v41" stroke-dasharray="4 4"/>',
    wire('M328 145v-7l7-5 7 10 7-10 7 5v-7'),
    label(300, 70, open ? '第一动作已到位' : '第一动作支路'),
    label(466, 146, '第二动作支路'),
    label(228, 154, 'P'),
    label(370, 154, 'A'),
    label(316, 228, 'Y'),
    label(298, 266, open ? 'P − Y = 4.0 MPa，达到开启条件' : 'P − Y = 2.0 MPa，低于示例设定 3.0 MPa'),
  ].join('');
}

function pilotReliefDrawing(open: boolean): string {
  const pilotIn = 'M310 102H179V136';
  const pilotOut = 'M179 168V218H310';
  return [
    oilRoute('M64 64H514', 'supply'),
    arrow('M104 64H150', 'supply'),
    arrow('M380 64H436', 'supply'),
    open ? oilRoute('M310 64V135', 'supply') : wire('M310 64V135', 'supply'),
    '<rect class="teaching-valve-cell" x="278" y="135" width="64" height="47" rx="3"/>',
    '<rect class="teaching-valve-cell" x="160" y="136" width="38" height="32" rx="3"/>',
    wire(pilotIn, open ? 'teaching-pilot-feed' : 'teaching-pilot-idle'),
    wire(pilotOut, open ? 'teaching-pilot-return' : 'teaching-pilot-idle'),
    '<path class="wire measure" d="M226 102v54h52" stroke-dasharray="4 4"/>',
    wire('M234 96Q240 105 246 96M234 108Q240 99 246 108'),
    node(226, 102),
    open
      ? [
          motion(pilotIn, 'slow teaching-pilot-motion'),
          motion(pilotOut, 'slow teaching-pilot-motion'),
          arrow('M179 141V162', 'return'),
          arrow('M310 141V176', 'supply'),
          oilRoute('M310 182V240', 'return'),
          arrow('M310 188V210', 'return'),
          node(310, 218),
        ].join('')
      : wire('M179 136v10m-6 0h12M310 135v16m-8 0h16M310 182V240'),
    wire('M342 158h7l6-7 7 14 7-14 7 14 7-7'),
    node(310, 64),
    symbol('tank', 310, 270),
    label(107, 42, '来自泵出口'),
    label(463, 42, '去工作回路'),
    label(128, 154, '先导阀', true),
    label(423, 161, open ? '主阀开启' : '主阀关闭'),
    label(330, 121, 'P'),
    label(332, 232, 'T'),
    label(122, 239, open ? '先导油经内部通道回 T' : '先导支路截止', true),
    label(382, 283, '油箱', true),
  ].join('');
}

export const storagePressureTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:volume',
    name: '液压容腔',
    category: '供油与回油',
    topic: '用可压缩的油液储存压力',
    ports: [['H', '容腔进出油口']],
    condition: '接较高压力，油液压缩',
    summary: '少量油经 H 口进入固定容积，油液略微压缩，腔压升高。',
    action: '接到低压侧',
    observation: '看箭头和点距。点距变化为放大示意，容腔始终充满油液。',
    drawing: storageDrawing(true, false),
    alternate: {
      condition: '接较低压力，容腔释放油液',
      summary: '外侧压力较低时，压缩的油液膨胀，少量油从 H 口排出。',
      action: '接到高压侧',
      observation: '箭头反向，腔压随放油降低。进出油共用 H 口。',
      drawing: storageDrawing(false, false),
    },
  },
  {
    id: 'teaching:accumulator',
    name: '气囊式蓄能器',
    category: '供油与回油',
    topic: '压缩氮气储能，再推动油液',
    ports: [['H', '充油与放油口']],
    condition: '外侧压力较高，充油储能',
    summary: '油液经 H 口进入，挤压预充氮气的气囊，储存能量。',
    action: '切到放油',
    observation: '看浅色气囊变小。气囊把氮气和液压油隔开。',
    drawing: storageDrawing(true, true),
    alternate: {
      condition: '外侧压力下降，放油释能',
      summary: '气囊膨胀，把油从 H 口推入压力较低的回路。',
      action: '恢复充油',
      observation: '气囊变大，H 口箭头反向。图中演示放油阶段。',
      drawing: storageDrawing(false, true),
    },
  },
  {
    id: 'teaching:pressure-reducing',
    name: '非溢流减压阀',
    category: '压力控制',
    topic: '调低出口压力，超压时关小进油',
    ports: [
      ['P', '供油入口'],
      ['A', '减压出口'],
      ['Y', '外泄参考口'],
    ],
    condition: 'P → A，减压供油',
    summary: '阀按 A 口相对 Y 口的压力调节主通路，让 A 口低于供油压力。',
    action: '施加下游外力',
    observation: '看 P 到 A 的箭头。下游受外力抬压时，观察进油怎样变化。',
    drawing: reductionDrawing(false, false),
    alternate: {
      condition: 'A 口外力抬压，进油关小',
      summary: 'A 口压力被外力推高，主通路关小，图中演示关闭后的状态。',
      action: '撤去下游外力',
      observation: 'P → A 的流动停止，Y 口作为外泄参考，A 口超压需由回路另行释放。',
      drawing: reductionDrawing(true, false),
    },
  },
  {
    id: 'teaching:pressure-reducing-relieving',
    name: '三通溢流减压阀',
    category: '压力控制',
    topic: '供油时减压，出口超压时泄油',
    ports: [
      ['P', '供油入口'],
      ['A', '工作口'],
      ['T', '接回油箱'],
    ],
    condition: 'P → A，减压供油',
    summary: '正常供油时，油从 P 流向 A，T 口的泄压通路关闭。',
    action: '施加下游外力',
    observation: '对照 P、A、T 三个口。让 A 口压力被外力推高，再看油从哪边排出。',
    drawing: reductionDrawing(false, true),
    alternate: {
      condition: 'A 口超压，A → T 泄放',
      summary: 'A 口压力升高时，供油通路关小，A 口多余的油经 T 回油箱。',
      action: '撤去下游外力',
      observation: '看箭头从 A 指向 T。这个工况示意 P 口供油通路已经关闭。',
      drawing: reductionDrawing(true, true),
    },
  },
  {
    id: 'teaching:sequence-valve',
    name: '顺序阀',
    category: '压力控制',
    topic: '达到压力条件，再开始第二个动作',
    ports: [
      ['P', '入口兼取压'],
      ['A', '第二动作供油'],
      ['Y', '外泄参考口'],
    ],
    condition: '压力较低，先供第一支路',
    summary: 'P 口相对 Y 口的压差低于设定值，顺序阀关闭，只有第一支路进油。',
    action: '让第一动作到位',
    observation: '看上方支路。示例设定压差为 3.0 MPa。',
    drawing: sequenceDrawing(false),
    alternate: {
      condition: '压差达到设定，第二支路开启',
      summary: '第一动作到位后，P 口压力升高。压差达到条件，P 向 A 供油。',
      action: '复位第一动作',
      observation: '看第二支路的箭头。决定开启的是 P − Y 压差。',
      drawing: sequenceDrawing(true),
    },
  },
  {
    id: 'teaching:pilot-relief',
    name: '先导式溢流阀',
    category: '压力控制',
    topic: '先导泄油，主阀打开旁路',
    ports: [
      ['P', '供油及内部取压'],
      ['T', '主阀与先导共同回油'],
    ],
    condition: '压力较低，两级均关闭',
    summary: '供油压力低于开启条件，先导阀和主阀均关闭，油沿主油路供给负载。',
    action: '提高供油压力',
    observation: '左侧虚线是内部先导支路，右侧方框是主阀。',
    drawing: pilotReliefDrawing(false),
    alternate: {
      condition: '先导泄油，主阀开启',
      summary: '压差达到条件后，先导油泄向 T，主阀控制腔降压，主阀开启。',
      action: '降低供油压力',
      observation: '看左侧细流和中间粗流。主溢流从 P 经主阀回 T。',
      drawing: pilotReliefDrawing(true),
    },
  },
];
