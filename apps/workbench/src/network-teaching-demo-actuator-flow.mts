import { arrow, label, node, oilRoute, symbol, wire } from './network-teaching-demo-diagram.mjs';
import type { TeachingDemo } from './network-teaching-demo-content.mjs';

function cushionDrawing(extend: boolean, dual: boolean): string {
  return [
    `<g class="teaching-actuator teaching-cushioned" data-stroke="${extend ? 'extend' : 'retract'}">`,
    '<rect class="teaching-cylinder-shell" x="204" y="75" width="186" height="54"/>',
    `<rect class="teaching-cushion-zone${extend ? '' : ' is-active'}" x="205" y="76" width="58" height="52"/>`,
    `<rect class="teaching-cushion-zone${extend ? ' is-active' : ''}" x="325" y="76" width="64" height="52"/>`,
    '<g class="teaching-cushion-piston" data-teaching-motion>',
    '<rect class="teaching-piston-metal" x="0" y="76" width="7" height="52"/><rect class="teaching-piston-metal" x="7" y="97" width="149" height="10"/>',
    dual ? '<rect class="teaching-piston-metal" x="-155" y="97" width="155" height="10"/>' : '',
    '</g>',
    extend ? oilRoute('M221 221V129', 'supply') : oilRoute('M221 129V221', 'return', 'slow'),
    extend ? oilRoute('M374 129V221', 'return', 'slow') : oilRoute('M374 221V129', 'supply'),
    extend
      ? arrow('M221 203V171', 'supply') + arrow('M374 169V202', 'return')
      : arrow('M221 169V202', 'return') + arrow('M374 203V171', 'supply'),
    wire(extend ? 'M364 152q10 8 20 0m-20 16q10-8 20 0' : 'M211 152q10 8 20 0m-20 16q10-8 20 0'),
    label(220, 55, '缩回缓冲区', extend),
    label(374, 55, '伸出缓冲区', !extend),
    label(221, 249, extend ? 'A 进油' : 'A 排油'),
    label(374, 249, extend ? 'B 排油' : 'B 进油'),
    label(298, 280, dual ? '两侧有效面积相同' : '有杆腔有效面积较小', true),
    '</g>',
  ].join('');
}

function swingDrawing(clockwise: boolean): string {
  return [
    '<g class="teaching-actuator">',
    '<circle class="teaching-cylinder-shell" cx="290" cy="120" r="54"/>',
    wire('M290 60V50M241 71l7 7M339 71l-7 7'),
    arrow(clockwise ? 'M244 74A65 65 0 0 1 336 74' : 'M336 74A65 65 0 0 0 244 74', ''),
    `<g class="teaching-swing-arm" data-swing="${clockwise ? 'clockwise' : 'counterclockwise'}" data-teaching-motion>`,
    '<path class="wire teaching-swing-pointer" d="M290 120V78"/>',
    '</g>',
    node(290, 120),
    clockwise ? oilRoute('M74 215H223V142H241', 'supply') : oilRoute('M241 142H223V215H74', 'return'),
    clockwise ? oilRoute('M339 142H357V215H506', 'return') : oilRoute('M506 215H357V142H339', 'supply'),
    clockwise
      ? arrow('M132 215H191', 'supply') + arrow('M392 215H451', 'return')
      : arrow('M191 215H132', 'return') + arrow('M451 215H392', 'supply'),
    label(218, 61, '−45°', true),
    label(362, 61, '+45°', true),
    label(203, 180, 'A'),
    label(377, 180, 'B'),
    label(290, 264, clockwise ? '顺时针摆向 +45° 限位' : '逆时针摆向 −45° 限位'),
    '</g>',
  ].join('');
}

function dividerDrawing(collect: boolean): string {
  const paths = collect
    ? ['M124 79H228V150L290 181', 'M456 79H352V150L290 181', 'M290 181V251']
    : ['M290 251V181', 'M290 181L228 150V79H124', 'M290 181L352 150V79H456'];
  return [
    '<rect class="teaching-valve-cell" x="204" y="121" width="172" height="92" rx="6"/>',
    ...paths.map((path) => oilRoute(path, collect ? 'return' : 'supply')),
    collect
      ? arrow('M141 79H202', 'return') + arrow('M438 79H377', 'return') + arrow('M290 221V245', 'return')
      : arrow('M202 79H141', 'supply') + arrow('M377 79H438', 'supply') + arrow('M290 245V221', 'supply'),
    wire('M218 144l16 13m-8-19 16 13M362 144l-16 13m8-19-16 13'),
    node(290, 181),
    label(134, 55, 'A · 6 L/min'),
    label(446, 55, 'B · 6 L/min'),
    label(290, 278, 'P · 12 L/min'),
    label(290, 144, collect ? '按比例集流' : '按比例分流', true),
  ].join('');
}

function syncDrawing(correcting: boolean): string {
  return [
    '<rect class="teaching-cylinder-shell" x="101" y="27" width="92" height="59"/><rect class="teaching-cylinder-shell" x="387" y="27" width="92" height="59"/>',
    `<path class="wire" d="M103 ${correcting ? 33 : 49}h88"/>`,
    `<path class="wire teaching-correction-piston" data-correcting="${correcting}" d="M389 49h88"/>`,
    '<rect class="teaching-valve-cell" x="205" y="127" width="170" height="96" rx="6"/>',
    oilRoute('M290 256V198', 'supply', correcting ? 'slow' : undefined),
    correcting ? wire('M147 86V110H225V180h28m0-7v14', 'supply') : oilRoute('M290 198L225 180V110H147V86', 'supply'),
    correcting
      ? oilRoute('M290 198H361V155H355V110H433V86', 'supply', 'slow')
      : oilRoute('M290 198L355 180V110H433V86', 'supply'),
    arrow('M290 251V230', 'supply'),
    correcting ? '' : arrow('M190 110H154', 'supply'),
    arrow('M395 110H427', 'supply'),
    correcting ? wire('M352 155q9-7 18 0m-18 13q9 7 18 0') : wire('M361 198V166m-7 0h14'),
    node(290, 198),
    label(147, 18, correcting ? 'A 缸先到位' : 'A 缸'),
    label(433, 18, correcting ? 'B 缸继续补油' : 'B 缸'),
    label(190, 139, 'A'),
    label(390, 139, 'B'),
    label(290, 282, 'P'),
    label(290, 157, correcting ? '有限纠偏孔口' : '比例分流', true),
  ].join('');
}

function intensifierDrawing(boost: boolean): string {
  return [
    '<path class="teaching-cylinder-shell" d="M233 215V137h35V98h61v39h35v78z"/>',
    `<g class="teaching-boost-piston" data-boost="${boost}"><rect class="teaching-piston-metal" x="234" y="171" width="129" height="9"/><rect class="teaching-piston-metal" x="289" y="114" width="20" height="57"/></g>`,
    boost ? oilRoute('M151 259V203H233', 'supply') : oilRoute('M151 259V70H207', 'supply'),
    boost ? oilRoute('M299 98V44', 'supply', 'slow') : oilRoute('M279 70H299V44', 'supply'),
    boost ? oilRoute('M364 153H430V259', 'return') : wire('M364 153H430V259'),
    boost ? wire('M151 203V70H207M279 70H299') : wire('M151 203H233M299 70V98'),
    symbol(boost ? 'check-closed' : 'check', 243, 70, 90),
    arrow(boost ? 'M165 203H222' : 'M151 125V81', 'supply'),
    arrow('M299 63V47', 'supply'),
    boost ? arrow('M430 206V241', 'return') : '',
    node(151, 203),
    node(299, 70),
    label(299, 26, boost ? 'H · 7 MPa' : 'H · 2 MPa'),
    label(151, 282, 'IN · 3 MPa'),
    label(430, 282, 'R · 回油'),
    label(200, 52, '快速充油旁路', true),
    label(402, 105, boost ? '小面积输出' : '增压机构', true),
    label(299, 245, boost ? '大面积驱动' : '低压充油示意', true),
  ].join('');
}

export const actuatorFlowTeachingDemos: readonly TeachingDemo[] = [
  {
    id: 'teaching:cushioned-cylinder',
    name: '可调缓冲单杆缸',
    category: '执行元件',
    topic: '让活塞杆在行程末端减速',
    ports: [
      ['A', '无杆腔'],
      ['B', '有杆腔'],
    ],
    condition: '伸出到位，B 端缓冲',
    summary: '伸出时 A 进油。接近终点，B 侧排油被节流，活塞杆减速。',
    action: '换向缩回',
    observation: '看最后一小段速度变化。两端的缓冲长度和排油开口可分别调整。',
    drawing: cushionDrawing(true, false),
    stroke: '伸出',
    alternate: {
      condition: '缩回到位，A 端缓冲',
      summary: '缩回时 B 进油，A 排油。接近另一端时，A 侧缓冲使活塞杆减速。',
      action: '换向伸出',
      observation: '缓冲跟随排油端。单杆缸两腔有效面积不同。',
      drawing: cushionDrawing(false, false),
      stroke: '缩回',
    },
  },
  {
    id: 'teaching:cushioned-double-rod-cylinder',
    name: '可调缓冲双出杆缸',
    category: '执行元件',
    topic: '两侧面积相同，两端各自缓冲',
    ports: [
      ['A', '左侧环形腔'],
      ['B', '右侧环形腔'],
    ],
    condition: '右移到位，B 端缓冲',
    summary: 'A 进油，双出杆一起向右移动。右端 B 侧排油受限，末段减速。',
    action: '换向左移',
    observation: '相同流量下，等面积使中段速度大小接近。两端缓冲可单独调节。',
    drawing: cushionDrawing(true, true),
    stroke: '伸出',
    alternate: {
      condition: '左移到位，A 端缓冲',
      summary: 'B 进油，双出杆一起向左移动。左端 A 侧排油受限，末段减速。',
      action: '换向右移',
      observation: '看两侧杆同时左移。末段由这一端的缓冲设置决定。',
      drawing: cushionDrawing(false, true),
      stroke: '缩回',
    },
  },
  {
    id: 'teaching:limited-rotary-actuator',
    name: '有限角度摆动执行器',
    category: '执行元件',
    topic: '在两个角度限位之间摆动',
    ports: [
      ['A', '示例顺时针供油口'],
      ['B', '示例逆时针供油口'],
    ],
    condition: '到达 +45° 限位',
    summary: 'A 供油、B 回油，输出轴沿弧形箭头顺时针摆向限位。',
    action: '换向逆时针摆动',
    observation: '到位后点按钮。±45° 是示例，图中的短线标出摆动范围。',
    drawing: swingDrawing(true),
    stroke: '顺时针摆动',
    alternate: {
      condition: '到达 −45° 限位',
      summary: 'B 供油、A 回油，输出轴逆时针摆回另一端。',
      action: '换向顺时针摆动',
      observation: '两侧油流和弧形箭头一起换向。输出轴在限位处停止。',
      drawing: swingDrawing(false),
      stroke: '逆时针摆动',
    },
  },
  {
    id: 'teaching:flow-divider-combiner',
    name: '双向分流集流阀',
    category: '流量控制',
    topic: '同一只阀可按比例分流或集流',
    ports: [
      ['P', '总管'],
      ['A / B', '两条支路'],
    ],
    condition: 'P 进油，A 和 B 分流',
    summary: '示例采用 1∶1 分配。P 的 12 L/min 分成两路，各 6 L/min。',
    action: '切换到集流',
    observation: '看三个箭头。两支路压差条件都满足时才能按设定比例通流。',
    drawing: dividerDrawing(false),
    alternate: {
      condition: 'A 和 B 进油，P 集流',
      summary: '油从两支路回到阀内，A、B 各 6 L/min，在 P 合成 12 L/min。',
      action: '切回分流',
      observation: '箭头全部反向。一条支路受阻时，两路按比例通流的总量会受限。',
      drawing: dividerDrawing(true),
    },
  },
  {
    id: 'teaching:synchronizing-flow-divider',
    name: '同步分流集流阀',
    category: '流量控制',
    topic: '一侧先到位，另一侧少量补油',
    ports: [
      ['P', '总管'],
      ['A / B', '两缸支路'],
    ],
    condition: '两侧通流，按比例分配',
    summary: '两缸正常运动时，阀按设定比例分配流量。',
    action: '让 A 缸先到位',
    observation: '普通分流状态下，两条支路都有油流。切换后观察未到位的一侧。',
    drawing: syncDrawing(false),
    alternate: {
      condition: 'A 侧受阻，B 侧有限纠偏',
      summary: '主流量降到纠偏范围、支路压差足够时，B 侧经小孔得到少量补油。',
      action: '恢复正常分流',
      observation: '只看 B 侧继续前进。阀依据流量和压差判断纠偏条件。',
      drawing: syncDrawing(true),
    },
  },
  {
    id: 'teaching:pressure-intensifier',
    name: '液压增压器',
    category: '供油与回油',
    topic: '先充油，再用面积差增压',
    ports: [
      ['IN', '驱动进油'],
      ['H', '高压输出'],
      ['R', '回油'],
    ],
    condition: 'H 压力较低，快速充油',
    summary: 'H 压力低于入口时，油可经单向旁路从 IN 给 H 快速充油。',
    action: '提高高压侧负载',
    observation: '先看左侧旁路。压力数值为示例，箭头突出本工况的主要路径。',
    drawing: intensifierDrawing(false),
    alternate: {
      condition: '旁路截止，H 继续增压输出',
      summary: 'H 压力高于 IN 后，旁路截止。大面积驱动小面积，H 可输出更高压力。',
      action: '恢复低压充油',
      observation: '对照 H 小流量高压输出和 R 回油。模型用平均流量描述增压过程。',
      drawing: intensifierDrawing(true),
    },
  },
];
