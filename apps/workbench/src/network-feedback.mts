import { type NetworkProject } from '@hyd/domain';
import { folderUserGuide } from '@hyd/project-io';

import {
  componentDisplayName,
  networkDefinition,
  networkPortActive,
  parameterDisplayName,
  networkObjectDisplayName,
  diagnosticPresentation,
  groupDisplayDiagnostics,
  type DisplayDiagnostic,
} from '@hyd/domain';

import { element as $, setText } from './network-dom.mjs';
import {
  createDiagnosticBatches,
  type DiagnosticSubject,
  type DiagnosticTarget,
} from './network-diagnostic-batches.mjs';
import { presentNetworkRun } from './network-v13-operation-feedback.mjs';
import type { NetworkDraftSession, NetworkRuntimeView } from '@hyd/application';
interface FeedbackHooks {
  editor(): NetworkDraftSession;
  runtime(): NetworkRuntimeView | null;
  error(): string;
  invalidated(): boolean;
  initializationProgress(): { readonly percent: number; readonly stage: string } | null;
}
type DiagnosticContext = {
  sessionId: string;
  revision: number;
  operation: number;
  source: string;
  document: NetworkProject | null;
};
export function createNetworkFeedback(hooks: FeedbackHooks) {
  $('projectFolderGuide').textContent = folderUserGuide;
  let activeDiagnostics: readonly DisplayDiagnostic[] = [];
  let diagnosticOperation = 0,
    activeDiagnosticContext: DiagnosticContext | null = null;
  const batches = createDiagnosticBatches(diagnosticSubject);
  const progress = $('initializationProgress');
  let progressDelay: number | undefined;
  function showInitializationProgress(pending: ReturnType<FeedbackHooks['initializationProgress']>): void {
    if (!pending) {
      if (progressDelay !== undefined) window.clearTimeout(progressDelay);
      progressDelay = undefined;
      if (!progress.hidden) progress.hidden = true;
      return;
    }
    const value = String(pending.percent);
    if (progress.getAttribute('aria-valuenow') !== value) {
      progress.setAttribute('aria-valuenow', value);
      progress.style.setProperty('--completed', value + '%');
    }
    progress.setAttribute('aria-valuetext', pending.stage + '，' + value + '%');
    if (progress.hidden && progressDelay === undefined) {
      progressDelay = window.setTimeout(() => {
        progressDelay = undefined;
        progress.hidden = !hooks.initializationProgress();
      }, 500);
    }
  }
  function selectDiagnostics() {
    const editor = hooks.editor();
    if (
      activeDiagnosticContext &&
      (activeDiagnosticContext.sessionId !== editor.documentSessionId ||
        activeDiagnosticContext.revision !== editor.physicsRevision)
    ) {
      activeDiagnostics = [];
      activeDiagnosticContext = null;
    }
    batches.select(editor.documentSessionId, editor.physicsRevision);
  }
  function clearDiagnostics(): void {
    diagnosticOperation++;
    activeDiagnostics = [];
    activeDiagnosticContext = null;
    batches.clearOperation();
  }
  function diagnostics(
    items: readonly DisplayDiagnostic[],
    source = '工程操作',
    document: NetworkProject | null = hooks.editor().document,
  ) {
    selectDiagnostics();
    activeDiagnostics = items.filter(
      (d, i) => items.findIndex((other) => JSON.stringify(other) === JSON.stringify(d)) === i,
    );
    activeDiagnosticContext = {
      sessionId: hooks.editor().documentSessionId,
      revision: hooks.editor().physicsRevision,
      operation: ++diagnosticOperation,
      source,
      document,
    };
    batches.operation(activeDiagnostics, source, document, hooks.editor().document.title);
    renderFeedback();
  }
  function renderFeedback(): void {
    selectDiagnostics();
    const current =
      hooks.runtime()?.identity?.documentSessionId === hooks.editor().documentSessionId &&
      hooks.runtime()?.identity?.physicsRevision === hooks.editor().physicsRevision;
    const errors: readonly DisplayDiagnostic[] = current
      ? (hooks.runtime()?.diagnostics?.filter((d) => d.severity === 'error') ?? [])
      : [];
    const groups = groupDisplayDiagnostics(errors, (d) => diagnosticObject(d));
    const brief = (items: ReturnType<typeof groupDisplayDiagnostics>) =>
      items
        .slice(0, 3)
        .map(
          (g) =>
            `${g.object}：${diagnosticPresentation(g.items[0]!).title}${g.items.length > 1 ? `（${g.items.length}项）` : ''}`,
        )
        .join('；') + (items.length > 3 ? `；另${items.length - 3}组见诊断` : '');
    const initializing = hooks.initializationProgress();
    showInitializationProgress(initializing);
    const summary =
      hooks.error() ||
      (initializing
        ? `正在初始化仿真 · ${initializing.percent}% · ${initializing.stage}`
        : hooks.invalidated()
          ? '设计已修改，旧结果已失效；点击运行重新初始化。'
          : current && hooks.runtime()?.status === 'failed'
            ? `运行已隔离；没有当前有效结果。${hooks.runtime()?.lastSuccessfulHistorical ? '可恢复到最后有效点。' : ''}${brief(groups)}`
            : errors.length && !hooks.runtime()?.running
              ? `保护性暂停：${brief(groups)}`
              : current && hooks.runtime()?.status === 'ready'
                ? hooks.runtime()?.running
                  ? '运行中 · 10 ms宿主步长'
                  : hooks.runtime()?.sequence?.status === 'completed'
                    ? '自动动作已完成；复位可返回设计初态，再点运行重新演示。'
                    : hooks.runtime()?.sequence?.status === 'stopped'
                      ? '自动控制已停止；点击运行可重新开始，复位将返回设计初态。'
                      : '已暂停 · 点击运行继续；复位将返回设计初态。'
                : activeDiagnosticContext?.source === '初始化'
                  ? '初始化未完成；检查诊断后重试。'
                  : '未初始化；点击运行初始化。');
    const operationGroups = groupDisplayDiagnostics(activeDiagnostics, (d) =>
      diagnosticObject(d, activeDiagnosticContext?.document ?? null),
    );
    const feedback =
      summary +
      (operationGroups.length ? ` 本次${activeDiagnosticContext?.source ?? '操作'}：${brief(operationGroups)}` : '');
    // Presentation follows the accepted current runtime; pending requests alone never mean running.
    const runtime = hooks.runtime();
    $('recoverRun').hidden =
      !current || hooks.invalidated() || runtime?.status !== 'failed' || !runtime.lastSuccessfulHistorical;
    const running = current && runtime?.status === 'ready' && runtime.running && !hooks.error() && !hooks.invalidated();
    const runButton = $('run');
    if (runButton.dataset.running !== String(running)) runButton.dataset.running = String(running);
    presentNetworkRun(
      initializing
        ? 'starting'
        : running
          ? 'running'
          : current && runtime?.status === 'ready' && !hooks.invalidated() && !hooks.error()
            ? runButton.dataset.iconPhase === 'idle'
              ? 'idle'
              : 'paused'
            : 'idle',
    );
    const runLabel = running ? '运行（正在运行）' : '运行';
    if (runButton.getAttribute('aria-label') !== runLabel) runButton.setAttribute('aria-label', runLabel);
    setText($('runStatus'), feedback);
    const statusClass =
      hooks.error() || (current && hooks.runtime()?.status === 'failed')
        ? 'error'
        : current && hooks.runtime()?.status === 'ready' && !hooks.invalidated()
          ? 'good'
          : 'muted';
    if ($('runStatus').className !== statusClass) $('runStatus').className = statusClass;
    setText($('status'), feedback);
    batches.runtime(current ? runtime : null);
    renderDiagnostics();
  }
  function diagnosticObject(d: DisplayDiagnostic, document: NetworkProject | null = hooks.editor().document): string {
    return diagnosticSubject(d, document).object;
  }
  function diagnosticSubject(d: DisplayDiagnostic, document: NetworkProject | null): DiagnosticSubject {
    if (!document) return { object: '待打开文件' };
    const parts = (d.field ?? '').split('/');
    const group = parts[1] === 'design' ? parts[2] : undefined;
    const ref = parts[3] ?? '';
    const index = /^\d+$/.test(ref) ? Number(ref) : -1;
    const initial = group === 'initialConditions' ? document.design.initialConditions[index] : undefined;
    const explicitComponent =
      document.design.components.find((c) => c.id === (d.componentId ?? initial?.componentId)) ??
      (group === 'components'
        ? (document.design.components.find((c) => c.id === ref) ?? document.design.components[index])
        : undefined);
    const c =
      explicitComponent ??
      document.design.components.find((c) => parts.includes(c.id) || d.message.includes(c.id + ':'));
    const edge =
      group === 'connections'
        ? (document.design.connections.find((item) => item.id === ref) ?? document.design.connections[index])
        : document.design.connections.find((item) => parts.includes(item.id));
    const node =
      group === 'nodes'
        ? (document.design.nodes.find((item) => item.id === ref) ?? document.design.nodes[index])
        : undefined;
    const key = parts.at(-1) ?? '';
    const port =
      c &&
      networkDefinition(c.definition.id, c.definition.version)?.ports.find(
        (item) => item.id === key && networkPortActive(c, item.id),
      );
    const parameter = parameterDisplayName(key);
    const object = c
      ? c.label || componentDisplayName(c.typeId, c.definition.id)
      : edge
        ? networkObjectDisplayName(document, 'connection', edge.id)
        : node
          ? networkObjectDisplayName(document, 'node', node.id)
          : '当前工程';
    let target: DiagnosticTarget | undefined;
    if (explicitComponent) {
      target = port
        ? { kind: 'port', componentId: explicitComponent.id, portId: port.id, signal: port.domain === 'signal' }
        : { kind: 'component', id: explicitComponent.id };
    } else if (edge && group === 'connections') target = { kind: 'connection', id: edge.id };
    else if (node) target = { kind: 'node', id: node.id };
    return {
      object:
        object +
        (port
          ? ` · ${port.domain === 'signal' ? '信号口' : '油口'} ${port.id}`
          : parameter !== '参数'
            ? ` · ${parameter}`
            : ''),
      ...(port ? { headlineSubject: `${object} 的 ${port.id} 口` } : {}),
      ...(target ? { target } : {}),
    };
  }
  let renderDiagnostics = () => {};
  return {
    diagnosticView() {
      selectDiagnostics();
      return batches.view;
    },
    connectDiagnosticPanel(render: () => void) {
      renderDiagnostics = render;
    },
    archiveDiagnostics(): readonly DisplayDiagnostic[] {
      selectDiagnostics();
      return [
        ...[...batches.view.history].reverse().flatMap((batch) => batch.rows.map((row) => row.diagnostic)),
        ...batches.view.information.map((row) => row.diagnostic),
      ];
    },
    toolDiagnostics(): readonly DisplayDiagnostic[] {
      return activeDiagnosticContext?.sessionId === hooks.editor().documentSessionId ? [...activeDiagnostics] : [];
    },
    clear: clearDiagnostics,
    show: diagnostics,
    render: renderFeedback,
    objectFor: diagnosticObject,
    get operation() {
      return diagnosticOperation;
    },
    get source() {
      return activeDiagnosticContext?.source;
    },
  };
}

export type NetworkFeedback = ReturnType<typeof createNetworkFeedback>;
