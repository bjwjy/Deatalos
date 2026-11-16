import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNetworkDuty, networkGoalSupplySatisfied, planNetworkDuty, planNetworkCatalog } from '@hyd/engineering';
import {
  calculationBook,
  createNetworkDraftSession,
  prepareNetworkDutyCalculation,
  previewNetworkCatalog,
  exportNetworkCatalog,
} from '@hyd/application';
import { good } from '../fixtures/E04B/graphs.mjs';
import { steadyCylinderCircuit, steadyCylinderRequest } from '../fixtures/E1.2S10/steady-cylinders.mjs';
import { accessoryCircuit, accessoryRequest } from '../fixtures/E1.2S10/steady-accessories.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const stamp = { snapshotId: 'cylinder-book', capturedAt: '2026-11-08T08:00:00.000Z', fields: {} };
const getStep = (record, key) => record.steps.find((step) => step.key === key);

for (const [type, pressure, flow] of [
  ['cushioned-cylinder', [1280000, 1996153.846153846], [3, 1.95]],
  ['cushioned-double-rod-cylinder', [1683333.3333333333, 1683333.3333333333], [2.25, 2.25]],
]) {
  test(type + ' uses correct effective areas, directions and travel limits', () => {
    const project = steadyCylinderCircuit(type);
    const request = steadyCylinderRequest(type);
    const plan = good(checkNetworkDuty(project, request));
    for (const [index, demand] of plan.phases.entries()) {
      near(demand.pressurePa, pressure[index]);
      near(demand.flowM3PerS * 60000, flow[index]);
      near(getStep(plan.record, `phase${index}:part:travel-position`).display.value.value, 50);
      near(getStep(plan.record, `phase${index}:part:travel-lower`).display.value.value, 15);
      near(getStep(plan.record, `phase${index}:part:travel-upper`).display.value.value, 85);
    }
    const session = good(createNetworkDraftSession(project, 'cylinder'));
    const record = good(prepareNetworkDutyCalculation(session, request, []));
    const book = good(calculationBook(record, stamp));
    assert.ok(
      book.sections.some(
        (section) => section.heading === '稳态核算适用条件' && section.paragraphs.some((p) => p.includes('吸能')),
      ),
    );
    assert.ok(
      book.sections.some(
        (section) => section.heading.includes('缓冲区外下界') && section.paragraphs.some((p) => p.includes('15 mm')),
      ),
    );
  });
}

test('both cushion zones, missing position, mechanical endpoints and overlapping cushions are diagnosed', () => {
  const type = 'cushioned-cylinder';
  const document = steadyCylinderCircuit(type);
  const request = steadyCylinderRequest(type, ['forward']);
  const action = request.phases[0].actions[0];
  for (const [x, message] of [
    [undefined, /请填写/],
    [0, /行程内部/],
    [0.1, /行程内部/],
    [0.005, /缓冲段内/],
    [0.095, /缓冲段内/],
  ]) {
    if (x === undefined) delete action.positionM;
    else action.positionM = x;
    const r = checkNetworkDuty(document, request);
    assert.equal(r.ok, false);
    assert.match(r.diagnostics[0].message, message);
  }
  action.positionM = 0.015;
  assert.equal(checkNetworkDuty(document, request).ok, true);
  action.positionM = 0.085;
  assert.equal(checkNetworkDuty(document, request).ok, true);
  const overlap = structuredClone(document);
  overlap.design.components.find((item) => item.id === 'part').parameters.cushion.extendCushionLengthM = 0.09;
  const r = checkNetworkDuty(overlap, request);
  assert.equal(r.ok, false);
  assert.match(r.diagnostics[0].message, /不得超过总行程/);
  overlap.design.components.find((item) => item.id === 'part').parameters.cushion.extendCushionLengthM = 0.085;
  const noWindow = checkNetworkDuty(overlap, request);
  assert.equal(noWindow.ok, false);
  assert.match(noWindow.diagnostics[0].message, /相接或重叠/);
});

test('spring extension and return use explicit position and distinguish pump supply from the spring force margin', () => {
  const type = 'single-acting-cylinder';
  const document = steadyCylinderCircuit(type);
  const request = steadyCylinderRequest(type);
  const plan = good(checkNetworkDuty(document, request));
  near(plan.phases[0].pressurePa, 1050000);
  near(plan.phases[0].flowM3PerS * 60000, 3);
  assert.deepEqual(plan.phases[1].springReturn, { flowM3PerS: 0.00005, backPressurePa: 2e5, forceMarginN: 300 });
  assert.equal(plan.phases[1].pressurePa, undefined);
  near(getStep(plan.record, 'phase0:part:spring-force').value.value, 700);
  near(getStep(plan.record, 'phase1:part:spring-return-margin').value.value, 300);
  assert.equal(networkGoalSupplySatisfied(plan), true);
  const session = good(createNetworkDraftSession(document, 'spring'));
  const before = JSON.stringify(session.document);
  const record = good(prepareNetworkDutyCalculation(session, request, []));
  const book = good(calculationBook(record, stamp));
  assert.match(
    book.sections.find((s) => s.heading === '工况核算状态').rows[2][2],
    /排油 3 L\/min，力裕量 300 N。无缸供油需求/,
  );
  assert.ok(book.sections.some((s) => s.heading.includes('回程力裕量') && s.equations.length === 2));
  assert.equal(JSON.stringify(session.document), before);
});

test('return-only reports no pump target and negative force margin remains a calculated shortfall', () => {
  const type = 'single-acting-cylinder';
  const document = steadyCylinderCircuit(type);
  const request = steadyCylinderRequest(type, ['reverse']);
  request.phases[0].actions[0].returnPressurePa = 0.8e6;
  const plan = good(checkNetworkDuty(document, request));
  near(plan.phases[0].springReturn.forceMarginN, -300);
  assert.equal(networkGoalSupplySatisfied(plan), false);
  assert.equal(getStep(plan.record, 'pumpDisplacement'), undefined);
  assert.equal(planNetworkDuty(document, request).ok, false);
  const settings = {
    duty: request,
    region: '中国',
    fluid: 'unconfirmed',
    customization: 'standard-only',
    limit: 1,
  };
  const catalog = good(planNetworkCatalog(document, settings));
  assert.deepEqual(catalog.candidates, []);
  assert.ok(catalog.missing.some((message) => message.includes('仅有弹簧回程')));
  const session = good(createNetworkDraftSession(document, 'spring-return'));
  const preview = good(previewNetworkCatalog(session, settings, stamp));
  const md = good(exportNetworkCatalog(session, preview, 'md'));
  assert.match(md.text, /仅弹簧回程/);
  assert.doesNotMatch(md.text, /无标准目标匹配|泵规格待核算/);
});

test('buffered single-rod cylinder retains first-batch supply and return accessory calculations', () => {
  const graph = structuredClone(accessoryCircuit());
  const sample = steadyCylinderCircuit('cushioned-cylinder');
  const cylinder = sample.design.components.find((c) => c.id === 'part');
  const initial = sample.design.initialConditions.find((item) => item.componentId === 'part');
  graph.design.components = graph.design.components.map((c) => (c.id === 'actuator' ? { ...cylinder, id: c.id } : c));
  graph.design.initialConditions = graph.design.initialConditions.map((item) =>
    item.componentId === 'actuator' ? { ...initial, componentId: item.componentId } : item,
  );
  const request = accessoryRequest();
  request.phases[0].actions[0].positionM = 0.05;
  const result = good(checkNetworkDuty(graph, request));
  near(result.phases[0].pressurePa, 1374886.5);
  near(getStep(result.record, 'phase0:filter:series-drop').value.value, 15210);
  near(getStep(result.record, 'phase0:gauge:gauge-drop').value.value, 15210);
});

test('spring return rejects pump connection, missing protection and leakage ambiguity', () => {
  const type = 'single-acting-cylinder';
  const document = steadyCylinderCircuit(type);
  const request = steadyCylinderRequest(type, ['reverse']);
  const wrongValve = structuredClone(request);
  wrongValve.phases[0].valves[0].positionId = 'extend';
  const unprotected = structuredClone(document);
  unprotected.design.components.find((part) => part.id === 'pump').parameters.relief.enabled = 0;
  const leakage = structuredClone(request);
  leakage.phases[0].actions[0].volumetricEfficiency = 0.95;
  for (const [project, input, message] of [
    [document, wrongValve, /与泵出口隔离/],
    [unprotected, request, /缺少可确认/],
    [document, leakage, /容积效率为 1/],
  ]) {
    const r = checkNetworkDuty(project, input);
    assert.equal(r.ok, false);
    assert.match(r.diagnostics[0].message, message);
  }
});
