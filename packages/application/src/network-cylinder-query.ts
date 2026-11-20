import { ContractReader, diagnostic, type NetworkSnapshot, type Result } from '@hyd/domain';
import type { NetworkExportCapture } from './network-export.js';
export interface CylinderCondition {
  readonly componentId: string;
  readonly comparison: 'gte' | 'lte';
  readonly positionM: number;
}
export interface CylinderStop {
  readonly condition: CylinderCondition;
  readonly startTick: number;
  readonly targetTick: number;
  readonly tick: number;
  readonly positionM: number;
  readonly reason: 'running' | 'threshold' | 'tick-limit' | 'interrupted';
}
export function readCylinderCondition(r: ContractReader, input: unknown, field: string): CylinderCondition {
  const c = r.object(input, field, ['componentId', 'comparison', 'positionM']);
  if (c.comparison !== 'gte' && c.comparison !== 'lte') r.fail('CONDITION_INVALID', field, '比较方向须为 gte 或 lte。');
  return {
    componentId: r.id(c.componentId, field + '/componentId'),
    comparison: c.comparison === 'lte' ? 'lte' : 'gte',
    positionM: r.number(c.positionM, field + '/positionM', 0, 100),
  };
}
export function cylinderReading(point: NetworkSnapshot, id: string) {
  const state = point.states.find((s) => s.componentId === id);
  return state?.kind === 'cylinder' ? state : undefined;
}
export function compareCylinders(
  capture: NetworkExportCapture,
  ids?: readonly string[],
  fromTick = 0,
): Result<unknown> {
  const point = capture.view.point;
  const cylinders = point.states.filter((s) => s.kind === 'cylinder').map((s) => s.componentId);
  const selected = ids ?? cylinders;
  const [left, right] = selected;
  if (
    selected.length !== 2 ||
    !left ||
    !right ||
    left === right ||
    !cylinders.includes(left) ||
    !cylinders.includes(right)
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'CYLINDER_SELECTION_REQUIRED',
          '/cylinders',
          '请选择两个不同的液压缸。当前可选：' + cylinders.join('、'),
        ),
      ],
    };
  if (fromTick > point.identity.tick)
    return { ok: false, diagnostics: [diagnostic('RANGE_INVALID', '/fromTick', '起始步晚于当前结果。')] };
  // Multiple controls may have a result on the same tick. Use the latest accepted pair on that tick.
  const points = new Map<number, NetworkSnapshot>();
  for (const sample of [...capture.samples, point])
    if (sample.identity.tick >= fromTick) points.set(sample.identity.tick, sample);
  const pair = (sample: NetworkSnapshot) => {
    const a = cylinderReading(sample, left),
      b = cylinderReading(sample, right);
    return a && b
      ? {
          tick: sample.identity.tick,
          timeS: sample.identity.timeS,
          left: { positionM: a.positionM, velocityMPerS: a.velocityMPerS },
          right: { positionM: b.positionM, velocityMPerS: b.velocityMPerS },
          positionDifferenceM: a.positionM - b.positionM,
          velocityDifferenceMPerS: a.velocityMPerS - b.velocityMPerS,
        }
      : null;
  };
  const current = pair(point);
  if (!current)
    return { ok: false, diagnostics: [diagnostic('CYLINDER_DATA_MISSING', '/cylinders', '当前步缺少液压缸结果。')] };
  let maxPosition: typeof current | undefined, maxVelocity: typeof current | undefined;
  let count = 0,
    firstTick: number | undefined;
  for (const sample of points.values()) {
    const row = pair(sample);
    if (!row) continue;
    firstTick ??= row.tick;
    count++;
    if (!maxPosition || Math.abs(row.positionDifferenceM) > Math.abs(maxPosition.positionDifferenceM))
      maxPosition = row;
    if (!maxVelocity || Math.abs(row.velocityDifferenceMPerS) > Math.abs(maxVelocity.velocityDifferenceMPerS))
      maxVelocity = row;
  }
  return {
    ok: true,
    value: {
      leftId: left,
      rightId: right,
      identity: point.identity,
      requestedFromTick: fromTick,
      firstTick,
      sampleCount: count,
      everyTick: count === point.identity.tick - fromTick + 1,
      samplesDropped: capture.record.samplesDropped,
      current,
      maxAbsPositionDifferenceM: Math.abs(maxPosition?.positionDifferenceM ?? current.positionDifferenceM),
      positionPeak: maxPosition,
      maxAbsVelocityDifferenceMPerS: Math.abs(maxVelocity?.velocityDifferenceMPerS ?? current.velocityDifferenceMPerS),
      velocityPeak: maxVelocity,
    },
  };
}
