import {
  checkJson,
  ContractReader,
  parseNetworkControls,
  parseNetworkProject,
  parseNetworkSnapshot,
  type NetworkControl,
  type NetworkIdentity,
  type NetworkProject,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';
import { readNetworkIdentity, sameNetworkIdentity, type RecordSelection } from './network-records.js';
export interface NetworkControlEvent {
  readonly identity: NetworkIdentity;
  readonly controls: readonly NetworkControl[];
}
export interface NetworkControlLog {
  readonly events: readonly NetworkControlEvent[];
  readonly dropped: number;
}
export interface NetworkControlRecordPage {
  readonly sourceIdentity: NetworkIdentity;
  readonly document: NetworkProject;
  readonly point: NetworkSnapshot;
  readonly record: { readonly count: number; readonly dropped: number; readonly capacity: 256 };
  readonly events: readonly NetworkControlEvent[];
  readonly offset: number;
  readonly nextOffset: number | null;
}
/** Accepted controls are recorded independently of downsampled time-series frames, including same-tick changes. */
export function parseNetworkControlRecordPage(
  input: unknown,
  expected: NetworkIdentity,
  selection: RecordSelection,
): Result<NetworkControlRecordPage> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['sourceIdentity', 'document', 'point', 'record', 'events', 'offset', 'nextOffset']);
  const document = parseNetworkProject(o.document);
  if (!document.ok) return document;
  const point = parseNetworkSnapshot(document.value, o.point);
  if (!point.ok) return point;
  const sourceIdentity = readNetworkIdentity(r, o.sourceIdentity, '/sourceIdentity');
  if (!sameNetworkIdentity(sourceIdentity, expected))
    r.fail('RESPONSE_STALE', '/sourceIdentity', '控制记录捕获身份不匹配。');
  const target = point.value.identity;
  if (
    target.documentSessionId !== expected.documentSessionId ||
    target.physicsRevision !== expected.physicsRevision ||
    (selection.simulationSessionId === null
      ? !sameNetworkIdentity(target, expected)
      : target.simulationSessionId !== selection.simulationSessionId)
  )
    r.fail('RESPONSE_STALE', '/point', '控制记录不属于所选工程/运行。');
  const raw = r.object(o.record, '/record', ['count', 'dropped', 'capacity']),
    count = r.number(raw.count, '/record/count', 0, 256),
    dropped = r.number(raw.dropped, '/record/dropped', 0, Number.MAX_SAFE_INTEGER);
  r.constant(raw.capacity, 256, '/record/capacity');
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(dropped))
    r.fail('RECORD_INVALID', '/record', '控制记录计数须为安全整数。');
  if (count + dropped !== target.controlSequence)
    r.fail('RECORD_INVALID', '/record', '已接受控制数量与捕获控制序号不一致。');
  const events: NetworkControlEvent[] = [];
  for (const [i, v] of r.array(o.events, '/events', selection.limit).entries()) {
    const p = '/events/' + i,
      event = r.object(v, p, ['identity', 'controls']),
      id = readNetworkIdentity(r, event.identity, p + '/identity');
    const controls = parseNetworkControls(document.value, event.controls);
    if (!controls.ok) return controls;
    if (
      id.controlSequence !== dropped + selection.offset + i + 1 ||
      Math.abs(id.timeS - id.tick * point.value.clock.advanceIntervalS) > 1e-8 + Math.abs(id.timeS) * 1e-12
    )
      r.fail('RECORD_INVALID', p, '控制记录有缺号或tick/时刻不符。');
    if (
      id.documentSessionId !== target.documentSessionId ||
      id.physicsRevision !== target.physicsRevision ||
      id.simulationSessionId !== target.simulationSessionId ||
      id.controlSequence > target.controlSequence ||
      id.tick > target.tick ||
      id.requestSequence > target.requestSequence
    )
      r.fail('RESPONSE_STALE', p, '控制事件越过捕获时刻或属于其他运行。');
    const prior = events.at(-1);
    if (
      prior &&
      (id.controlSequence <= prior.identity.controlSequence ||
        id.requestSequence <= prior.identity.requestSequence ||
        id.tick < prior.identity.tick)
    )
      r.fail('RECORD_INVALID', p, '控制事件顺序重复或倒退。');
    events.push({ identity: id, controls: controls.value });
  }
  const end = Math.min(count, selection.offset + selection.limit);
  r.constant(o.offset, selection.offset, '/offset');
  r.constant(events.length, end - selection.offset, '/events/length');
  if (o.nextOffset !== (end < count ? end : null)) r.fail('RECORD_INVALID', '/nextOffset', '控制记录分页范围不一致。');
  return r.finish({
    sourceIdentity,
    document: document.value,
    point: point.value,
    record: { count, dropped, capacity: 256 },
    events,
    offset: selection.offset,
    nextOffset: end < count ? end : null,
  });
}
