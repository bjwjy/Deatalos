import { diagnostic, networkValvePaths, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import {
  refinedTransient,
  samplePeak,
  type TransientModel,
  type Metrics,
  type MetricUnit,
} from './network-duty-transient-integration.js';
import type { DutyBoundaryDemand, DutyPhase, NetworkDutyRequest } from './network-duty.js';
import type { StepWriter } from './network-duty-supply-storage.js';

export interface TransientInput {
  windowS?: number;
  switchAtS?: number;
  rampS?: number;
  cutoffPa?: number;
  bandPa?: number;
  responseS?: number;
  finalAreaM2?: number;
}
export function transientConditions(project: NetworkProject) {
  const kind = transientKind(project);
  return [
    '限定单泵、单理想油箱与明确供油容积。使用工程油液体积模量、质量、阻尼、气压参考与保存初态；管路按等压节点，端位按非弹性停止。给定时间窗内每步跟踪压力和事件。',
    ...(kind === '单缸缓冲与换向'
      ? [
          '单缸换向采用 O 中位四通阀，阀芯由保存位置在给定时刻开始线性移至工况阀位，过零时关闭。缓冲按排油侧插入深度和最小孔口计算附加腔压。',
        ]
      : []),
    ...(kind === '双缸末端纠偏'
      ? [
          '同步试验由泵直供同步阀，两支各接同侧缸腔，另一腔回箱。按实际接线判定同步伸出或缩回，按压差及主通道流量启动末端纠偏。',
        ]
      : []),
    ...(kind === '变量泵动态恒压'
      ? [
          '变量泵仅核算给定截压、调节带和实测一阶排量时间常数的压力补偿回路。负载节流面积从保存开口线性变化至给定开口。稳定判据为最终平衡压差的 ±2%，至少保持三个排量时间常数或 5 ms。',
        ]
      : []),
    '积分从 200 μs 起逐档减半。相邻两档各峰值压力允差为 10 kPa 加细档值的 0.5%，时刻 0.25 ms，距离 0.05 mm、速度 0.5 mm/s、排量 0.001 cm³/rev 另加 0.5%。未收敛时保留输入和待核原因。峰压限集总回路，不含管内波传播、端部弹性碰撞和空化。',
  ];
}
export function transientKind(p: NetworkProject) {
  const cs = p.design.components;
  if (cs.filter((c) => c.typeId === 'pump').length !== 1 || cs.filter((c) => c.typeId === 'tank').length !== 1)
    return undefined;
  if (cs.some((c) => c.definition.id === 'teaching:variable-pump') && cs.some((c) => c.typeId === 'throttle'))
    return '变量泵动态恒压';
  if (cs.some((c) => c.typeId === 'synchronizing-flow-divider')) return '双缸末端纠偏';
  if (
    cs.some((c) => c.typeId === 'valve') &&
    cs.some((c) => ['cushioned-cylinder', 'cushioned-double-rod-cylinder', 'cylinder'].includes(c.typeId)) &&
    cs.filter((c) => ['cushioned-cylinder', 'cushioned-double-rod-cylinder', 'cylinder'].includes(c.typeId)).length ===
      1
  )
    return '单缸缓冲与换向';
  return undefined;
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/transient', message)],
});
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sqrt = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v));
const fmt = (v: number) => Number(v.toPrecision(6));
const put = (m: Metrics, key: string, label: string, unit: MetricUnit, value: number) =>
  m.set(key, { label, unit, value });
interface Ram {
  x: number;
  v: number;
  pa: number;
  pb: number;
  ac: number;
  ar: number;
  stroke: number;
  mass: number;
  damp: number;
  load: number;
  leak: number;
  va: number;
  vb: number;
  swept: boolean;
  lenA: number;
  lenB: number;
  kA: number;
  kB: number;
}
function ram(project: NetworkProject, c: NetworkComponent): Ram | undefined {
  const g = c.parameters.geometry,
    m = c.parameters.mechanics,
    s = c.parameters.storage,
    h = c.parameters.hydraulic,
    cu = c.parameters.cushion;
  const initial = project.design.initialConditions.find((i) => i.componentId === c.id);
  if (
    initial?.kind !== 'cylinder' ||
    !g ||
    !m ||
    !m.massKg ||
    m.loadDampingNsPerM === undefined ||
    m.externalForceN === undefined
  )
    return;
  const ac = g.capAreaM2 ?? g.equalAnnularAreaM2,
    ar = g.rodSideAreaM2 ?? g.equalAnnularAreaM2;
  const swept = c.typeId === 'cylinder',
    va = swept ? g.capDeadVolumeM3 : s?.portVolumeM3,
    vb = swept ? g.rodDeadVolumeM3 : s?.portVolumeM3;
  const pa = initial.capPressurePa ?? s?.initialPressurePa,
    pb = initial.rodPressurePa ?? s?.initialPressurePa;
  const v = initial.velocityMPerS;
  if (!ac || !ar || !g.strokeM || !va || !vb || pa === undefined || pb === undefined || v == null) return;
  const k = (area: number | undefined) =>
    cu && area && cu.flowCoefficient ? project.design.fluid.densityKgPerM3 / (2 * (area * cu.flowCoefficient) ** 2) : 0;
  return {
    x: initial.positionM,
    v,
    pa,
    pb,
    ac,
    ar,
    stroke: g.strokeM,
    mass: m.massKg,
    damp: m.loadDampingNsPerM + (m.pistonDampingNsPerM ?? 0),
    load: m.externalForceN,
    leak: h?.internalLeakageM3PerSPa ?? 0,
    va,
    vb,
    swept,
    lenA: cu?.retractCushionLengthM ?? 0,
    lenB: cu?.extendCushionLengthM ?? 0,
    kA: k(cu?.retractCushionAreaM2),
    kB: k(cu?.extendCushionAreaM2),
  };
}
function working(r: Ram, x: number, v: number, pa: number, pb: number) {
  const drop = (len: number, distance: number, k: number, q: number) =>
    len > 0 ? k * (q * clamp(1 - distance / len, 0, 1)) ** 2 : 0;
  return [
    pa + (v < 0 ? drop(r.lenA, x, r.kA, r.ac * v) : 0),
    pb + (v > 0 ? drop(r.lenB, r.stroke - x, r.kB, r.ar * v) : 0),
  ] as const;
}
function stop(y: number[], i: number, r: Ram) {
  if (y[i]! <= 0) {
    y[i] = 0;
    y[i + 1] = Math.max(0, y[i + 1]!);
  }
  if (y[i]! >= r.stroke) {
    y[i] = r.stroke;
    y[i + 1] = Math.min(0, y[i + 1]!);
  }
}
function motion(r: Ram, x: number, v: number, pa: number, pb: number) {
  const a = (r.ac * pa - r.ar * pb - r.load - r.damp * v) / r.mass;
  return v === 0 && ((x <= 0 && a < 0) || (x >= r.stroke && a > 0)) ? 0 : a;
}
export function transientPoint(
  project: NetworkProject,
  req: NetworkDutyRequest,
  phase: DutyPhase,
  add: StepWriter,
): Result<DutyBoundaryDemand> {
  const config = phase.transient,
    kind = transientKind(project);
  const output = (summary: string, pending: boolean, satisfied = !pending): Result<DutyBoundaryDemand> => ({
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: {
        summary,
        satisfied,
        transientStudy: true,
        ...(pending ? { loadPending: true as const } : {}),
      },
    },
  });
  if (
    !config ||
    !kind ||
    phase.actions.length ||
    req.boundary ||
    phase.flowSplit ||
    phase.dividerEnd ||
    phase.filterBypass ||
    phase.cycleThermal ||
    phase.minimumInletPa !== undefined ||
    phase.accumulatorTargetOilVolumeM3 !== undefined ||
    phase.shutoffs?.length ||
    phase.loadStudy ||
    phase.pumpCommandPercent !== undefined ||
    phase.pumpPressureControl ||
    phase.loadSenseMarginPa !== undefined ||
    phase.pumpStorage ||
    phase.resetStudy ||
    phase.switchPrevious ||
    phase.accumulatorOilVolumeM3 !== undefined ||
    req.totalEfficiency > req.pumpVolumetricEfficiency
  )
    return fail('瞬态试验须单独核算，采用工程初态、阀时序及物理参数。');
  const parts = project.design.components,
    find = (type: string) => parts.find((c) => c.typeId === type);
  const pump = find('pump'),
    tank = find('tank'),
    volume = find('volume'),
    relief = find('relief'),
    valve = find('valve'),
    divider = find('synchronizing-flow-divider'),
    meter = find('throttle');
  const cylinders = parts.filter((c) =>
    ['cylinder', 'cushioned-cylinder', 'cushioned-double-rod-cylinder'].includes(c.typeId),
  );
  const variable = kind === '变量泵动态恒压',
    sync = kind === '双缸末端纠偏',
    single = !variable && !sync;
  const allowed = [
    pump,
    tank,
    relief,
    volume,
    ...(variable ? [meter] : sync ? [divider, ...cylinders] : [valve, ...cylinders]),
  ];
  if (
    !pump ||
    req.pumpId !== pump.id ||
    pump.definition.id !== (variable ? 'teaching:variable-pump' : 'teaching:pump') ||
    !tank ||
    parts.length !== allowed.filter(Boolean).length ||
    cylinders.length !== (variable ? 0 : sync ? 2 : 1) ||
    project.design.connections.some((c) => c.kind !== 'ideal')
  )
    return fail('需单泵、单油箱和指定试验接法；信号控制、附加元件与有损管混接待核。');
  const paths = dutyPhasePaths(project, phase, false);
  if (!paths.ok) return paths;
  const net = paths.value.idealReachable,
    P = pump.id + ':P',
    T = tank.id + ':T';
  if (
    !net(T, pump.id + ':S') ||
    net(T, P) ||
    (volume && !net(volume.id + ':H', P)) ||
    (relief && (!net(relief.id + ':P', P) || !net(relief.id + ':T', T)))
  )
    return fail('须核对吸油、主供油容积与直回箱溢流支路接线。');
  const t = tank.parameters.hydraulic?.pressurePa,
    ph = pump.parameters.hydraulic,
    ps = pump.parameters.storage;
  const iv = project.design.initialConditions.find((i) => i.componentId === volume?.id);
  const vp = (volume?.parameters.hydraulic?.volumeM3 ?? 0) + (ps?.portVolumeM3 ?? 0),
    pumpInitial = ps?.deliveryInitialPressurePa ?? ps?.initialPressurePa;
  const startP = iv?.kind === 'volume' ? iv.pressurePa : pumpInitial;
  if (
    t === undefined ||
    !vp ||
    startP == null ||
    (volume && iv?.kind !== 'volume') ||
    (pumpInitial !== undefined && Math.abs(startP - pumpInitial) > 1) ||
    !ph?.displacementM3PerRev ||
    ph.leakageM3PerSPa === undefined
  )
    return fail('供油稳压容积、相容的供油初压、泵排量、泄漏或油箱压力待核。');
  const density = project.design.fluid.densityKgPerM3,
    beta = project.design.fluid.bulkModulusPa,
    omega = (req.angularSpeedRadPerS / (2 * Math.PI)) * req.pumpVolumetricEfficiency;
  if (!beta) return output('缺少油液体积模量，受压容积与峰压待核。', true);
  const rhoK = Math.sqrt(2 / density),
    leak = ph.leakageM3PerSPa,
    D = ph.displacementM3PerRev;
  const pr = pump.parameters.relief,
    rr = relief?.parameters.hydraulic;
  const loss = (dp: number, set = 0, area = 0, cq = 0) => cq * area * rhoK * Math.sqrt(Math.max(0, dp - set));
  const supply = (p: number, d: number) =>
    omega * d -
    leak * (p - t) -
    (pr?.enabled ? loss(p - t, pr.settingDifferentialPa, pr.maximumAreaM2, pr.flowCoefficient) : 0) -
    (rr ? loss(p - t, rr.settingDifferentialPa, rr.maximumAreaM2, rr.flowCoefficient) : 0);
  const ref = project.design.pressureReference;
  if (ref.kind !== 'gauge' || ref.absoluteReferencePa === null)
    return output('缺少已知绝压参考的表压基准，缸力和低压边界待核。', true);
  const offset = ref.absoluteReferencePa;
  let domainIssue = '轨迹含非有限数值，峰压待核。';
  const validP = (p: number) => {
    if (Number.isFinite(p) && p + offset >= 0 && p <= 70e6) return true;
    domainIssue = !Number.isFinite(p)
      ? '压力数值无效，峰压待核。'
      : p + offset < 0
        ? '计算轨迹低于零绝压，当前模型不能求空化后的峰压。'
        : '计算轨迹超过本模型 70 MPa 上限，峰压待核。';
    return false;
  };
  const { windowS: end, switchAtS: at, rampS } = config;
  add('initial-pressure', '泵口初始压力', '保存初态', startP, 'Pa', 1e-6, 'MPa');
  add('compliance-volume', '供油受压容积', '泵口与相连集中容腔', vp, 'm³', 1000, 'L');
  if (end === undefined) return output('缺少观测时长，峰值与事件待核。', true);
  if (!sync && (at === undefined || rampS === undefined))
    return output('缺少切换起点或线性过渡时长，启动与换向时序待核。', true);
  if (
    (sync && (at !== undefined || rampS !== undefined)) ||
    (!variable && [config.responseS, config.bandPa, config.cutoffPa, config.finalAreaM2].some((x) => x !== undefined))
  )
    return fail('本工况含与接法不符的时序或压力调节参数。');
  add('duration', '工况观测时长', '从保存初态起算', end, 's');
  if (at !== undefined) add('switch-time', '切换开始时刻', '阀或负载', at, 's');
  if (rampS !== undefined) add('ramp', '线性过渡时长', '从初态到给定终态', rampS, 's');
  const start = at ?? 0,
    ramp = rampS ?? 0;
  if (!sync && (start >= end || start + ramp > end)) return output('切换过程超出观测窗口，调整时序后复核。', true);
  const corners = [...new Set([start, start + ramp, end])].filter((x) => x > 0).sort((a, b) => a - b);
  const fraction = (time: number) => (time < start ? 0 : ramp === 0 ? 1 : clamp((time - start) / ramp, 0, 1));
  const init = (c: NetworkComponent) => project.design.initialConditions.find((i) => i.componentId === c.id);
  const distinct = (ports: string[]) => ports.every((p, i) => ports.slice(i + 1).every((q) => !net(p, q)));
  let create: () => TransientModel;
  if (variable && meter) {
    if (phase.valves.length || !net(P, meter.id + ':A') || !net(T, meter.id + ':B'))
      return fail('动态恒压试验需变量泵 P 经单节流口回同箱。');
    const opening = init(meter),
      mh = meter.parameters.hydraulic,
      lo = ph.minimumDisplacementM3PerRev,
      hi = ph.maximumDisplacementM3PerRev;
    const { cutoffPa: cut, bandPa: band, responseS: tau, finalAreaM2: target } = config;
    if (!cut || !band || !tau || target === undefined)
      return output(
        '动态恒压待核，缺少' +
          [
            !cut ? '截压压差' : '',
            !band ? '调节带' : '',
            !tau ? '排量响应时间常数' : '',
            target === undefined ? '最终节流开口' : '',
          ]
            .filter(Boolean)
            .join('、') +
          '。',
        true,
      );
    if (
      opening?.kind !== 'throttle' ||
      !mh?.maximumAreaM2 ||
      !mh.flowCoefficient ||
      lo === undefined ||
      !hi ||
      band > cut ||
      target > mh.maximumAreaM2 ||
      D < lo ||
      D > hi
    )
      return fail('核对节流面积、初始排量、调节范围与截压带。');
    const initialArea = opening.openingAreaM2,
      cq = mh.flowCoefficient * rhoK;
    const command = (p: number) => lo + (hi - lo) * clamp((cut - (p - t)) / band, 0, 1);
    const balance = (p: number) => supply(p, command(p)) - cq * target * sqrt(p - t);
    if (balance(t) <= 0 || balance(70e6) >= 0) return output('最终开口缺少唯一的可达稳态压力，恒压恢复待核。', true);
    let low = t,
      high = 70e6;
    for (let j = 0; j < 62; j++) {
      const mid = (low + high) / 2;
      if (balance(mid) > 0) low = mid;
      else high = mid;
    }
    const final = (low + high) / 2,
      tol = 0.02 * (final - t);
    add('pressure-equilibrium', '最终负载平衡压力', '泵调节曲线与最终节流口流量交点', final, 'Pa', 1e-6, 'MPa');
    add('tau', '排量执行机构时间常数', '给定一阶响应', tau, 's');
    add('cutoff', '截压压差', '相对油箱', cut, 'Pa', 1e-6, 'MPa');
    add('band', '调节带宽', '压力补偿曲线', band, 'Pa', 1e-6, 'MPa');
    add('target-area', '最终节流面积', '负载变化终点', target, 'm²', 1e6, 'mm²');
    create = () => {
      let insideSince: number | undefined;
      return {
        initial: [startP, D],
        corners,
        valid: (y) => validP(y[0]!) && Number.isFinite(y[1]),
        project: () => {},
        rate: (time, y) => {
          const p = y[0]!,
            d = y[1]!,
            area = initialArea + (target - initialArea) * fraction(time);
          return [(beta / vp) * (supply(p, d) - cq * area * sqrt(p - t)), (command(p) - d) / tau];
        },
        observe: (time, y, m) => {
          const p = y[0]!;
          if (time >= start) samplePeak(m, 'peak', '负载变化后泵口峰压', time, p);
          if (time >= start + ramp) {
            insideSince = Math.abs(p - final) <= tol ? (insideSince ?? time) : undefined;
          }
          put(m, 'p-final', '窗口末泵口压力', 'Pa', p);
          put(m, 'd-final', '窗口末排量', 'm³/rev', y[1]!);
        },
        finish: (m) => {
          put(m, 'overshoot', '高于最终平衡压力的幅值', 'Pa', Math.max(0, m.get('peak')!.value - final));
          if (insideSince !== undefined && end - insideSince >= Math.max(0.005, 3 * tau)) {
            put(m, 'settled', '进入并保持稳压带的边界时刻', 's', insideSince);
            return [];
          }
          return ['观测窗口内未证实在稳压带内保持足够时长'];
        },
      };
    };
  } else {
    const rams = cylinders.map((c) => ram(project, c));
    if (rams.some((r) => !r)) return output('缺少缸位置、速度、两腔初压、受压容积或机械参数。', true);
    if (!rams[0]) return fail('缺少油缸。');
    for (const [i, r] of rams.entries()) {
      if (!r) continue;
      const id = cylinders[i]!.id;
      add('x-init-' + i, id + ' 初始位置', '工程初态', r.x, 'm', 1000, 'mm');
      add('v-init-' + i, id + ' 初始速度', '工程初态', r.v, 'm/s', 1000, 'mm/s');
      add('pa-init-' + i, id + ' A 腔初压', '工程初态', r.pa, 'Pa', 1e-6, 'MPa');
      add('pb-init-' + i, id + ' B 腔初压', '工程初态', r.pb, 'Pa', 1e-6, 'MPa');
      add('load-' + i, id + ' 外载', '伸出阻力为正', r.load, 'N');
    }
    if (single && valve) {
      const c = cylinders[0]!,
        r = rams[0],
        vh = valve.parameters.hydraulic,
        spool = valve.parameters.spool,
        initial = init(valve),
        target = phase.valves[0];
      if (
        phase.valves.length !== 1 ||
        target?.componentId !== valve.id ||
        initial?.kind !== 'valve' ||
        !vh?.maximumAreaM2 ||
        !vh.flowCoefficient ||
        !net(P, valve.id + ':P') ||
        !net(T, valve.id + ':T') ||
        !net(c.id + ':A', valve.id + ':A') ||
        !net(c.id + ':B', valve.id + ':B') ||
        !distinct([P, T, c.id + ':A', c.id + ':B'])
      )
        return fail('单缸须按 P/T/A/B 对应连接同一四通阀，给定初始阀位与目标阀位。');
      const pairs = (k: 'extend' | 'retract' | 'neutral') =>
        networkValvePaths(valve, k)
          .map((a) => a.join('-'))
          .sort()
          .join(',');
      if (
        valve.definition.id !== 'teaching:directional-3-4' ||
        pairs('extend') !== 'B-T,P-A' ||
        pairs('retract') !== 'A-T,P-B' ||
        pairs('neutral') !== '' ||
        spool?.overlapM !== 0 ||
        !spool.maximumTravelM ||
        !spool.commandTravelM
      )
        return fail('限正反向标准通路、O 中位及零遮盖的已知阀口。');
      const cmd = (v: string) => (v === 'extend' ? 1 : v === 'retract' ? -1 : 0);
      const u0 = cmd(initial.positionId),
        u1 = cmd(target.positionId),
        coef = vh.maximumAreaM2 * vh.flowCoefficient * rhoK * clamp(spool.commandTravelM / spool.maximumTravelM, 0, 1);
      add('spool-target', '阀芯目标归一位置', initial.positionId + ' → ' + target.positionId, u1, '1');
      if (!u1) return fail('本批单缸试验目标阀位须为伸出或缩回。');
      const cushion = u1 > 0 ? r.lenB : r.lenA,
        entry = u1 > 0 ? r.stroke - cushion : cushion,
        limit = u1 > 0 ? r.stroke : 0;
      create = () => {
        let entered = false,
          arrived = false,
          rev = false,
          lastX = r.x,
          lastV = r.v,
          lastT = 0;
        return {
          initial: [startP, r.x, r.v, r.pa, r.pb],
          corners,
          project: (y) => stop(y, 1, r),
          valid: (y) =>
            y.every(Number.isFinite) &&
            validP(y[0]!) &&
            validP(y[3]!) &&
            validP(y[4]!) &&
            working(r, y[1]!, y[2]!, y[3]!, y[4]!).every(validP),
          rate: (time, y) => {
            const [p = 0, x = 0, v = 0, pa = 0, pb = 0] = y,
              u = u0 + (u1 - u0) * fraction(time);
            const drive = u >= 0 ? pa : pb,
              back = u >= 0 ? pb : pa,
              feed = coef * Math.abs(u) * sqrt(p - drive),
              drain = coef * Math.abs(u) * sqrt(back - t);
            const qa = u >= 0 ? feed : -drain,
              qb = u >= 0 ? -drain : feed,
              leakage = r.leak * (pa - pb),
              [wa, wb] = working(r, x, v, pa, pb);
            return [
              (beta / vp) * (supply(p, D) - feed),
              v,
              motion(r, x, v, wa, wb),
              (beta / (r.va + (r.swept ? r.ac * x : 0))) * (qa - r.ac * v - leakage),
              (beta / (r.vb + (r.swept ? r.ar * (r.stroke - x) : 0))) * (qb + r.ar * v + leakage),
            ];
          },
          observe: (time, y, m) => {
            const [p = 0, x = 0, v = 0, pa = 0, pb = 0] = y,
              [wa, wb] = working(r, x, v, pa, pb);
            if (time <= start && start > 0) samplePeak(m, 'startup', '切换前泵口启动峰压', time, p);
            if (time >= start && !(cushion > 0 && arrived)) {
              samplePeak(m, 'peak', cushion > 0 ? '行程内泵口峰压' : '切换后泵口峰压', time, p);
              samplePeak(m, 'peak-a', 'A 腔峰压', time, wa);
              samplePeak(m, 'peak-b', 'B 腔峰压', time, wb);
              if (u0 * u1 < 0 && !rev && u1 * lastV < 0 && u1 * v >= 0) {
                rev = true;
                put(
                  m,
                  'reverse',
                  '运动反向时刻',
                  's',
                  lastT + ((time - lastT) * Math.abs(lastV)) / (Math.abs(lastV) + Math.abs(v)),
                );
              }
              if (
                cushion > 0 &&
                !entered &&
                u1 * (lastX - entry) <= 0 &&
                u1 * (x - entry) >= 0 &&
                u1 * (x - lastX) > 0
              ) {
                const f = (entry - lastX) / (x - lastX);
                entered = true;
                put(m, 'entry', '进入缓冲区时刻', 's', lastT + f * (time - lastT));
                put(m, 'entry-speed', '入缓冲速度幅值', 'm/s', Math.abs(lastV + f * (v - lastV)));
              }
              if (cushion > 0 && u1 * (x - entry) >= 0)
                samplePeak(m, 'cushion-peak', '缓冲区排油腔峰压', time, u1 > 0 ? wb : wa);
              if (!arrived && x === limit && lastX !== limit) {
                arrived = true;
                put(m, 'end', '到达端位时刻', 's', time);
                if (entered) put(m, 'cushion-duration', '缓冲区内运行时长', 's', time - m.get('entry')!.value);
                if (entered) put(m, 'distance', '入缓冲至停止距离', 'm', Math.abs(limit - entry));
              }
            }
            lastX = x;
            lastV = v;
            lastT = time;
          },
          finish: () => [
            ...(cushion > 0 && !entered ? ['窗口内未观测到完整入缓冲事件'] : []),
            ...(cushion > 0 && !arrived ? ['窗口内未到端位，停止距离待核'] : []),
            ...(u0 * u1 < 0 && !rev ? ['窗口内未观测到速度反向'] : []),
          ],
        };
      };
    } else if (sync && divider) {
      if (cylinders.some((c) => c.typeId !== 'cylinder')) return fail('末端纠偏试验需两只普通双作用缸。');
      if (phase.valves.length) return fail('同步直供试验不含换向阀指令。');
      const dh = divider.parameters.hydraulic;
      const retract = cylinders.some((c) => net(c.id + ':B', divider.id + ':A'));
      const pressureSide = retract ? ':B' : ':A',
        returnSide = retract ? ':A' : ':B';
      const a = cylinders.find((c) => net(c.id + pressureSide, divider.id + ':A')),
        b = cylinders.find((c) => net(c.id + pressureSide, divider.id + ':B'));
      if (
        !a ||
        !b ||
        a === b ||
        !net(P, divider.id + ':P') ||
        !net(T, a.id + returnSide) ||
        !net(T, b.id + returnSide) ||
        !distinct([P, T, a.id + pressureSide, b.id + pressureSide]) ||
        !dh?.branchAFlowFraction ||
        !dh.maximumAreaM2 ||
        !dh.flowCoefficient ||
        !dh.correctionAreaM2 ||
        !dh.correctionGateM3PerS ||
        !dh.correctionDifferentialPa
      )
        return fail('同步阀 P 接泵，A/B 各接单缸同侧驱动腔，两排油腔独立直回同箱，须明确主开口及纠偏参数。');
      // Use travel measured towards the commanded end. Transform conjugate force, velocity and both chamber volumes together.
      const orient = (r: Ram): Ram =>
        retract
          ? {
              ...r,
              x: r.stroke - r.x,
              v: -r.v,
              ac: r.ar,
              ar: r.ac,
              pa: r.pb,
              pb: r.pa,
              va: r.vb,
              vb: r.va,
              load: -r.load,
            }
          : r;
      const ra = orient(rams[cylinders.indexOf(a)]!),
        rb = orient(rams[cylinders.indexOf(b)]!);
      add('sync-direction', '同步动作方向', retract ? '两杆腔供油、缩回' : '两无杆腔供油、伸出', retract ? -1 : 1, '1');
      if (ra.pb !== t || rb.pb !== t) return fail('排油腔直接接油箱时，其初始压力须与油箱一致。');
      const share = dh.branchAFlowFraction,
        coef = rhoK * dh.flowCoefficient,
        max = dh.maximumAreaM2,
        trim = dh.correctionAreaM2,
        gate = dh.correctionGateM3PerS,
        diff = dh.correctionDifferentialPa;
      const flows = (p: number, pa: number, pb: number) => {
        const ha = p - pa,
          hb = p - pb;
        const total =
          ha * hb > 0
            ? Math.sign(ha) *
              Math.min(
                (max * coef * Math.sqrt(Math.abs(ha))) / share,
                (max * coef * Math.sqrt(Math.abs(hb))) / (1 - share),
              )
            : 0;
        const left = Math.abs(ha) >= Math.abs(hb),
          head = left ? ha : hb,
          other = left ? hb : ha;
        const weight =
          Math.abs(total) < gate && Math.sign(head) * other >= -diff
            ? (1 - Math.abs(total) / gate) * clamp((Math.abs(head - other) - diff) / diff, 0, 1)
            : 0;
        const extra = weight * trim * coef * sqrt(head);
        return [
          (1 - weight) * share * total + (left ? extra : 0),
          (1 - weight) * (1 - share) * total + (left ? 0 : extra),
          extra,
        ] as const;
      };
      create = () => {
        let endA = false,
          endB = false,
          both = false,
          corrected = false;
        return {
          initial: [startP, ra.x, ra.v, ra.pa, rb.x, rb.v, rb.pa],
          corners,
          project: (y) => {
            stop(y, 1, ra);
            stop(y, 4, rb);
          },
          valid: (y) => y.every(Number.isFinite) && [y[0]!, y[3]!, y[6]!].every(validP),
          rate: (_time, y) => {
            const [p = 0, xa = 0, va = 0, pa = 0, xb = 0, vb = 0, pb = 0] = y,
              [qa, qb] = flows(p, pa, pb);
            const deriv = (r: Ram, x: number, v: number, pc: number, q: number) => {
              const [wA, wB] = working(r, x, v, pc, t);
              return [
                v,
                motion(r, x, v, wA, wB),
                (beta / (r.va + (r.swept ? r.ac * x : 0))) * (q - r.ac * v - r.leak * (pc - t)),
              ];
            };
            return [(beta / vp) * (supply(p, D) - qa - qb), ...deriv(ra, xa, va, pa, qa), ...deriv(rb, xb, vb, pb, qb)];
          },
          observe: (time, y, m) => {
            const [p = 0, x = 0, , pa = 0, z = 0, , pb = 0] = y;
            if (!both) samplePeak(m, 'peak', '到位过程供油峰压', time, p);
            if (!endA && x === ra.stroke) {
              endA = true;
              put(m, 'end-a', 'A 支缸 [' + a.id + '] 首次到位', 's', time);
            }
            if (!endB && z === rb.stroke) {
              endB = true;
              put(m, 'end-b', 'B 支缸 [' + b.id + '] 首次到位', 's', time);
            }
            if (!both && x === ra.stroke && z === rb.stroke) {
              both = true;
              put(m, 'both', '双缸同时到位时刻', 's', time);
            }
            if (
              !both &&
              !corrected &&
              flows(p, pa, pb)[2] > 1e-12 &&
              ((x === ra.stroke && z < rb.stroke && pb < pa) || (z === rb.stroke && x < ra.stroke && pa < pb))
            ) {
              corrected = true;
              put(m, 'correction', '向滞后缸纠偏起始时刻', 's', time);
            }
            put(m, 'remaining-a', 'A 缸末态剩余行程', 'm', ra.stroke - x);
            put(m, 'remaining-b', 'B 缸末态剩余行程', 'm', rb.stroke - z);
          },
          finish: (m) => {
            if (both && corrected)
              put(
                m,
                'correction-duration',
                '纠偏通流至双缸到位时长',
                's',
                m.get('both')!.value - m.get('correction')!.value,
              );
            return [
              ...(!both ? ['窗口内未观测到两缸全部到位'] : []),
              ...(!both && !corrected ? ['未观测到向滞后缸纠偏'] : []),
            ];
          },
        };
      };
    } else return fail('回路接法与瞬态试验不符。');
  }
  const checked = refinedTransient(create);
  if (!checked.ok) return output(checked.domainError ? domainIssue : checked.reason, true);
  add('coarse-step', '收敛对照粗步长', '相邻两档独立重放', checked.coarse, 's', 1e6, 'μs');
  add('fine-step', '收敛对照细步长', '关键结果均通过容差', checked.fine, 's', 1e6, 'μs');
  const scale: Record<MetricUnit, [number, string]> = {
    Pa: [1e-6, 'MPa'],
    s: [1, 's'],
    m: [1000, 'mm'],
    'm/s': [1000, 'mm/s'],
    'rad/s': [1, 'rad/s'],
    'm³/rev': [1e6, 'cm³/rev'],
  };
  const { values, pending } = checked.run;
  for (const [key, x] of values) {
    const [k, unit] = scale[x.unit];
    add(key, x.label, '细步长瞬态轨迹', x.value, x.unit, k, unit);
  }
  const peak = values.get('peak')!,
    peakTime = values.get('peak-time')!,
    maxPump = Math.max(peak.value, values.get('startup')?.value ?? 0);
  const events = Array.from(values)
    .filter(([key]) =>
      [
        'entry-speed',
        'distance',
        'cushion-peak',
        'reverse',
        'both',
        'correction',
        'correction-duration',
        'settled',
        'overshoot',
      ].includes(key),
    )
    .map(([, x]) => x.label + ' ' + fmt(x.value * scale[x.unit][0]) + ' ' + scale[x.unit][1]);
  return output(
    kind +
      '：' +
      peak.label +
      ' ' +
      fmt(peak.value / 1e6) +
      ' MPa（' +
      fmt(peakTime.value) +
      ' s）' +
      (peakTime.value === end ? '，最大值位于观测窗口末端。' : '。') +
      (events.length ? events.join('；') + '。' : '') +
      (sync && values.has('both') && !values.has('correction') ? '两缸已到位，过程中未触发末端纠偏。' : '') +
      (maxPump > req.pressureLimitPa ? '泵口峰压超过给定预算。' : '') +
      pending.join('；'),
    pending.length > 0,
    !pending.length && maxPump <= req.pressureLimitPa,
  );
}
