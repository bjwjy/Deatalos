import {
  ContractReader,
  checkJson,
  checkNetworkParameterRules,
  immutable,
  parseNetworkProject,
  networkDefinition,
  componentDisplayName,
  parameterDisplayName,
  engineeringValueText,
  networkValvePositions,
  directionalValveSettings,
  directionalValveAutoName,
  isLinearActuatorType,
  networkProbeEndpoint,
  networkProbeName,
  type Result,
} from '@hyd/domain';
import {
  parseNetworkDutyReportRequest,
  isDutySupplyDemand,
  reviewNetworkDuty,
  type NetworkDutyCoverage,
  type NetworkDutyPlan,
  type NetworkDutyReportRequest,
} from './network-duty.js';
import { threeWayDutyFlowMatches } from './network-duty-multi-port-valves.js';

/** Common preferred subsets are search targets, not complete GB tables or manufacturer products. */
export const selectionStandards = immutable([
  {
    id: 'GB/T 2346-2003',
    subject: '公称压力系列',
    url: 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=65F15F607A5F85D21EAFF7870E39460A',
    status: '2026-10-30核实为现行；采用有限常用子集，非产品额定证明',
  },
  {
    id: 'GB/T 2347-1980',
    subject: '液压泵及马达公称排量系列',
    url: 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=D21CA6D889274DC35CEA1F9F7831CA19',
    status: '2026-10-30核实为现行；外部检索须复核标准原文及产品公称与几何排量差异',
  },
  {
    id: 'GB/T 2348-2018',
    subject: '缸径及活塞杆直径',
    url: 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=11304FE4896A013F86A12158EA6286AD',
    status: '2026-10-30核实为现行；保留工程几何，不擅自圆整缸杆径',
  },
  {
    id: 'GB/T 2349',
    subject: '缸活塞行程系列',
    url: 'https://std.samr.gov.cn/search/stdPage?q=2349',
    status: '2026-10-30：1980版现行，2026版2026-11-01实施；须按选型日期核对版本与行程系列',
  },
]);
export const selectionSeries = immutable({
  version: 'gb-preferred-subset-20261030-v1',
  checkedOn: '2026-10-30',
  pressureMPa: [1, 1.6, 2.5, 4, 6.3, 10, 12.5, 16, 20, 25, 31.5, 40, 50, 63],
  displacementCm3PerRev: [
    0.1, 0.16, 0.25, 0.4, 0.63, 1, 1.25, 1.6, 2, 2.5, 3.15, 4, 5, 6.3, 8, 10, 12.5, 16, 20, 25, 31.5, 40, 50, 63, 80,
    100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  ],
});
export interface CatalogRequest extends NetworkDutyReportRequest {
  readonly region: string;
  readonly fluid: 'unconfirmed' | 'mineral' | 'HFA';
  readonly customization: 'standard-only' | 'allow-custom';
  readonly limit: number;
}
export interface CatalogCandidate {
  readonly code: string;
  readonly displacementM3PerRev: number;
  readonly nominalPressurePa: number;
  readonly estimatedFlowM3PerS: number;
  readonly flowMarginM3PerS: number;
  readonly procurement: 'standard-target-product-unverified';
}
export interface CatalogTarget {
  readonly componentId: string;
  readonly label: string;
  readonly requirement: string;
  readonly rows: readonly (readonly string[])[];
}
export interface NetworkCatalogPlan {
  readonly request: CatalogRequest;
  readonly duty: NetworkDutyPlan | null;
  readonly coverage: NetworkDutyCoverage;
  readonly candidates: readonly CatalogCandidate[];
  readonly rejected: readonly { readonly code: string; readonly reasons: readonly string[] }[];
  readonly eligibleCount: number;
  readonly missing: readonly string[];
  readonly targets: readonly CatalogTarget[];
}
const catalogNumber = (value: number) => Number(value.toPrecision(7)).toString();
function selectionValue(key: string, value: number, unit: string): string {
  if (key === 'internalTank') return value === 1 ? '内置油箱' : '外接 T 口';
  if (key === 'enabled' && unit === '1') return value === 1 ? '开启' : '关闭';
  return engineeringValueText(value, unit, key);
}
const catalogChecks: Readonly<Record<string, string>> = {
  pump: '核对排量、额定压力、允许转速、轴伸和安装接口。',
  cylinder: '核对缸径、杆径、行程、安装尺寸和允许载荷。',
  motor: '核对排量、转矩、允许转速和工作压差。',
  valve: '核对各阀位油路、驱动与复位方式，以及额定压力、流量和压降。',
  relief: '核对设定范围、额定压力和可通过的溢流流量。',
  'check-valve': '核对允许流向、开启压差、额定流量和压降、反向泄漏及耐压。',
  'one-way-throttle': '核对节流与旁通方向、可调流量范围、反向旁通压降及单向阀开启压差。',
  'pressure-source': '核对压力基准、供油压力范围、可持续供流及限压条件。',
  tank: '核对回油背压、有效容积、吸油与回油接口以及通气条件。',
  throttle: '核对有效开口和流量调节范围、允许压差、通流方向及关断泄漏。',
  volume: '核对实际充油容积、允许压力、初始压力及连接接口。',
  accumulator: '核对容积、预充压力、额定压力和介质。',
  'single-acting-cylinder': '核对作用方向、弹簧回程力、缸径、行程、安装尺寸与允许侧向载荷。',
  'cushioned-cylinder': '核对缸径、杆径、行程、缓冲长度、允许进入速度、缓冲吸能与安装尺寸。',
  'cushioned-double-rod-cylinder': '核对两端杆径与伸出空间、双向缓冲能力、行程及安装尺寸。',
  'limited-rotary-actuator': '核对有效转角、工作压差下的输出扭矩、端位允许冲击、轴接口和安装方式。',
  'manual-shutoff': '核对常态开闭、操作方式、工作压力、通流压降与关断泄漏。',
  'shuttle-valve': '核对两入口与出口标识、换向压差、通流压降与反向泄漏。',
  'two-pressure-valve': '核对两输入同时供压的动作条件、最低驱动压力、通流压降及允许背压。',
  'pilot-check-close': '核对关闭先导压力、先导比、外泄要求、复位条件与密封泄漏。',
  'pilot-check': '核对先导比、自由流开启压差、反向解锁条件、内泄或外泄接法及保载泄漏。',
  'pressure-reducing': '核对减压范围、额定流量、进口压力范围、Y 口泄油接法及允许背压。',
  'sequence-valve': '核对开启压力范围、额定流量、先导基准、Y 口泄油接法及允许背压。',
  counterbalance: '核对保载设定、先导比、回油背压、超越负载工况与允许泄漏。',
  'pressure-compensated-flow': '核对调速范围、最低补偿压差、额定流量及反向通流要求。',
  'three-way-flow-control': '核对工作口流量范围、最低补偿压差、旁通能力及 T 口允许背压。',
  'pressure-reducing-relieving': '核对减压范围、泄油口背压、减压及溢流额定流量和压差。',
  'flow-meter': '核对量程、精度、流向、工作压力、介质黏度、串联压降与信号输出。',
  'return-filter': '核对过滤精度、额定流量、清洁滤芯压降、旁通开启压差及堵塞指示。',
  'differential-pressure-gauge': '核对差压量程、允许共模静压、单侧过载、精度及两测压接口。',
  'flow-divider-combiner': '核对分流比、分流与集流精度、允许流量范围、负载差和泄漏。',
  'synchronizing-flow-divider': '核对双向流量范围、分流比例、末端纠偏流量、负载差和同步精度。',
  'adjustable-pressure-switch': '核对动作与复位压力、最大允许压力、触点形式和允许电气负载。',
  'pilot-unloading-valve': '核对动作与复位压差、额定卸荷流量、回油背压、先导接法及隔离止回阀。',
  'shock-makeup-valve': '核对 A/B 两向冲击溢流设定、补油开启压差、保护流量及 T 口补油条件。',
  'pressure-intensifier': '核对增压比、低压侧供流、高压侧允许压力与输出流量、回程及补油要求。',
  'dynamic-controller': '工程里的动作逻辑。选型时核对控制输出与阀的驱动方式是否匹配。',
};

const catalogDefinitionChecks: Readonly<Record<string, string>> = {
  'teaching:variable-motor': '核对排量范围、转矩、允许转速、工作压差、排量控制方式及先导或电控接口。',
  'teaching:pilot-relief': '核对设定压差范围、额定压力、可通过的溢流流量、先导级要求及 T 口允许背压。',
};
/** S07 owns demand equations. These GB targets never imply purchasable combined products. */
export function planNetworkCatalog(document: unknown, input: unknown): Result<NetworkCatalogPlan> {
  const project = parseNetworkProject(document);
  if (!project.ok) return project;
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    raw = r.object(input, '/catalog', ['duty', 'pendingPhases', 'region', 'fluid', 'customization', 'limit']);
  const inputDuty = parseNetworkDutyReportRequest(raw.duty, raw.pendingPhases);
  if (!inputDuty.ok) return inputDuty;
  const region = r.text(raw.region, '/catalog/region', 0, 80);
  if (!['unconfirmed', 'mineral', 'HFA'].includes(String(raw.fluid)))
    r.fail('CATALOG_INVALID', '/catalog/fluid', '请选择介质核实状态。');
  if (raw.customization !== 'standard-only' && raw.customization !== 'allow-custom')
    r.fail('CATALOG_INVALID', '/catalog/customization', '请选择定制政策。');
  const limit = r.number(raw.limit, '/catalog/limit', 1, 2);
  if (!Number.isInteger(limit)) r.fail('CATALOG_INVALID', '/catalog/limit', '仅输出1至2组目标规格。');
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  const request: CatalogRequest = {
    ...inputDuty.value,
    region,
    fluid: raw.fluid === 'mineral' || raw.fluid === 'HFA' ? raw.fluid : 'unconfirmed',
    customization: raw.customization === 'allow-custom' ? 'allow-custom' : 'standard-only',
    limit,
  };
  const { coverage, completePlan: duty } = reviewNetworkDuty(project.value, inputDuty.value);
  const candidates: CatalogCandidate[] = [],
    rejected: { code: string; reasons: string[] }[] = [];
  const supplyPhases = duty?.phases.filter(isDutySupplyDemand) ?? [];
  const requiresFlowBalance = project.value.design.components.some((c) => c.typeId === 'three-way-flow-control');
  const hasFlowSplit =
    request.duty?.phases.some((phase) => phase.flowSplit) || supplyPhases.some((phase) => phase.flowSplit);
  if (duty && supplyPhases.length && !hasFlowSplit) {
    const requiredFlow = Math.max(...supplyPhases.map((p) => p.flowM3PerS)),
      requiredPressure = Math.max(duty.request.pressureLimitPa, ...supplyPhases.map((p) => p.pressurePa)),
      nominalPressure = selectionSeries.pressureMPa.find((p) => p * 1e6 >= requiredPressure);
    for (const size of selectionSeries.displacementCm3PerRev) {
      const displacement = size / 1e6,
        flow =
          ((displacement * duty.request.angularSpeedRadPerS) / (2 * Math.PI)) * duty.request.pumpVolumetricEfficiency;
      if (flow < requiredFlow * (1 - 1e-12)) continue;
      const code = `GB目标 ${size} cm³/rev`,
        reasons: string[] = [];
      if (requiresFlowBalance && supplyPhases.some((phase) => !threeWayDutyFlowMatches(flow, phase.flowM3PerS)))
        reasons.push('本转速下的估计供流与至少一个三通调速工况的工作及旁通流量之和不匹配。');
      if (nominalPressure === undefined) reasons.push('所需压力超出本次已收录公称压力子集；只交接计算目标。');
      const proposed = parseNetworkProject({
        ...project.value,
        design: {
          ...project.value.design,
          components: project.value.design.components.map((c) =>
            c.id !== duty.request.pumpId
              ? c
              : {
                  ...c,
                  parameters: {
                    ...c.parameters,
                    hydraulic: { ...c.parameters.hydraulic, displacementM3PerRev: displacement },
                    drive: { ...c.parameters.drive, angularSpeedRadPerS: duty.request.angularSpeedRadPerS },
                  },
                },
          ),
        },
      });
      const rules = proposed.ok ? checkNetworkParameterRules(project.value, proposed.value) : proposed;
      if (!rules.ok) reasons.push(...rules.diagnostics.map((d) => d.message));
      if (reasons.length) rejected.push({ code, reasons });
      else if (nominalPressure !== undefined)
        candidates.push({
          code,
          displacementM3PerRev: displacement,
          nominalPressurePa: nominalPressure * 1e6,
          estimatedFlowM3PerS: flow,
          flowMarginM3PerS: flow - requiredFlow,
          procurement: 'standard-target-product-unverified',
        });
    }
  }
  const missing = [
    '标准系列目标不证明厂家有对应整套产品；缸杆径/行程、泵排量/转速/压力、阀位油路/流量/压差/控制方式必须在同一产品配置中同时成立。',
    '标准全文表格与优先/非优先系列须由外部Agent复核；当前为有限常用子集，不能宣称覆盖全部GB或已通过标准合规认证。',
    '安装、法兰、轴伸、接口、油液、黏度、温度、清洁度、负载持续率及寿命降额待核实。',
    '效率是本次计算假设；须核对厂家性能曲线、驱动功率、吸油与低速条件。',
    '目录存在、厂家确认可订购和当前库存分别取证并注明日期；完整订购编码及供货待确认。',
    '采用规格后须重新校核并仿真，不能沿用原运行结果；本任务书不自动修改回路。',
  ];
  if (!region.trim()) missing.unshift('采购地区未指定。');
  if (request.fluid === 'unconfirmed') missing.unshift('油液和密封适用性尚未确认，不假设任意产品可用。');
  if (request.fluid === 'HFA') missing.unshift('HFA须核对专用材料、密封、润滑和压力降额；标准排量本身不保证HFA适用。');
  if (!duty) missing.unshift('工况未完整核算；泵需求和规格目标待补齐条件后复核。');
  if (hasFlowSplit) missing.unshift('双缸实际分流按当前泵及阀口核算，改变泵规格后须重新匹配两支路。');
  if (duty && !supplyPhases.length)
    missing.unshift(
      duty.request.boundary
        ? '本次按恒压源或蓄能器边界核算。源额定供流与储能元件规格需独立核对。'
        : '本次仅有弹簧回程，没有液压缸供油需求。',
    );
  if (duty && requiresFlowBalance)
    missing.unshift('三通调速阀须逐工况匹配泵供流与工作及旁通流量之和，排量向上圆整后须重新核算。');
  if (duty?.phases.some((phase) => phase.springReturn && phase.springReturn.forceMarginN < 0))
    missing.unshift('存在回程力不足的工况，泵规格备选仅覆盖液压供油需求。');
  if (duty?.constraints.length) missing.unshift('当前设计存在供油预算/溢流约束，推荐公称规格不能消除原设计问题。');
  const n = catalogNumber;
  const targets = project.value.design.components.map((c): CatalogTarget => {
    const rows: string[][] = [['参数', '工程值或要求', '选型说明']];
    const definition = networkDefinition(c.definition.id, c.definition.version);
    const linear = isLinearActuatorType(c.typeId);
    const valvePositions = c.typeId === 'valve' ? networkValvePositions(c) : [];
    if (linear) {
      const a = c.parameters.geometry?.capAreaM2,
        b = c.parameters.geometry?.rodSideAreaM2,
        stroke = c.parameters.geometry?.strokeM;
      if (a !== undefined) rows.push(['缸径', n(Math.sqrt((4 * a) / Math.PI) * 1000) + ' mm', '按 GB/T 2348 复核']);
      if (a !== undefined && b !== undefined && a >= b)
        rows.push(['杆径', n(Math.sqrt((4 * (a - b)) / Math.PI) * 1000) + ' mm', '校核稳定性']);
      if (stroke !== undefined) rows.push(['行程', n(stroke * 1000) + ' mm', '按 GB/T 2349 复核']);
    } else if (c.typeId === 'pump' || c.typeId === 'motor') {
      const d = c.parameters.hydraulic?.displacementM3PerRev;
      if (d !== undefined) rows.push(['保存排量', n(d * 1e6) + ' cm³/rev', '改型须满足锁定/范围与全部工况']);
    }
    if (c.typeId === 'valve') {
      const initial = project.value.design.initialConditions.find((item) => item.componentId === c.id);
      if (initial?.kind === 'valve') {
        const settings = directionalValveSettings(c, initial.positionId);
        if (settings)
          rows.push([
            '阀型与驱动',
            directionalValveAutoName(settings.positionCount, settings.portCount, settings.valveActuation),
            '核对线圈电压或先导条件',
          ]);
        const positionNames = { extend: '左位', neutral: '中位', retract: '右位' };
        rows.push(['常态位置', positionNames[initial.positionId], '']);
      }
    }
    for (const [group, specs] of Object.entries(definition?.groups ?? {})) {
      for (const { key, unit } of specs) {
        const value = c.parameters[group]?.[key];
        if (value === undefined) continue;
        const rule = c.parameterRules?.find((item) => item.group === group && item.key === key);
        if (group === 'positions' && valvePositions.some((position) => key === position + 'Function')) continue;
        if (linear && group === 'geometry' && key === 'strokeM' && !rule) continue;
        const note =
          rule?.mode === 'locked'
            ? '已锁定'
            : rule?.mode === 'variable'
              ? `允许范围 ${selectionValue(key, rule.minimum, unit)} 至 ${selectionValue(key, rule.maximum, unit)}`
              : '';
        rows.push([
          group === 'outletRelief' && key === 'enabled'
            ? 'H→R 内置溢流'
            : group === 'workProtection' && key === 'enabled'
              ? '内置冲击溢流补油'
              : key === 'angularSpeedRadPerS'
                ? '转速'
                : parameterDisplayName(key),
          selectionValue(key, value, unit),
          note,
        ]);
      }
    }
    return {
      componentId: c.id,
      label: c.label.trim() || componentDisplayName(c.typeId, c.definition.id),
      requirement:
        (c.typeId === 'pressure-compensated-flow' && c.parameters.storage
          ? '核对调速范围、最低补偿压差、额定流量、反向通流和 A 口内置油液容积。'
          : undefined) ??
        (c.parameters.outletRelief?.enabled === 1
          ? '核对增压比、IN 口供流、H 侧允许压力和储油容积、H→R 溢流容量及 R 口回压。'
          : undefined) ??
        (c.parameters.workProtection?.enabled === 1
          ? c.parameters.protectionReturn?.internalTank === 1
            ? '核对有效转角、转矩、允许端位冲击、A/B 溢流开启压差、补油能力及内置油箱压力。'
            : '核对有效转角、转矩、允许端位冲击、A/B 溢流开启压差、补油能力及 T 口允许背压。'
          : undefined) ??
        catalogDefinitionChecks[c.definition.id] ??
        catalogChecks[c.typeId] ??
        '按元件功能和本次工况核对工作范围、安装与油口接口。',
      rows,
    };
  });
  for (const probe of project.value.controlProbes ?? []) {
    const endpoint = networkProbeEndpoint(project.value, probe);
    targets.push({
      componentId: probe.id,
      label: networkProbeName(project.value, probe),
      requirement: '核对量程、精度、允许峰值压力、安装方式、测压接口和信号输出。',
      rows: [
        ['参数', '工程值或要求', '选型说明'],
        [
          '测压位置',
          endpoint?.kind === 'port' ? endpoint.componentId + ':' + endpoint.portId : (endpoint?.nodeId ?? '待指定'),
          '按工程测点核对安装与接头',
        ],
      ],
    });
  }
  return {
    ok: true,
    value: immutable({
      request,
      duty,
      coverage,
      candidates: candidates.slice(0, limit),
      rejected,
      eligibleCount: candidates.length,
      missing,
      targets,
    }),
  };
}
