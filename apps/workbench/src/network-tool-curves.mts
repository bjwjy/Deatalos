import {
  exportCurveSegment,
  parseNetworkArtifact,
  storedCurveCsv,
  type NetworkArtifact,
  type NetworkToolCurve,
  type NetworkToolRequest,
} from '@hyd/application';
import { diagnostic, type Result } from '@hyd/domain';
import { curveFigureSvg } from './network-curve-svg.mjs';
/** Reuse the workbench's exact curve rendering/CSV encoders with an application-owned frozen plan. */
export function toolCurveArtifact(
  curve: NetworkToolCurve,
  action: Extract<Extract<NetworkToolRequest, { method: 'file_prepare' }>['params']['action'], { kind: 'curve' }>,
): Result<NetworkArtifact> {
  if (curve.kind === 'imported') {
    const count = Math.max(1, Math.ceil(curve.samples.length / 2000));
    if (
      !Number.isSafeInteger(action.segment) ||
      action.segment < 0 ||
      action.segment >= count ||
      (action.format !== 'csv' && action.segment !== 0)
    )
      return { ok: false, diagnostics: [diagnostic('CURVE_SEGMENT_INVALID', '/curve', '导入曲线分段不存在。')] };
    if (action.format === 'csv') {
      const selected = {
        ...curve.curve,
        samples: curve.samples.slice(action.segment * 2000, (action.segment + 1) * 2000),
      };
      return storedCurveCsv(
        { ...curve.file, curves: [selected], explanations: [curve.file.explanations[curve.curveIndex] === true] },
        0,
      );
    }
    const originalTitle = [...curve.curve.state.title];
    const sourceLabel =
      curve.file.identityLevel === 'sample' ? '导入冻结结果 · 逐样本身份' : '导入冻结结果 · 旧格式，无逐样本身份';
    const artifact = curveFigureSvg(
      {
        samples: curve.samples,
        indices: curve.samples.map((sample) => sample.index),
        label: curve.curve.label,
        unit: curve.curve.unit,
        metadata: JSON.stringify({
          snapshotId: curve.file.snapshotId,
          sourceKind: 'imported-frozen-result',
          identityLevel: curve.file.identityLevel,
          originalTitle: curve.curve.state.title,
          originalMetadata: curve.curve.metadata,
        }),
        keys: curve.curve.state.keys,
      },
      {
        paper: curve.curve.state.paper,
        title:
          sourceLabel +
          (originalTitle.length
            ? ' · ' + originalTitle.slice(0, 100).join('') + (originalTitle.length > 100 ? '…' : '')
            : ''),
        showExplanation: curve.file.explanations[curve.curveIndex] === true,
      },
      curve.file.snapshotId,
    );
    return !artifact.ok || action.format === 'svg'
      ? artifact
      : parseNetworkArtifact({ ...artifact.value, format: 'pdf', suggestedName: '曲线图.pdf' });
  }
  if (action.format === 'csv') return exportCurveSegment(curve.capture, curve.plan, action.segment);
  const plan = curve.plan;
  const svg = curveFigureSvg(
    {
      samples: plan.samples,
      indices: plan.indices,
      label: plan.label,
      unit: plan.unit,
      metadata: plan.metadata,
      keys: plan.request.keys,
    },
    { paper: 'A4', title: plan.label, showExplanation: true },
    curve.capture.snapshotId,
  );
  if (!svg.ok || action.format === 'svg') return svg;
  return parseNetworkArtifact({ ...svg.value, format: 'pdf', suggestedName: '曲线图.pdf' });
}
