import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNetworkDuty, sharedReturnPipeEligible } from '@hyd/engineering';
import { calculationBook, createNetworkDraftSession, prepareNetworkDutyCalculation } from '@hyd/application';
import { good } from '../fixtures/E04B/graphs.mjs';
import { treeCircuit, treeReference, treeRequest } from '../fixtures/E1.2S10/tree-return.mjs';
import { segment } from '../fixtures/E1.2S10/two-level-return.mjs';

const near = (actual, expected, relative = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= relative * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const solve = (project, request = treeRequest()) => good(checkNetworkDuty(project, request)).phases[0].flowSplit;
const pipe = (project, id) => project.design.connections.find((edge) => edge.id === id);
const pipeIds = [
  'return-branch-a',
  'return-branch-b',
  'return-branch-c',
  'return-branch-d',
  'return-ab',
  'return-cd',
  'return-trunk',
];
const pipes = (point) => [
  ...point.branches.map((branch) => branch.returnPipe),
  ...point.intermediateReturns,
  point.sharedReturn,
];

for (const mode of ['matched', 'biased']) {
  test(mode + ' four-cylinder reference balances all seven physical pipes and three junctions', () => {
    const result = solve(treeCircuit(mode));
    const ref = treeReference(mode);
    assert.equal(result.kind, 'solved');
    assert.equal(result.matchesTargets, mode === 'matched');
    assert.deepEqual(
      result.branches.map((b) => b.status),
      mode === 'matched' ? Array(4).fill('matched') : ['slow', 'slow', 'fast', 'fast'],
    );
    near(result.pressurePa, ref.pressurePa);
    const actual = pipes(result);
    assert.deepEqual(
      actual.map((state) => state.connectionId),
      pipeIds,
    );
    for (const [i, expected] of ref.points.entries()) {
      near(actual[i].flowM3PerS * 60000, expected.flow);
      near(actual[i].reynolds, expected.reynolds);
      near(actual[i].frictionDropPa, expected.frictionPa);
      near(actual[i].localDropPa, expected.localPa);
      near(actual[i].upstreamPressurePa - actual[i].downstreamPressurePa, expected.totalPa);
    }
    for (const [index, branch] of result.branches.entries()) {
      const [inlet, pT, chamber] = index < 2 ? [ref.qAB, ref.abT, ref.abChamber] : [ref.qCD, ref.cdT, ref.cdChamber];
      near(branch.flowM3PerS * 60000, inlet);
      near(branch.speedMPerS * 1000, (inlet / 3) * 50);
      near(branch.returnBoundaryPa, pT);
      near(branch.returnPressurePa, chamber);
      near(branch.returnPipe.downstreamPressurePa, result.intermediateReturns[index < 2 ? 0 : 1].upstreamPressurePa);
    }
    for (const merge of result.intermediateReturns)
      near(merge.downstreamPressurePa, result.sharedReturn.upstreamPressurePa);
  });
}

test('unequal area ratios in both pairs balance with relief and reversed drawings', () => {
  const project = structuredClone(treeCircuit());
  const request = treeRequest();
  const phase = request.phases[0];
  request.pressureLimitPa = 20e6;
  request.angularSpeedRadPerS *= 1.1;
  const pSupply = 16e6;
  const inlet = [2.5, 2.2, 3.5, 3.8];
  const ratio = [0.6, 1 / 0.6, 0.6, 1 / 0.6];
  const returnFlow = inlet.map((q, i) => q * ratio[i]);
  const ref = treeReference();
  const abReturn = returnFlow[0] + returnFlow[1];
  const cdReturn = returnFlow[2] + returnFlow[3];
  const common = 1e5 + segment(abReturn + cdReturn, ref.pipes.trunk).totalPa;
  const mergePressures = [
    common + segment(abReturn, ref.pipes.ab).totalPa,
    common + segment(cdReturn, ref.pipes.cd).totalPa,
  ];
  const expectedChambers = inlet.map((q, i) => {
    const retract = i % 2 === 1;
    phase.actions[i].direction = retract ? 'reverse' : 'forward';
    phase.valves[i].positionId = retract ? 'retract' : 'extend';
    const pT = mergePressures[i < 2 ? 0 : 1] + segment(returnFlow[i], ref.pipes.leaf).totalPa;
    const dropIn = (1e6 / (1 + 0.6 ** 3)) * (q / 3) ** 2;
    const chamber = pT + dropIn * ratio[i] ** 2;
    phase.actions[i].resistingLoad = (pSupply - dropIn - ratio[i] * chamber) * (retract ? 0.0006 : 0.001);
    assert.ok(phase.actions[i].resistingLoad > 0);
    return chamber;
  });
  const ids = phase.actions.map((action) => action.componentId);
  phase.actions.reverse();
  for (const edge of project.design.connections.filter((e) => e.kind === 'pipe'))
    [edge.from, edge.to] = [edge.to, edge.from];
  const relief = project.design.components.find((part) => part.id === 'relief').parameters.hydraulic;
  relief.settingDifferentialPa = pSupply - 3e5;
  relief.maximumAreaM2 = (1.2 / 60000 / relief.flowCoefficient) * Math.sqrt(project.design.fluid.densityKgPerM3 / 4e5);
  const point = solve(project, request);
  assert.equal(point.kind, 'solved', point.reasons.join(' '));
  near(point.pressurePa, pSupply);
  near(point.reliefFlowM3PerS * 60000, 1.2);
  near(point.intermediateReturns[0].flowM3PerS * 60000, abReturn);
  near(point.intermediateReturns[1].flowM3PerS * 60000, cdReturn);
  near(point.sharedReturn.flowM3PerS * 60000, abReturn + cdReturn);
  for (const [i, id] of ids.entries()) {
    const actual = point.branches.find((b) => b.componentId === id);
    near(actual.flowM3PerS * 60000, inlet[i]);
    near(actual.returnPressurePa, expectedChambers[i]);
  }
});

test('inactive branch inherits its own junction backpressure and an idle pair still sees trunk head', () => {
  const project = treeCircuit();
  const request = treeRequest();
  request.angularSpeedRadPerS *= 0.5;
  request.phases[0].actions[2].resistingLoad = 12000;
  request.phases[0].actions[3].resistingLoad = 12000;
  const point = solve(project, request);
  assert.equal(point.kind, 'solved');
  assert.deepEqual(
    point.branches.map((b) => b.status),
    ['matched', 'matched', 'stopped', 'stopped'],
  );
  near(point.intermediateReturns[1].flowM3PerS, 0, 1e-12);
  assert.ok(point.intermediateReturns[0].pressureDropPa > 0);
  for (const branch of point.branches.slice(2)) {
    assert.equal(branch.returnPipe.pressureDropPa, 0);
    near(branch.returnBoundaryPa, point.sharedReturn.upstreamPressurePa);
  }
  request.phases[0].actions[3].resistingLoad = 2000;
  const threeActive = solve(project, request);
  assert.equal(threeActive.kind, 'solved');
  assert.equal(threeActive.branches[2].status, 'stopped');
  near(threeActive.branches[2].returnBoundaryPa, threeActive.intermediateReturns[1].upstreamPressurePa);
  assert.ok(threeActive.intermediateReturns[1].pressureDropPa > 0);
});

test('all pump flow can return via relief while the seven pipes remain at tank pressure', () => {
  const project = structuredClone(treeCircuit());
  const relief = project.design.components.find((part) => part.id === 'relief').parameters.hydraulic;
  relief.settingDifferentialPa = 3e5;
  relief.maximumAreaM2 = (12 / 60000 / relief.flowCoefficient) * Math.sqrt(project.design.fluid.densityKgPerM3 / 2e5);
  const point = solve(project);
  assert.equal(point.kind, 'solved');
  near(point.pressurePa, 5e5);
  assert.ok(pipes(point).every((p) => p.flowM3PerS === 0 && p.upstreamPressurePa === 1e5));
});

test('missing CD length preserves targets, a 3+1 tree solves, and a bypass is rejected', () => {
  const missing = solve(treeCircuit('pending'));
  assert.equal(missing.kind, 'pending');
  assert.match(missing.reasons.join(''), /两缸汇合段 \[return-cd\].*实际长度 L/);
  assert.equal(missing.targets.length, 4);
  assert.ok(missing.targets.every((target) => target.targetSpeedMPerS === 0.05));
  assert.equal(missing.sharedReturn, undefined);
  const project = structuredClone(treeCircuit());
  const ab = pipe(project, 'return-ab');
  const d = pipe(project, 'return-branch-d');
  const original = d.to;
  d.to = ab.from;
  assert.equal(solve(project).kind, 'solved');
  d.to = original;
  project.design.connections.push({ id: 'ab-bypass', kind: 'ideal', from: ab.from, to: ab.to });
  project.layout.routes.push({ connectionId: 'ab-bypass', mode: 'auto' });
  assert.match(solve(project).reasons.join(''), /旁路|汇合/);
});

test('formal calculation retains seven pipe rows, four verdicts and a pending second phase', () => {
  const project = treeCircuit('biased');
  assert.ok(pipeIds.every((id) => sharedReturnPipeEligible(project, id)));
  const request = treeRequest();
  const pending = structuredClone(request.phases[0]);
  pending.name = '回油基准待核';
  pending.actions[0].returnPressurePa = 2e5;
  request.phases.push(pending);
  const session = good(createNetworkDraftSession(project, 'tree-return'));
  const record = good(prepareNetworkDutyCalculation(session, request, []));
  const book = good(
    calculationBook(record, { snapshotId: 'tree-return', capturedAt: '2026-11-09T00:00:00.000Z', fields: {} }),
  );
  const details = book.sections.find((s) => s.heading.includes('回油管段压降'));
  assert.equal(details.rows.length, 8);
  assert.match(details.rows[5][0], /汇合段.*return-ab/);
  assert.match(details.rows[6][0], /汇合段.*return-cd/);
  assert.match(details.rows[7][0], /return-trunk/);
  assert.equal(book.sections.filter((s) => s.heading.includes('四缸实际分流') && s.rows.length === 5).length, 2);
  assert.ok(
    book.sections.some(
      (s) => s.heading.includes('回油基准待核') && s.rows.slice(1).every((row) => row[2].includes('待核')),
    ),
  );
});
