import {
  checkJson,
  ContractReader,
  diagnostic,
  parseNetworkProject,
  parseNetworkSnapshot,
  readSequenceRunView,
  type SequenceRunView,
  type Diagnostic,
  type NetworkIdentity,
  type NetworkProject,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';
import type { NetworkSaveCapture } from './network-draft.js';
import { readCylinderCondition, type CylinderStop } from './network-cylinder-query.js';
import type { KernelServiceRequest } from './kernel-service.js';
import { parseNetworkArtifact, type NetworkArtifact } from './formal-export.js';
import { readNetworkRecord, sameNetworkIdentity, type NetworkRecord } from './network-records.js';
import { readNetworkFlowRegulators, type NetworkFlowRegulatorView } from './network-flow-regulation.js';

/** Small renderer status DTO. Record pages are independently parsed at export. */
export interface NetworkRuntimeView {
  readonly conditionRun?: CylinderStop;
  readonly flowRegulators?: readonly NetworkFlowRegulatorView[];
  readonly sequence?: SequenceRunView | null;
  readonly controllers?: readonly (SequenceRunView & { readonly componentId: string; readonly label: string })[];
  readonly document: NetworkProject;
  readonly documentSessionId: string;
  readonly physicsRevision: number;
  readonly status: 'new' | 'ready' | 'failed' | 'releasing' | 'released';
  readonly running: boolean;
  readonly busy: boolean;
  readonly identity: NetworkIdentity | null;
  readonly point: NetworkSnapshot | null;
  readonly lastSuccessfulHistorical: NetworkSnapshot | null;
  readonly historicalRuns: readonly {
    readonly document: NetworkProject;
    readonly last: NetworkSnapshot | null;
    readonly record: NetworkRecord;
  }[];
  readonly diagnostics: readonly Diagnostic[];
  readonly clock: { readonly nativeStepS: number };
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('PROTOCOL_INVALID', '/service', message)],
});
function integer(r: ContractReader, input: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = r.number(input, field, 0, maximum);
  if (!Number.isSafeInteger(value)) r.fail('IDENTITY_INVALID', field, '序号必须是安全整数。');
  return value;
}
function boolean(r: ContractReader, input: unknown, field: string): boolean {
  if (typeof input !== 'boolean') r.fail('PROTOCOL_INVALID', field, '此字段必须是布尔值。');
  return input === true;
}
function choice<T extends string>(
  r: ContractReader,
  input: unknown,
  field: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = values.find((item) => item === input);
  if (value === undefined) r.fail('PROTOCOL_INVALID', field, '未知状态。');
  return value ?? fallback;
}
function identity(r: ContractReader, input: unknown): NetworkIdentity {
  const o = r.object(input, '/identity', [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  return {
    documentSessionId: r.id(o.documentSessionId, '/identity/documentSessionId'),
    simulationSessionId: r.id(o.simulationSessionId, '/identity/simulationSessionId'),
    physicsRevision: integer(r, o.physicsRevision, '/identity/physicsRevision'),
    tick: integer(r, o.tick, '/identity/tick'),
    timeS: r.number(o.timeS, '/identity/timeS', 0, 1e12),
    controlSequence: integer(r, o.controlSequence, '/identity/controlSequence'),
    requestSequence: integer(r, o.requestSequence, '/identity/requestSequence'),
  };
}
export function serviceDiagnostics(r: ContractReader, input: unknown): readonly Diagnostic[] {
  return r.array(input, '/diagnostics', 100).map((value, i) => {
    const field = '/diagnostics/' + i,
      o = r.object(value, field, ['code', 'field', 'message', 'severity', 'suggestion']);
    return {
      code: r.text(o.code, field + '/code', 1, 100),
      field: r.text(o.field, field + '/field', 0, 1000),
      message: r.text(o.message, field + '/message', 1, 5000),
      severity: choice(r, o.severity, field + '/severity', ['error', 'warning', 'info'], 'error'),
      suggestion: r.text(o.suggestion, field + '/suggestion', 0, 5000),
    };
  });
}
/** Parse the Result envelope first; callers must still parse successful data. */
export function parseServiceResult(input: unknown): Result<unknown> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['ok', 'value', 'diagnostics', 'approximations']);
  if (o.ok === true) return r.finish(o.value);
  if (o.ok !== false) return fail('运行服务没有合法结果状态。');
  const diagnostics = serviceDiagnostics(r, o.diagnostics);
  const parsed = r.finish(diagnostics);
  return parsed.ok ? (diagnostics.length ? { ok: false, diagnostics } : fail('失败响应缺少诊断。')) : parsed;
}
export function parseNetworkRuntimeView(input: unknown): Result<NetworkRuntimeView> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  return readNetworkRuntimeView(input);
}
/** Result parsing already checks the complete JSON tree. Keep all typed runtime
 * checks, without walking that same tree again at the immediately nested boundary. */
export function parseNetworkRuntimeResult(input: unknown): Result<NetworkRuntimeView> {
  const result = parseServiceResult(input);
  return result.ok ? readNetworkRuntimeView(result.value) : result;
}
/** Opt-in transport form. Physics, history and all live values remain complete. */
export function networkRuntimeReference(view: NetworkRuntimeView): unknown {
  if (view.status !== 'ready' || !view.identity) return view;
  const { document, ...state } = view;
  return {
    format: 'HydraulicRuntimeReference',
    version: 1,
    reference: {
      documentSessionId: view.documentSessionId,
      physicsRevision: view.physicsRevision,
      simulationSessionId: view.identity.simulationSessionId,
    },
    state,
  };
}
/** One validated immutable document, owned by this transport decoder. No runtime
 * points/history are cached. Epoch and client ordering retire late responses. */
export function createNetworkRuntimeResponseReader() {
  let epoch = 0,
    accepted = 0;
  let context: { document: NetworkProject; identity: NetworkIdentity } | undefined;
  const matches = (a: NetworkIdentity, b: NetworkIdentity) =>
    a.documentSessionId === b.documentSessionId &&
    a.physicsRevision === b.physicsRevision &&
    a.simulationSessionId === b.simulationSessionId;
  const clear = () => {
    context = undefined;
    epoch++;
  };
  return {
    clear,
    canReference(expected: NetworkIdentity): boolean {
      return !!context && matches(context.identity, expected);
    },
    begin(request: KernelServiceRequest): (input: unknown) => Result<NetworkRuntimeView> {
      // These operations can publish a different document or simulation ID.
      // An overlapping read must request a full context until publication returns.
      if (request.action === 'initialize' || request.action === 'sequence-start' || request.action === 'reset') clear();
      const ticket = epoch,
        known = context;
      return (input) => {
        if (ticket !== epoch)
          return { ok: false, diagnostics: [diagnostic('RESPONSE_STALE', '/runtime', '运行回复所属工程已退役。')] };
        const result = parseServiceResult(input);
        if (!result.ok) return result;
        let parsed: Result<NetworkRuntimeView>;
        const value = result.value;
        if (value && typeof value === 'object' && 'format' in value) {
          const r = new ContractReader(),
            o = r.object(value, '', ['format', 'version', 'reference', 'state']);
          r.constant(o.format, 'HydraulicRuntimeReference', '/format');
          r.constant(o.version, 1, '/version');
          const ref = r.object(o.reference, '/reference', [
            'documentSessionId',
            'physicsRevision',
            'simulationSessionId',
          ]);
          const session = r.id(ref.documentSessionId, '/reference/documentSessionId'),
            revision = integer(r, ref.physicsRevision, '/reference/physicsRevision'),
            run = r.id(ref.simulationSessionId, '/reference/simulationSessionId');
          const checked = r.finish(true);
          if (!checked.ok) return checked;
          if (
            request.action !== 'state' ||
            !('view' in request) ||
            !known ||
            request.expected === null ||
            session !== known.identity.documentSessionId ||
            revision !== known.identity.physicsRevision ||
            run !== known.identity.simulationSessionId ||
            !matches(known.identity, request.expected)
          )
            return {
              ok: false,
              diagnostics: [
                diagnostic('RESPONSE_STALE', '/reference', '运行文档引用未匹配已验证的工程、物理修订和仿真会话。'),
              ],
            };
          parsed = readNetworkRuntimeView(o.state, known.document);
          if (parsed.ok && (!parsed.value.identity || !matches(parsed.value.identity, known.identity)))
            return {
              ok: false,
              diagnostics: [diagnostic('RESPONSE_STALE', '/identity', '运行状态与文档引用不一致。')],
            };
        } else parsed = readNetworkRuntimeView(value);
        if (parsed.ok && request.clientSequence >= accepted) {
          accepted = request.clientSequence;
          context = parsed.value.identity
            ? { document: parsed.value.document, identity: parsed.value.identity }
            : undefined;
        }
        return parsed;
      };
    },
  };
}
function readNetworkRuntimeView(input: unknown, knownDocument?: NetworkProject): Result<NetworkRuntimeView> {
  const r = new ContractReader(),
    o = r.object(input, '', [
      ...(knownDocument ? [] : ['document']),
      'documentSessionId',
      'physicsRevision',
      'status',
      'running',
      'busy',
      'identity',
      'point',
      'lastSuccessfulHistorical',
      'samples',
      'historicalRuns',
      'record',
      'diagnostics',
      'clock',
      'conditionRun',
      'samplesTruncated',
      'samplesDropped',
      'quality',
      'sequence',
      'controllers',
      'flowRegulators',
    ]);
  const document = knownDocument ? { ok: true as const, value: knownDocument } : parseNetworkProject(o.document);
  if (!document.ok) return document;
  const id = o.identity === null ? null : identity(r, o.identity);
  const point =
    o.point === null
      ? { ok: true as const, value: null }
      : parseNetworkSnapshot(document.value, o.point, id ?? undefined);
  if (!point.ok) return point;
  const historicalPoint =
    o.lastSuccessfulHistorical === undefined || o.lastSuccessfulHistorical === null
      ? { ok: true as const, value: null }
      : parseNetworkSnapshot(document.value, o.lastSuccessfulHistorical, id ?? undefined);
  if (!historicalPoint.ok) return historicalPoint;
  const historicalRuns: NetworkRuntimeView['historicalRuns'][number][] = [];
  for (const raw of r.array(o.historicalRuns, '/historicalRuns', 3)) {
    const h = r.object(raw, '/historicalRuns', ['document', 'last', 'samples', 'reason', 'record']);
    const doc = parseNetworkProject(h.document);
    if (!doc.ok) return doc;
    const last = h.last === null ? { ok: true as const, value: null } : parseNetworkSnapshot(doc.value, h.last);
    if (!last.ok) return last;
    historicalRuns.push({ document: doc.value, last: last.value, record: readNetworkRecord(r, h.record) });
  }
  const documentSessionId = r.id(o.documentSessionId, '/documentSessionId'),
    physicsRevision = integer(r, o.physicsRevision, '/physicsRevision');
  if (id && (id.documentSessionId !== documentSessionId || id.physicsRevision !== physicsRevision))
    r.fail('RESPONSE_STALE', '/identity', '运行快照与工程身份不一致。');
  if (point.value && (!id || !sameNetworkIdentity(point.value.identity, id)))
    r.fail('RESPONSE_STALE', '/point', '当前点与运行身份不一致。');
  for (const history of historicalRuns) {
    if (
      history.document.projectId !== document.value.projectId ||
      (history.last &&
        (history.last.identity.documentSessionId !== documentSessionId ||
          history.last.identity.physicsRevision !== physicsRevision))
    )
      r.fail('RESPONSE_STALE', '/historicalRuns', '历史记录属于其他工程或物理修订。');
  }
  const status = choice(r, o.status, '/status', ['new', 'ready', 'failed', 'releasing', 'released'], 'failed');
  if (historicalPoint.value && (status !== 'failed' || !id || !sameNetworkIdentity(historicalPoint.value.identity, id)))
    r.fail('RESPONSE_STALE', '/lastSuccessfulHistorical', '可恢复点须属于当前失败运行的最后有效身份。');
  if (status === 'ready' && (!id || !point.value)) r.fail('PROTOCOL_INVALID', '/point', '有效运行必须包含身份和结果。');
  const running = boolean(r, o.running, '/running');
  if (running && status !== 'ready') r.fail('PROTOCOL_INVALID', '/running', '无效运行不能标记为正在运行。');
  const clock = r.object(o.clock, '/clock', [
    'stepSeconds',
    'sampleEveryTicks',
    'maxGapSeconds',
    'maxStepsPerPulse',
    'nativeStepS',
  ]);
  const stop =
    o.conditionRun === undefined
      ? null
      : r.object(o.conditionRun, '/conditionRun', [
          'condition',
          'startTick',
          'targetTick',
          'tick',
          'positionM',
          'reason',
        ]);
  return r.finish({
    ...(stop
      ? {
          conditionRun: {
            condition: readCylinderCondition(r, stop.condition, '/conditionRun/condition'),
            startTick: integer(r, stop.startTick, '/startTick'),
            targetTick: integer(r, stop.targetTick, '/targetTick'),
            tick: integer(r, stop.tick, '/tick'),
            positionM: r.number(stop.positionM, '/positionM', -1e6, 1e6),
            reason: choice(
              r,
              stop.reason,
              '/reason',
              ['running', 'threshold', 'tick-limit', 'interrupted'] as const,
              'interrupted',
            ),
          },
        }
      : {}),
    document: document.value,
    flowRegulators:
      o.flowRegulators === undefined ? [] : readNetworkFlowRegulators(r, o.flowRegulators, document.value),
    sequence: o.sequence === undefined || o.sequence === null ? null : readSequenceRunView(r, o.sequence),
    controllers:
      o.controllers === undefined
        ? []
        : r.array(o.controllers, '/controllers', 30).map((raw, i) => {
            const c = r.object(raw, '/controllers/' + i, [
              'runId',
              'status',
              'cycle',
              'cycles',
              'stepIndex',
              'stepName',
              'elapsedS',
              'condition',
              'message',
              'componentId',
              'label',
            ]);
            const { componentId, label, ...state } = c;
            return {
              ...readSequenceRunView(r, state),
              componentId: r.id(componentId, '/controllers/' + i + '/componentId'),
              label: r.text(label, '/controllers/' + i + '/label', 0, 60),
            };
          }),
    documentSessionId,
    physicsRevision,
    status,
    identity: id,
    point: point.value,
    lastSuccessfulHistorical: historicalPoint.value,
    historicalRuns,
    diagnostics: serviceDiagnostics(r, o.diagnostics),
    running,
    busy: boolean(r, o.busy, '/busy'),
    clock: { nativeStepS: r.number(clock.nativeStepS, '/clock/nativeStepS', 1e-9, 1) },
  });
}

export interface NetworkFileContext {
  readonly projectId: string;
  readonly timestamp: string;
  readonly appVersion: string;
}
export type NetworkFileRequest =
  | {
      readonly action: 'activate';
      readonly document: NetworkProject;
      readonly sessionId: string;
      readonly requestId?: string;
    }
  | {
      readonly action: 'create';
      readonly document: NetworkProject;
      readonly sessionId: string;
      readonly requestId?: string;
    }
  | {
      readonly action: 'open';
      readonly context: NetworkFileContext;
      readonly sessionId: string;
      readonly requestId?: string;
      readonly importCopy?: boolean;
    }
  | { readonly action: 'save'; readonly capture: NetworkSaveCapture; readonly saveAs: boolean }
  | {
      readonly action: 'export';
      readonly sessionId: string;
      readonly requestId: string;
      readonly artifact: NetworkArtifact;
      readonly category?: 'drawings' | 'data' | 'curves' | 'calculations' | 'diagnostics';
      readonly destination?: 'project' | 'external';
      readonly defaultDirectory?: string;
    }
  | { readonly action: 'choose-export-directory' }
  | { readonly action: 'close'; readonly sessionId: string };
export type NetworkFileOutcome =
  | { readonly status: 'error'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'ok'; readonly operation: 'choose-export-directory'; readonly path: string }
  | { readonly status: 'ok'; readonly operation: 'activate' | 'close'; readonly sessionId: string }
  | {
      readonly status: 'ok';
      readonly operation: 'open';
      readonly document: NetworkProject;
      readonly requiresSaveAs: boolean;
      readonly migration: readonly { readonly code: string; readonly field: string; readonly message: string }[];
      readonly path: string;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'save';
      readonly path: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly revision: number;
      readonly content: string;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'export';
      readonly path: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly snapshotId: string;
    };

export function parseNetworkFileRequest(input: unknown): Result<NetworkFileRequest> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader();
  const o = r.object(input, '', [
    'action',
    'document',
    'sessionId',
    'context',
    'capture',
    'saveAs',
    'requestId',
    'artifact',
    'category',
    'destination',
    'defaultDirectory',
    'importCopy',
  ]);
  if (o.action === 'choose-export-directory') return r.finish({ action: o.action });
  if (o.action === 'activate' || o.action === 'create') {
    r.object(input, '', ['action', 'document', 'sessionId', 'requestId']);
    const document = parseNetworkProject(o.document);
    if (!document.ok) return document;
    return r.finish({
      action: o.action,
      document: document.value,
      sessionId: r.id(o.sessionId, '/sessionId'),
      ...(o.requestId === undefined ? {} : { requestId: r.id(o.requestId, '/requestId') }),
    });
  }
  if (o.action === 'open') {
    r.object(input, '', ['action', 'sessionId', 'context', 'requestId', 'importCopy']);
    const c = r.object(o.context, '/context', ['projectId', 'timestamp', 'appVersion']);
    return r.finish({
      action: 'open',
      sessionId: r.id(o.sessionId, '/sessionId'),
      ...(o.requestId === undefined ? {} : { requestId: r.id(o.requestId, '/requestId') }),
      ...(o.importCopy === undefined ? {} : { importCopy: boolean(r, o.importCopy, '/importCopy') }),
      context: {
        projectId: r.id(c.projectId, '/context/projectId'),
        timestamp: r.timestamp(c.timestamp, '/context/timestamp'),
        appVersion: r.text(c.appVersion, '/context/appVersion', 1, 100),
      },
    });
  }
  if (o.action === 'save') {
    const c = r.object(o.capture, '/capture', ['documentSessionId', 'requestId', 'revision', 'content', 'document']);
    const document = parseNetworkProject(c.document);
    if (!document.ok) return document;
    return r.finish({
      action: 'save',
      saveAs: o.saveAs === undefined ? false : boolean(r, o.saveAs, '/saveAs'),
      capture: {
        documentSessionId: r.id(c.documentSessionId, '/capture/documentSessionId'),
        requestId: r.text(c.requestId, '/capture/requestId', 1, 80),
        revision: integer(r, c.revision, '/capture/revision'),
        content: r.text(c.content, '/capture/content', 1, 2_000_000),
        document: document.value,
      },
    });
  }
  if (o.action === 'export') {
    const artifact = parseNetworkArtifact(o.artifact);
    if (!artifact.ok) return artifact;
    const category = o.category;
    const destination = o.destination;
    if (
      category !== undefined &&
      category !== 'drawings' &&
      category !== 'data' &&
      category !== 'curves' &&
      category !== 'calculations' &&
      category !== 'diagnostics'
    )
      return fail('未知归档类别。');
    if (destination !== undefined && destination !== 'project' && destination !== 'external')
      return fail('未知导出位置。');
    return r.finish({
      action: 'export',
      sessionId: r.id(o.sessionId, '/sessionId'),
      requestId: r.text(o.requestId, '/requestId', 1, 80),
      artifact: artifact.value,
      ...(category === undefined ? {} : { category }),
      ...(destination === undefined ? {} : { destination }),
      ...(o.defaultDirectory === undefined
        ? {}
        : { defaultDirectory: r.text(o.defaultDirectory, '/defaultDirectory', 1, 32000) }),
    });
  }
  if (o.action === 'close') return r.finish({ action: 'close', sessionId: r.id(o.sessionId, '/sessionId') });
  return fail('未知文件操作。');
}
export function parseNetworkFileOutcome(request: NetworkFileRequest, input: unknown): Result<NetworkFileOutcome> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', [
      'status',
      'diagnostics',
      'sessionId',
      'document',
      'sourceVersion',
      'requiresSaveAs',
      'migration',
      'path',
      'requestId',
      'revision',
      'content',
      'snapshotId',
    ]);
  if (o.status === 'cancelled') return { ok: true, value: { status: 'cancelled' } };
  if (o.status === 'error') {
    const diagnostics = serviceDiagnostics(r, o.diagnostics);
    if (!diagnostics.length) r.fail('PROTOCOL_INVALID', '/diagnostics', '失败响应必须说明原因。');
    return r.finish({ status: 'error', diagnostics });
  }
  if (o.status !== 'ok') return fail('文件服务没有合法结果状态。');
  if (request.action === 'choose-export-directory')
    return r.finish({
      status: 'ok',
      operation: request.action,
      path: r.text(o.path, '/path', 1, 32000),
    });
  if (request.action === 'open' || request.action === 'create') {
    const document = parseNetworkProject(o.document);
    if (!document.ok) return document;
    const migration = r.array(o.migration, '/migration', 1000).map((raw) => {
      const item = r.object(raw, '/migration', ['code', 'field', 'message']);
      return {
        code: r.text(item.code, '/migration/code', 1, 100),
        field: r.text(item.field, '/migration/field', 0, 1000),
        message: r.text(item.message, '/migration/message', 1, 5000),
      };
    });
    return r.finish({
      status: 'ok',
      operation: 'open',
      document: document.value,
      requiresSaveAs: boolean(r, o.requiresSaveAs, '/requiresSaveAs'),
      migration,
      path: o.path === undefined ? '' : r.text(o.path, '/path', 0, 32000),
    });
  }
  const sessionId = r.id(o.sessionId, '/sessionId');
  const expected = request.action === 'save' ? request.capture.documentSessionId : request.sessionId;
  if (sessionId !== expected) r.fail('RESPONSE_STALE', '/sessionId', '文件响应属于其他工程。');
  if (request.action === 'activate' || request.action === 'close')
    return r.finish({ status: 'ok', operation: request.action, sessionId });
  const filePath = r.text(o.path, '/path', 1, 32000),
    requestId = r.text(o.requestId, '/requestId', 1, 80);
  if (requestId !== (request.action === 'save' ? request.capture.requestId : request.requestId))
    r.fail('RESPONSE_STALE', '/requestId', '文件请求身份不匹配。');
  if (request.action === 'save') {
    const revision = integer(r, o.revision, '/revision'),
      content = r.text(o.content, '/content', 1, 2_000_000);
    if (revision !== request.capture.revision || content !== request.capture.content)
      r.fail('RESPONSE_STALE', '/capture', '保存回执不匹配捕获版本。');
    return r.finish({ status: 'ok', operation: 'save', path: filePath, sessionId, requestId, revision, content });
  }
  const snapshotId = r.text(o.snapshotId, '/snapshotId', 1, 100);
  if (snapshotId !== request.artifact.snapshotId) r.fail('RESPONSE_STALE', '/snapshotId', '导出响应不属于所选快照。');
  return r.finish({ status: 'ok', operation: 'export', path: filePath, sessionId, requestId, snapshotId });
}
