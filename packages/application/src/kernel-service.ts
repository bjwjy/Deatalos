import {
  checkJson,
  ContractReader,
  diagnostic,
  isNetworkNativeStepS,
  type NetworkIdentity,
  type Result,
} from '@hyd/domain';
import type { MappingOptions } from '@hyd/engine';
import { legacyNetworkRecordCapacity, networkRecordMaximum, type RecordSelection } from './network-records.js';
interface RequestEnvelope {
  readonly clientSequence: number;
}
type ActiveRequest = RequestEnvelope & { readonly expected: NetworkIdentity };
/** Payload requirements are action-specific; v1 cannot express v2-only operations. */
export type KernelServiceRequest =
  | (RequestEnvelope & {
      readonly version: 1 | 2;
      readonly action: 'initialize';
      readonly expected: null;
      readonly project: unknown;
      readonly mapping: MappingOptions;
      readonly documentSessionId: string;
      readonly physicsRevision: number;
    })
  | (ActiveRequest & { readonly version: 1 | 2; readonly action: 'start'; readonly speed: number })
  | (ActiveRequest & { readonly version: 2; readonly action: 'start'; readonly speed: number; readonly ticks: number })
  | (ActiveRequest & {
      readonly version: 1 | 2;
      readonly action: 'control';
      readonly controls: unknown;
      readonly sequenceRunId?: string;
    })
  | (ActiveRequest & { readonly version: 1 | 2; readonly action: 'pause' | 'step' | 'reset' | 'state' | 'release' })
  | (ActiveRequest & { readonly version: 2; readonly action: 'state'; readonly view: 'reference-v1' })
  | (ActiveRequest & {
      readonly version: 2;
      readonly action: 'records' | 'control-records';
      readonly selection: RecordSelection;
    })
  | (ActiveRequest & { readonly version: 2; readonly action: 'capture' | 'recover' | 'pause-bounded' })
  | (ActiveRequest & {
      readonly version: 2;
      readonly action: 'sequence-start';
      readonly project: unknown;
      readonly ticks?: number;
    })
  | (ActiveRequest & {
      readonly version: 2;
      readonly action: 'sequence-resume';
      readonly sequenceRunId: string;
      readonly ticks?: number;
    })
  | (ActiveRequest & { readonly version: 2; readonly action: 'sequence-stop'; readonly sequenceRunId: string });

type Command<R> = R extends KernelServiceRequest
  ? Omit<R, keyof RequestEnvelope | 'version' | 'expected' | 'view'>
  : never;
/** Local intent; the transport adds and validates the current sequence/identity envelope. */
export type KernelServiceCommand = Command<KernelServiceRequest>;
/** Renderer-owned data only: no command strings, paths, executable or arbitrary channel. */
export function parseKernelServiceRequest(input: unknown): Result<KernelServiceRequest> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', [
      'version',
      'clientSequence',
      'action',
      'expected',
      'project',
      'mapping',
      'controls',
      'speed',
      'documentSessionId',
      'physicsRevision',
      'selection',
      'sequenceRunId',
      'view',
      'ticks',
    ]);
  if (o.version !== 1 && o.version !== 2)
    r.fail('VERSION_UNSUPPORTED', '/version', '仅支持显式v1兼容请求与v2分页请求。');
  const seq = r.number(o.clientSequence, '/clientSequence', 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(seq)) r.fail('IDENTITY_INVALID', '/clientSequence', '请求序号必须是安全整数。');
  const actions = [
    'initialize',
    'start',
    'pause',
    'step',
    'control',
    'reset',
    'state',
    'release',
    'records',
    'capture',
    'recover',
    'control-records',
    'sequence-start',
    'sequence-resume',
    'sequence-stop',
    'pause-bounded',
  ] as const;
  const action = actions.find((a) => a === o.action) ?? 'state';
  if (!actions.some((a) => a === o.action)) r.fail('PROTOCOL_OPERATION_INVALID', '/action', '未知运行服务操作。');
  if (
    o.version === 1 &&
    (action === 'records' ||
      action === 'capture' ||
      action === 'control-records' ||
      action === 'recover' ||
      action === 'pause-bounded' ||
      o.ticks !== undefined ||
      action.startsWith('sequence-'))
  )
    r.fail('VERSION_UNSUPPORTED', '/action', '分页读取须使用v2；v1保持原操作与响应。');
  r.object(input, '', [
    'version',
    'clientSequence',
    'action',
    ...(action === 'initialize'
      ? ['project', 'mapping', 'documentSessionId', 'physicsRevision', 'expected']
      : ['expected']),
    ...(action === 'control' ? ['controls'] : []),
    ...(action === 'sequence-start' ? ['project'] : []),
    ...(action === 'sequence-resume' || action === 'sequence-stop' || action === 'control' ? ['sequenceRunId'] : []),
    ...(action === 'start' ? ['speed'] : []),
    ...(action === 'start' || action === 'sequence-start' || action === 'sequence-resume' ? ['ticks'] : []),
    ...(action === 'records' || action === 'control-records' ? ['selection'] : []),
    ...(action === 'state' && o.version === 2 ? ['view'] : []),
  ]);
  if ((action === 'initialize' || action === 'sequence-start') && !('project' in o))
    r.fail('PROTOCOL_INVALID', '/project', '此操作必须提供工程数据。');
  if (action === 'control' && !('controls' in o)) r.fail('PROTOCOL_INVALID', '/controls', '控制操作必须提供控制数据。');
  let mapping: MappingOptions | undefined,
    expected: NetworkIdentity | null = null;
  if (action === 'initialize') {
    if (o.expected !== undefined && o.expected !== null)
      r.fail('IDENTITY_INVALID', '/expected', '初始化不接受旧运行身份。');
    const m = r.object(o.mapping, '/mapping', [
      'nativeStepS',
      'lowPressureModel',
      'junctionPolicy',
      'initialPressurePa',
      'volumeScale',
      'constraintPressureTolerancePa',
    ]);
    if (!isNetworkNativeStepS(m.nativeStepS))
      r.fail('CLOCK_INVALID', '/mapping/nativeStepS', '只支持声明的原生步长；具体模型集由worker再验证。');
    if (m.junctionPolicy !== 'strict' && m.junctionPolicy !== 'tlm-limit')
      r.fail('MAPPING_CONFIG_INVALID', '/mapping/junctionPolicy', '须声明近似政策。');
    if (m.lowPressureModel !== undefined && m.lowPressureModel !== 'equivalent-cavity-v1')
      r.fail('MAPPING_CONFIG_INVALID', '/mapping/lowPressureModel', '未知的低压模型。');
    mapping = {
      ...(m.lowPressureModel === 'equivalent-cavity-v1' ? { lowPressureModel: m.lowPressureModel } : {}),
      nativeStepS: isNetworkNativeStepS(m.nativeStepS) ? m.nativeStepS : 0.0001,
      junctionPolicy: m.junctionPolicy === 'strict' ? 'strict' : 'tlm-limit',
      initialPressurePa: r.number(m.initialPressurePa, '/mapping/initialPressurePa', 0, 1e12),
      volumeScale: r.number(m.volumeScale, '/mapping/volumeScale', 0.25, 4),
      constraintPressureTolerancePa: r.number(
        m.constraintPressureTolerancePa,
        '/mapping/constraintPressureTolerancePa',
        1e-12,
        1000,
      ),
    };
  } else {
    const e = r.object(o.expected, '/expected', [
      'documentSessionId',
      'physicsRevision',
      'simulationSessionId',
      'tick',
      'timeS',
      'controlSequence',
      'requestSequence',
    ]);
    const n = (k: string) => {
      const v = r.number(e[k], '/expected/' + k, 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(v)) r.fail('IDENTITY_INVALID', '/expected/' + k, '序号必须是安全整数。');
      return v;
    };
    expected = {
      documentSessionId: r.id(e.documentSessionId, '/expected/documentSessionId'),
      simulationSessionId: r.id(e.simulationSessionId, '/expected/simulationSessionId'),
      physicsRevision: n('physicsRevision'),
      tick: n('tick'),
      timeS: r.number(e.timeS, '/expected/timeS', 0, 1e12),
      controlSequence: n('controlSequence'),
      requestSequence: n('requestSequence'),
    };
  }
  const speed = action === 'start' ? r.number(o.speed, '/speed', 0.25, 2) : undefined;
  if (speed !== undefined && ![0.25, 0.5, 1, 2].includes(speed))
    r.fail('CLOCK_INVALID', '/speed', '倍速仅支持0.25/0.5/1/2。');
  const revision =
    action === 'initialize' ? r.number(o.physicsRevision, '/physicsRevision', 0, Number.MAX_SAFE_INTEGER) : undefined;
  if (revision !== undefined && !Number.isSafeInteger(revision))
    r.fail('IDENTITY_INVALID', '/physicsRevision', '物理修订必须是安全整数。');
  let selection: RecordSelection | undefined;
  if (action === 'records' || action === 'control-records') {
    const s = r.object(o.selection, '/selection', ['simulationSessionId', 'offset', 'limit']);
    const maxOffset = action === 'records' ? networkRecordMaximum : legacyNetworkRecordCapacity;
    const offset = r.number(s.offset, '/selection/offset', 0, maxOffset),
      limit = r.number(s.limit, '/selection/limit', 1, 20);
    if (![offset, limit].every(Number.isSafeInteger))
      r.fail('RECORD_RANGE_INVALID', '/selection', '分页参数必须是整数。');
    selection = {
      simulationSessionId:
        s.simulationSessionId === null ? null : r.id(s.simulationSessionId, '/selection/simulationSessionId'),
      offset,
      limit,
    };
  }
  const envelope = { version: o.version === 1 ? (1 as const) : (2 as const), clientSequence: seq };
  if (action === 'initialize' && mapping && revision !== undefined)
    return r.finish({
      ...envelope,
      action,
      expected: null,
      project: o.project,
      mapping,
      documentSessionId: r.id(o.documentSessionId, '/documentSessionId'),
      physicsRevision: revision,
    });
  // Initialization returned above; other operations require a parsed active identity.
  const incomplete = (): Result<never> => ({
    ok: false,
    diagnostics: [...r.diagnostics, diagnostic('PROTOCOL_INVALID', '/action', '操作数据不完整。')],
  });
  if (!expected) return incomplete();
  const active = { ...envelope, expected };
  let ticks: number | undefined;
  if (o.ticks !== undefined) {
    ticks = r.number(o.ticks, '/ticks', 1, 10000);
    if (!Number.isSafeInteger(ticks)) r.fail('CLOCK_INVALID', '/ticks', '有限运行步数必须为1至10000的整数。');
    if (action === 'start' && speed !== 1) r.fail('CLOCK_INVALID', '/speed', '有限运行仅使用固定步长和1倍速。');
  }
  switch (action) {
    case 'start':
      return speed === undefined
        ? incomplete()
        : ticks === undefined
          ? r.finish({ ...active, action, speed })
          : r.finish({ ...active, version: 2, action, speed, ticks });
    case 'control':
      return r.finish({
        ...active,
        action,
        controls: o.controls,
        ...(o.sequenceRunId !== undefined ? { sequenceRunId: r.id(o.sequenceRunId, '/sequenceRunId') } : {}),
      });
    case 'records':
    case 'control-records':
      if (selection) return r.finish({ ...active, version: 2, action, selection });
      break;
    case 'capture':
    case 'recover':
    case 'pause-bounded':
      return r.finish({ ...active, version: 2, action });
    case 'sequence-start':
      return r.finish({ ...active, version: 2, action, project: o.project, ...(ticks === undefined ? {} : { ticks }) });
    case 'sequence-resume':
      return r.finish({
        ...active,
        version: 2,
        action,
        sequenceRunId: r.id(o.sequenceRunId, '/sequenceRunId'),
        ...(ticks === undefined ? {} : { ticks }),
      });
    case 'sequence-stop':
      return r.finish({ ...active, version: 2, action, sequenceRunId: r.id(o.sequenceRunId, '/sequenceRunId') });
    case 'pause':
    case 'step':
    case 'reset':
    case 'release':
      return r.finish({ ...active, action });
    case 'state':
      if (o.view !== undefined) {
        r.constant(o.view, 'reference-v1', '/view');
        return r.finish({ ...active, version: 2, action, view: 'reference-v1' });
      }
      return r.finish({ ...active, action });
  }
  return incomplete();
}
