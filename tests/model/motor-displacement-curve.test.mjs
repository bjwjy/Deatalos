import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileMotorDisplacementCurve,
  defaultMotorDisplacementCurve,
  initialNetworkControls,
  networkDisplacementRange,
  networkModelSetVersion,
  parseNetworkProject,
  sampleMotorDisplacementCurve,
} from '@hyd/domain';
import { displacementCircuit } from '../fixtures/E1.3S12/displacement.mjs';
import { good } from '../fixtures/E04B/graphs.mjs';

const motorOf = (project) => project.design.components.find((c) => c.id === 'motor');
const range = { min: 4e-6, max: 16e-6 };

test('a curve stays within motor bounds, joins with matching slope and clamps outside its pressure domain', () => {
  const original = defaultMotorDisplacementCurve(range);
  const points = original.points.map((point, i) =>
    i === 2
      ? {
          ...point,
          tangent: { slopeM3PerRevPa: 8e-12, leftReach: 0.2, rightReach: 0.4 },
        }
      : point,
  );
  const { segments } = compileMotorDisplacementCurve({ ...original, points }, range);
  for (const [i, segment] of segments.entries()) {
    const [p0, p1, p2, p3] = segment.pressure;
    const [d0, d1, d2, d3] = segment.displacement;
    assert.ok(p0 < p1 && p1 < p2 && p2 < p3);
    for (const d of segment.displacement) assert.ok(d >= range.min && d <= range.max);
    const next = segments[i + 1];
    if (next)
      assert.ok(
        Math.abs((d3 - d2) / (p3 - p2) - (next.displacement[1] - next.displacement[0]) / (next.pressure[1] - p3)) <
          1e-22,
      );
    assert.ok(Math.abs(sampleMotorDisplacementCurve(segments, p0).displacementM3PerRev - d0) < 1e-16);
  }
  assert.equal(sampleMotorDisplacementCurve(segments, -10e6).displacementM3PerRev, range.max);
  assert.deepEqual(sampleMotorDisplacementCurve(segments, -1.1e6), sampleMotorDisplacementCurve(segments, 1.1e6));
});

test('project boundary preserves a disabled draft and rejects invalid or competing motor curves', () => {
  const legacy = displacementCircuit();
  assert.equal(motorOf(legacy).motorDisplacementCurve, undefined);
  assert.equal(initialNetworkControls(legacy).find((c) => c.componentId === 'motor').value, 8e-6);
  const draft = structuredClone(legacy);
  const motor = motorOf(draft);
  motor.motorDisplacementCurve = defaultMotorDisplacementCurve(networkDisplacementRange(motor));
  const read = good(parseNetworkProject(JSON.parse(JSON.stringify(draft))));
  assert.deepEqual(motorOf(read).motorDisplacementCurve, motor.motorDisplacementCurve);
  assert.equal(networkModelSetVersion(read.design.components), '0.3.0');
  assert.equal(
    initialNetworkControls(read).some((c) => c.componentId === 'motor'),
    true,
  );
  motor.motorDisplacementCurve.enabled = true;
  const active = good(parseNetworkProject(draft));
  assert.equal(networkModelSetVersion(active.design.components), '0.9.0');
  assert.equal(
    initialNetworkControls(active).some((c) => c.componentId === 'motor'),
    false,
  );
  const conflicting = structuredClone(displacementCircuit('combined', true));
  motorOf(conflicting).motorDisplacementCurve = motor.motorDisplacementCurve;
  const conflict = parseNetworkProject(conflicting);
  assert.ok(!conflict.ok && conflict.diagnostics.some((d) => d.code === 'SEQUENCE_REFERENCE_INVALID'));
  for (const change of [
    (v) => {
      v.points[1].pressurePa = v.points[0].pressurePa;
    },
    (v) => {
      v.points[1].displacementM3PerRev = 17e-6;
    },
    (v) => {
      v.pressureLimitPa = 1e6;
    },
  ]) {
    const invalid = structuredClone(draft);
    change(motorOf(invalid).motorDisplacementCurve);
    assert.equal(parseNetworkProject(invalid).ok, false);
  }
  draft.design.components.find((c) => c.id === 'pump').motorDisplacementCurve = motor.motorDisplacementCurve;
  assert.equal(parseNetworkProject(draft).ok, false);
});
