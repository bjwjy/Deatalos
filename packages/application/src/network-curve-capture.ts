import { ContractReader, parseNetworkProject, checkJson, type NetworkSnapshot, type Result } from '@hyd/domain';
import { networkResultView } from '@hyd/engineering';
import { parseNetworkRecordPage, type NetworkExportCapture } from './network-export.js';
import { networkRecordMaximum } from './network-records.js';
/** Worker boundary. Rebuild result views from validated document/snapshots, never trust supplied derived values. */
export function parseCurveCapture(input: unknown): Result<NetworkExportCapture> {
  const r = new ContractReader(),
    o = r.object(input, '', [
      'format',
      'version',
      'snapshotId',
      'capturedAt',
      'appVersion',
      'sourceIdentity',
      'selection',
      'view',
      'samples',
      'record',
    ]);
  r.constant(o.format, 'HydraulicNetworkExport', '/format');
  r.constant(o.version, 1, '/version');
  const snapshotId = r.text(o.snapshotId, '/snapshotId', 1, 80);
  if (!/^[\w-]+$/.test(snapshotId)) r.fail('CURVE_CAPTURE_INVALID', '/snapshotId', '快照身份无效。');
  const capturedAt = r.timestamp(o.capturedAt, '/capturedAt'),
    appVersion = r.text(o.appVersion, '/appVersion', 1, 80);
  const view = r.object(o.view, '/view', ['format', 'version', 'document', 'point', 'quantities', 'assumptions']);
  // Apply the existing JSON budget to the header and each bounded page, just like capture.
  const safe = checkJson({ ...o, samples: [], view: { ...view, quantities: [] } });
  if (!safe.ok) return safe;
  const project = parseNetworkProject(view.document);
  if (!project.ok) return project;
  const id = r.object(o.sourceIdentity, '/sourceIdentity', [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  const seq = (key: string) => {
    const n = r.number(id[key], '/sourceIdentity/' + key, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(n)) r.fail('CURVE_CAPTURE_INVALID', '/sourceIdentity/' + key, '序号须为整数。');
    return n;
  };
  const identity = {
    documentSessionId: r.id(id.documentSessionId, '/sourceIdentity/documentSessionId'),
    physicsRevision: seq('physicsRevision'),
    simulationSessionId: r.id(id.simulationSessionId, '/sourceIdentity/simulationSessionId'),
    tick: seq('tick'),
    timeS: r.number(id.timeS, '/sourceIdentity/timeS', 0, 1e12),
    controlSequence: seq('controlSequence'),
    requestSequence: seq('requestSequence'),
  };
  const samples = r.array(o.samples, '/samples', networkRecordMaximum);
  const point = r.object(view.point, '/view/point', [
    'identity',
    'clock',
    'solver',
    'source',
    'initialization',
    'appliedControls',
    'states',
    'readings',
    'diagnostics',
  ]);
  const pointId = r.object(point.identity, '/view/point/identity', [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  const simulationSessionId = r.id(pointId.simulationSessionId, '/view/point/identity/simulationSessionId');
  if (o.selection !== 'current' && o.selection !== 'history')
    r.fail('CURVE_CAPTURE_INVALID', '/selection', '记录选择无效。');
  const valid = r.finish(true);
  if (!valid.ok) return valid;
  let accepted: ReturnType<typeof parseNetworkRecordPage> | null = null;
  const parsedSamples: NetworkSnapshot[] = [];
  let previousTick = -1,
    previousRequest = -1,
    previousControl = -1;
  let offset = 0,
    limit = 20;
  do {
    const end = Math.min(samples.length, offset + limit);
    const page = parseNetworkRecordPage(
      {
        sourceIdentity: identity,
        document: project.value,
        point: view.point,
        record: o.record,
        offset,
        nextOffset: end < samples.length ? end : null,
        samples: samples.slice(offset, end),
        selection: o.selection,
      },
      identity,
      { offset, limit, simulationSessionId: o.selection === 'current' ? null : simulationSessionId },
    );
    if (!page.ok) {
      if (samples.length && limit > 1 && page.diagnostics.every((d) => d.code === 'RESOURCE_LIMIT')) {
        limit = Math.floor(limit / 2);
        continue;
      }
      return page;
    }
    for (const sample of page.value.samples) {
      if (
        sample.identity.tick <= previousTick ||
        sample.identity.requestSequence <= previousRequest ||
        sample.identity.controlSequence < previousControl
      )
        r.fail('CURVE_CAPTURE_INVALID', '/samples', '跨页样本顺序无效。');
      previousTick = sample.identity.tick;
      previousRequest = sample.identity.requestSequence;
      previousControl = sample.identity.controlSequence;
    }
    parsedSamples.push(...page.value.samples);
    accepted = page;
    offset = end;
  } while (offset < samples.length);
  if (!accepted || !accepted.ok) {
    r.fail('CURVE_CAPTURE_INVALID', '/samples', '缺少记录页。');
    return { ok: false, diagnostics: r.diagnostics };
  }
  const page = accepted;
  const result = networkResultView(project.value, page.value.point, page.value.point.identity);
  if (!result.ok) return result;
  return r.finish({
    format: 'HydraulicNetworkExport',
    version: 1,
    snapshotId,
    capturedAt,
    appVersion,
    sourceIdentity: identity,
    selection: page.value.selection,
    view: result.value,
    samples: parsedSamples,
    record: page.value.record,
  });
}
