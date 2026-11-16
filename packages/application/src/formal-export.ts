import { checkJson, ContractReader, diagnostic, immutable, type Result } from '@hyd/domain';
import type {
  CalculationRecord,
  CombinedDutyCoverage,
  DutyGroupCoverage,
  NetworkDutyCoverage,
  ParallelFlowResult,
} from '@hyd/engineering';
import { parseExportArtifact, exportLimits, utf8Bytes, type ExportArtifact } from './export-artifact.js';
import { parseCurveFile } from './curve-file.js';
import { parseOfflineCurve } from './offline-curve.js';
import { bookResult, readBookMath, stepBookMath, type BookMath } from './calculation-book-math.js';
import { parseDrawingTemplate, type DrawingTemplate } from './drawing-template.js';
export type { BookMath } from './calculation-book-math.js';

export type PaperSize = 'A4' | 'A3' | 'A2';
export interface DrawingSettings {
  readonly labels: 'all' | 'none';
  readonly paper: PaperSize;
  readonly orientation: 'portrait' | 'landscape';
  readonly occupancy: number;
  readonly bindingEdge?: boolean;
  readonly fields: Readonly<Record<string, string>>;
  readonly changes: readonly Readonly<Record<string, string>>[];
  readonly titleCells?: Readonly<Record<string, string>>;
  readonly template?: DrawingTemplate;
}
export const drawingFields = Object.freeze([
  ['organization', '单位名称'],
  ['title', '图样名称'],
  ['number', '图样代号'],
  ['scale', '比例'],
  ['material', '材料标记'],
  ['stage', '阶段标记'],
  ['mass', '质量'],
  ['total', '共几张'],
  ['sheet', '第几张'],
  ['projection', '投影符号或说明'],
  ['designName', '设计签名'],
  ['designDate', '设计日期'],
  ['checkName', '校核签名'],
  ['checkDate', '校核日期'],
  ['reviewName', '审核签名'],
  ['reviewDate', '审核日期'],
  ['processName', '工艺签名'],
  ['processDate', '工艺日期'],
  ['standardName', '标准化签名'],
  ['standardDate', '标准化日期'],
  ['approveName', '批准签名'],
  ['approveDate', '批准日期'],
]);
export const changeFields = Object.freeze([
  ['mark', '标记'],
  ['count', '处数'],
  ['zone', '分区'],
  ['number', '更改文件号'],
  ['signature', '签名'],
  ['date', '年月日'],
]);
export function paperDimensions(paper: PaperSize, orientation: 'portrait' | 'landscape') {
  const short = paper === 'A4' ? 210 : paper === 'A3' ? 297 : 420,
    long = paper === 'A4' ? 297 : paper === 'A3' ? 420 : 594;
  return orientation === 'portrait' ? { widthMm: short, heightMm: long } : { widthMm: long, heightMm: short };
}
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/formal', message)],
});
export function parseDrawingSettings(input: unknown): Result<DrawingSettings> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', [
      'paper',
      'orientation',
      'occupancy',
      'bindingEdge',
      'fields',
      'changes',
      'titleCells',
      'labels',
      'template',
    ]);
  const template = o.template === undefined ? null : parseDrawingTemplate(o.template);
  if (template && !template.ok) return template;
  const labels = o.labels === undefined ? 'all' : o.labels;
  if (labels !== 'all' && labels !== 'none') return fail('DRAWING_SETTINGS_INVALID', '请选择显示或隐藏元件名称。');
  const paper = o.paper === 'A4' || o.paper === 'A3' || o.paper === 'A2' ? o.paper : null;
  const orientation = o.orientation === 'portrait' || o.orientation === 'landscape' ? o.orientation : null;
  if (!paper || !orientation) return fail('DRAWING_SETTINGS_INVALID', '请选择A4、A3或A2及横竖向。');
  const bindingEdge = o.bindingEdge;
  if (bindingEdge !== undefined && typeof bindingEdge !== 'boolean')
    return fail('DRAWING_SETTINGS_INVALID', '请选择是否保留装订边。');
  const texts = (raw: unknown, field: string, keys: readonly string[]) => {
    const object = r.object(raw, field, keys),
      result: Record<string, string> = {};
    for (const key of keys) {
      const text = r.text(object[key], field + '/' + key, 0, 160);
      if (/[\u0000-\u001f\uFFFE\uFFFF]/.test(text))
        r.fail('DRAWING_TEXT_INVALID', field + '/' + key, '文字不能含控制字符。');
      result[key] = text;
    }
    return result;
  };
  const fields = texts(o.fields, '/fields', [
    ...new Set([
      ...drawingFields.flatMap((f) => (f[0] ? [f[0]] : [])),
      ...(template?.ok ? template.value.fields.map((f) => f.key) : []),
    ]),
  ]);
  const changes = r.array(o.changes, '/changes', 3).map((raw, i) =>
    texts(
      raw,
      '/changes/' + i,
      changeFields.flatMap((f) => (f[0] ? [f[0]] : [])),
    ),
  );
  if (changes.length !== 3) r.fail('DRAWING_SETTINGS_INVALID', '/changes', '标题栏更改区须为3行，允许全空。');
  const titleCells: Record<string, string> = {};
  if (o.titleCells !== undefined) {
    const keys = [
      ...changeFields.map(([key]) => 'changeHeading.' + key),
      ...['design', 'check', 'review', 'process', 'standard', 'approve'].map((key) => 'signHeading.' + key),
      'signHeading.spare1',
      'signHeading.spare2',
      'spare1Name',
      'spare1Date',
      'spare2Name',
      'spare2Date',
      'stageHeading',
      'massHeading',
      'scaleHeading',
      'totalCell',
      'sheetCell',
      ...[0, 1, 2, 3].map((index) => 'stage.' + index),
      ...(template?.ok
        ? [
            ...template.value.fields.map(({ key }) => 'templateHeading.' + key),
            'templateSpare.0',
            'templateSpare.1',
            'templateSpare.2',
          ]
        : []),
    ];
    const raw = r.object(o.titleCells, '/titleCells', keys);
    Object.assign(
      titleCells,
      texts(
        raw,
        '/titleCells',
        Object.keys(raw).filter((key) => keys.includes(key)),
      ),
    );
  }
  return r.finish({
    labels,
    paper,
    orientation,
    occupancy: r.number(o.occupancy, '/occupancy', 0.5, 1),
    ...(bindingEdge === undefined ? {} : { bindingEdge }),
    fields,
    changes,
    ...(Object.keys(titleCells).length ? { titleCells } : {}),
    ...(template?.ok ? { template: template.value } : {}),
  });
}
export interface BookSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly equations: readonly BookMath[];
  readonly rows: readonly (readonly string[])[];
  readonly keepTogether?: true;
}
export interface CalculationBook {
  readonly version: 1;
  readonly title: string;
  readonly introduction: string;
  readonly source: string;
  readonly sections: readonly BookSection[];
  readonly metadata: string;
  readonly formulaFormat?: 'native' | 'latex';
}
export function parseCalculationBook(input: unknown): Result<CalculationBook> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['version', 'title', 'introduction', 'source', 'sections', 'metadata', 'formulaFormat']);
  r.constant(o.version, 1, '/version');
  const formulaFormat = o.formulaFormat;
  if (formulaFormat !== undefined && formulaFormat !== 'native' && formulaFormat !== 'latex')
    return fail('BOOK_FORMULA_FORMAT_INVALID', '计算书公式格式须为排版公式或LaTeX源码。');
  const text = (v: unknown, p: string, max: number) => {
    const t = r.text(v, p, 0, max);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/.test(t))
      r.fail('BOOK_TEXT_INVALID', p, '文本含不可输出字符。');
    return t;
  };
  const sections = r.array(o.sections, '/sections', 1000).map((raw, i) => {
    const p = '/sections/' + i,
      s = r.object(raw, p, ['heading', 'paragraphs', 'equations', 'rows', 'keepTogether']);
    if (s.keepTogether !== undefined && s.keepTogether !== true)
      r.fail('BOOK_SECTION_INVALID', p + '/keepTogether', '整块排版标记须为 true 或省略。');
    const rows = r
      .array(s.rows, p + '/rows', 1000)
      .map((row, j) => r.array(row, p + '/rows/' + j, 3).map((v, k) => text(v, p + '/rows/' + j + '/' + k, 12000)));
    if (rows.some((row) => row.length !== 3)) r.fail('BOOK_TABLE_INVALID', p, '表格须为3列。');
    return {
      heading: text(s.heading, p + '/heading', 300),
      paragraphs: r.array(s.paragraphs, p + '/paragraphs', 100).map((v, j) => text(v, p + '/paragraphs/' + j, 16000)),
      // Previously archived v1 books did not contain equations. Preserve those plain-text documents.
      equations:
        s.equations === undefined
          ? []
          : r.array(s.equations, p + '/equations', 100).map((v, j) => readBookMath(v, r, p + '/equations/' + j)),
      rows,
      ...(s.keepTogether === true ? { keepTogether: true as const } : {}),
    };
  });
  return r.finish({
    version: 1,
    title: text(o.title, '/title', 300),
    introduction: text(o.introduction, '/introduction', 2000),
    source: text(o.source, '/source', 4000),
    sections,
    metadata: text(o.metadata, '/metadata', 2_000_000),
    ...(formulaFormat === undefined ? {} : { formulaFormat }),
  });
}
/** A PDF book carries parsed data, never arbitrary HTML or a document path. */
export function parseCalculationPdfSource(input: unknown): Result<CalculationBook> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['format', 'version', 'book']);
  r.constant(o.format, 'HydraulicCalculationBookPdf', '/format');
  r.constant(o.version, 1, '/version');
  const shape = r.finish(true);
  if (!shape.ok) return shape;
  const book = parseCalculationBook(o.book);
  if (!book.ok) return book;
  if (book.value.formulaFormat === 'latex')
    return fail('BOOK_FORMULA_FORMAT_INVALID', 'PDF计算书使用排版公式；LaTeX源码选项仅用于Word。');
  return book;
}
function includesAccumulatorTransfer(coverage: NetworkDutyCoverage): boolean {
  return coverage.phases.some((phase) => phase.kind === 'calculated' && phase.demand.boundaryAssessment?.transfer);
}

/** A projection of the existing calculation record; no hydraulic formula or threshold is recomputed. */
export function dutyCoverageSections(coverage: NetworkDutyCoverage): readonly BookSection[] {
  const format = (value: number) => Number(value.toPrecision(6)).toString();
  const labels = {
    incomplete: '未核算 · 条件未齐',
    excluded: '未纳入',
    unsupported: '暂不支持核算',
    blocked: '已判定 · 目标受阻',
  } as const;
  const summary = (phase: Extract<NetworkDutyCoverage['phases'][number], { kind: 'calculated' }>) => {
    const demand = phase.demand;
    if (demand.boundaryAssessment) return demand.boundaryAssessment.summary;
    if ('pumpPressurePoint' in demand && demand.pumpPressurePoint) {
      const point = demand.pumpPressurePoint;
      return (
        `泵出口 ${format(point.pressurePa / 1e6)} MPa，实际缸速 ${format(point.cylinderSpeedMPerS * 1000)} mm/s，目标 ${format(point.targetSpeedMPerS * 1000)} mm/s，${point.matchesSpeed ? '缸速达标' : '缸速未达标'}。` +
        (phase.limits?.length ? ' ' + phase.limits.join(' ') : '')
      );
    }
    const { flowSplit } = demand;
    if (
      flowSplit?.kind === 'solved' &&
      (flowSplit.sharedReturn ||
        flowSplit.returnSegments ||
        flowSplit.returnAccessories ||
        flowSplit.supplySegments ||
        flowSplit.workingSegments)
    )
      return flowSplit.matchesTargets ? '各缸速度和供油预算均满足。' : '缸速目标或供油预算未同时满足。';
    const result = demand.springReturn
      ? `弹簧回程。目标点 A 腔 ${format(demand.springReturn.backPressurePa / 1e6)} MPa，排油 ${format(demand.springReturn.flowM3PerS * 60000)} L/min，力裕量 ${format(demand.springReturn.forceMarginN)} N${demand.springReturn.forceMarginN < 0 ? '（不足）' : ''}。${demand.springReturn.actual ? `实际 ${format(demand.springReturn.actual.speedMPerS * 1000)} mm/s，目标 ${format(demand.springReturn.actual.targetSpeedMPerS * 1000)} mm/s，实际背压 ${format(demand.springReturn.actual.backPressurePa / 1e6)} MPa，实际排油 ${format(demand.springReturn.actual.flowM3PerS * 60000)} L/min。` : ''}无缸供油需求。`
      : `${flowSplit ? '下列基础目标未含实际阀口及干线压降。' : ''}压力 ${format(demand.pressurePa / 1e6)} MPa，流量 ${format(demand.flowM3PerS * 60000)} L/min，轴功率 ${format(demand.shaftPowerW / 1000)} kW。`;
    const available = 'availableFlowM3PerS' in demand ? demand.availableFlowM3PerS : undefined;
    return (
      result +
      (available === undefined ? '' : ` 本工况变量泵估计供流 ${format(available * 60000)} L/min。`) +
      (phase.limits?.length ? ' ' + phase.limits.join(' ') : '')
    );
  };
  const hasPressurePoint = coverage.phases.some(
    (phase) => phase.kind === 'calculated' && 'pumpPressurePoint' in phase.demand && phase.demand.pumpPressurePoint,
  );
  const transferStatus = {
    timed: '充放油时间已核算',
    blocked: labels.blocked,
    pending: '起始状态已核算 · 时间待核',
  };
  return [
    {
      heading: '工况核算状态',
      paragraphs: [
        ...(includesAccumulatorTransfer(coverage)
          ? ['逐工况区分充放油时间已算、目标受阻和待核。可确定的起始状态保留在计算书。']
          : hasPressurePoint
            ? [
                coverage.complete ? '本次纳入的工况均已按稳态条件核算。' : '本次工况核算未覆盖完整需求。',
                '压力调节工况列出所用模型的稳态工作点。各工况的目标达标情况、待核原因见下表，动态响应另验。',
              ]
            : [
                coverage.complete
                  ? '本次纳入的工况均已按稳态条件核算。已核算表示给出需求估算，实际供油与动态响应仍需验证。'
                  : '本次工况核算未覆盖完整需求。仅列出已核算工况的需求；全回路泵需求及规格待复核。',
              ]),
        ...(coverage.phases.length ? [] : ['本次没有可核算的工况输入。']),
      ],
      equations: [],
      rows: coverage.phases.length
        ? [
            ['工况', '核算状态', '结果或原因'],
            ...coverage.phases.map((phase) =>
              phase.kind === 'calculated'
                ? [
                    phase.name,
                    phase.demand.boundaryAssessment?.transfer
                      ? transferStatus[phase.demand.boundaryAssessment.transfer]
                      : 'pumpPressurePoint' in phase.demand && phase.demand.pumpPressurePoint
                        ? '压力调节稳态点已核算'
                        : phase.demand.flowSplit?.kind === 'pending'
                          ? '基础目标已核算 · 实际分流待核'
                          : phase.demand.flowSplit
                            ? '实际分流已核算'
                            : '已核算',
                    summary(phase),
                  ]
                : [phase.name, labels[phase.kind], phase.reason],
            ),
          ]
        : [],
    },
    ...coverage.phases.flatMap((phase) => {
      if (phase.kind === 'calculated' && 'pumpPressurePoint' in phase.demand && phase.demand.pumpPressurePoint) {
        const point = phase.demand.pumpPressurePoint;
        const state = { maximum: '最大排量', regulating: '调节区', minimum: '最小排量' }[point.state];
        const mp = (pa: number) => format(pa / 1e6) + ' MPa';
        const d = (value: number) => format(value * 1e6) + ' cm³/rev';
        const q = (value: number) => format(value * 60000) + ' L/min';
        const speed = (value: number) => format(value * 1000) + ' mm/s';
        const section: BookSection = {
          heading: phase.name + ' · 变量泵压力调节',
          keepTogether: true,
          paragraphs: [
            `截压压差 ${mp(point.cutoffDifferentialPa)}，调节带 ${mp(point.bandPa)}，排量范围 ${d(point.minimumDisplacementM3PerRev)} 至 ${d(point.maximumDisplacementM3PerRev)}。`,
          ],
          equations: [],
          rows: [
            ['排量与压力', '泵供流与分配', '缸速与功率'],
            [
              `${state}，实际排量 ${d(point.displacementM3PerRev)}，泵出口 ${mp(point.pressurePa)}，泵压差 ${mp(point.differentialPa)}。`,
              `扣泄漏前 ${q(point.pumpFlowM3PerS)}，泄漏 ${q(point.leakageM3PerS)}，泵出口供流 ${q(point.deliveryFlowM3PerS)}，进缸 ${q(point.cylinderFlowM3PerS)}。${point.reliefOpen === undefined ? '无溢流支路。' : `溢流阀${point.reliefOpen ? '开启' : '关闭'}，回箱 ${q(point.reliefFlowM3PerS)}。`}`,
              `实际 ${speed(point.cylinderSpeedMPerS)}，目标 ${speed(point.targetSpeedMPerS)}，${point.matchesSpeed ? '达标' : '未达标'}。轴功率 ${format(point.shaftPowerW)} W。`,
            ],
          ],
        };
        return [section];
      }
      const result =
        phase.kind === 'calculated'
          ? phase.demand.flowSplit
          : phase.kind === 'unsupported'
            ? phase.flowSplit
            : undefined;
      return result ? dutyFlowSplitSections(phase.name, result) : [];
    }),
    ...(coverage.componentLimits.length
      ? [
          {
            heading: '暂不支持核算的元件',
            paragraphs: ['当前稳态核算按整图检查元件类型，包含未接管实例。下列限制适用于工况核算。'],
            equations: [],
            rows: [
              ['元件', '实例 ID', '核算限制'],
              ...coverage.componentLimits.map((item) => [item.label, item.componentId, item.reason]),
            ],
          },
        ]
      : []),
  ];
}

export function dutyFlowSplitSection(name: string, result: ParallelFlowResult): BookSection {
  const n = (value: number) => Number(value.toPrecision(6)).toString();
  const solved = result.kind === 'solved';
  const targets = solved ? result.branches : result.targets;
  const trunk = solved ? result.sharedReturn : undefined;
  const branched =
    solved &&
    (result.returnAccessories?.length ||
      result.pilotRelief?.earlyMerge ||
      result.branches.some((branch) => branch.returnPipe));
  const uneven = targets.length >= 5;
  const compact = targets.length >= 4;
  const cylinders =
    targets.length === 1
      ? '单缸'
      : targets.length > 5
        ? targets.length + ' 缸'
        : uneven
          ? '五缸'
          : compact
            ? '四缸'
            : targets.length === 3
              ? '三缸'
              : '两缸';
  const verdict = {
    matched: '达到目标',
    slow: '低于目标',
    fast: '高于目标',
    stopped: '未建立通流',
    'end-stop': '已到位，按零流量边界核算',
  };
  return {
    heading:
      name +
      ' · ' +
      (solved && result.workingSegments
        ? '单缸有损工作管稳态点'
        : (cylinders === '两缸' ? '双缸' : cylinders) + '实际分流'),
    ...(compact || (solved && (result.divider || result.supplySegments || result.workingSegments))
      ? { keepTogether: true }
      : {}),
    paragraphs: [
      ...(solved
        ? [
            result.divider?.mode === 'correction'
              ? result.matchesTargets
                ? '到位缸保持零流，未到位缸达到目标速度（±1%）且满足供油预算。'
                : '纠偏速度或供油预算未满足。'
              : result.matchesTargets
                ? cylinders + '同时达到目标速度（±1%）且满足供油预算。'
                : cylinders + '目标或供油预算未同时满足。',
            `${result.supplySegments || result.workingSegments ? '泵出口压力' : '公共压力'} ${n(result.pressurePa / 1e6)} MPa，泵估计供流 ${n(result.pumpFlowM3PerS * 60000)} L/min，溢流 ${n(result.reliefFlowM3PerS * 60000)} L/min，${result.workingSegments ? '稳态点' : '实际分流点'}估计轴功率 ${n(result.shaftPowerW / 1000)} kW。`,
            ...(trunk && !compact && !result.supplySegments
              ? [
                  `共用回油干线 [${trunk.connectionId}] 实际回油 ${n(trunk.flowM3PerS * 60000)} L/min，干线压降 ${n(trunk.pressureDropPa / 1e6)} MPa，${branched ? '汇流点' : '阀 T 侧'} ${n(trunk.upstreamPressurePa / 1e6)} MPa，油箱 ${n(trunk.tankPressurePa / 1e6)} MPa。`,
                  ...(branched
                    ? []
                    : [
                        `流态 ${trunk.regime}，Re=${n(trunk.reynolds)}，管内速度 ${n(trunk.velocityMPerS)} m/s${trunk.frictionFactor === undefined ? '' : '，Darcy f=' + n(trunk.frictionFactor)}。沿程压降 ${n(trunk.frictionDropPa / 1e6)} MPa，局部压降 ${n(trunk.localDropPa / 1e6)} MPa。`,
                        `保存内径 ${n(trunk.diameterM * 1000)} mm，长度 ${n(trunk.lengthM)} m，粗糙度 ${n(trunk.roughnessM * 1000)} mm，局部 K=${n(trunk.localLossCoefficient)}。油液密度 ${n(trunk.densityKgPerM3)} kg/m³，运动黏度 ${n(trunk.kinematicViscosityM2PerS * 1e6)} mm²/s。`,
                      ]),
                ]
              : []),
          ]
        : ['实际分流待核。已确定的目标量保留，实际值留待分配条件补齐。']),
      ...result.reasons,
    ],
    equations: [],
    rows: [
      ['油缸支路', '目标流量与速度', '实际分流与判定'],
      ...targets.map((target, index) => {
        const branch = solved ? result.branches[index] : undefined;
        return [
          target.label + ' [' + target.componentId + ']',
          branch?.status === 'end-stop'
            ? '到位约束，目标流量和速度为 0。'
            : `${n(target.targetFlowM3PerS * 60000)} L/min，${n(target.targetSpeedMPerS * 1000)} mm/s`,
          branch
            ? `${n(branch.flowM3PerS * 60000)} L/min，${n(branch.speedMPerS * 1000)} mm/s。${
                branch.valveInletPressurePa === undefined ? '' : `阀 P 口 ${n(branch.valveInletPressurePa / 1e6)} MPa。`
              }${
                uneven
                  ? `T 侧／回油腔 ${n(branch.returnBoundaryPa / 1e6)}／${n(branch.returnPressurePa / 1e6)} MPa。`
                  : compact
                    ? `阀 T 侧 ${n(branch.returnBoundaryPa / 1e6)} MPa，缸回油腔 ${n(branch.returnPressurePa / 1e6)} MPa。`
                    : trunk
                      ? `排油 ${n(branch.returnFlowM3PerS * 60000)} L/min，${branched ? '阀 T 侧 ' + n(branch.returnBoundaryPa / 1e6) + ' MPa，' : ''}缸回油腔 ${n(branch.returnPressurePa / 1e6)} MPa。`
                      : `T 侧 ${n(branch.returnBoundaryPa / 1e6)} MPa，缸回油腔 ${n(branch.returnPressurePa / 1e6)} MPa，阀口 ${n(branch.valveAreaM2 * 1e6)} mm²。`
              }${branch.inletPressurePa === undefined ? '' : `缸进油腔 ${n(branch.inletPressurePa / 1e6)} MPa。`}${verdict[branch.status]}。${branch.closed && !(solved && result.workingSegments) ? '串联节流阀关闭。' : ''}`
            : '缺少分配条件，待核。',
        ];
      }),
    ],
  };
}

function paginateBookTable(section: BookSection, maxRows = 5): readonly BookSection[] {
  const [header, ...rows] = section.rows;
  if (!header || rows.length <= maxRows) return [section];
  const pageCount = Math.ceil(rows.length / maxRows);
  const pageSize = Math.ceil(rows.length / pageCount);
  return Array.from({ length: pageCount }, (_, i) => ({
    ...section,
    heading: i === 0 ? section.heading : section.heading + '（续 ' + (i + 1) + '）',
    paragraphs: i === 0 ? section.paragraphs : [],
    rows: [header, ...rows.slice(i * pageSize, (i + 1) * pageSize)],
  }));
}

const pilotReliefState = {
  closed: '先导阀关闭，主阀关闭',
  'pilot-only': '先导阀已开启，主阀关闭',
  'main-open': '先导阀已开启，主阀已开启',
  'main-full': '先导阀已开启，主阀达到最大行程',
} as const;

const pilotPipeCounts = ['', '单段', '两段', '三段', '四段'];
const pilotPipeCount = (count: number) => pilotPipeCounts[count] ?? count + ' 段';

function pilotReturnComparison(
  name: string,
  actual: Extract<ParallelFlowResult, { kind: 'solved' }>,
): BookSection | undefined {
  const current = actual.pilotRelief;
  const reference = actual.directReturnComparison;
  if (!current || !reference) return undefined;
  const heading = name + ' · 两种 T 口接法对照';
  const branches = current.returnBranchSegments ?? [];
  const series = branches.length > 1;
  const referenceCount = branches.length - 1;
  const retainedRange =
    referenceCount <= 3
      ? Array.from({ length: referenceCount }, (_, index) => index + 1).join('、')
      : '1 至 ' + referenceCount;
  const directLabel = series
    ? 'T 经' + pilotPipeCount(referenceCount) + '接滤芯'
    : branches.length
      ? 'T 直接接滤芯入口'
      : 'T 直回油箱';
  const condition =
    '保持泵、负载、换向阀位、滤芯和油箱压力相同，试算 ' +
    directLabel +
    '。' +
    (series
      ? pilotPipeCount(referenceCount) +
        '试算保留从 T 口起的第 ' +
        retainedRange +
        ' 段及其管参数，第 ' +
        branches.length +
        ' 段按理想连接处理。'
      : '');
  if (reference.kind === 'pending')
    return {
      heading,
      paragraphs: [condition, directLabel + '试算待核。', ...reference.reasons],
      equations: [],
      rows: [],
    };
  const direct = reference.pilotRelief;
  const currentFilter = actual.returnAccessories?.find((part) => part.kind === 'filter');
  const directFilter = reference.returnAccessories?.find((part) => part.kind === 'filter');
  if (!direct || !currentFilter || !directFilter) return undefined;
  const referencePipes = direct.returnBranchSegments ?? [];
  if (series && referencePipes.length !== referenceCount)
    return { heading, paragraphs: [condition, directLabel + '试算缺少管段结果，待核。'], equations: [], rows: [] };
  const n = (value: number) => Number(value.toPrecision(6)).toString();
  const p = (value: number) => n(value / 1e6) + ' MPa';
  const q = (value: number) => n(value * 60000) + ' L/min';
  const branchCell = (branch: (typeof actual.branches)[number]) =>
    `进油 ${q(branch.flowM3PerS)}，缸背压 ${p(branch.returnPressurePa)}，缸速 ${n(branch.speedMPerS * 1000)} mm/s。`;
  return {
    heading,
    keepTogether: true,
    paragraphs: [condition],
    equations: [],
    rows: [
      [
        '对照项目',
        series
          ? 'T 经' + pilotPipeCount(branches.length) + '接滤芯 · 当前接线'
          : branches.length
            ? 'T 经支管接滤芯 · 当前接线'
            : 'T 接滤芯上游 · 当前接线',
        directLabel + ' · 同条件试算',
      ],
      ...(branches.length
        ? [
            [
              series ? 'T 口支管总压降' : 'T 口独立支管压降',
              p(branches.reduce((sum, pipe) => sum + pipe.pressureDropPa, 0)),
              series ? p(referencePipes.reduce((sum, pipe) => sum + pipe.pressureDropPa, 0)) : '0 MPa（理想连接）',
            ],
          ]
        : []),
      [
        '滤芯流量与压降',
        `${q(currentFilter.flowM3PerS)}，压降 ${p(currentFilter.pressureDropPa)}`,
        `${q(directFilter.flowM3PerS)}，压降 ${p(directFilter.pressureDropPa)}`,
      ],
      [
        'P／T 口压力',
        `${p(current.inletPressurePa)}／${p(current.returnPressurePa)}`,
        `${p(direct.inletPressurePa)}／${p(direct.returnPressurePa)}`,
      ],
      [
        '开启状态与溢流',
        `${pilotReliefState[current.state]}。合计 ${q(current.totalFlowM3PerS)}`,
        `${pilotReliefState[direct.state]}。合计 ${q(direct.totalFlowM3PerS)}`,
      ],
      ...actual.branches.flatMap((branch) => {
        const other = reference.branches.find((item) => item.componentId === branch.componentId);
        return other ? [[branch.label, branchCell(branch), branchCell(other)]] : [];
      }),
    ],
  };
}

export function dutyFlowSplitSections(name: string, result: ParallelFlowResult): readonly BookSection[] {
  const summary = [...paginateBookTable(dutyFlowSplitSection(name, result))];
  if (result.kind !== 'solved') return summary;
  const n = (value: number) => Number(value.toPrecision(6)).toString();
  if (result.workingSegments?.length)
    summary.push({
      heading: name + ' · 工作管逐段压降',
      keepTogether: true,
      paragraphs: ['按当前工况实际通流方向列出进、排油工作管。'],
      equations: [],
      rows: [
        ['工作管', '实际流量、流态与端压', '沿程、局部与总压降'],
        ...result.workingSegments.map((pipe) => [
          `${pipe.role} [${pipe.connectionId}]，D ${n(pipe.diameterM * 1000)} mm，L ${n(pipe.lengthM)} m，ε ${n(pipe.roughnessM * 1000)} mm，K=${n(pipe.localLossCoefficient)}。`,
          `${n(pipe.flowM3PerS * 60000)} L/min，${pipe.regime}，Re=${n(pipe.reynolds)}。入口 → 出口 ${n(pipe.upstreamPressurePa / 1e6)} → ${n(pipe.downstreamPressurePa / 1e6)} MPa。`,
          `沿程 ${n(pipe.frictionDropPa / 1e6)} MPa，局部 ${n(pipe.localDropPa / 1e6)} MPa，合计 ${n(pipe.pressureDropPa / 1e6)} MPa。`,
        ]),
      ],
    });
  const supplyPipes = result.supplySegments;
  const firstSupplyPipe = supplyPipes?.[0];
  if (supplyPipes && firstSupplyPipe)
    summary.push(
      ...paginateBookTable({
        heading: name + ' · 供油管段压降',
        keepTogether: true,
        paragraphs: [
          '干线取两缸实际进油量之和，支管取本缸实际进油量。泵口溢流直接回箱，不流经供油管。',
          `油液密度 ${n(firstSupplyPipe.densityKgPerM3)} kg/m³，运动黏度 ${n(firstSupplyPipe.kinematicViscosityM2PerS * 1e6)} mm²/s。`,
        ],
        equations: [],
        rows: [
          ['供油管段与参数', '实际流量、流态与端压', '沿程、局部与总压降'],
          ...supplyPipes.map((pipe) => [
            `${pipe.role}（${pipe.cylinderLabels.join('、')}） [${pipe.connectionId}]。D ${n(pipe.diameterM * 1000)} mm，L ${n(pipe.lengthM)} m，ε ${n(pipe.roughnessM * 1000)} mm，K=${n(pipe.localLossCoefficient)}。`,
            `${n(pipe.flowM3PerS * 60000)} L/min，${pipe.regime}，Re=${n(pipe.reynolds)}。入口 → 出口 ${n(pipe.upstreamPressurePa / 1e6)} → ${n(pipe.downstreamPressurePa / 1e6)} MPa。`,
            `沿程 ${n(pipe.frictionDropPa / 1e6)} MPa，局部 ${n(pipe.localDropPa / 1e6)} MPa，合计 ${n(pipe.pressureDropPa / 1e6)} MPa。`,
          ]),
        ],
      }),
    );
  const sharedRelief = result.pilotRelief?.returnRoute === 'shared-filter';
  const earlyMerge = result.pilotRelief?.earlyMerge;
  const mixedPipeIds = new Set(earlyMerge?.pipeIds);
  if (result.pilotRelief) {
    const relief = result.pilotRelief;
    const branches = relief.returnBranchSegments ?? [];
    const state = pilotReliefState[relief.state];
    const differential = relief.inletPressurePa - relief.returnPressurePa;
    summary.push({
      heading: name + ' · 先导式溢流回箱',
      keepTogether: true,
      paragraphs: [
        earlyMerge
          ? '一缸排油先与 T 口溢流汇合，另一缸在共用滤芯入口侧汇入。T 口压力等于滤芯入口压力加沿 T 口路径的纯溢流段及提前汇合段压降。'
          : branches.length
            ? '溢流 T 口经独立支管汇入滤芯。T 口压力等于滤芯入口压力加支管压降。'
            : sharedRelief
              ? '溢流 T 口接共用滤芯上游。先导与主阀溢流汇入两缸排油，T 口压力取滤芯入口。'
              : '溢流 T 口直回油箱。共用滤芯只通过两缸排油。',
      ],
      equations: [],
      rows: [
        ['溢流阀与状态', 'P、T 端压与开启条件', '回箱流量及主阀芯开度'],
        [
          `${relief.label} [${relief.componentId}]。${state}。`,
          `P 口 ${n(relief.inletPressurePa / 1e6)} MPa，T 口 ${n(relief.returnPressurePa / 1e6)} MPa。P−T 压差 ${n(differential / 1e6)} MPa，先导开启压差 ${n(relief.pilotCrackingPa / 1e6)} MPa，主阀开启压差 ${n(relief.mainCrackingPa / 1e6)} MPa。`,
          `先导回箱 ${n(relief.pilotFlowM3PerS * 60000)} L/min，主阀回箱 ${n(relief.mainFlowM3PerS * 60000)} L/min，溢流回箱合计 ${n(relief.totalFlowM3PerS * 60000)} L/min。主阀芯开度 ${n(relief.liftM * 1000)} mm。`,
        ],
      ],
    });
    if (earlyMerge) {
      const firstPipe = result.returnSegments?.find((pipe) => pipe.connectionId === earlyMerge.pipeIds[0]);
      const filter = result.returnAccessories?.find((part) => part.kind === 'filter');
      const early = result.branches.find((branch) => branch.valveId === earlyMerge.valveId);
      const late = result.branches.find((branch) => branch.valveId !== earlyMerge.valveId);
      if (firstPipe && filter && early && late)
        summary.push({
          heading: name + ' · T 口提前汇流',
          keepTogether: true,
          paragraphs: [
            `第一汇点 ${n(firstPipe.upstreamPressurePa / 1e6)} MPa。溢流 ${n(relief.totalFlowM3PerS * 60000)} L/min 与 ${early.label} 排油 ${n(early.returnFlowM3PerS * 60000)} L/min 汇入 [${firstPipe.connectionId}]，合计 ${n(firstPipe.flowM3PerS * 60000)} L/min。`,
            `滤芯前汇点 ${n(filter.upstreamPressurePa / 1e6)} MPa。${late.label} 排油 ${n(late.returnFlowM3PerS * 60000)} L/min 在此汇入，滤芯流量 ${n(filter.flowM3PerS * 60000)} L/min。`,
          ],
          rows: [],
          equations: [],
        });
    }
    if (branches.length)
      summary.push(
        ...paginateBookTable({
          heading: name + ' · 溢流阀 T 口支管压降',
          keepTogether: true,
          paragraphs: [
            '支管流量取先导与主阀的实际溢流之和。沿程按 Darcy–Weisbach 计算，局部损失取保存的 K。',
            ...(branches.length > 1
              ? [
                  `从 T 口到${earlyMerge ? '第一汇点' : '滤芯入口'}按实际接线顺序列段。${pilotPipeCount(branches.length)}总压降 ${n(branches.reduce((sum, pipe) => sum + pipe.pressureDropPa, 0) / 1e6)} MPa。`,
                ]
              : []),
          ],
          equations: [],
          rows: [
            ['支管与参数', '实际流量、流态与端压', '沿程、局部与总压降'],
            ...branches.map((branch, index) => [
              `T 口支管${branches.length > 1 ? '第 ' + (index + 1) + ' 段' : ''} [${branch.connectionId}]。D ${n(branch.diameterM * 1000)} mm，L ${n(branch.lengthM)} m，ε ${n(branch.roughnessM * 1000)} mm，K=${n(branch.localLossCoefficient)}。`,
              `${n(branch.flowM3PerS * 60000)} L/min，${branch.regime}，Re=${n(branch.reynolds)}。${branches.length > 1 ? '本段入口 → 出口' : earlyMerge ? 'T 口 → 第一汇点' : 'T 口 → 滤芯入口'} ${n(branch.upstreamPressurePa / 1e6)} → ${n(branch.downstreamPressurePa / 1e6)} MPa。`,
              `沿程 ${n(branch.frictionDropPa / 1e6)} MPa，局部 ${n(branch.localDropPa / 1e6)} MPa，合计 ${n(branch.pressureDropPa / 1e6)} MPa。`,
            ]),
          ],
        }),
      );
  }
  if (result.divider) {
    const valve = result.divider;
    const mode = { division: '正向分流', combining: '反向集流', correction: '伸出末端纠偏' }[valve.mode];
    const trim = valve.correction;
    summary.push({
      heading: name + ' · ' + valve.label + ' · ' + mode,
      keepTogether: true,
      paragraphs: [
        `P 口压力 ${n(valve.commonPressurePa / 1e6)} MPa，保存 A:B 比例 ${n(valve.aShare * 100)}:${n((1 - valve.aShare) * 100)}。`,
        trim
          ? `${trim.stoppedLabel}到位。主分流为 0，低于 ${n(trim.flowGateM3PerS * 60000)} L/min 纠偏门槛。支路压差 ${n(trim.pressureDifferencePa / 1e6)} MPa，开启阈值 ${n(trim.thresholdPa / 1e6)} MPa，纠偏权重 ${n(trim.openingWeight * 100)}%。`
          : `比例施加在${valve.mode === 'division' ? '两缸进油' : '两缸排油'}。限流侧达到全开孔口压降，另一侧补偿节流。缸速由各缸实际进油量与有效面积计算。`,
      ],
      equations: [],
      rows: [
        ['阀口与缸', '实际流量及端压', '沿通流方向的压降及阀状态'],
        ...valve.ports.map((port) => [
          `${port.port} · ${port.label}`,
          `${n(port.flowM3PerS * 60000)} L/min，${n(port.pressurePa / 1e6)} MPa`,
          port.flowM3PerS === 0
            ? '到位侧无通流。'
            : `${n(port.dropPa / 1e6)} MPa，${trim ? '纠偏通流' : port.limiting ? '全开限流' : '补偿节流'}。`,
        ]),
      ],
    });
  }
  if (result.returnAccessories?.length)
    summary.push({
      heading: name + ' · 回油附件压降',
      keepTogether: true,
      paragraphs: [
        sharedRelief
          ? `滤芯流量为两缸排油 ${n(result.branches.reduce((sum, branch) => sum + branch.returnFlowM3PerS, 0) * 60000)} L/min 加溢流 ${n(result.reliefFlowM3PerS * 60000)} L/min。支路附件取所在缸的实际排油量。`
          : result.returnAccessories.some((part) => part.parallelBypass)
            ? '共用回油在滤芯与外接物理旁路之间分流。滤芯按本支路实际流量校核额定。两路端压分别列出。'
            : result.returnAccessories.some((part) => part.builtInBypass)
              ? '共用滤芯与内置旁通承受相同压差，流量之和等于合计回油。按滤芯支路实际流量核对额定。'
              : '各附件按实际接线取其上游各缸排油量之和。单缸支路只取本缸排油，各附件端压按实际流向列出。',
      ],
      equations: [],
      rows: [
        ['回油附件与所在位置', '实际回油量与端压', '参数与压降'],
        ...result.returnAccessories.map((part) => [
          `${part.label} [${part.componentId}]，${part.location === 'trunk' ? '共用干线' : (part.cylinderLabels.join('、') || '未参与动作') + (part.location === 'junction' ? ' 汇合支路' : ' 支路')}。`,
          `${n(part.flowM3PerS * 60000)} L/min，${part.forward ? 'A→B' : 'B→A'}。入口 → 出口 ${n(part.upstreamPressurePa / 1e6)} → ${n(part.downstreamPressurePa / 1e6)} MPa。`,
          (part.kind === 'filter'
            ? `额定 ${n(part.ratedFlowM3PerS * 60000)} L/min，工况额定压降 ${n(part.ratedDropPa / 1e6)} MPa。${part.builtInBypass ? `内置旁通${part.builtInBypass.state === 'open' ? '开启' : '关闭'}，开启压差 ${n(part.builtInBypass.crackingPressurePa / 1e6)} MPa，有效面积 ${n(part.builtInBypass.effectiveAreaM2 * 1e6)} mm²。滤芯流量 ${n(part.flowM3PerS * 60000)} L/min，旁通流量 ${n(part.builtInBypass.flowM3PerS * 60000)} L/min，合计回油 ${n(part.builtInBypass.totalFlowM3PerS * 60000)} L/min。` : ''}`
            : part.kind === 'meter'
              ? `R=${n(part.resistancePaSPerM3)} Pa·s/m³。`
              : part.kind === 'reverse-throttle'
                ? `旁通${part.bypassState === 'open' ? '已开启' : '未开启'}（开启压差 ${n(part.crackingPressurePa / 1e6)} MPa）。主节流流量 ${n(part.meterFlowM3PerS * 60000)} L/min，旁通流量 ${n(part.bypassFlowM3PerS * 60000)} L/min。保存开口 ${n(part.openingAreaM2 * 1e6)} mm²，旁通面积 ${n(part.bypassAreaM2 * 1e6)} mm²，Cq=${n(part.flowCoefficient)}，ρ=${n(part.densityKgPerM3)} kg/m³。`
                : `旁通关闭（A→B）。保存开口 ${n(part.openingAreaM2 * 1e6)} mm²，Cq=${n(part.flowCoefficient)}，ρ=${n(part.densityKgPerM3)} kg/m³。`) +
            `实际压降 ${n(part.pressureDropPa / 1e6)} MPa。`,
        ]),
      ],
    });
  for (const filter of result.returnAccessories ?? []) {
    const bypass = filter.parallelBypass;
    if (!bypass) continue;
    const { pipe, totalFlowM3PerS } = bypass;
    summary.push({
      heading: name + ' · 滤芯外接并联旁路',
      keepTogether: true,
      paragraphs: [
        `两缸合计回油 ${n(totalFlowM3PerS * 60000)} L/min。滤芯与旁路流量之和等于合计回油，共同压降 ${n(filter.pressureDropPa / 1e6)} MPa。`,
        `旁路 D ${n(pipe.diameterM * 1000)} mm，L ${n(pipe.lengthM)} m，ε ${n(pipe.roughnessM * 1000)} mm，K=${n(pipe.localLossCoefficient)}。从滤芯入口侧向出口侧计流。`,
      ],
      equations: [],
      rows: [
        ['并联支路', '实际流量与端压', '压降及适用条件'],
        [
          `${filter.label} [${filter.componentId}]`,
          `${n(filter.flowM3PerS * 60000)} L/min，A→B。入口 → 出口 ${n(filter.upstreamPressurePa / 1e6)} → ${n(filter.downstreamPressurePa / 1e6)} MPa。`,
          `实际压降 ${n(filter.pressureDropPa / 1e6)} MPa。按本支路流量校核额定。`,
        ],
        [
          `外接旁路 [${pipe.connectionId}]`,
          `${n(pipe.flowM3PerS * 60000)} L/min，${pipe.regime}，Re=${n(pipe.reynolds)}。入口 → 出口 ${n(pipe.upstreamPressurePa / 1e6)} → ${n(pipe.downstreamPressurePa / 1e6)} MPa。`,
          `沿程 ${n(pipe.frictionDropPa / 1e6)} MPa，局部 ${n(pipe.localDropPa / 1e6)} MPa，合计 ${n(pipe.pressureDropPa / 1e6)} MPa。`,
        ],
      ],
    });
  }
  const comparison = pilotReturnComparison(name, result);
  if (comparison) summary.push(comparison);
  if (!result.returnSegments?.length) return summary;
  const pipes = result.returnSegments;
  if (
    pipes.length === 1 &&
    result.sharedReturn &&
    result.branches.length < 4 &&
    !result.returnAccessories?.length &&
    !result.supplySegments
  )
    return summary;

  const branchPipes = pipes
    .filter((pipe) => pipe.cylinderLabels.length === 1 && !mixedPipeIds.has(pipe.connectionId))
    .sort((a, b) => b.depth - a.depth);
  const mainPipes = pipes
    .filter((pipe) => pipe.cylinderLabels.length > 1 || mixedPipeIds.has(pipe.connectionId))
    .sort((a, b) => b.depth - a.depth);
  const oil = pipes[0];
  if (!oil) return summary;
  const fluid = `油液密度 ${n(oil.densityKgPerM3)} kg/m³，运动黏度 ${n(oil.kinematicViscosityM2PerS * 1e6)} mm²/s。`;
  const details = (heading: string, paragraphs: readonly string[], segments: typeof pipes): BookSection => ({
    heading: name + ' · ' + heading,
    keepTogether: true,
    paragraphs,
    equations: [],
    rows: [
      ['回油管段与参数', '实际流量、流态与端压', '沿程、局部与总压降'],
      ...segments.map((pipe) => {
        const label = mixedPipeIds.has(pipe.connectionId)
          ? pipe.role + '（' + pipe.cylinderLabels.join('、') + '）'
          : pipe.cylinderLabels.length === 1
            ? pipe.cylinderLabels[0] + ' 支管'
            : pipe.role === '回油干线'
              ? '共用回油干线'
              : pipe.role + '（' + pipe.cylinderLabels.join('、') + '）';
        return [
          `${label} [${pipe.connectionId}]。D ${n(pipe.diameterM * 1000)} mm，L ${n(pipe.lengthM)} m，ε ${n(pipe.roughnessM * 1000)} mm，K=${n(pipe.localLossCoefficient)}。`,
          `${n(pipe.flowM3PerS * 60000)} L/min，${pipe.regime}，Re=${n(pipe.reynolds)}。入口 → 出口 ${n(pipe.upstreamPressurePa / 1e6)} → ${n(pipe.downstreamPressurePa / 1e6)} MPa。`,
          `沿程 ${n(pipe.frictionDropPa / 1e6)} MPa，局部 ${n(pipe.localDropPa / 1e6)} MPa，合计 ${n(pipe.pressureDropPa / 1e6)} MPa。`,
        ];
      }),
    ],
  });
  if (result.branches.length < 5 && pipes.length <= 7)
    return [
      ...summary,
      details(
        '回油管段压降',
        [
          earlyMerge
            ? '单缸支管仅计本缸排油。提前汇合段计溢流和先汇入的一缸排油，滤芯下游计溢流和两缸排油。'
            : sharedRelief
              ? '滤芯下游管段同时计入两缸排油与溢流。其余管段按实际接线和上游排油量确定。'
              : '各段流量由实际接线及其上游各缸排油量确定。',
          fluid,
        ],
        [...branchPipes, ...mainPipes],
      ),
    ];
  return [
    ...summary,
    ...(branchPipes.length
      ? paginateBookTable(details('回油支管压降', ['支管流量取相应油缸的实际排油量。', fluid], branchPipes))
      : []),
    ...(mainPipes.length
      ? paginateBookTable(
          details(
            result.sharedReturn ? '回油汇合段及总干线压降' : '回油汇合及回箱管段压降',
            [
              earlyMerge
                ? '提前汇合段计溢流和先汇入的一缸排油，滤芯下游计溢流和两缸排油。'
                : '各段流量取其上游各缸的实际排油量之和。',
              ...(branchPipes.length ? [] : [fluid]),
            ],
            mainPipes,
          ),
        )
      : []),
  ];
}

export function dutyGroupSections(groups: readonly DutyGroupCoverage[]): readonly BookSection[] {
  const n = (value: number) => Number(value.toPrecision(6)).toString();
  const flow = (value: number) => n(value * 60000) + ' L/min';
  const p = (value: number) => n(value / 1e6) + ' MPa';
  return groups.flatMap((group, groupIndex) => {
    const title = '供油组 · ' + group.pumpLabel + ' [' + group.pumpId + ']';
    const component = (id: string | undefined, label: string | undefined) =>
      id ? (!label || label === id ? id : label + ' [' + id + ']') : '待确认';
    const boundary =
      '油箱 ' +
      component(group.tankId, group.tankLabel) +
      ' · 双作用缸 ' +
      (group.cylinders.map(({ id, label }) => component(id, label)).join('、') || '待确认');
    if (group.sharedReturn)
      return group.sharedReturn.map((phase): BookSection => {
        const pipe = phase.kind === 'solved' ? phase.pipe : undefined;
        return {
          heading: title + ' · ' + phase.name,
          keepTogether: true,
          paragraphs: [
            boundary,
            ...(pipe && groupIndex === 0
              ? [
                  `共用回油干线 [${pipe.connectionId}] ${flow(pipe.flowM3PerS)}，汇合点 ${p(pipe.upstreamPressurePa)}，油箱 ${p(pipe.downstreamPressurePa)}。流态 ${pipe.regime}，Re=${n(pipe.reynolds)}，沿程 ${p(pipe.frictionDropPa)}、局部 ${p(pipe.localDropPa)}、合计 ${p(pipe.pressureDropPa)}。`,
                ]
              : []),
          ],
          equations: [],
          rows: [
            ['本组已知条件', '实际供油与回油', '缸速与判定'],
            [
              [
                phase.estimatedSupplyM3PerS === undefined
                  ? ''
                  : '已知零压供流 ' + flow(phase.estimatedSupplyM3PerS) + '。',
                phase.target
                  ? `${phase.target.label} 保留目标 ${flow(phase.target.targetFlowM3PerS)}、${n(phase.target.targetSpeedMPerS * 1000)} mm/s。`
                  : '',
              ].join(''),
              phase.kind === 'solved'
                ? `泵出口 ${p(phase.pumpPa)}，轴功率 ${n(phase.shaftPowerW)} W。进缸 ${flow(phase.cylinderFlowM3PerS)}，缸排油 ${flow(phase.returnFlowM3PerS)}，直动溢流 ${flow(phase.reliefFlowM3PerS)}，泄漏 ${flow(phase.leakageM3PerS)}。`
                : '实际压力、流量、缸速和轴功率待核。',
              phase.kind === 'solved'
                ? `阀 T 口 ${p(phase.pipe.upstreamPressurePa)}，缸回油腔 ${p(phase.chamberPa)}，缸速 ${n(phase.speedMPerS * 1000)} mm/s。${phase.reason}`
                : phase.reason,
            ],
          ],
        };
      });
    return dutyCoverageSections(group.coverage).map((section, index) => ({
      ...section,
      heading: index === 0 ? title : title + ' · ' + section.heading,
      paragraphs:
        index === 0
          ? [
              boundary,
              group.reason ??
                (group.coverage.complete ? '本组已核算所列目标工况。' : '本组有未完成的工况，已核算结果仍可查看。'),
              ...section.paragraphs,
            ]
          : section.paragraphs,
    }));
  });
}

export function dutyCombinedSections(coverage: CombinedDutyCoverage): readonly BookSection[] {
  const n = (value: number) => Number(value.toPrecision(6)).toString();
  const flow = (value: number) => n(value * 60000) + ' L/min';
  const p = (value: number) => n(value / 1e6) + ' MPa';
  const speed = (kind: 'cylinder' | 'motor', value: number) =>
    kind === 'cylinder' ? n(value * 1000) + ' mm/s' : n((value * 30) / Math.PI) + ' r/min';
  const unloadingStatus = (phase: CombinedDutyCoverage['phases'][number]) => {
    const large = phase.pumps.find((pump) => pump.kind === 'solved' && pump.unloading);
    const stage = large?.kind === 'solved' ? large.unloading : undefined;
    return stage
      ? [
          `${stage.label}${stage.open ? '开启' : '关闭'}，先导压差 ${p(stage.pilotDifferentialPa)}（动作 ${p(stage.tripDifferentialPa)}，复位 ${p(stage.resetDifferentialPa)}）。卸荷回箱 ${flow(stage.flowM3PerS)}。`,
        ]
      : [];
  };
  const pumpReturn = (pump: Extract<CombinedDutyCoverage['phases'][number]['pumps'][number], { kind: 'solved' }>) => {
    const losses = `本泵溢流 ${flow(pump.localReliefM3PerS)}，泄漏 ${flow(pump.leakageM3PerS)}。`;
    if (!coverage.hasUnloading) return losses;
    const total = (pump.unloading?.flowM3PerS ?? 0) + pump.localReliefM3PerS + pump.leakageM3PerS;
    const hasLoss = pump.localReliefM3PerS > 0 || pump.leakageM3PerS > 0;
    return '本泵总回箱 ' + flow(total) + '。' + (hasLoss ? losses : '');
  };
  const sections = coverage.phases.map((phase): BookSection => ({
    heading:
      phase.name +
      (coverage.hasUnloading ? ' · 高低压双泵卸荷' : phase.pumps.length === 2 ? ' · 双泵合流' : ' · 多泵合流'),
    paragraphs:
      phase.kind === 'solved'
        ? [
            `${phase.supplyPipe ? '母线出口压力' : '母线压力'} ${p(phase.busPa)}，母线溢流 ${flow(phase.busReliefM3PerS)}。`,
            ...(phase.supplyPipe
              ? [
                  `供油母线 [${phase.supplyPipe.connectionId}] 实际流量 ${flow(phase.supplyPipe.flowM3PerS)}，入口 ${p(phase.supplyPipe.upstreamPressurePa)}，出口 ${p(phase.busPa)}。流态 ${phase.supplyPipe.regime}，Re=${n(phase.supplyPipe.reynolds)}，沿程 ${p(phase.supplyPipe.frictionDropPa)}、局部 ${p(phase.supplyPipe.localDropPa)}、合计 ${p(phase.supplyPipe.pressureDropPa)}。`,
                ]
              : []),
            ...phase.loads.map(
              (load) =>
                `${load.label} 实际进油 ${flow(load.flowM3PerS)}、${speed(load.kind, load.speed)}。目标 ${flow(load.targetFlowM3PerS)}、${speed(load.kind, load.targetSpeed)}，${load.matchesTarget ? '达标' : '未达标'}。`,
            ),
            phase.matchesTarget ? '目标速度（±1%）与泵预算均满足。' : '目标速度或泵预算未满足或待核。',
            ...(phase.targetWindow.kind === 'incompatible'
              ? ['本工况各执行器的目标速度在当前阀口和负载下没有共同母线压力范围。']
              : []),
            ...unloadingStatus(phase),
          ]
        : [
            phase.reason,
            ...(coverage.hasUnloading ? ['卸荷阀稳态待核。'] : []),
            ...phase.targets.map(
              (target) =>
                target.label +
                ' 保留目标 ' +
                flow(target.targetFlowM3PerS) +
                '、' +
                speed(target.kind, target.targetSpeed) +
                '。',
            ),
          ],
    equations: [],
    rows: [
      ['泵', '入母线流量、状态与功率', '压力、分流与原因'],
      ...phase.pumps.map((pump) => [
        pump.label + ' [' + pump.pumpId + ']',
        pump.kind === 'solved'
          ? `${flow(pump.busFlowM3PerS)} · ${pump.valveLabel}${pump.open ? '开启' : '关闭'} · ${pump.shaftPowerW === undefined ? '轴功率待核' : '轴功率 ' + n(pump.shaftPowerW) + ' W'}`
          : '实际供流、止回阀状态和功率待核',
        pump.kind === 'solved'
          ? `泵出口 ${p(pump.outletPa)}。${pump.openingThresholdPa === undefined ? '' : '开启门槛 ' + p(pump.openingThresholdPa) + '。'}${pumpReturn(pump)}${pump.reason}`
          : (pump.estimatedSupplyM3PerS === undefined
              ? ''
              : '已知零压供流 ' + flow(pump.estimatedSupplyM3PerS) + '。') + pump.reason,
      ]),
    ],
  }));
  if (coverage.pendingPhases.length)
    sections.push({
      heading: '合流工况待核',
      paragraphs: [],
      equations: [],
      rows: [
        ['工况', '核算状态', '原因'],
        ...coverage.pendingPhases.map((phase) => [
          phase.name,
          phase.kind === 'excluded' ? '未纳入' : '条件未齐',
          phase.reason,
        ]),
      ],
    });
  return sections;
}

export function calculationBook(
  record: CalculationRecord,
  context: {
    snapshotId: string;
    capturedAt: string;
    fields: Readonly<Record<string, string>>;
    formulaFormat?: 'native' | 'latex';
  },
): Result<CalculationBook> {
  const r = new ContractReader();
  r.timestamp(context.capturedAt, '/capturedAt');
  const valid = r.finish(true);
  if (!valid.ok) return valid;
  const filled = drawingFields
    .filter(([key]) => key && context.fields[key])
    .map(([key, label]) => `${label}：${key ? context.fields[key] : ''}`);
  const sections: BookSection[] = filled.length
    ? [{ heading: '工程信息', paragraphs: filled, equations: [], rows: [] }]
    : [];
  if (record.dutyCoverage) sections.push(...dutyCoverageSections(record.dutyCoverage));
  if (record.dutyGroups) sections.push(...dutyGroupSections(record.dutyGroups));
  if (record.dutyCombined) sections.push(...dutyCombinedSections(record.dutyCombined));
  if (record.dutyConditions) {
    const transfer = record.dutyCoverage && includesAccumulatorTransfer(record.dutyCoverage);
    sections.push({
      heading: transfer ? '蓄能器充放油核算适用条件' : '稳态核算适用条件',
      paragraphs: record.dutyConditions,
      equations: [],
      rows: [],
    });
  }
  const readableLabel = (label: string) => {
    const [id, rest] = label.split(' · ');
    const component = record.document.design.components.find((c) => c.id === id);
    return component && rest ? `${component.label} ${rest}` : label;
  };
  const keepTreeStepsTogether =
    record.document.design.components.filter((component) => component.typeId === 'cylinder').length >= 4 &&
    record.dutyCoverage?.phases.some((phase) => phase.kind === 'calculated' && phase.demand.flowSplit);
  const hasBoundary = record.dutyCoverage?.phases.some(
    (phase) => phase.kind === 'calculated' && phase.demand.boundaryAssessment,
  );
  for (const [index, step] of record.steps.filter((s) => s.source !== 'kernel').entries()) {
    const content = stepBookMath(step);
    sections.push({
      heading: `${index + 1} ${readableLabel(step.label)}`,
      ...content,
      ...(hasBoundary ? { paragraphs: [step.formula, ...content.paragraphs], keepTogether: true } : {}),
      rows: [],
      ...(keepTreeStepsTogether ? { keepTogether: true } : {}),
    });
  }
  if (
    !record.dutyCombined &&
    !record.dutyGroups?.some((group) => group.sharedReturn) &&
    !record.steps.some((step) => step.source !== 'kernel')
  )
    sections.push({ heading: '计算结果', paragraphs: ['当前记录没有可展开的辅助计算。'], equations: [], rows: [] });
  const requirements = [
    ['forceN', '目标推力', 'N'],
    ['speedMPerS', '目标速度', 'm/s'],
    ['strokeM', '行程', 'm'],
    ['pressureBudgetPa', '压力预算', 'Pa'],
  ].flatMap(([reference, label, unit]) => {
    const input = record.steps[0]?.inputs.find((item) => item.reference === reference);
    return input && unit ? [`${label}${bookResult(input.value, unit)}`] : [];
  });
  return parseCalculationBook({
    version: 1,
    title: record.document.title + ' 计算书',
    introduction:
      record.kind === 'preliminary'
        ? record.title +
          '。' +
          (requirements.length ? '设计要求：' + requirements.join('，') + '。' : '') +
          (record.dutyCoverage && !record.dutyCoverage.complete
            ? '各工况的核算结果与未覆盖原因见下表。'
            : hasBoundary
              ? '按各工况的保存压力边界和指定储能状态核算。'
              : '按本次预览的效率、背压和管路损失条件进行初选，不代表已完成仿真。') +
          '公式代入采用国际单位，末项给出常用单位结果。'
        : '根据所选有效结果进行辅助计算。公式代入采用国际单位，末项给出常用单位结果。',
    source: `${record.title}；${record.kind === 'preliminary' ? '初选预览' : '有效快照'}；来源 ${context.snapshotId}；捕获 ${context.capturedAt}；${record.identity ? `运行 ${record.identity.simulationSessionId}，tick ${record.identity.tick}，t=${record.identity.timeS} s，控制 ${record.identity.controlSequence}` : `工程修订 ${record.context?.documentRevision ?? '未提供'}`}。`,
    sections,
    metadata: JSON.stringify({ context, record }),
    ...(context.formulaFormat === undefined ? {} : { formulaFormat: context.formulaFormat }),
  });
}
/** These are bounded source documents; binary encoding is owned by the desktop adapter. */
export interface FormalArtifact {
  readonly version: 1;
  readonly snapshotId: string;
  readonly format: 'pdf' | 'png' | 'jpg' | 'docx' | 'html' | 'hydcurve' | 'md';
  readonly suggestedName: string;
  readonly text: string;
}
export type NetworkArtifact = ExportArtifact | FormalArtifact;
export function parseNetworkArtifact(input: unknown): Result<NetworkArtifact> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['version', 'snapshotId', 'format', 'suggestedName', 'text']);
  if (
    o.format !== 'pdf' &&
    o.format !== 'png' &&
    o.format !== 'jpg' &&
    o.format !== 'docx' &&
    o.format !== 'html' &&
    o.format !== 'hydcurve' &&
    o.format !== 'md'
  )
    return parseExportArtifact(input);
  r.constant(o.version, 1, '/version');
  const snapshotId = r.text(o.snapshotId, '/snapshotId', 1, 80),
    suggestedName = r.text(o.suggestedName, '/suggestedName', 1, 100),
    text = r.text(o.text, '/text', 1, 4_000_000);
  if (
    !/^[\w-]+$/.test(snapshotId) ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(suggestedName) ||
    !suggestedName.endsWith('.' + o.format)
  )
    r.fail('FORMAL_ARTIFACT_INVALID', '/formal', '正式导出名称或来源身份无效。');
  if (utf8Bytes(text) > exportLimits.bytes) return fail('EXPORT_SIZE_LIMIT', '正式导出源超过4MB预算，未写文件。');
  const shape = r.finish(true);
  if (!shape.ok) return shape;
  if (o.format === 'md') {
    if (/[\u0000\uFFFE\uFFFF]/.test(text)) return fail('MARKDOWN_INVALID', 'Markdown不能含不可输出字符。');
  } else if (o.format === 'hydcurve') {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail('CURVE_FILE_INVALID', '曲线数据不是有效JSON。');
    }
    const file = parseCurveFile(raw);
    if (!file.ok) return file;
    if (file.value.snapshotId !== snapshotId) return fail('CURVE_FILE_INVALID', '曲线文件与导出身份不一致。');
  } else if (o.format === 'html') {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail('OFFLINE_CURVE_INVALID', '离线曲线源不是有效JSON，不接受HTML或脚本。');
    }
    const data = parseOfflineCurve(raw);
    if (!data.ok) return data;
    if (data.value.snapshotId !== snapshotId) return fail('OFFLINE_CURVE_INVALID', '离线曲线与导出来源身份不一致。');
  } else if (o.format === 'pdf' || o.format === 'png' || o.format === 'jpg') {
    if (o.format === 'pdf' && text.trimStart().startsWith('{')) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return fail('BOOK_INVALID', 'PDF计算书源不是有效JSON。');
      }
      const book = parseCalculationPdfSource(raw);
      if (!book.ok) return book;
    } else {
      const svg = parseExportArtifact({ version: 1, snapshotId, format: 'svg', suggestedName: '图纸.svg', text });
      if (!svg.ok) return svg;
      const size = /^<svg [^>]*width="(\d+)mm" height="(\d+)mm"/.exec(text);
      if (
        ![
          [210, 297],
          [297, 210],
          [297, 420],
          [420, 297],
          [420, 594],
          [594, 420],
        ].some(([w, h]) => w === Number(size?.[1]) && h === Number(size?.[2]))
      )
        return fail('DRAWING_PAGE_INVALID', '图纸源必须明确 A4/A3/A2 物理幅面。');
    }
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail('BOOK_INVALID', '计算书内容不是有效JSON。');
    }
    const book = parseCalculationBook(raw);
    if (!book.ok) return book;
  }
  return { ok: true, value: immutable({ version: 1, snapshotId, format: o.format, suggestedName, text }) };
}
