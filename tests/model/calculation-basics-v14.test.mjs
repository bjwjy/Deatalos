import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNetworkDuty, planNetworkDuty, planNetworkGoal } from '@hyd/engineering';
import { createNetworkDraftSession, previewNetworkDuty, applyNetworkDuty } from '@hyd/application';
import { actuatorGraph } from '../fixtures/E04B/graphs.mjs';

const good = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
function request(direction = 'forward') {
  return {
    pumpId: 'pump',
    angularSpeedRadPerS: 50 * Math.PI,
    pumpVolumetricEfficiency: 0.9,
    totalEfficiency: 0.75,
    pressureLimitPa: 3e6,
    phases: [
      {
        name: direction,
        valves: [{ componentId: 'valve', positionId: direction === 'forward' ? 'extend' : 'retract' }],
        actions: [
          {
            componentId: 'actuator',
            direction,
            speed: 0.04,
            resistingLoad: 800,
            supplyLossPa: 1e5,
            returnPressurePa: 2e5,
            mechanicalEfficiency: 0.8,
            volumetricEfficiency: 0.8,
          },
        ],
      },
    ],
  };
}
function step(plan, key) {
  const result = plan.record.steps.find((item) => item.key === key);
  assert.ok(result, key);
  assert.equal(result.value.kind, 'known');
  assert.equal(result.display.value.kind, 'known');
  return result;
}

for (const [direction, pressure, flow, power] of [
  ['forward', 1220000, 0.00005, 74.66666666666667],
  ['reverse', 2100000, 0.00003, 80],
]) {
  test(`V14 independent cylinder ${direction}: nonideal efficiencies, return pressure and SI/display units`, () => {
    const graph = actuatorGraph();
    const original = JSON.stringify(graph);
    const plan = good(planNetworkDuty(graph, request(direction)));
    // A=10 cm², B=6 cm², F/eta_m=1000 N. Return forces are 120 N / 200 N.
    // 40 mm/s with eta_v=.8 needs 3 L/min on A, 1.8 L/min on B.
    near(plan.phases[0].pressurePa, pressure);
    near(plan.phases[0].flowM3PerS, flow);
    near(plan.phases[0].shaftPowerW, power);
    near(step(plan, 'phase0:actuator:pressure').display.value.value, pressure / 1e6);
    near(step(plan, 'phase0:actuator:flow').display.value.value, direction === 'forward' ? 3 : 1.8);
    near(step(plan, 'phase0:power').display.value.value, power / 1000);
    near(plan.requiredDisplacementM3PerRev, direction === 'forward' ? 2.222222222222222e-6 : 1.3333333333333334e-6);
    assert.equal(JSON.stringify(graph), original);
  });
}

for (const direction of ['forward', 'reverse']) {
  test(`V14 independent motor ${direction}: torque, rpm conversion, efficiencies and pump displacement`, () => {
    const req = request(direction);
    req.phases[0].actions[0].speed = 20 * Math.PI;
    req.phases[0].actions[0].resistingLoad = 4 / Math.PI;
    const plan = good(planNetworkDuty(actuatorGraph('motor'), req));
    // 10 cm³/rev at 600 rpm gives 6 ideal L/min, or 7.5 L/min at eta_v=.8.
    // T=4/pi N m and eta_m=.8 give 1 MPa motor differential, then .3 MPa return/loss.
    near(plan.phases[0].pressurePa, 1300000);
    near(plan.phases[0].flowM3PerS, 0.000125);
    near(plan.phases[0].shaftPowerW, 200);
    near(step(plan, 'phase0:actuator:flow').display.value.value, 7.5);
    near(step(plan, 'pumpDisplacement').display.value.value, 5.555555555555555);
  });
}

test('V14 zero is field-specific: no load or supply loss is legal, zero speed and efficiency are not', () => {
  const legal = request();
  legal.phases[0].actions[0].resistingLoad = 0;
  legal.phases[0].actions[0].supplyLossPa = 0;
  const plan = good(checkNetworkDuty(actuatorGraph(), legal));
  near(plan.phases[0].pressurePa, 120000);
  for (const key of ['speed', 'mechanicalEfficiency', 'volumetricEfficiency']) {
    for (const value of [0, -1, null, '', NaN, Infinity]) {
      const invalid = request();
      invalid.phases[0].actions[0][key] = value;
      assert.equal(checkNetworkDuty(actuatorGraph(), invalid).ok, false, `${key}=${value}`);
    }
    const missing = request();
    delete missing.phases[0].actions[0][key];
    assert.equal(checkNetworkDuty(actuatorGraph(), missing).ok, false, `missing ${key}`);
  }
  for (const key of ['angularSpeedRadPerS', 'pumpVolumetricEfficiency', 'totalEfficiency', 'pressureLimitPa']) {
    const invalid = request();
    invalid[key] = 0;
    assert.equal(checkNetworkDuty(actuatorGraph(), invalid).ok, false, key);
  }
});

test('V14 finite-input overflow fails without substituting zero or returning a candidate', () => {
  const invalid = request();
  invalid.phases[0].actions[0].speed = Number.MAX_VALUE;
  assert.equal(checkNetworkDuty(actuatorGraph(), invalid).ok, false);
  assert.equal(planNetworkDuty(actuatorGraph(), invalid).ok, false);
});

test('V14 insufficient current pump flow is not a valid goal solution and does not mutate the project', () => {
  const req = request();
  req.phases[0].actions[0].speed = 1;
  const graph = actuatorGraph();
  const original = JSON.stringify(graph);
  const plan = good(planNetworkGoal(graph, { mode: 'check', duty: req, variables: [] }));
  assert.equal(plan.status, 'not-feasible');
  assert.ok(plan.current.availableFlowM3PerS < plan.current.phases[0].flowM3PerS);
  assert.equal(plan.candidate, null);
  assert.deepEqual(plan.changes, []);
  assert.equal(JSON.stringify(graph), original);
});

test('V14 a preview cannot become valid again after apply then undo to identical physical values', () => {
  const session = good(createNetworkDraftSession(actuatorGraph(), 'v14-basics', true));
  const original = session.document;
  const preview = good(previewNetworkDuty(session, request()));
  good(applyNetworkDuty(session, preview));
  assert.equal(session.undo(), true);
  assert.deepEqual(session.document.design, original.design);
  const rejected = applyNetworkDuty(session, preview);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.diagnostics[0].code, 'RESPONSE_STALE');
  assert.equal(session.undoCount, 0);
});
