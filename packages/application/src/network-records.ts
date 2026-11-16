import { ContractReader, type NetworkIdentity, type NetworkProject, type NetworkSnapshot } from '@hyd/domain';
export function readNetworkIdentity(r: ContractReader, input: unknown, field: string): NetworkIdentity {
  const o = r.object(input, field, [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  const integer = (key: string) => {
    const n = r.number(o[key], field + '/' + key, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(n)) r.fail('IDENTITY_INVALID', field + '/' + key, '序号必须是安全整数。');
    return n;
  };
  return {
    documentSessionId: r.id(o.documentSessionId, field + '/documentSessionId'),
    simulationSessionId: r.id(o.simulationSessionId, field + '/simulationSessionId'),
    physicsRevision: integer('physicsRevision'),
    tick: integer('tick'),
    timeS: r.number(o.timeS, field + '/timeS', 0, 1e12),
    controlSequence: integer('controlSequence'),
    requestSequence: integer('requestSequence'),
  };
}
export interface NetworkRecord {
  readonly mode: 'paged';
  readonly count: number;
  readonly samplesDropped: number;
  readonly samplesTruncated: boolean;
  readonly capacity: number;
}
export const legacyNetworkRecordCapacity = 2000;
export const networkRecordMaximum = 6001;

/** Larger records for ordinary circuits while bounding the expanded footprint of complex diagrams. */
export function networkRecordCapacity(project: NetworkProject): number {
  const { components, nodes, connections } = project.design;
  const elements = Math.max(
    1,
    components.length + nodes.length + connections.length + (project.controlProbes?.length ?? 0),
  );
  return Math.min(networkRecordMaximum, Math.max(legacyNetworkRecordCapacity, Math.floor(240_000 / elements)));
}

export function readNetworkRecord(r: ContractReader, input: unknown): NetworkRecord {
  const o = r.object(input, '/record', ['mode', 'count', 'samplesDropped', 'samplesTruncated', 'capacity']);
  r.constant(o.mode, 'paged', '/record/mode');
  const integer = (key: string, min: number, max: number) => {
    const field = '/record/' + key;
    const value = r.number(o[key], field, min, max);
    if (!Number.isSafeInteger(value)) r.fail('RECORD_INVALID', field, '记录数量须为整数。');
    return value;
  };
  const capacity = integer('capacity', legacyNetworkRecordCapacity, networkRecordMaximum);
  const count = integer('count', 0, capacity);
  const samplesDropped = integer('samplesDropped', 0, Number.MAX_SAFE_INTEGER);
  const samplesTruncated = samplesDropped > 0;
  if (o.samplesTruncated !== samplesTruncated)
    r.fail('RECORD_INVALID', '/record/samplesTruncated', '截断标记与丢弃数不一致。');
  return { mode: 'paged', capacity, count, samplesDropped, samplesTruncated };
}
export interface NetworkRecordPage {
  readonly sourceIdentity: NetworkIdentity;
  readonly document: NetworkProject;
  readonly point: NetworkSnapshot;
  readonly record: NetworkRecord;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly samples: readonly NetworkSnapshot[];
  readonly selection: 'current' | 'history';
}
export interface RecordSelection {
  readonly simulationSessionId: string | null;
  readonly offset: number;
  readonly limit: number;
}
export function sameNetworkIdentity(a: NetworkIdentity, b: NetworkIdentity): boolean {
  return (
    a.documentSessionId === b.documentSessionId &&
    a.physicsRevision === b.physicsRevision &&
    a.simulationSessionId === b.simulationSessionId &&
    a.tick === b.tick &&
    a.controlSequence === b.controlSequence &&
    a.requestSequence === b.requestSequence &&
    Math.abs(a.timeS - b.timeS) <= 1e-8 + Math.abs(b.timeS) * 1e-12
  );
}
