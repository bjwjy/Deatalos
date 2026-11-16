import type { NetworkDefinition } from '@hyd/domain';

interface SelectionNote {
  readonly role: string;
  readonly inputs: string;
  readonly limitations: string;
}
// Descriptive tool guidance only. Registry/model contracts own actual capabilities.
const notes: Readonly<Record<string, SelectionNote>> = {
  'single-acting-cylinder': {
    role: '单油口弹簧复位直线缸',
    inputs: 'A 口供回油、有效面积、行程、弹簧预紧与刚度、质量和负载',
    limitations: '弹簧负责回程，回程能力受回油背压和负载影响。',
  },
  'cushioned-cylinder': {
    role: '两端可调排油缓冲的双作用单杆缸',
    inputs: 'A/B 油口、两侧面积、行程、两端缓冲长度和最小开口',
    limitations: '两侧面积不同。等效孔口描述缓冲阻力，支持准静态液压耗散和集中质量运动。',
  },
  'cushioned-double-rod-cylinder': {
    role: '两端可调排油缓冲的等面积双出杆缸',
    inputs: 'A/B 油口、共用环形有效面积、行程和两端缓冲设置',
    limitations: '两个方向的液压有效面积相同。等效孔口描述缓冲阻力。',
  },
  'limited-rotary-actuator': {
    role: '双油口驱动的有界摆动执行器',
    inputs: 'A/B 工作口、每弧度排量、摆角上限、转动惯量、阻尼和负载转矩。内置冲击溢流补油启用时连接 T 口。',
    limitations: '采用无回弹机械挡位。内置保护的泄放和补油能力取决于 T 口回压、开启压差和孔口面积。',
  },
  'two-pressure-valve': {
    role: '液压与逻辑，两入口均达到阈值后由高压侧向C供油',
    inputs: 'A/B输入、C出口、工程压力基准、开启压力和全开过渡带',
    limitations: '近等压可分担流量，C口无内置卸压通路。',
  },
  'pilot-check-close': {
    role: 'X先导提高A到B开启压差，B到A始终关闭',
    inputs: 'A/B主通路、X先导压力、先导比和未加先导时的开启压差',
    limitations: '先导压力以A为参考，X不持续耗流，准静态无泄漏。',
  },
  'pressure-reducing-relieving': {
    role: 'P向A减压补油，A超压时向T泄放',
    inputs: '供压、回油背压、A相对T的设定压力和调节带',
    limitations: '有限孔口，流量受压差限制，无A到P反向旁通或阀芯惯性。',
  },
  'manual-shutoff': {
    role: '双向手动通断，关闭时隔离，打开时为有限面积节流口',
    inputs: 'A/B连接、全开面积、流量系数、初始全开或关闭',
    limitations: '仅两档，无半开、惯性或关闭泄漏；不能当作卸荷或溢流保护。',
  },
  'shuttle-valve': {
    role: 'A/B较高压力侧单向通向C，低压入口隔离',
    inputs: 'A/B入口、C出口、最大面积、流量系数、完全切换压差',
    limitations: '准静态模型；切换带内两入口可共同向C供油，C不向入口反流，不储油。',
  },
  'flow-meter': {
    role: '双油口串联流量测量，A到B为正，线性阻力产生实际压降',
    inputs: '测量位置、流量范围和meterResistancePaSPerM3阻力参数',
    limitations: '准静态双向线性压降模型；读数来自A口有效流量；不包含转子惯量、计量误差或厂家标定',
  },
  'return-filter': {
    role: '回油管串联滤芯，按有符号流量产生二次压降',
    inputs: 'A/B 油口、额定流量与该流量下的压降',
    limitations: '阻塞程度通过压降参数给定；没有杂质输运、堵塞演化或内部旁通。',
  },
  'differential-pressure-gauge': {
    role: '两个独立测压口读取有符号 A−B 压差',
    inputs: 'A 接待测点，B 接参考点，两端都要连入油路',
    limitations: '两个测压口均不持续耗流；内部没有连通油道。',
  },
  'flow-divider-combiner': {
    role: 'P 到 A/B 分流，A/B 到 P 集流，通流受较弱支路限制',
    inputs: 'P 总管、A/B 支路、A 口流量份额、最大通流面积、流量系数',
    limitations: '准静态比例和有限通流能力；没有阀芯惯性、内泄漏或末端纠偏。',
  },
  'adjustable-pressure-switch': {
    role: 'H 口取压，升压闭合、降压复位的离散触点',
    inputs: 'H 口、动作压力和较低的复位压力',
    limitations: '测压端不持续耗流；只输出仿真触点状态，无电气端子。',
  },
  'pilot-unloading-valve': {
    role: 'X 口高压触发 P→T 卸荷，降到较低设定值时重新关闭',
    inputs: 'P 泵侧、T 回油、X 远程取压、动作和复位压力、旁通面积',
    limitations: 'X 相对 T 取压；蓄能器回路需外接止回阀隔离储油。',
  },
  'synchronizing-flow-divider': {
    role: 'P 与 A/B 双向分流集流，低主流量且支路压差足够时有限纠偏',
    inputs: 'P 总管、A/B 支路、流量份额、主开口和纠偏开口、纠偏压差和流量上限',
    limitations: '按液压状态推断支路受阻，未建阀芯惯性和厂家同步精度。',
  },
  'three-way-flow-control': {
    role: '自力式三通调速，P→A 计量，过剩流量 P→T',
    inputs: '标称流量、计量压差、旁通面积和油箱回压',
    limitations: '旁路容量与压头有限，反向不通；无外部指令口。',
  },
  'shock-makeup-valve': {
    role: '双工作口相对 T 的冲击溢流和低压侧补油',
    inputs: 'A/B 工作口、T 回油和补油源、两侧溢流设定与补油压差',
    limitations: '补油依赖 T 口实际压力；有限开口准静态模型。',
  },
  'pressure-intensifier': {
    role: '液压增压，IN 驱动、H 高压、R 回油',
    inputs: '增压比、增压与旁路阻力、旁路开启压差、回油压力',
    limitations: '等效平均模型，无往复脉动；高压侧止回，增压以流量为代价。',
  },
  'dynamic-controller': {
    role: '无油口的应用控制元件，一个控制器对应一个阀，可配置多个动作和有限循环',
    inputs:
      '换向阀位或变量泵／马达排量百分比、时间/缸位置/压力表/油口表压/有符号流量条件、连续满足时间、超时和循环次数',
    limitations:
      '双击配置，无需连线；多个控制器不可接管同一阀。仅教学仿真调度，不提供PLC或硬件控制；保存工程只含配置，不保存运行游标',
  },
  counterbalance: {
    role: '三口内泄负载控制；A到B单向旁路，B到A由负载及X先导连续调制',
    inputs: '负载压力、回油背压、先导压力/面积比、弹簧设定、调节带和有限开口',
    limitations: 'A口背压影响开启；准静态教学模型，无动态稳定性或软管安全认证，不代替机械制动',
  },
  'pressure-compensated-flow': {
    role: '二通限制式调速；P到A正向补偿，A到P反向经同一节流口非补偿',
    inputs: '节流口面积、补偿压差、流量系数、密度、供压/负载余量及显式油液储存',
    limitations: '压差不足时降流，面积0双向关闭；不支持纯Q-Q零容积理想支路，须真实C类储油、执行器或物理管；不是恒流源',
  },
  cylinder: {
    role: '直线往复执行元件；经机构也可驱动摆动',
    inputs: '双向力、速度、行程、负载；若驱动摆动需机构尺寸和传动关系',
    limitations: '不能由摆动角度直接当作活塞行程；两腔有效面积和负载条件分别核对',
  },
  motor: {
    role: '旋转执行元件',
    inputs: '转矩、角速度、转角/行程约束、负载和传动关系',
    limitations: '转角要求不自动提供限位/定位控制；不能假定已建模机械连杆或减速器',
  },
  valve: {
    role: '按具体定义的通路和阀位换向/通断',
    inputs: '工作口数量、动作方向、各阀位通路、中位需求、控制方式',
    limitations: '不同位通/中位不可仅凭阀名互换；控制能力以本定义control和模型为准',
  },
  pump: {
    role: '液压供油元件',
    inputs: '各工况流量、转速/排量、压力需求、吸油/回油连接和内置溢流设置',
    limitations: '需核对S口与P口、内置溢流是否参与限压；默认转速/排量不代表满足需求',
  },
  tank: {
    role: '油箱边界',
    inputs: '回油/吸油路径及压力基准',
    limitations: '连接和边界数值以模型为准，图形相交不构成汇流节点',
  },
  relief: {
    role: '压力控制/溢流支路',
    inputs: '设定压差、流向、回油边界及流量范围',
    limitations: '不同模型/版本不能凭名称假定同一动态响应；与泵内置溢流协调',
  },
  throttle: {
    role: '双向节流支路',
    inputs: '流量、实际压差、开口范围和工况',
    limitations: '运行中可用实测流量闭环或手动开口；目标受压差和开口上限约束，复位恢复设计初态。',
  },
  'one-way-throttle': {
    role: '单向节流及反向旁通',
    inputs: '计量方向、流量、压差与旁通方向',
    limitations: '按flowPolicy核对方向，不能仅凭符号朝向推断',
  },
  'check-valve': {
    role: '单向导通支路',
    inputs: '允许流向、开启压差与压差范围',
    limitations: '不是液控解锁或机械保持装置，方向以flowPolicy为准',
  },
  'pilot-check': {
    role: '液控单向/锁紧支路',
    inputs: '主流向、控制口、解锁条件及负载工况',
    limitations: '内部/外部泄油及控制端口按实际定义核对；教学支持域不等于安全认证',
  },
  'pressure-reducing': {
    role: '减压支路',
    inputs: '供压、目标下游压力、控制/泄油边界',
    limitations: '需核对压力参考和本模型受支持的工况，不当作任意压力源',
  },
  'sequence-valve': {
    role: '压力触发顺序支路',
    inputs: '触发压差、控制/泄油连接及动作顺序',
    limitations: '压力阈值不等于动作到位信号，不能推断具备未建模的位置控制',
  },
  'pressure-source': {
    role: '理想压力源边界',
    inputs: '压力基准、边界数值及用途',
    limitations: '不是实际泵组选型，不提供实际排量/效率依据',
  },
  accumulator: {
    role: '有限容积气体储能',
    inputs: '预充绝压、容积、多变指数、初始存油量、油口阻力及明确压力参考',
    limitations: '理想多变气体教学模型；不保证真实温度/高压气体行为，不冒充无限恒压源或安全认证',
  },
  volume: {
    role: '液压容积/可压缩边界',
    inputs: '容积、初压、油液属性和连接',
    limitations: '不能用任意容积掩盖模型或数值失败，也不冒充蓄能器模型',
  },
};

export function networkToolSelectionNotes(definition: NetworkDefinition) {
  const note = notes[definition.typeId];
  return {
    status: note ? 'guidance-only' : 'unclassified',
    role: note?.role ?? '未提供选型解释，按定义和模型核对，不推断支持',
    inputs: note?.inputs ?? '需依据任务与本定义确认',
    limitations: note?.limitations ?? '目录存在不表示能满足本次需求',
  };
}
