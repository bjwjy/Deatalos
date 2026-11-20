import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDrawingTemplate } from '@hyd/application';
import {
  frame,
  splitRect,
  divider,
  bounds,
  changeBand,
  verticalMergeGroup,
  sizeCell,
} from '../../apps/workbench/dist/network-frame-table-geometry.mjs';
test('directional merge accepts a complete neighbouring strip but refuses a partial or stepped strip', () => {
  const [a, b] = splitRect(frame, 2, 1);
  const pair = splitRect(b, 1, 2);
  assert.equal(verticalMergeGroup([a, ...pair], a, false).length, 3);
  assert.deepEqual(verticalMergeGroup([a, ...pair], pair[0], true), []);
  const stepped = [...splitRect(pair[0], 2, 1), pair[1]];
  assert.deepEqual(verticalMergeGroup([a, ...stepped], a, false), []);
});
test('precise sizing uses room on both sides and rejects an impossible height atomically', () => {
  const table = splitRect(frame, 3, 3),
    c = table[4];
  const resized = sizeCell(table, c, 15000, 2500);
  const result = resized.find((v) => v.id === c.id);
  assert.equal(result.right - result.left, 15000);
  assert.equal(result.bottom - result.top, 2500);
  assert.ok(valid(resized));
  assert.equal(sizeCell(table, c, 15000, 5600), undefined);
  assert.equal(c.right - c.left, 6000);
});
const valid = (table) => parseDrawingTemplate({ version: 1, name: '格线测试', fields: [], table }).ok;
test('irregular tables tile the physical frame after inserting or deleting a band and limiting an edge drag', () => {
  const grid = splitRect(frame, 3, 4);
  const base = grid.filter((_, i) => i !== 0 && i !== 4);
  const merged = { ...grid[0], ...bounds([grid[0], grid[4]]) };
  const table = [merged, ...base.slice(0, -1), ...splitRect(base.at(-1), 1, 3)];
  assert.ok(valid(table));
  for (const c of table)
    for (const axis of ['x', 'y']) {
      for (const insert of [true, false])
        for (const after of [true, false]) {
          const next = changeBand(table, c, axis, insert, after);
          if (next) assert.ok(valid(next));
        }
      for (const at of axis === 'x' ? [c.left, c.right] : [c.top, c.bottom]) {
        const edge = divider(table, c, axis, at);
        if (edge) assert.ok(valid(edge.move(-10000)) && valid(edge.move(100000)));
      }
    }
  assert.equal(valid([...grid, grid[0]]), false);
  assert.equal(valid(grid.slice(1)), false);
  assert.equal(valid([{ ...frame, id: 'c1', field: 'missing', text: '' }]), false);
});
