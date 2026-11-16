import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSI, fromSI, parameterGroups, unitScales, valveDefinitions, specs, defaultDefinitionId } from '@hyd/domain';

test('independent unit anchors include pressure, rev displacement, signed speed and already-SI fields', () => {
  const cases = [['pressure', 1, 1_000_000], ['length', 1000, 1], ['force', 1, 1000],
    ['displacement', 1, .000001], ['flow', 60, .001], ['viscosity', 1, .000001],
    ['angularSpeed', 60, 2 * Math.PI], ['linearSpeed', -1000, -1], ['pipeLength', 2.5, 2.5],
    ['pipeSpeed', -2.5, -2.5], ['torque', 25, 25], ['angle', 180, Math.PI],
    ['power', 1, 1000], ['area', 1, 1], ['density', 870, 870], ['time', .01, .01]];
  for (const [quantity, input, expected] of cases) assert.ok(Math.abs(toSI(quantity, input) - expected) < 1e-12, quantity);
  assert.equal(toSI('pipeSpeed', -1), -1);
  assert.equal(toSI('linearSpeed', 0), 0);
  for (const unknown of [null, undefined, NaN, Infinity]) assert.throws(() => toSI('pressure', unknown), TypeError);
});

test('every registered input roundtrips min/max/default with tight scale-aware tolerance', () => {
  for (const [group, list] of Object.entries(parameterGroups)) for (const spec of list) {
    for (const value of [spec.minimum, spec.maximum, spec.defaultValue]) {
      const observed = fromSI(spec.quantity, toSI(spec.quantity, value));
      assert.ok(Math.abs(observed - value) <= 1e-12 + Math.abs(value) * 2e-12, `${group}.${spec.key}`);
    }
    assert.ok(unitScales[spec.quantity].si);
  }
  assert.ok(Object.isFrozen(parameterGroups.cylinder));
});

test('O/M definitions have the expected neutral paths and all stable port references', () => {
  const o = valveDefinitions['builtin:valve-o']; const m = valveDefinitions['builtin:valve-m'];
  assert.equal(defaultDefinitionId('valve'), 'builtin:valve-o');
  assert.deepEqual(o.positions[1].connections, []);
  assert.deepEqual(o.positions[1].blockedPorts, ['P', 'T', 'A', 'B']);
  assert.deepEqual(m.positions[1].connections, [['P', 'T']]);
  assert.deepEqual(m.positions[1].blockedPorts, ['A', 'B']);
  for (const definition of [o, m]) {
    assert.equal(definition.defaultPositionId, 'neutral');
    assert.deepEqual(definition.positions.map(p => p.id), ['extend', 'neutral', 'retract']);
    for (const position of definition.positions) {
      const ports = [...position.connections.flat(), ...position.blockedPorts];
      assert.deepEqual(ports.sort(), ['A', 'B', 'P', 'T']);
    }
  }
  assert.equal(specs('cylinder').find(s => s.legacyKey === 'rod').minimum, 0);
});
