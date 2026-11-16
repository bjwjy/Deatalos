import {
  checkJson,
  ContractReader,
  initialNetworkControls,
  parseNetworkProject,
  parseNetworkSnapshot,
  requestNetworkControls,
  networkNativeStepAllowed,
  type NetworkClock,
  type NetworkControl,
  type NetworkIdentity,
  type NetworkProject,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';
import { diagnostic } from '@hyd/domain';
const failure = (code: string, field: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, field, message)],
});

export type KernelOperation = 'initialize' | 'advance' | 'control' | 'snapshot' | 'reset' | 'release';
export interface KernelRequest {
  readonly protocol: 'HydraulicKernel';
  readonly version: 1;
  readonly kind: KernelOperation;
  readonly identity: NetworkIdentity;
  readonly clock?: NetworkClock;
  readonly controls?: readonly NetworkControl[];
}
export interface KernelCursor {
  readonly identity: NetworkIdentity;
  readonly clock: NetworkClock;
  readonly controls: readonly NetworkControl[];
  readonly lifecycle: 'ready' | 'released';
}
export interface ValidatedRequest {
  readonly request: KernelRequest;
  readonly next: KernelCursor;
}
export interface KernelSnapshotReply {
  readonly protocol: 'HydraulicKernel';
  readonly version: 1;
  readonly kind: 'snapshot';
  readonly status: 'ok';
  readonly identity: NetworkIdentity;
  readonly point: NetworkSnapshot;
}
const operations: readonly string[] = ['initialize', 'advance', 'control', 'snapshot', 'reset', 'release'];
function identity(r: ContractReader, value: unknown): NetworkIdentity {
  const raw = r.object(value, '/identity', [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  const integer = (key: string) => {
    const n = r.number(raw[key], `/identity/${key}`, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(n)) r.fail('IDENTITY_INVALID', `/identity/${key}`, '序号必须是安全整数。');
    return n;
  };
  return {
    documentSessionId: r.id(raw.documentSessionId, '/identity/documentSessionId'),
    physicsRevision: integer('physicsRevision'),
    simulationSessionId: r.id(raw.simulationSessionId, '/identity/simulationSessionId'),
    tick: integer('tick'),
    timeS: r.number(raw.timeS, '/identity/timeS', 0, 1e12),
    controlSequence: integer('controlSequence'),
    requestSequence: integer('requestSequence'),
  };
}
const closeTime = (a: number, b: number) => Math.abs(a - b) <= 1e-8 + Math.abs(b) * 1e-12;
/** Application-owned request contract, pure validation/transition proposal only.
 * Commit `next` after a matching native acknowledgement, never before I/O succeeds. */
export function validateKernelRequest(
  projectInput: unknown,
  input: unknown,
  current: KernelCursor | null,
): Result<ValidatedRequest> {
  const projectResult = parseNetworkProject(projectInput);
  if (!projectResult.ok) return projectResult;
  const project: NetworkProject = projectResult.value,
    safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    raw = r.object(input, '', ['protocol', 'version', 'kind', 'identity', 'clock', 'controls']);
  r.constant(raw.protocol, 'HydraulicKernel', '/protocol');
  r.constant(raw.version, 1, '/version', 'VERSION_UNSUPPORTED');
  if (typeof raw.kind !== 'string' || !operations.includes(raw.kind))
    return failure('PROTOCOL_OPERATION_INVALID', '/kind', '未知内核操作。');
  const kind = raw.kind as KernelOperation;
  r.object(input, '', [
    'protocol',
    'version',
    'kind',
    'identity',
    ...(kind === 'initialize' ? ['clock'] : []),
    ...(kind === 'control' ? ['controls'] : []),
  ]);
  const id = identity(r, raw.identity);
  const clock =
    kind === 'initialize'
      ? (() => {
          const c = r.object(raw.clock, '/clock', ['advanceIntervalS', 'nativeStepS']);
          r.constant(c.advanceIntervalS, 0.01, '/clock/advanceIntervalS', 'CLOCK_INVALID');
          const supported = networkNativeStepAllowed(project.design.components, c.nativeStepS);
          if (!supported) r.fail('CLOCK_INVALID', '/clock/nativeStepS', '原生步长须在该模型集已验证配置内。');
          return {
            advanceIntervalS: 0.01,
            nativeStepS: networkNativeStepAllowed(project.design.components, c.nativeStepS) ? c.nativeStepS : 0.0001,
          };
        })()
      : (current?.clock ?? { advanceIntervalS: 0.01, nativeStepS: 0.0001 });
  if (kind === 'initialize') {
    if (current && current.lifecycle !== 'released')
      r.fail('LIFECYCLE_INVALID', '/kind', '先释放旧运行，不能覆盖活动资源。');
    if (current && id.simulationSessionId === current.identity.simulationSessionId)
      r.fail('RESPONSE_STALE', '/identity', '不能复用仿真会话。');
    if (id.tick !== 0 || id.timeS !== 0 || id.controlSequence !== 0)
      r.fail('IDENTITY_INVALID', '/identity', '初始化必须从设计初态及tick0开始。');
  } else if (!current) r.fail('LIFECYCLE_INVALID', '/kind', '尚未初始化。');
  else {
    const before = current.identity;
    if (
      id.documentSessionId !== before.documentSessionId ||
      id.physicsRevision !== before.physicsRevision ||
      (kind === 'reset'
        ? id.simulationSessionId === before.simulationSessionId
        : id.simulationSessionId !== before.simulationSessionId) ||
      id.requestSequence !== before.requestSequence + 1
    )
      r.fail('RESPONSE_STALE', '/identity', '会话/物理修订/请求顺序不匹配。');
    if (current.lifecycle === 'released' && kind !== 'release')
      r.fail('LIFECYCLE_INVALID', '/kind', '释放后只接受幂等释放或新初始化。');
    const tick = kind === 'reset' ? 0 : before.tick + (kind === 'advance' ? 1 : 0);
    const sequence = kind === 'reset' ? 0 : before.controlSequence + (kind === 'control' ? 1 : 0);
    if (id.tick !== tick || !closeTime(id.timeS, tick * clock.advanceIntervalS) || id.controlSequence !== sequence)
      r.fail('RESPONSE_STALE', '/identity', 'tick/时间/控制序号不匹配。');
  }
  const controls =
    kind === 'initialize' || kind === 'reset'
      ? { ok: true as const, value: initialNetworkControls(project) }
      : kind === 'control'
        ? requestNetworkControls(project, current?.controls ?? initialNetworkControls(project), raw.controls)
        : { ok: true as const, value: current?.controls ?? initialNetworkControls(project) };
  if (!controls.ok) return controls;
  const request: KernelRequest = {
    protocol: 'HydraulicKernel',
    version: 1,
    kind,
    identity: id,
    ...(kind === 'initialize' ? { clock } : {}),
    ...(kind === 'control' ? { controls: controls.value } : {}),
  };
  return r.finish({
    request,
    next: { identity: id, clock, controls: controls.value, lifecycle: kind === 'release' ? 'released' : 'ready' },
  });
}

/** Native-free response envelope. The shell echoes the dispatch identity;
 * this parser compares it to the currently awaited request, including same-tick sequences. */
export function acceptKernelResponse(
  project: NetworkProject,
  input: unknown,
  expected: NetworkIdentity,
): Result<NetworkSnapshot> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    raw = r.object(input, '', ['protocol', 'version', 'kind', 'status', 'identity', 'point', 'diagnostics']);
  r.constant(raw.protocol, 'HydraulicKernel', '/protocol');
  r.constant(raw.version, 1, '/version', 'VERSION_UNSUPPORTED');
  r.constant(raw.kind, 'snapshot', '/kind');
  const id = identity(r, raw.identity);
  const strictKeys = [
    'documentSessionId',
    'simulationSessionId',
    'physicsRevision',
    'tick',
    'controlSequence',
    'requestSequence',
  ] as const;
  if (strictKeys.some((k) => id[k] !== expected[k]) || !closeTime(id.timeS, expected.timeS))
    r.fail('RESPONSE_STALE', '/identity', '返回属于旧会话/修订/tick或同刻旧控制/请求。');
  if (raw.status === 'error') {
    r.object(input, '', ['protocol', 'version', 'kind', 'status', 'identity', 'diagnostics']);
    const diagnostics = r.array(raw.diagnostics, '/diagnostics', 100).map((v, i) => {
      const f = `/diagnostics/${i}`,
        d = r.object(v, f, ['code', 'field', 'severity', 'message', 'suggestion']);
      r.constant(d.severity, 'error', `${f}/severity`);
      return {
        code: r.text(d.code, `${f}/code`, 1, 100),
        field: r.text(d.field, `${f}/field`, 1, 300),
        severity: 'error' as const,
        message: r.text(d.message, `${f}/message`, 1, 1000),
        suggestion: r.text(d.suggestion, `${f}/suggestion`, 1, 1000),
      };
    });
    if (!diagnostics.length) r.fail('PROTOCOL_INVALID', '/diagnostics', '失败必须有诊断。');
    const checked = r.finish(diagnostics);
    return checked.ok ? { ok: false, diagnostics: checked.value } : checked;
  }
  r.object(input, '', ['protocol', 'version', 'kind', 'status', 'identity', 'point']);
  r.constant(raw.status, 'ok', '/status');
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  return parseNetworkSnapshot(project, raw.point, expected);
}

/** Release has no result frame: resources must already be closed before this acknowledgement is emitted. */
export function acceptKernelRelease(input: unknown, expected: NetworkIdentity): Result<true> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    raw = r.object(input, '', ['protocol', 'version', 'kind', 'status', 'identity']);
  r.constant(raw.protocol, 'HydraulicKernel', '/protocol');
  r.constant(raw.version, 1, '/version', 'VERSION_UNSUPPORTED');
  r.constant(raw.kind, 'release', '/kind');
  r.constant(raw.status, 'ok', '/status');
  const id = identity(r, raw.identity);
  const keys = [
    'documentSessionId',
    'simulationSessionId',
    'physicsRevision',
    'tick',
    'controlSequence',
    'requestSequence',
  ] as const;
  if (keys.some((k) => id[k] !== expected[k]) || !closeTime(id.timeS, expected.timeS))
    r.fail('RESPONSE_STALE', '/identity', '释放确认身份不匹配。');
  return r.finish(true);
}
