import { wire, arrow, motion, label, symbol, node } from './network-teaching-demo-diagram.mjs';
import { basicTeachingDemos } from './network-teaching-demo-basics.mjs';
import { flowPressureTeachingDemos } from './network-teaching-demo-flow-pressure.mjs';
import { storagePressureTeachingDemos } from './network-teaching-demo-storage-pressure.mjs';
import { pilotTeachingDemos } from './network-teaching-demo-pilot.mjs';
import { actuatorFlowTeachingDemos } from './network-teaching-demo-actuator-flow.mjs';
import { logicTeachingDemos } from './network-teaching-demo-logic.mjs';
import { controlTeachingDemos } from './network-teaching-demo-controls.mjs';

// The first batch follows the approved offline diagrams in component-teaching-batch-01.html.
interface GaugeReading {
  readonly reading: string;
  readonly angle: number;
  readonly samples?: readonly [string, string];
}
export type TeachingScene = {
  readonly condition: string;
  readonly summary: string;
  readonly action: string;
  readonly observation: string;
} & (
  | {
      readonly drawing: string;
      readonly stroke?: '伸出' | '缩回' | '顺时针摆动' | '逆时针摆动';
      readonly gauge?: never;
    }
  | { readonly gauge: GaugeReading; readonly gaugeDrawing: string; readonly drawing?: never; readonly stroke?: never }
);
export type TeachingDemo = TeachingScene & {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly topic: string;
  readonly ports: readonly (readonly [string, string])[];
  readonly alternate: TeachingScene;
  readonly additional?: readonly TeachingScene[];
};

export const teachingDemoDefinitions = `<defs>
  <linearGradient id="teaching-demo-analog-signal" gradientUnits="userSpaceOnUse" x1="220" y1="0" x2="507" y2="0"><stop stop-color="#5a87b7"/><stop offset="1" stop-color="#248881"/></linearGradient>
  <marker id="teaching-demo-supply-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 8 4 0 8z" fill="#b7512d" /></marker>
  <marker id="teaching-demo-return-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 8 4 0 8z" fill="#30759a" /></marker>
  <marker id="teaching-demo-ink-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 8 4 0 8z" fill="currentColor" /></marker>
<symbol id="teaching-demo-pump" viewBox="-48 -48 96 96"><g stroke="currentColor" stroke-width="2.4" fill="none"><circle r="26" fill="var(--dialog-paper)" /><path d="M0-42v16m0 52v16" /><path d="m-8-7h16L0-22z" fill="currentColor" /></g></symbol>
<symbol id="teaching-demo-tank" viewBox="-48 -48 96 96"><path d="M0-30V8M-25-15v35h50v-35M-20 10h40" fill="none" stroke="currentColor" stroke-width="2.4" /></symbol>
<symbol id="teaching-demo-check" viewBox="-48 -48 96 96"><g stroke="currentColor" stroke-width="2.4" fill="none"><path d="M0 36V15M0-15V-36M-13 5 0 15 13 5" /><circle cy="-3" r="8" fill="var(--dialog-paper)" /></g></symbol>
<symbol id="teaching-demo-check-closed" viewBox="-48 -48 96 96"><g stroke="currentColor" stroke-width="2.4" fill="none"><path d="M0 36V15M0-15V-36M-13 5 0 15 13 5" /><circle cy="5" r="8" fill="var(--dialog-paper)" /></g></symbol>
<symbol id="teaching-demo-throttle" viewBox="-48 -48 96 96"><g stroke="currentColor" stroke-width="2.4" fill="none"><path d="M0-36v72M-13-12Q7 0-13 12M13-12Q-7 0 13 12" /><path d="m-22 24 44-48" marker-end="url(#teaching-demo-ink-arrow)" /></g></symbol>
<symbol id="teaching-demo-relief" viewBox="-48 -48 96 96"><g transform="translate(-10 0) scale(.77)" stroke="currentColor" stroke-width="2.8" fill="none"><rect x="-18" y="-20" width="36" height="40" fill="var(--dialog-paper)" /><path d="M-18 0h-14v-28H0" stroke-dasharray="4 3" /><path d="M0-36v16m0 40v16M18 0h7l5-7 7 14 7-14 7 14 7-7" /><path d="M0-14v28m31 2 20-32" marker-end="url(#teaching-demo-ink-arrow)" /></g></symbol>
</defs>`;

const pressureGaugeDrawing = [
  wire('M67 201H512', 'supply'),
  wire('M291 111V201', 'measure'),
  node(291, 201),
  arrow('M128 201H199', 'supply'),
  arrow('M379 201H448', 'supply'),
  motion('M67 201H512'),
  '<circle class="wire gauge-face" cx="291" cy="86" r="25"/>',
  '<path class="wire gauge-needle" d="M291 86V67"/>',
  '<circle class="teaching-node" cx="291" cy="86" r="2.5"/>',
  label(291, 45, '压力表'),
  '<text x="374" y="91" text-anchor="middle" data-gauge-reading></text>',
  label(352, 155, '测压支路', true),
  label(115, 236, '供油侧'),
  label(464, 236, '工作侧'),
].join('');

const demos: readonly TeachingDemo[] = [
  {
    id: 'teaching:pump',
    name: '定量泵',
    category: '供油与回油',
    topic: '从油箱吸油，向回路供油',
    condition: '泵在转动',
    summary: '泵从 S 口吸油，再从 P 口向工作回路送油。',
    action: '停止泵',
    ports: [
      ['S', '吸油口'],
      ['P', '出油口'],
    ],
    observation: '看箭头方向。排量和转速决定理想供油量，出口压力随负载变化。',
    drawing: [
      wire('M100 211V133H211', 'return'),
      wire('M295 133H505', 'supply'),
      arrow('M136 133H181', 'return'),
      arrow('M348 133H409', 'supply'),
      motion('M100 211V133H211'),
      motion('M295 133H505'),
      symbol('pump', 253, 133, 90),
      symbol('tank', 100, 241),
      label(192, 117, 'S'),
      label(313, 117, 'P'),
      label(100, 277, '油箱'),
      label(253, 190, '定量泵'),
      label(476, 105, '去工作回路'),
    ].join(''),
    alternate: {
      condition: '泵已停转',
      action: '启动泵',
      summary: '泵停转后，示意中的吸油和供油停止。',
      observation: '再启动泵，比较 S、P 两侧的流动方向。',
      drawing: [
        wire('M100 211V133H211M295 133H505'),
        symbol('pump', 253, 133, 90),
        symbol('tank', 100, 241),
        label(192, 117, 'S'),
        label(313, 117, 'P'),
        label(100, 277, '油箱'),
        label(253, 190, '定量泵'),
        label(476, 105, '去工作回路'),
      ].join(''),
    },
  },
  {
    id: 'teaching:tank',
    name: '油箱',
    category: '供油与回油',
    topic: '为泵供油，并接收回油',
    condition: '回油进入油箱',
    summary: '回油经接点流向 T 口，进入油箱。',
    action: '切换到吸油',
    ports: [['T', '油箱接口']],
    observation: '切换后，看同一个 T 口怎样向泵供油。',
    drawing: [
      wire('M510 120H302V181', 'return'),
      wire('M302 120H172'),
      arrow('M458 120H386', 'return'),
      arrow('M302 138V166', 'return'),
      motion('M510 120H302V181'),
      symbol('pump', 130, 120, -90),
      symbol('tank', 302, 211),
      node(302, 120),
      label(461, 100, '来自回油路'),
      label(188, 104, 'S'),
      label(318, 170, 'T'),
      label(130, 173, '去泵吸入口'),
      label(302, 255, '油箱'),
    ].join(''),
    alternate: {
      condition: '油箱向泵供油',
      action: '切换到回油',
      summary: '泵从 S 口吸油，油从油箱 T 口流向泵。',
      observation: '图上的黑点是连接处，两条油路接入同一个 T 口。',
      drawing: [
        wire('M510 120H302'),
        wire('M302 181V120H172', 'return'),
        arrow('M302 169V138', 'return'),
        arrow('M264 120H199', 'return'),
        motion('M302 181V120H172'),
        symbol('pump', 130, 120, -90),
        symbol('tank', 302, 211),
        node(302, 120),
        label(461, 100, '来自回油路'),
        label(188, 104, 'S'),
        label(318, 170, 'T'),
        label(130, 173, '去泵吸入口'),
        label(302, 255, '油箱'),
      ].join(''),
    },
  },
  {
    id: 'teaching:check-valve',
    name: '单向阀',
    category: '方向控制',
    topic: '让油沿一个方向通过',
    condition: 'A 侧供油，正向通流',
    summary: 'A 侧压力比 B 侧高出开启压差后，油从 A 流向 B。',
    action: '切换供油方向',
    ports: [
      ['A', '正向入口'],
      ['B', '正向出口'],
    ],
    observation: '切换到 B 侧供油，观察阀芯和两侧油路。',
    drawing: [
      wire('M76 143H254M326 143H504', 'supply'),
      arrow('M145 143H201', 'supply'),
      arrow('M378 143H434', 'supply'),
      motion('M76 143H254'),
      motion('M326 143H504'),
      symbol('check', 290, 143, 90),
      label(243, 120, 'A'),
      label(337, 120, 'B'),
      label(118, 185, '供油侧'),
      label(465, 185, '工作侧'),
      label(290, 216, '单向阀'),
    ].join(''),
    alternate: {
      condition: 'B 侧供油，反向截止',
      action: '切换供油方向',
      summary: 'B 侧加压后，阀芯贴住阀座。油到不了 A 侧，阀内反向流量为零。',
      observation: '看红色油路停在 B 侧，流动箭头也停了。切回 A 侧供油可重新通流。',
      drawing: [
        wire('M76 143H254'),
        wire('M326 143H504', 'supply'),
        symbol('check-closed', 290, 143, 90),
        '<path class="stop-mark" d="m309 167 10 10m0-10-10 10"/>',
        label(243, 120, 'A'),
        label(337, 120, 'B'),
        label(118, 185, 'A 侧无流量'),
        label(465, 185, 'B 侧加压'),
        label(290, 216, '阀芯关闭'),
      ].join(''),
    },
  },
  {
    id: 'teaching:throttle',
    name: '可调节流阀',
    category: '流量控制',
    topic: '用阀口开度改变流量',
    condition: '开口较大，流量较大',
    summary: '这个示意保持 A、B 两口的压差相同，先看开口较大时的流动。',
    action: '关小阀口',
    ports: [
      ['A', '图示进油侧'],
      ['B', '图示出油侧'],
    ],
    observation: '点按钮比较。阀口越小，同一压差下的流量越少。',
    drawing: [
      wire('M76 143H254M326 143H504', 'supply'),
      arrow('M148 143H202', 'supply'),
      arrow('M372 143H426', 'supply'),
      motion('M76 143H254'),
      motion('M326 143H504'),
      symbol('throttle', 290, 143, 90),
      label(233, 120, 'A'),
      label(348, 120, 'B'),
      label(112, 185, '上游'),
      label(467, 185, '下游'),
      label(290, 216, '阀口开度较大'),
    ].join(''),
    alternate: {
      condition: '开口较小，流量较小',
      action: '开大阀口',
      summary: '进出口压差相同，阀口关小后，通过阀的流量减少。',
      observation: '两侧仍然通流。图中流动标记放慢，用来对比流量变化。',
      drawing: [
        wire('M76 143H254M326 143H504', 'supply'),
        arrow('M148 143H202', 'supply'),
        arrow('M372 143H426', 'supply'),
        motion('M76 143H254', 'slow'),
        motion('M326 143H504', 'slow'),
        symbol('throttle', 290, 143, 90),
        label(233, 120, 'A'),
        label(348, 120, 'B'),
        label(112, 185, '上游'),
        label(467, 185, '下游'),
        label(290, 216, '阀口开度较小'),
      ].join(''),
    },
  },
  {
    id: 'teaching:relief',
    name: '溢流阀',
    category: '压力控制',
    topic: '压力升高时打开旁路',
    condition: 'P 到 T 的压差达到开启条件',
    summary: '溢流阀并在供油路上。开启时，一部分泵流量从 P 口经 T 口回油箱。',
    action: '降低供油压力',
    ports: [
      ['P', '接供油支路'],
      ['T', '接回油'],
    ],
    observation: '看向下的旁路箭头。压差低于开启条件时，旁路关闭。',
    drawing: [
      wire('M64 62H510M289 62V120', 'supply'),
      wire('M289 176V220', 'return'),
      arrow('M106 62H160', 'supply'),
      arrow('M366 62H427', 'supply'),
      arrow('M289 185V211', 'return'),
      motion('M64 62H510'),
      motion('M289 62V120'),
      motion('M289 176V220'),
      symbol('relief', 299, 148),
      symbol('tank', 289, 250),
      node(289, 62),
      label(106, 39, '来自泵出口'),
      label(466, 39, '去工作回路'),
      label(274, 108, 'P'),
      label(274, 195, 'T'),
      label(366, 152, '溢流阀'),
      label(361, 269, '油箱'),
    ].join(''),
    alternate: {
      condition: '低于开启压差，旁路关闭',
      action: '提高供油压力',
      summary: 'P 到 T 的压差降低，溢流阀关闭，油沿主油路继续流向工作回路。',
      observation: '看通往油箱的支路。提高压力达到开启条件后，支路恢复流动。',
      drawing: [
        wire('M64 62H510M289 62V120', 'supply'),
        wire('M289 176V220'),
        arrow('M106 62H160', 'supply'),
        arrow('M366 62H427', 'supply'),
        motion('M64 62H510'),
        symbol('relief', 299, 148),
        symbol('tank', 289, 250),
        node(289, 62),
        '<path class="stop-mark" d="m284 193 10 10m0-10-10 10"/>',
        label(106, 39, '来自泵出口'),
        label(466, 39, '去工作回路'),
        label(274, 108, 'P'),
        label(268, 193, 'T'),
        label(366, 152, '溢流阀'),
        label(361, 269, '油箱'),
      ].join(''),
    },
  },
  {
    id: 'instrument:pressure-gauge',
    name: '压力表',
    category: '测量仪表',
    topic: '读取连接点的油液压力',
    condition: '测点压力 2.0 MPa',
    summary: '压力表通过支路读出连接点的压力。示意中，表针当前指在 2.0 MPa。',
    action: '提高测点压力',
    ports: [['测压口', '接到测量点']],
    observation: '看中间的三通接点。主油路的流量继续流向负载，表的支路只用于取压。',
    gauge: { reading: '2.0', angle: -34 },
    gaugeDrawing: pressureGaugeDrawing,
    alternate: {
      condition: '测点压力 5.0 MPa',
      action: '降低测点压力',
      summary: '测点压力升高后，表针随之转动，示例读数变为 5.0 MPa。',
      observation: '看表针和读数的变化。取压支路上没有流动箭头。',
      gauge: { reading: '5.0', angle: 42 },
      gaugeDrawing: pressureGaugeDrawing,
    },
  },
];

export function componentTeachingDemo(reference: string): TeachingDemo | undefined {
  return (
    demos.find((demo) => demo.id === reference) ??
    basicTeachingDemos.find((demo) => demo.id === reference) ??
    flowPressureTeachingDemos.find((demo) => demo.id === reference) ??
    storagePressureTeachingDemos.find((demo) => demo.id === reference) ??
    pilotTeachingDemos.find((demo) => demo.id === reference) ??
    actuatorFlowTeachingDemos.find((demo) => demo.id === reference) ??
    logicTeachingDemos.find((demo) => demo.id === reference) ??
    controlTeachingDemos.find((demo) => demo.id === reference)
  );
}
