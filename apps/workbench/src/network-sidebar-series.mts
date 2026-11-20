import {
  legacyNetworkRecordCapacity,
  networkRecordMaximum,
  projectCurveSample,
  reduceCurveSamples,
  type CurveRequest,
  type CurveSample,
  type NetworkExportCapture,
} from '@hyd/application';
import { ContractReader, parseNetworkProject, type NetworkSnapshot } from '@hyd/domain';
import { displayNetworkQuantity, networkResultView } from '@hyd/engineering';
import { curveFigureSvg } from './network-curve-svg.mjs';

// Transfer only columns for the requested quantity. NaN encodes a missing numeric value
// inside the buffer; the corresponding reason is kept and the plot receives null.
const columns = 5;
export function createSidebarProjection() {
  let targetKey = '';
  let cache = new WeakMap<NetworkSnapshot, CurveSample>();
  return async function project(capture: NetworkExportCapture, target: CurveRequest['target'], current: () => boolean) {
    const key = JSON.stringify([
      capture.view.point.identity.documentSessionId,
      capture.view.point.identity.physicsRevision,
      capture.view.point.identity.simulationSessionId,
      target.objectKind,
      target.objectId,
      target.field,
    ]);
    if (key !== targetKey) {
      cache = new WeakMap();
      targetKey = key;
    }
    const samples = capture.samples;
    const data = new Float64Array(samples.length * columns);
    const reasons: string[] = [];
    const project = parseNetworkProject(capture.view.document);
    if (!project.ok) throw new Error(project.diagnostics[0]?.message);
    const quantity = capture.view.quantities.find(
      (q) => q.objectKind === target.objectKind && q.objectId === target.objectId && q.field === target.field,
    );
    if (!quantity) throw new Error('冻结记录中没有所选量值。');
    const unit = displayNetworkQuantity(quantity).unit;
    let deadline = performance.now() + 3;
    for (const [i, point] of samples.entries()) {
      if (performance.now() >= deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!current()) return null;
        deadline = performance.now() + 3;
      }
      let sample = cache.get(point);
      if (!sample) {
        const view = networkResultView(project.value, point, point.identity);
        if (!view.ok) throw new Error(view.diagnostics[0]?.message);
        sample = projectCurveSample(view.value, target, i);
        cache.set(point, sample);
      }
      const at = i * columns;
      data[at] = sample.timeS;
      data[at + 1] = sample.tick;
      data[at + 2] = point.identity.controlSequence;
      data[at + 3] = sample.si ?? NaN;
      data[at + 4] = sample.value ?? NaN;
      reasons.push(sample.reason);
    }
    return { data, reasons, unit };
  };
}

export function drawSidebarSeries(input: unknown) {
  const r = new ContractReader();
  const o = r.object(input, '', ['mode', 'data', 'reasons', 'unit', 'title', 'snapshotId', 'viewport']);
  const viewport = r.object(o.viewport, '/viewport', ['width', 'height']);
  const width = r.number(viewport.width, '/viewport/width', 120, 16384);
  const height = r.number(viewport.height, '/viewport/height', 100, 16384);
  const unit = r.text(o.unit, '/unit', 1, 80);
  const title = r.text(o.title, '/title', 0, 160);
  const snapshotId = r.text(o.snapshotId, '/snapshotId', 1, 80);
  const reasons = r.array(o.reasons, '/reasons', networkRecordMaximum);
  const data = o.data;
  if (
    r.diagnostics.length ||
    !(data instanceof Float64Array) ||
    !reasons.length ||
    data.length !== reasons.length * columns
  )
    throw new Error('曲线预览的样本或尺寸无效。');
  const samples: CurveSample[] = [];
  const mandatory: number[] = [];
  for (let i = 0; i < reasons.length; i++) {
    const at = i * columns;
    const timeS = data[at]!,
      tick = data[at + 1]!,
      control = data[at + 2]!,
      si = data[at + 3]!,
      value = data[at + 4]!;
    const reason = reasons[i];
    if (
      !Number.isFinite(timeS) ||
      timeS < 0 ||
      !Number.isSafeInteger(tick) ||
      tick < 0 ||
      !Number.isSafeInteger(control) ||
      control < 0 ||
      (!Number.isFinite(si) && !Number.isNaN(si)) ||
      (!Number.isFinite(value) && !Number.isNaN(value)) ||
      typeof reason !== 'string'
    )
      throw new Error('曲线预览样本无效。');
    if (i && control !== data[at - columns + 2]) mandatory.push(i - 1, i);
    samples.push({
      index: i,
      timeS,
      tick,
      value: Number.isNaN(value) ? null : value,
      si: Number.isNaN(si) ? null : si,
      reason,
    });
  }
  const reduced = reduceCurveSamples(
    samples.map((s) => s.timeS),
    [{ values: samples.map((s) => s.si), reasons: samples.map((s) => s.reason) }],
    mandatory,
    0.005,
    samples.length > legacyNetworkRecordCapacity ? samples.length : 300,
  );
  if (!reduced.ok) throw new Error(reduced.diagnostics.map((d) => d.message).join('；'));
  const svg = curveFigureSvg(
    { samples, indices: reduced.value.indices, label: title, unit, metadata: '', keys: [] },
    { paper: 'A4', title, showExplanation: false },
    snapshotId,
    { width, height, compact: true },
  );
  return svg.ok
    ? { status: 'sidebar', artifact: svg.value }
    : { status: 'error', message: svg.diagnostics.map((d) => d.message).join('；') };
}
