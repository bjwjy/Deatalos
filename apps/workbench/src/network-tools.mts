import {
  NetworkTools,
  NetworkToolCurves,
  compareCylinders,
  networkToolBase,
  networkToolParameterChanges,
  parseNetworkToolRequest,
  parseServiceResult,
  type NetworkDraftSession,
  type NetworkToolRequest,
  type NetworkToolSource,
  type NetworkExportCapture,
} from '@hyd/application';
import {
  checkJson,
  ContractReader,
  diagnostic,
  isLinearActuatorType,
  type DisplayDiagnostic,
  type Result,
} from '@hyd/domain';
import { toolCurveArtifact } from './network-tool-curves.mjs';
import { createToolFileDialogs } from './network-tool-files.mjs';
import { createToolSettings } from './network-tool-settings.mjs';
import type { createNetworkAppSettings } from './network-app-settings.mjs';
import type { createNetworkCanvas } from './network-canvas-controller.mjs';
import type { createNetworkFiles } from './network-file-controller.mjs';
import type { createNetworkFormalExport } from './network-formal-export.mjs';
import type { createNetworkRecovery } from './network-recovery.mjs';
import type { NetworkRuntime } from './network-runtime-controller.mjs';
import { element } from './network-dom.mjs';
import { setupNetworkAiSettings } from './network-ai-settings.mjs';
import { createAiCandidateNotices } from './network-ai-notices.mjs';
import { createAiCandidateHistory } from './network-ai-candidate-history.mjs';
import { candidateReplay, recordCandidate } from './network-ai-candidate-record.mjs';
import { showNetworkNotice } from './network-shell.mjs';
import { diagnosticToolSnapshot, type DiagnosticView } from './network-diagnostic-batches.mjs';
declare global {
  interface Window {
    networkTools: {
      start(sessionId: string): Promise<unknown>;
      stop(): Promise<unknown>;
      lifecycle(input: unknown): Promise<boolean>;
      reply(input: unknown): Promise<boolean>;
      onRequest(callback: (input: unknown) => void): () => void;
      onCancel(callback: (input: unknown) => void): () => void;
      onDisabled(callback: () => void): () => void;
    };
  }
}
interface Credentials {
  readonly connectionId: string;
}
interface Hooks {
  settings: ReturnType<typeof createNetworkAppSettings>;
  canvas: ReturnType<typeof createNetworkCanvas>;
  showDiagnostics(items: readonly DisplayDiagnostic[], source: string): void;
  history(projectId: string): Promise<readonly NetworkExportCapture[]>;
  files: ReturnType<typeof createNetworkFiles>;
  formalExport: ReturnType<typeof createNetworkFormalExport>;
  recovery: ReturnType<typeof createNetworkRecovery>;
  editor(): NetworkDraftSession;
  runtime: NetworkRuntime;
  diagnostics(): readonly DisplayDiagnostic[];
  diagnosticView(): DiagnosticView;
  commit(action: () => Result<true>): boolean;
  uid(prefix: string): string;
}
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/tools', message)],
});
/** Native bridge and transient presentation only. Protocol/proposal state lives in application NetworkTools. */
export function createNetworkTools(hooks: Hooks) {
  const tools = new NetworkTools();
  const curves = new NetworkToolCurves();
  const settingsDialogs = createToolSettings({
    settings: hooks.settings,
    uid: hooks.uid,
    base: () => networkToolBase(hooks.editor(), source()),
    notify: showNetworkNotice,
  });
  const fileDialogs = createToolFileDialogs({
    ...hooks,
    enqueue: (action) => hooks.runtime.enqueue(action),
    importCurve: (input, base) =>
      curves.importFile(base, networkToolBase(hooks.editor(), source()), input, hooks.uid('curve-source')),
    base: () => networkToolBase(hooks.editor(), source()),
    curve: (action) => {
      const found = curves.get(networkToolBase(hooks.editor(), source()), action.curveId);
      if (!found.ok) return found;
      const artifact = toolCurveArtifact(found.value, action);
      if (!artifact.ok) return artifact;
      if (found.value.kind === 'imported') {
        const imported = found.value;
        return {
          ok: true,
          value: {
            artifact: artifact.value,
            summary:
              '导入的冻结曲线：' +
              imported.curve.label +
              ' (' +
              imported.curve.unit +
              ')' +
              '\n原始来源：' +
              imported.file.snapshotId +
              '\n身份级别：' +
              imported.file.identityLevel +
              '\n所存样本：' +
              imported.samples.length +
              (action.format === 'csv'
                ? '\nCSV分段：' + (action.segment + 1) + '/' + Math.max(1, Math.ceil(imported.samples.length / 2000))
                : '') +
              '\n此文件不是当前求解结果，不补造缺失的身份或数值。',
          },
        };
      }
      const plan = found.value.plan;
      return {
        ok: true,
        value: {
          artifact: artifact.value,
          summary:
            plan.label +
            ' (' +
            plan.unit +
            ')' +
            '\n信号：' +
            plan.request.target.objectId +
            ' / ' +
            plan.request.target.field +
            '\n时间范围：' +
            plan.request.fromS +
            '–' +
            plan.request.toS +
            ' s' +
            '\n真实样本：' +
            plan.samples.length +
            '；导出选点：' +
            plan.indices.length +
            (action.format === 'csv'
              ? '\nCSV 分段：' + (action.segment + 1) + ' / ' + plan.segments.length + '（本次只保存此段）'
              : ''),
        },
      };
    },
    catalog: (action) => tools.catalogPreview(hooks.editor(), source(), action.calculationId),
    calculation: (action) =>
      tools.calculationRecord(hooks.editor(), source(), action.calculationId, action.recordSelection),
  });
  let credentials: Credentials | null = null,
    transition: 'idle' | 'starting' | 'stopping' | 'stop-failed' = 'idle',
    projectSession = '',
    generation = 0,
    stamp = '',
    activeProposalId = '';
  const origins = new Map<string, string>();
  const filesByRequest = new Map<string, string>();
  const settingsByRequest = new Map<string, string>();
  const cancelled = new Set<string>(),
    proposalsByRequest = new Map<string, string>();
  const root = element('externalTools');
  root.innerHTML = `<section id="aiConnection">
      <h3>本机连接</h3>
      <p id="toolConnectionSummary" role="status"></p>
      <p class="muted ai-connection-note">通过 hydraulic MCP 连接已保存的文件夹工程。改图候选需要在工作台确认，切换工程后旧连接和待确认候选会退役。</p>
      <button type="button" id="openAiControlSettings">AI 控制设置…</button>
    </section>
    <section id="aiCandidatePane">
      <h3>修改候选</h3>
      <p id="aiCandidateEmpty" class="b3-result-state">没有待确认的修改。AI 提交的候选会在这里显示。</p>
      <p id="aiCandidateStatus" role="status" class="muted"></p>
      <div id="toolProposal" hidden>
        <label>待确认候选<select id="toolProposalChoice"></select></label>
        <p id="toolProposalOrigin"></p>
        <div id="toolParameterChanges"></div>
        <p id="toolProposalKind"></p>
        <p id="toolValidation" class="muted"></p>
        <details><summary>逐项修改（原值 → 候选）</summary><pre id="toolChanges"></pre></details>
        <div class="ai-dialog-actions">
          <button type="button" id="rejectToolProposal">拒绝此候选</button>
          <button type="button" id="acceptToolProposal" class="dialog-primary">接受并应用（一次撤销）</button>
        </div>
      </div>
    </section>`;
  const toggleElement = element('allowAiOperations');
  if (!(toggleElement instanceof HTMLInputElement)) throw new Error('AI permission must be a switch');
  const toggle = toggleElement;
  const preferenceKey = 'deatalos.ai.control';
  let allowed = true;
  try {
    allowed = localStorage.getItem(preferenceKey) !== 'off';
  } catch {
    /* Use session preference. */
  }
  toggle.checked = allowed;
  const folderReady = () => hooks.files.canConnectMcp;
  const choiceElement = element('toolProposalChoice');
  if (!(choiceElement instanceof HTMLSelectElement)) throw new Error('Proposal choice must be a select');
  const choice = choiceElement;
  const quickElement = element('enableAi');
  if (!(quickElement instanceof HTMLButtonElement)) throw new Error('AI shortcut must be a button');
  const quick = quickElement;
  function selectedProposal() {
    return tools.pendingProposals.find((p) => p.id === activeProposalId) ?? tools.pending;
  }
  function openProposal(id: string, focusApply = false) {
    if (!tools.pendingProposals.some((proposal) => proposal.id === id)) {
      showNetworkNotice('候选已退役，请重新读取并生成。');
      return;
    }
    activeProposalId = id;
    stamp = '';
    render();
    const dialog = element('externalToolsDialog');
    if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
    dialog.dispatchEvent(new Event('show-ai-candidate'));
    if (focusApply) element('acceptToolProposal').focus();
  }
  const notices = createAiCandidateNotices(openProposal, acceptProposal);
  choice.addEventListener('change', () => {
    activeProposalId = choice.value;
    stamp = '';
    render();
  });
  function renderQuick() {
    const busy = transition === 'starting' || transition === 'stopping';
    quick.disabled = busy;
    quick.setAttribute('aria-busy', String(busy));
    quick.setAttribute('aria-pressed', String(allowed));
    const action =
      transition === 'stop-failed' ? '重试关闭 AI 连接' : allowed ? '关闭本次 AI 控制' : '开启本次 AI 控制';
    quick.setAttribute('aria-label', action);
    quick.dataset.tip = action;
    const state = transition === 'idle' ? (credentials ? 'enabled' : 'disabled') : transition;
    toggle.dataset.connectionState = state;
    quick.dataset.aiState = state;
    quick.querySelector('.ai-status-mark')?.setAttribute('d', allowed ? 'M14 16l1.3 1.3 2.7-3' : 'M14 16h4');
    const status = element('toolStatus');
    if (!busy && transition !== 'stop-failed') {
      if (!allowed) status.textContent = 'AI 控制已关闭。';
      else if (!folderReady()) status.textContent = 'AI 控制已开启，保存或打开文件夹工程后将自动连接。';
      else if (credentials) status.textContent = 'MCP 已连接当前工程。';
    }
    element('toolConnectionSummary').textContent = status.textContent;
    element('retryAiConnection').hidden =
      busy || !(transition === 'stop-failed' || (allowed && folderReady() && !credentials));
  }
  function openAiSettings() {
    const dialog = element('externalToolsDialog');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    element('openAppSettings').click();
    element('appSettingsTabs').querySelector<HTMLButtonElement>('[data-tab="ai-control"]')?.click();
    toggle.focus();
  }
  quick.addEventListener('click', async () => {
    if (transition === 'stop-failed') {
      await stop();
      syncBinding();
      return;
    }
    if (transition !== 'idle') return;
    allowed = !allowed;
    if (allowed) syncBinding();
    else await stop();
  });
  element('openAiControlSettings').addEventListener('click', openAiSettings);
  const source = (): NetworkToolSource => ({ runtime: hooks.runtime.runtime, diagnostics: hooks.diagnostics() });
  const history = createAiCandidateHistory({
    open: openProposal,
    report: showNetworkNotice,
    reuse(favorite) {
      if (!credentials) return { message: '请先允许 AI 操作，再复用收藏。' };
      const editor = hooks.editor();
      const replay = candidateReplay(favorite.entry, editor.document);
      if (!replay.commands) return { message: replay.message ?? '收藏方案不可用。' };
      const id = hooks.uid('proposal');
      const result = preview(
        editor,
        {
          base: networkToolBase(editor, source()),
          operation: 'edit',
          commands: replay.commands,
        },
        id,
        '收藏 · ' + favorite.name,
      );
      if (!result.ok) return { message: result.diagnostics.map((item) => item.message).join('；') };
      render();
      return { id };
    },
  });
  function preview(
    editor: NetworkDraftSession,
    params: Extract<NetworkToolRequest, { method: 'preview' }>['params'],
    id: string,
    origin: string,
  ) {
    const prior = tools.pendingProposals;
    const result = tools.preview(editor, source(), params, id);
    if (result.ok) {
      const pending = tools.pendingProposals;
      for (const item of prior) if (!pending.includes(item)) history.mark(item.id, 'replaced');
      const proposal = pending.find((item) => item.id === id);
      if (proposal) {
        origins.set(id, origin);
        history.add(recordCandidate(proposal, editor.document, origin, Date.now()));
      }
    }
    return result;
  }
  const settings = setupNetworkAiSettings({
    editor: hooks.editor,
    base: () => networkToolBase(hooks.editor(), source()),
    enabled: () => credentials !== null,
    preview(input, origin) {
      if (!credentials) return fail('TOOL_RETIRED', '请先允许AI操作。');
      const parsed = parseNetworkToolRequest({
        protocol: 'HydraulicTools',
        version: 1,
        requestId: hooks.uid('local'),
        method: 'preview',
        params: input,
      });
      if (!parsed.ok) return parsed;
      const request = parsed.value;
      if (request.method !== 'preview' || request.params.operation !== 'edit')
        return fail('TOOL_COMMAND_INVALID', '参数建议仅接受编辑操作。');
      const allowed = ['parameter', 'project-parameter', 'initial-parameter', 'pipe-parameter'];
      if (
        request.params.commands.some(
          (c) =>
            !c || typeof c !== 'object' || !('kind' in c) || typeof c.kind !== 'string' || !allowed.includes(c.kind),
        )
      )
        return fail('TOOL_COMMAND_INVALID', '参数建议仅接受已登记数值参数命令。');
      const result = preview(hooks.editor(), request.params, hooks.uid('proposal'), origin);
      render();
      if (result.ok) element('externalToolsDialog').dispatchEvent(new Event('show-ai-candidate'));
      return result;
    },
  });
  function disabled(message = '接口关闭，令牌和候选已退役。') {
    ++generation;
    credentials = null;
    if (transition !== 'stopping') transition = 'idle';
    void hooks.runtime.enqueue(hooks.runtime.pauseLimited);
    for (const proposal of tools.pendingProposals) history.mark(proposal.id, 'expired');
    tools.clear();
    fileDialogs.retire();
    settingsDialogs.retire();
    curves.retire();
    history.sync([]);
    cancelled.clear();
    proposalsByRequest.clear();
    filesByRequest.clear();
    settingsByRequest.clear();
    stamp = '';
    activeProposalId = '';
    origins.clear();
    notices.clear();
    element('toolStatus').textContent = message;
    renderQuick();
    element('toolProposal').hidden = true;
    element('aiCandidateEmpty').hidden = false;
    element('aiCandidateStatus').textContent = '';
    settings.render();
  }
  async function stop(message = '接口关闭，令牌和候选已退役。') {
    if (transition === 'stopping') return;
    transition = 'stopping';
    disabled('正在关闭AI接入；本地权限与候选已退役。');
    renderQuick();
    try {
      const result = parseServiceResult(await window.networkTools.stop());
      if (!result.ok) {
        transition = 'stop-failed';
        element('toolStatus').textContent = result.diagnostics.map((d) => d.message).join('；');
      } else {
        transition = 'idle';
        element('toolStatus').textContent = message;
      }
    } catch {
      transition = 'stop-failed';
      element('toolStatus').textContent = '关闭通信失败，请重试关闭或退出软件。';
    } finally {
      renderQuick();
      settings.render();
    }
  }
  async function start() {
    if (!allowed || !folderReady() || transition !== 'idle' || credentials) return;
    transition = 'starting';
    renderQuick();
    element('toolStatus').textContent = '正在建立 MCP 连接…';
    const current = ++generation,
      session = hooks.editor().documentSessionId;
    try {
      const result = parseServiceResult(await window.networkTools.start(session));
      if (current !== generation || session !== hooks.editor().documentSessionId) {
        return;
      }
      if (!result.ok) {
        disabled(result.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      const safe = checkJson(result.value);
      if (!safe.ok) {
        disabled('接口返回无效，保持关闭。');
        await window.networkTools.stop();
        return;
      }
      const r = new ContractReader(),
        o = r.object(result.value, '/tools', ['connectionId']);
      const checked = r.finish({ connectionId: r.id(o.connectionId, '/connectionId') });
      if (!checked.ok) {
        disabled('接口返回无效，保持关闭。');
        await window.networkTools.stop();
        return;
      }
      credentials = checked.value;
      element('toolStatus').textContent = 'AI操作已开启 · MCP 已就绪；候选须在这里逐次接受。';
      settings.render();
    } catch {
      if (current === generation && session === hooks.editor().documentSessionId) {
        disabled('启用通信失败，接口关闭。');
        await window.networkTools.stop();
      }
    } finally {
      if (current === generation) transition = 'idle';
      renderQuick();
    }
  }
  function syncBinding() {
    if (allowed && folderReady() && !credentials) void start();
    renderQuick();
  }
  toggle.addEventListener('change', () => {
    try {
      localStorage.setItem(preferenceKey, toggle.checked ? 'on' : 'off');
    } catch {
      toggle.checked = !toggle.checked;
      showNetworkNotice('未能保存启动时的 AI 控制设置。');
    }
  });
  element('retryAiConnection').addEventListener('click', async () => {
    if (transition === 'stop-failed') await stop();
    syncBinding();
  });
  function acceptProposal(id: string) {
    if (!credentials || !tools.pendingProposals.some((p) => p.id === id)) {
      showNetworkNotice('候选已退役，请重新读取并生成。');
      render();
      return;
    }
    const prior = tools.pendingProposals;
    const applied = hooks.commit(() => {
      const result = tools.accept(hooks.editor(), source(), id);
      history.mark(
        id,
        result.ok
          ? 'applied'
          : result.diagnostics.some((item) => item.code === 'RESPONSE_STALE')
            ? 'expired'
            : 'failed',
      );
      for (const item of prior) {
        if (item.id !== id && !tools.pendingProposals.includes(item)) history.mark(item.id, 'expired');
      }
      return result;
    });
    const message = applied ? '外部候选已接受；仅此批进入一次事务，可撤销。' : '候选未应用；请重新读取并预览。';
    element('aiCandidateStatus').textContent = message;
    showNetworkNotice(message);
    render();
  }
  element('acceptToolProposal').addEventListener('click', () => {
    const p = selectedProposal();
    if (p) acceptProposal(p.id);
  });
  element('rejectToolProposal').addEventListener('click', () => {
    const p = selectedProposal();
    if (p && tools.cancel(p.id).ok) history.mark(p.id, 'rejected');
    element('aiCandidateStatus').textContent = '已拒绝，工程和运行保持。';
    render();
  });
  function render() {
    fileDialogs.render();
    settingsDialogs.render();
    settings.render();
    renderQuick();
    const session = hooks.editor().documentSessionId;
    if (projectSession && projectSession !== session && credentials) {
      void stop('工程已切换，接口/旧令牌/候选已退役。');
    }
    projectSession = session;
    history.select(hooks.editor().document.projectId, session);
    const prior = tools.pendingProposals;
    tools.invalidate(hooks.editor(), source());
    if (prior.length && !tools.pending)
      element('aiCandidateStatus').textContent = '候选因工程、修订或运行身份变化已过期；未应用。';
    const p = selectedProposal();
    const proposals = tools.pendingProposals;
    for (const item of prior) if (!proposals.includes(item)) history.mark(item.id, 'expired');
    history.sync(proposals.map((item) => item.id));
    notices.sync(proposals);
    for (const id of origins.keys()) if (!proposals.some((p) => p.id === id)) origins.delete(id);
    const nextStamp = proposals.map((p) => p.id).join(':') + '/' + (p?.id ?? '');
    if (stamp === nextStamp) return;
    stamp = nextStamp;
    choice.replaceChildren(
      ...proposals.map(
        (p) => new Option((p.category === 'calculation' ? '计算候选' : '原理图候选') + ' · ' + p.id, p.id),
      ),
    );
    if (p) {
      activeProposalId = p.id;
      choice.value = p.id;
    }
    element('toolProposal').hidden = !p;
    element('aiCandidateEmpty').hidden = !!p;
    if (!p) return;
    element('aiCandidateStatus').textContent = '';
    element('toolProposalKind').textContent =
      `${p.operation === 'edit' ? '编辑' : p.operation === 'undo' ? '撤销' : '重做'} · ${p.physical ? '物理修改：旧结果将失效' : '纯布局/视图：物理结果保持'} · 文档修订 ${p.base.revision}`;
    element('toolChanges').textContent = JSON.stringify(p.changes, null, 2);
    element('toolProposalOrigin').textContent =
      '建议来源：' + (origins.get(p.id) ?? '本机候选（来源未核验）') + '；来源说明不代表物理验证。';
    const rows = p.plan ? networkToolParameterChanges(hooks.editor().document, p.plan.document) : [];
    const list = element('toolParameterChanges');
    list.replaceChildren();
    if (rows.length) {
      const table = document.createElement('table');
      const heading = table.createTHead().insertRow();
      for (const text of ['对象 / 字段', '单位', '原值', '建议值']) {
        const cell = document.createElement('th');
        cell.textContent = text;
        heading.append(cell);
      }
      const body = table.createTBody();
      for (const row of rows) {
        const line = body.insertRow();
        for (const text of [
          row.object + '（' + row.id + '） · ' + row.label,
          row.unit,
          row.before === null ? '未指定' : String(row.before),
          row.after === null ? '未指定' : String(row.after),
        ])
          line.insertCell().textContent = text;
      }
      list.append(table);
    } else list.textContent = '其他编辑或历史操作请展开逐项修改详情核对。';
    element('toolValidation').textContent = p.validation.ok
      ? '设计候选满足当前静态运行映射校验；实际求解仍须明确初始化。'
      : '设计可编辑，但当前运行映射不通过：' + p.validation.diagnostics.map((d) => d.code + ' ' + d.message).join('；');
  }
  window.networkTools.onDisabled(() => disabled());
  window.networkTools.onCancel((input) => {
    if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') return;
    cancelled.add(input.id);
    if (cancelled.size > 64) cancelled.delete(cancelled.values().next().value ?? '');
    const fileOperation = filesByRequest.get(input.id);
    if (fileOperation) fileDialogs.cancel(fileOperation);
    const settingsOperation = settingsByRequest.get(input.id);
    if (settingsOperation) settingsDialogs.cancel(settingsOperation);
    const id = proposalsByRequest.get(input.id);
    if (id && tools.pendingProposals.some((p) => p.id === id)) {
      if (tools.cancel(id).ok) history.mark(id, 'expired');
      element('aiCandidateStatus').textContent = '外部请求失联/超时，候选已退役。';
      render();
    }
  });
  async function simulate(
    editor: NetworkDraftSession,
    { base, action }: Extract<NetworkToolRequest, { method: 'simulate' }>['params'],
    current: () => boolean,
  ): Promise<Result<unknown>> {
    if (!current())
      return fail('SIMULATION_PERMISSION_REQUIRED', '请在目标工作台点击工具栏 AI 按钮，开启本次 AI 控制。');
    const now = networkToolBase(editor, source());
    const target = base.runtimeIdentity;
    const live = now.runtimeIdentity;
    const running = hooks.runtime.runtime?.running === true;
    const sameDesign = () => base.revision === editor.revision && base.physicsRevision === editor.physicsRevision;
    if (
      base.documentSessionId !== now.documentSessionId ||
      !sameDesign() ||
      target?.simulationSessionId !== live?.simulationSessionId ||
      (target &&
        live &&
        (target.documentSessionId !== live.documentSessionId ||
          target.physicsRevision !== live.physicsRevision ||
          (!running && (target.tick !== live.tick || target.controlSequence !== live.controlSequence))))
    )
      return fail('RESPONSE_STALE', '工程或仿真已变化，请重新捕获后再操作。');

    if (
      action.kind === 'run-until' &&
      !editor.document.design.components.some(
        (c) => c.id === action.condition.componentId && isLinearActuatorType(c.typeId),
      )
    )
      return fail('CONDITION_INVALID', '停止条件需要当前工程中液压缸的元件 ID。');
    if (!('componentId' in action)) {
      const result =
        action.kind === 'run-for' || action.kind === 'run-until'
          ? await hooks.runtime.operateLimited(
              action.ticks,
              () => current() && sameDesign(),
              action.kind === 'run-until' ? action.condition : undefined,
            )
          : await hooks.runtime.operateSimulation(action.kind, () => current() && sameDesign());
      if (!sameDesign()) return fail('RESPONSE_STALE', '执行期间工程已变化，请重新捕获。');
      if (!result.ok) return result;
      const { status, running, identity, point } = result.value;
      return {
        ok: true,
        value: {
          action: action.kind,
          status,
          running,
          identity,
          solver: point?.solver ?? null,
          ...(action.kind === 'run-until' ? { conditionRun: result.value.conditionRun } : {}),
          ...(action.kind === 'run-for' && identity
            ? {
                limit: {
                  ticks: action.ticks,
                  targetTick: identity.tick + action.ticks,
                  stepSeconds: 0.01,
                  state: running ? 'scheduled' : 'stopped-early',
                },
              }
            : {}),
        },
      };
    }
    if (!live) return fail('RUNTIME_NOT_READY', '请先运行仿真，再操作换向阀或节流阀。');
    const result = await hooks.runtime.dispatchControl([action], live);
    if (!sameDesign()) return fail('RESPONSE_STALE', '执行期间工程已变化，请重新捕获。');
    if (!result.ok) return result;
    const point = result.value;
    return {
      ok: true,
      value: {
        action: action.kind,
        identity: point.identity,
        solver: point.solver,
        appliedControl: point.appliedControls.find((item) => item.componentId === action.componentId) ?? null,
        state: point.states.find((item) => item.componentId === action.componentId) ?? null,
        flowRegulator:
          hooks.runtime.runtime?.flowRegulators?.find((item) => item.componentId === action.componentId) ?? null,
      },
    };
  }
  window.networkTools.onRequest((input) => {
    void (async () => {
      const safe = checkJson(input);
      if (!safe.ok) return;
      const r = new ContractReader(),
        o = r.object(input, '', ['id', 'connectionId', 'request']),
        id = r.id(o.id, '/id'),
        connectionId = r.id(o.connectionId, '/connectionId'),
        request = parseNetworkToolRequest(o.request);
      const envelope = r.finish(true);
      if (!envelope.ok || !request.ok) return;
      const epoch = generation,
        editor = hooks.editor();
      let replied = false;
      const reply = async (result: Result<unknown>) => {
        replied = true;
        await window.networkTools.reply({ id, result });
      };
      const active = () =>
        allowed &&
        epoch === generation &&
        credentials?.connectionId === connectionId &&
        !cancelled.has(id) &&
        hooks.editor() === editor;
      const maySimulate = active;
      await hooks.runtime.enqueue(
        async () => {
          try {
            if (!active()) {
              await reply(fail('TOOL_RETIRED', '连接或工程上下文已退役。'));
              return;
            }
            const q = request.value;
            let result: Result<unknown>;
            if (q.method === 'capabilities')
              result = {
                ok: true,
                value: { ...tools.capabilities(), simulationControl: { authorized: maySimulate() } },
              };
            else if (q.method === 'recovery_list') result = await hooks.recovery.summaries();
            else if (q.method === 'settings_read') result = settingsDialogs.read();
            else if (q.method === 'settings_prepare') {
              const prepared = settingsDialogs.prepare(q.params);
              result = prepared;
              if (prepared.ok) {
                settingsByRequest.set(id, prepared.value.operationId);
                if (settingsByRequest.size > 16) settingsByRequest.delete(settingsByRequest.keys().next().value ?? '');
              }
            } else if (q.method === 'settings_status') result = settingsDialogs.status(q.params.operationId);
            else if (q.method === 'settings_cancel') result = settingsDialogs.cancel(q.params.operationId);
            else if (q.method === 'view_read')
              result = {
                ok: true,
                value: {
                  temporary: hooks.canvas.toolView(),
                  persisted: editor.document.layout.viewport ?? null,
                  base: networkToolBase(editor, source()),
                },
              };
            else if (q.method === 'view_navigate' || q.method === 'diagnostic_locate' || q.method === 'diagnose') {
              const now = networkToolBase(editor, source()),
                base = q.params.base;
              if (
                base.documentSessionId !== now.documentSessionId ||
                base.revision !== now.revision ||
                base.physicsRevision !== now.physicsRevision
              )
                result = fail('RESPONSE_STALE', '工程已变化，未执行界面操作。');
              else if (q.method === 'view_navigate')
                result = hooks.canvas.navigateToolView(q.params.action)
                  ? {
                      ok: true,
                      value: {
                        temporary: hooks.canvas.toolView(),
                        persisted: editor.document.layout.viewport ?? null,
                        documentChanged: false,
                      },
                    }
                  : fail('INTERACTION_BUSY', '画布手势或连接编辑尚未结束。');
              else if (q.method === 'diagnose') {
                const checked = tools.diagnose(editor, source(), base);
                if (!checked.ok) result = checked;
                else {
                  hooks.showDiagnostics(checked.value.diagnostics, 'MCP运行前静态检查');
                  result = {
                    ok: true,
                    value: {
                      ...checked.value,
                      runtimeUntouched: true,
                      diagnosticSnapshot: diagnosticToolSnapshot(hooks.diagnosticView()),
                    },
                  };
                }
              } else {
                const view = hooks.diagnosticView();
                const row =
                  view.session === base.documentSessionId &&
                  view.revision === base.physicsRevision &&
                  view.current?.id === q.params.batchId
                    ? view.current.rows[q.params.rowIndex]
                    : undefined;
                result = !row
                  ? fail('DIAGNOSTIC_STALE', '所选诊断已不是当前批次，请重新检查并读取。')
                  : !row.target
                    ? fail('DIAGNOSTIC_NOT_LOCATABLE', '此诊断没有可定位的当前图形对象。')
                    : hooks.canvas.locateDiagnostic(row.target)
                      ? {
                          ok: true,
                          value: {
                            batchId: q.params.batchId,
                            rowIndex: q.params.rowIndex,
                            target: row.target,
                            temporary: hooks.canvas.toolView(),
                            documentChanged: false,
                          },
                        }
                      : fail('INTERACTION_BUSY', '对象已不存在或画布编辑尚未结束，未更改工程。');
              }
            } else if (q.method === 'cylinder_compare') {
              const revision = editor.revision;
              const capture = await hooks.runtime.refreshRecords('current');
              if (!active() || editor.revision !== revision) result = fail('RESPONSE_STALE', '读取期间工程已改变。');
              else if (!capture) result = fail('RUNTIME_NOT_READY', '当前没有有效运行数据，请先仿真。');
              else result = compareCylinders(capture, q.params.cylinderIds, q.params.fromTick);
            } else if (q.method === 'curve_history') {
              const rows = await hooks.history(editor.document.projectId);
              result = {
                ok: true,
                value: rows.map((capture) => ({
                  historyId: capture.snapshotId,
                  sourceKind: 'persisted-history',
                  capturedAt: capture.capturedAt,
                  identity: capture.view.point.identity,
                  sampleCount: capture.samples.length,
                  fromS: capture.samples[0]?.identity.timeS ?? null,
                  toS: capture.samples.at(-1)?.identity.timeS ?? null,
                  title: capture.view.document.title,
                })),
              };
            } else if (q.method === 'curve_capture' && q.params.historyId !== undefined) {
              const rows = await hooks.history(editor.document.projectId);
              const historical = rows.find((capture) => capture.snapshotId === q.params.historyId);
              result = historical
                ? curves.history(
                    q.params.base,
                    networkToolBase(editor, source()),
                    editor.document.projectId,
                    historical,
                  )
                : fail('CURVE_HISTORY_NOT_FOUND', '该本机历史记录已退役，请重新列出曲线历史。');
            } else if (q.method === 'curve_capture') {
              const revision = editor.revision;
              const anchor = curves.validateBase(q.params.base, networkToolBase(editor, source()));
              const captured = anchor.ok ? await hooks.runtime.refreshRecords('current') : null;
              result =
                !active() || revision !== editor.revision
                  ? fail('RESPONSE_STALE', '曲线捕获期间工程或连接改变。')
                  : !anchor.ok
                    ? anchor
                    : captured
                      ? curves.capture(q.params.base, networkToolBase(editor, source()), captured)
                      : fail('CURVE_RECORD_EMPTY', '当前没有可捕获的有效运行记录。');
            } else if (q.method === 'curve_prepare')
              result =
                'curveIndex' in q.params
                  ? curves.selectImported(
                      networkToolBase(editor, source()),
                      q.params.sourceId,
                      q.params.curveIndex,
                      hooks.uid('curve'),
                    )
                  : curves.prepare(
                      networkToolBase(editor, source()),
                      q.params.sourceId,
                      q.params.request,
                      hooks.uid('curve'),
                    );
            else if (q.method === 'curve_read')
              result = curves.read(
                networkToolBase(editor, source()),
                q.params.curveId,
                q.params.offset,
                q.params.limit,
              );
            else if (q.method === 'calculate')
              result = tools.calculate(editor, source(), q.params, {
                snapshotId: hooks.uid('selection'),
                capturedAt: new Date().toISOString(),
              });
            else if (q.method === 'file_prepare' || q.method === 'export_batch_prepare') {
              const prepared = await fileDialogs.prepare(
                q.method === 'file_prepare'
                  ? q.params
                  : {
                      base: q.params.base,
                      operationKey: q.params.operationKey,
                      action: {
                        kind: 'export-batch',
                        curveId: q.params.curveId,
                        segment: q.params.segment,
                        calculationId: q.params.calculationId,
                      },
                    },
              );
              result = prepared;
              if (prepared.ok && ![...filesByRequest.values()].includes(prepared.value.operationId)) {
                filesByRequest.set(id, prepared.value.operationId);
                if (filesByRequest.size > 16) filesByRequest.delete(filesByRequest.keys().next().value ?? '');
              }
            } else if (q.method === 'file_status') result = fileDialogs.status(q.params.operationId);
            else if (q.method === 'export_batch_retry')
              result = fileDialogs.retryBatch(q.params.operationId, q.params.retryKey);
            else if (q.method === 'file_cancel') result = fileDialogs.cancel(q.params.operationId);
            else if (q.method === 'simulate') result = await simulate(editor, q.params, maySimulate);
            else if (q.method === 'capture') {
              const revision = editor.revision,
                captured = await hooks.runtime.captureTools();
              result =
                !active() || editor.revision !== revision
                  ? fail('RESPONSE_STALE', '捕获期间工程改变。')
                  : captured.ok
                    ? tools.capture(
                        editor,
                        {
                          ...source(),
                          runtime: captured.value,
                          diagnosticSnapshot: diagnosticToolSnapshot(hooks.diagnosticView()),
                        },
                        hooks.uid('capture'),
                      )
                    : captured;
            } else if (q.method === 'read')
              result = await tools.read(editor, source(), q.params, { records: hooks.runtime.toolRecords });
            else if (q.method === 'preview') {
              const proposal = hooks.uid('proposal');
              result = preview(editor, q.params, proposal, '本机受信任客户端（生成来源未核验）');
              if (result.ok) {
                proposalsByRequest.set(id, proposal);
                if (proposalsByRequest.size > 32)
                  proposalsByRequest.delete(proposalsByRequest.keys().next().value ?? '');
              }
            } else if (q.method === 'proposal') result = tools.proposal(q.params.proposalId);
            else if (q.method === 'cancel') {
              result = tools.cancel(q.params.proposalId);
              if (result.ok) history.mark(q.params.proposalId, 'rejected');
            } else result = fail('CONFIRMATION_REQUIRED', '远程apply不会修改工程；请在工作台检查逐项预览并明确接受。');
            if (!active()) {
              const settingsOperation = settingsByRequest.get(id);
              if (settingsOperation) settingsDialogs.cancel(settingsOperation);
              if (
                q.method === 'simulate' &&
                (q.params.action.kind === 'run-for' || q.params.action.kind === 'run-until')
              )
                await hooks.runtime.pauseLimited();
              const fileOperation = filesByRequest.get(id);
              if (fileOperation) fileDialogs.cancel(fileOperation);
              const proposal = proposalsByRequest.get(id);
              if (proposal && tools.cancel(proposal).ok) history.mark(proposal, 'expired');
              result = fail('TOOL_RETIRED', '请求已失联或上下文退役。');
            }
            render();
            await reply(result);
          } catch {
            await reply(fail('TOOL_REQUEST_FAILED', '本机工具处理失败；未绕过候选确认修改工程。'));
          }
        },
        request.value.method === 'simulate' ? 'mutation' : 'capture',
      );
      if (!replied) await reply(fail('RESPONSE_STALE', '排队期间工程或物理修订改变。'));
    })().catch(() => {
      element('toolStatus').textContent = '工具连接已退役；请重新启用后读取。';
    });
  });
  return { render, syncBinding };
}
