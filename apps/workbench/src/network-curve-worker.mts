import {
  parseCurveCapture,
  planNetworkCurve,
  exportCurveSegment,
  fullCurveFromPlan,
  prepareCurveFile,
  curveFileText,
  parseCurveFigureSettings,
  type ExportArtifact,
  type NetworkExportCapture,
  type CurvePlan,
} from '@hyd/application';
import { ContractReader } from '@hyd/domain';
import { drawSidebarSeries } from './network-sidebar-series.mjs';
import { exportCurveSvg } from './network-curve-svg.mjs';
function collectCsv(capture: NetworkExportCapture, plan: CurvePlan, csv: ExportArtifact[]) {
  for (let i = 0; i < plan.segments.length; i++) {
    const part = exportCurveSegment(capture, plan, i);
    if (!part.ok) return part.diagnostics.map((d) => d.code + ': ' + d.message).join('；');
    csv.push(part.value);
  }
  return '';
}
function prepare(input: unknown) {
  if (input && typeof input === 'object' && 'mode' in input && input.mode === 'sidebar')
    return drawSidebarSeries(input);
  const r = new ContractReader(),
    o = r.object(input, '', ['capture', 'request', 'figure', 'mode', 'comparison', 'viewport']);
  const capture = parseCurveCapture(o.capture);
  if (!capture.ok)
    return { status: 'error', message: capture.diagnostics.map((d) => d.code + ': ' + d.message).join('；') };
  const figure = parseCurveFigureSettings(o.figure);
  if (!figure.ok) return { status: 'error', message: figure.diagnostics.map((d) => d.message).join('；') };
  const planned = planNetworkCurve(capture.value, o.request);
  if (!planned.ok)
    return { status: 'error', message: planned.diagnostics.map((d) => d.code + ': ' + d.message).join('；') };
  const plan = planned.value;
  if (o.mode === 'csv') {
    const csv: ExportArtifact[] = [];
    let problem = collectCsv(capture.value, plan, csv);
    if (problem) return { status: 'error', message: problem };
    if (o.comparison !== undefined) {
      const second = r.object(o.comparison, '/comparison', ['capture', 'request']);
      const source = parseCurveCapture(second.capture);
      if (!source.ok) return { status: 'error', message: source.diagnostics.map((d) => d.message).join('；') };
      const candidate = planNetworkCurve(source.value, second.request);
      if (!candidate.ok)
        return { status: 'error', message: candidate.diagnostics.map((d) => d.code + ': ' + d.message).join('；') };
      problem = collectCsv(source.value, candidate.value, csv);
      if (problem) return { status: 'error', message: problem };
    }
    if (csv.reduce((bytes, item) => bytes + new TextEncoder().encode(item.text).byteLength, 0) > 32_000_000)
      return { status: 'error', message: 'CSV 总量超过32MB，请缩小时间范围。' };
    return { status: 'csv', csv };
  }
  if (o.mode === 'data') {
    const set = prepareCurveFile(capture.value, plan.request, figure.value);
    if (!set.ok) return { status: 'error', message: set.diagnostics.map((d) => d.message).join('；') };
    const text = curveFileText(set.value);
    if (!text.ok) return { status: 'error', message: text.diagnostics.map((d) => d.message).join('；') };
    return {
      status: 'data',
      artifact: {
        version: 1,
        snapshotId: capture.value.snapshotId,
        format: 'hydcurve',
        suggestedName: '曲线数据.hydcurve',
        text: text.value,
      },
      summary: `${set.value.curves.length}条曲线，保存所选范围内已有的完整样本。`,
    };
  }
  if (o.mode !== 'preview') return { status: 'error', message: '未知曲线操作。' };
  const svg = exportCurveSvg(capture.value, plan, figure.value.paper, figure.value);
  if (!svg.ok) return { status: 'error', message: svg.diagnostics.map((d) => d.message).join('；') };
  const plot = fullCurveFromPlan(plan),
    csv: ExportArtifact[] = [];
  let bytes = new TextEncoder().encode(svg.value.text).byteLength;
  for (let i = 0; i < plan.segments.length; i++) {
    const part = exportCurveSegment(capture.value, plan, i);
    if (!part.ok) return { status: 'error', message: part.diagnostics.map((d) => d.message).join('；') };
    bytes += new TextEncoder().encode(part.value.text).byteLength;
    if (bytes > 32_000_000) return { status: 'error', message: '生成物超过32MB，请缩小范围或选单条曲线。' };
    csv.push(part.value);
  }
  return {
    status: 'ok',
    snapshotId: capture.value.snapshotId,
    svg: svg.value,
    csv,
    plot: plot.ok ? plot.value : null,
    indices: plan.indices,
    figure: figure.value,
    summary: `${plan.samples.length}个实际样本，出图/CSV保留${plan.indices.length}点；精简误差${Number((plan.maximumError * 100).toPrecision(4))}%量程。数据文件另存完整保留样本。`,
  };
}
self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    self.postMessage(prepare(event.data));
  } catch (cause: unknown) {
    self.postMessage({ status: 'error', message: '曲线整理失败：' + String(cause).slice(0, 200) });
  }
};
