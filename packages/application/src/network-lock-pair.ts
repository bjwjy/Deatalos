import { ContractReader, diagnostic, type Result } from '@hyd/domain';
import { planNetworkToolCommands, type NetworkToolEditPlan } from './network-tool-commands.js';

/** Two ordinary registered valves plus visible cross-pilot lines. No hidden tank or independent composite physics. */
export function planNetworkPilotLockPair(document: unknown, input: unknown): Result<NetworkToolEditPlan> {
  const r = new ContractReader(),
    raw = r.object(input, '/lockPair', ['componentIds', 'connectionIds', 'x', 'y']);
  const components = r
    .array(raw.componentIds, '/lockPair/componentIds', 2)
    .map((id, i) => r.id(id, '/lockPair/componentIds/' + i));
  const connections = r
    .array(raw.connectionIds, '/lockPair/connectionIds', 2)
    .map((id, i) => r.id(id, '/lockPair/connectionIds/' + i));
  const x = r.number(raw.x, '/lockPair/x', -999810, 999810),
    y = r.number(raw.y, '/lockPair/y', -1e6, 999900);
  if (components.length !== 2 || connections.length !== 2)
    r.fail('LOCK_PAIR_INVALID', '/lockPair', '组合必须明确两只阀和两条先导线。');
  r.unique([...components, ...connections], '/lockPair');
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  const [left, right] = components,
    [first, second] = connections;
  if (!left || !right || !first || !second)
    return { ok: false, diagnostics: [diagnostic('LOCK_PAIR_INVALID', '/lockPair', '组合标识不完整。')] };
  return planNetworkToolCommands(document, [
    {
      kind: 'add-component',
      id: left,
      definitionId: 'teaching:pilot-check-internal',
      definitionVersion: 1,
      label: '双向锁 · 左液控单向阀',
      x: x - 110,
      y,
    },
    {
      kind: 'add-component',
      id: right,
      definitionId: 'teaching:pilot-check-internal',
      definitionVersion: 1,
      label: '双向锁 · 右液控单向阀',
      x: x + 110,
      y,
    },
    {
      kind: 'connect',
      id: first,
      from: { kind: 'port', componentId: left, portId: 'A' },
      to: { kind: 'port', componentId: right, portId: 'X' },
      pipe: null,
    },
    {
      kind: 'connect',
      id: second,
      from: { kind: 'port', componentId: right, portId: 'A' },
      to: { kind: 'port', componentId: left, portId: 'X' },
      pipe: null,
    },
    {
      kind: 'route',
      route: {
        connectionId: first,
        mode: 'manual',
        points: [
          { x: x - 110, y: y + 80 },
          { x: x + 22, y: y + 80 },
          { x: x + 22, y },
        ],
      },
    },
    {
      kind: 'route',
      route: {
        connectionId: second,
        mode: 'manual',
        points: [
          { x: x + 110, y: y + 100 },
          { x: x - 190, y: y + 100 },
          { x: x - 190, y },
        ],
      },
    },
  ]);
}
