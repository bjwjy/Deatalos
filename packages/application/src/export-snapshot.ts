import {
  diagnostic,
  immutable,
  type Diagnostic,
  type ProjectDocument,
  type Result,
  type SimulationState,
} from '@hyd/domain';
import type { Controls, Solution } from '@hyd/engine';
import type { ControlEvent, HistoricalRun, Identity, RunPoint, Sample } from './records.js';
import type { SimulationConfig } from './simulation.js';

export type ExportSelection =
  | { readonly kind: 'diagram' | 'preview' | 'current-run' }
  | { readonly kind: 'history'; readonly documentSessionId: string; readonly runId: number };

interface ExportSource {
  readonly document: ProjectDocument;
  readonly documentSessionId: string;
  readonly documentRevision: number;
  readonly physicsRevision: number;
  readonly layoutRevision: number;
  readonly runtime: {
    readonly identity: Identity;
    readonly state: SimulationState;
    readonly controls: Controls;
    readonly result: Result<Solution>;
    readonly lastStep: RunPoint | null;
    readonly samples: readonly Sample[];
    readonly truncated: boolean;
    readonly controlEvents: readonly ControlEvent[];
    readonly scheduledControls: readonly Omit<ControlEvent, 'phase'>[];
    readonly simulation: {
      readonly config: SimulationConfig;
      readonly samplesDropped: number;
      readonly eventsTruncated: boolean;
      readonly diagnostics: readonly Diagnostic[];
    };
  };
  readonly historicalRuns: readonly HistoricalRun[];
}

export interface ExportSnapshot {
  readonly format: 'HydraulicWorkbenchResult';
  readonly version: 1;
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly appVersion: string;
  readonly solverId: string;
  readonly modelVersion: string;
  readonly selection: ExportSelection;
  readonly document: ProjectDocument;
  readonly documentSessionId: string;
  readonly documentRevision: number;
  readonly physicsRevision: number;
  readonly layoutRevision: number;
  readonly runId: number;
  readonly point: RunPoint | null;
  readonly initialState: SimulationState;
  readonly initialControls: Controls;
  readonly config: SimulationConfig;
  readonly controlEvents: readonly ControlEvent[];
  readonly scheduledControls: readonly Omit<ControlEvent, 'phase'>[];
  readonly samples: readonly Sample[];
  readonly manualPreviews: readonly Sample[];
  readonly record: {
    readonly samplesDropped: number;
    readonly samplesTruncated: boolean;
    readonly eventsTruncated: boolean;
    readonly sampleIntervalSeconds: number;
    readonly replay: 'complete-step-events' | 'incomplete' | 'not-a-trajectory';
  };
  readonly diagnostics: readonly Diagnostic[];
  readonly assumptions: readonly string[];
}

export const exportAssumptions = Object.freeze([
  '准静态计算与动作演示，非瞬态液压仿真；忽略惯性与压缩性，未单独建模泄漏。',
  '仅指定单泵、单换向阀、单执行器基础回路；正阻力负载，理想离散O/M机能与原管损假设。',
  '封闭腔压力及保持能力未求解；unknown不等于零，初选不等于强度或厂家校核。',
  '管线有符号流量以文件from→to为正；负流量代表反向，不是负的流量幅值。',
  'step事件tick=n作用于[(n-1)h,nh]；preview不进入轨迹，未来排队控制尚未生效。',
]);

const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/export', message)],
});

/** One synchronous capture; no solving, clock reads, UI reads or file effects. */
export function captureExport(
  source: ExportSource,
  selection: ExportSelection,
  context: { readonly snapshotId: string; readonly capturedAt: string; readonly appVersion: string },
): Result<ExportSnapshot> {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(context.snapshotId) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(context.capturedAt) ||
    !Number.isFinite(Date.parse(context.capturedAt)) ||
    !context.appVersion ||
    context.appVersion.length > 40
  )
    return fail('EXPORT_CONTEXT_INVALID', '导出身份、版本或时间无效。');

  if (!['diagram', 'preview', 'current-run', 'history'].includes(selection.kind))
    return fail('EXPORT_SELECTION_INVALID', '导出来源无效。');
  const history =
    selection.kind === 'history'
      ? source.historicalRuns.find(
          (run) => run.documentSessionId === selection.documentSessionId && run.runId === selection.runId,
        )
      : undefined;
  if (selection.kind === 'history' && !history)
    return fail('EXPORT_HISTORY_MISSING', '所选历史运行已被淘汰，请重新选择。');
  const doc = history?.document ?? source.document;
  const simulation = source.runtime.simulation;
  const config = history?.config ?? simulation.config;
  const preview: RunPoint = {
    identity: source.runtime.identity,
    state: source.runtime.state,
    controls: source.runtime.controls,
    result: source.runtime.result,
    controlSequence: source.runtime.controlEvents.reduce((n, event) => Math.max(n, event.sequence), 0),
    source: 'static-preview',
  };
  const point =
    selection.kind === 'diagram'
      ? null
      : selection.kind === 'preview'
        ? preview
        : history
          ? history.lastStep
          : source.runtime.lastStep;
  if (selection.kind !== 'diagram' && selection.kind !== 'preview' && !point)
    return fail('EXPORT_NO_TRAJECTORY', '此运行尚无成功计算步；可选择静态预览或纯图。');
  const samples = history?.samples ?? source.runtime.samples;
  const events = history?.controlEvents ?? source.runtime.controlEvents;
  const samplesDropped = history?.samplesDropped ?? simulation.samplesDropped;
  const samplesTruncated = history?.truncated ?? source.runtime.truncated;
  const eventsTruncated = history?.eventsTruncated ?? simulation.eventsTruncated;
  const trajectory = selection.kind === 'current-run' || selection.kind === 'history';
  const result = point?.result ?? (selection.kind === 'diagram' ? source.runtime.result : undefined);
  const diagnostics = !result ? [] : result.ok ? result.value.diagnostics : result.diagnostics;
  return {
    ok: true,
    value: immutable({
      format: 'HydraulicWorkbenchResult',
      version: 1,
      ...context,
      selection,
      document: doc,
      solverId: result?.ok ? result.value.solverId : doc.provenance.preferredSolverId,
      modelVersion: result?.ok ? result.value.modelVersion : doc.provenance.modelVersion,
      documentSessionId: history?.documentSessionId ?? source.documentSessionId,
      documentRevision: history?.documentRevision ?? source.documentRevision,
      physicsRevision: history?.physicsRevision ?? source.physicsRevision,
      layoutRevision: history?.layoutRevision ?? source.layoutRevision,
      runId: history?.runId ?? source.runtime.identity.runId,
      point,
      initialState: history?.initialState ?? {
        tick: 0,
        timeS: 0,
        actuatorStates: doc.design.initialConditions.actuators,
      },
      initialControls: history?.initialControls ?? { valves: doc.design.initialConditions.valves },
      config,
      controlEvents: events,
      scheduledControls: history ? [] : source.runtime.scheduledControls,
      samples: trajectory ? samples.filter((s) => s.source !== 'manual') : [],
      manualPreviews: trajectory ? samples.filter((s) => s.source === 'manual') : [],
      record: {
        samplesDropped,
        samplesTruncated,
        eventsTruncated,
        sampleIntervalSeconds: config.stepSeconds * config.sampleEveryTicks,
        replay: !trajectory
          ? 'not-a-trajectory'
          : eventsTruncated || samplesTruncated
            ? 'incomplete'
            : 'complete-step-events',
      },
      diagnostics: [...diagnostics, ...(history ? [] : simulation.diagnostics)],
      assumptions: exportAssumptions,
    }),
  };
}
