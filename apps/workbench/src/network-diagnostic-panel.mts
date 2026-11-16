import { element } from './network-dom.mjs';
import { copyDiagnosticReport } from './network-service-client.mjs';
import { networkUiIcon } from './network-v13-icons.mjs';
import {
  redactDiagnosticText,
  type DiagnosticBatch,
  type DiagnosticRow,
  type DiagnosticTarget,
  type DiagnosticView,
} from './network-diagnostic-batches.mjs';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const result = document.createElement(tag);
  result.textContent = text;
  result.className = className;
  return result;
}
function button(text: string, action: () => void, className = 'c1-link') {
  const control = node('button', text, className);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}
const batchTitle = (batch: DiagnosticBatch) => batch.source + ' · 第 ' + batch.id + ' 批';
const rowKey = ({ diagnostic, object }: DiagnosticRow) =>
  JSON.stringify([diagnostic.code, diagnostic.field, diagnostic.message, diagnostic.suggestion, object]);
function context(batch: DiagnosticBatch): string {
  return [
    batchTitle(batch),
    '工程 ' + batch.project,
    '物理修订 ' + batch.revision,
    ...(batch.run === null ? [] : ['运行 ' + batch.run]),
    ...(batch.tick === null ? [] : ['步号 ' + batch.tick]),
  ].join(' · ');
}
function rowText({ diagnostic, type, object, presentation }: DiagnosticRow): string {
  return [
    presentation.headline,
    '对象：' + object,
    '问题类型：' + type,
    '故障详情：' + presentation.fact,
    '下一步：' + presentation.next,
    '错误代码：' + diagnostic.code,
    '字段：' + (diagnostic.field || '整体'),
    ...(presentation.fact === diagnostic.message ? [] : ['原始诊断：' + diagnostic.message]),
  ].join('\n');
}

export function setupNetworkDiagnosticPanel(
  read: () => DiagnosticView,
  notify: (message: string) => void,
  locate: (target: DiagnosticTarget) => boolean,
) {
  const dialog = element('diagnosticsDialog');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('Diagnostic dialog required');
  const modal = dialog;
  const content = element('diagnostics');
  const title = modal.querySelector('h2');
  if (!title) throw new Error('Diagnostic heading required');
  const heading = title;
  const footer = node('footer', '', 'dialog-foot v13-dialog-footer');
  modal.append(footer);
  const card = element('shortcutDiagnostics');
  const list = node('div', '', 'c3-diagnostic-scroll');
  const cardFooter = node('footer', '', 'c3-diagnostic-footer');
  const detail = button('查看详情', () => showCurrent());
  const copyAll = button(
    '复制给 AI',
    () => {
      const batch = read().current;
      if (batch) void copy(batch, batch.rows);
    },
    'c1-link c3-copy-all',
  );
  copyAll.dataset.shortcutCopyAllDiagnostics = '';
  cardFooter.append(detail);
  card.append(copyAll, list, cardFooter);
  let initialized = false;
  let session = '';
  let lastBatch: DiagnosticBatch | undefined;
  let lastChecked = false;
  let nextHistory = false;
  function close() {
    return button('关闭', () => modal.close(), 'dialog-button');
  }
  async function copy(batch: DiagnosticBatch, rows: readonly DiagnosticRow[], status?: HTMLElement) {
    const origin = read().current?.id === batch.id ? '当前诊断' : '历史诊断';
    const report = redactDiagnosticText([origin + ' · ' + context(batch), ...rows.map(rowText)].join('\n\n'));
    const result = (await copyDiagnosticReport(report)) ? '已复制报错信息。' : '未能复制报错信息，请重试。';
    if (status) status.textContent = result;
    else notify(result);
  }
  function renderDialog(titleText: string, body: readonly HTMLElement[], actions: readonly HTMLElement[]) {
    heading.textContent = titleText;
    modal.setAttribute('aria-label', titleText);
    content.replaceChildren(...body);
    content.parentElement?.scrollTo(0, 0);
    footer.replaceChildren(...actions);
  }
  function showBatch(batch: DiagnosticBatch, fromHistory: boolean, information: readonly DiagnosticRow[] = []) {
    const source = read();
    const status = node('p', '', 'muted');
    status.setAttribute('role', 'status');
    const groups = new Map<string, HTMLElement>();
    for (const row of batch.rows) {
      let group = groups.get(row.type);
      if (!group) {
        group = node('section', '', 'c3-diagnostic-detail');
        group.append(node('h3', row.type));
        groups.set(row.type, group);
      }
      const entry = node('article', '', 'diagnostic-entry');
      entry.dataset.severity = row.diagnostic.severity ?? 'error';
      const reason = node('p', row.presentation.fact);
      reason.dataset.diagnosticReason = '';
      reason.dataset.diagnosticCode = row.diagnostic.code;
      const technical = node('details', '', 'diagnostic-technical');
      technical.append(
        node('summary', '技术详情'),
        node('code', row.diagnostic.code + ' · ' + (row.diagnostic.field || '整体')),
        node('p', row.diagnostic.message),
      );
      if (row.diagnostic.suggestion && row.diagnostic.suggestion !== row.presentation.next)
        technical.append(node('p', row.diagnostic.suggestion));
      const actions = node('div', '', 'diagnostic-row-actions');
      const target = row.target;
      if (target && batch.revision === source.revision)
        actions.append(
          button(target.kind === 'port' ? (target.signal ? '定位信号口' : '定位油口') : '定位对象', () => {
            const current = read();
            if (current.session === source.session && current.revision === batch.revision && locate(target)) {
              modal.close();
            } else status.textContent = '工程已变化，无法定位这条诊断。请重新检查。';
          }),
        );
      if (row.presentation.connectionHelp) {
        const help = node('button', '查看接线方法', 'c1-link');
        help.type = 'button';
        help.dataset.help = 'runtime';
        actions.append(help);
      }
      actions.append(button('复制给 AI', () => void copy(batch, [row], status)));
      entry.append(
        node('strong', row.presentation.headline),
        reason,
        node('p', '下一步：' + row.presentation.next, 'diagnostic-next'),
        actions,
        technical,
      );
      group.append(entry);
    }
    const body = [node('p', (fromHistory ? '历史诊断 · ' : '') + context(batch), 'muted'), status, ...groups.values()];
    if (information.length) body.push(modelInformation(information));
    renderDialog('诊断详情', body, [
      fromHistory ? button('返回历史', showHistory, 'dialog-button') : close(),
      button('复制整批报错', () => void copy(batch, batch.rows, status), 'dialog-button'),
    ]);
  }
  function modelInformation(rows: readonly DiagnosticRow[]) {
    const model = node('details');
    model.dataset.modelInformation = '';
    model.append(node('summary', '模型说明（' + rows.length + ' 条）'));
    for (const row of rows) {
      const item = node('section', '', 'diagnostic-entry');
      item.dataset.severity = 'info';
      item.append(
        node('strong', row.object + ' · ' + row.type),
        node('p', row.diagnostic.message),
        node('code', row.diagnostic.code),
        node('p', row.presentation.next),
      );
      model.append(item);
    }
    return model;
  }
  function showCurrent() {
    if (!modal.open) {
      modal.showModal();
      return;
    }
    renderCurrent();
  }
  function renderCurrent() {
    const state = read();
    if (state.current) {
      showBatch(state.current, false, state.information);
      return;
    }
    const empty = node('p', state.checked ? '本次检查未发现问题' : '尚未检查', 'c1-empty');
    renderDialog(
      '诊断详情',
      [empty, ...(state.information.length ? [modelInformation(state.information)] : [])],
      [close()],
    );
  }
  function showHistory() {
    const state = read();
    const rows = node('div', '', 'c3-history-list');
    for (const batch of state.history) {
      const row = node('div', '', 'c3-history-row');
      const label = node('div');
      const types = [...new Set(batch.rows.map((item) => item.type))].join('、');
      label.append(
        node('strong', batchTitle(batch) + (batch.id === state.current?.id ? ' · 当前' : '')),
        node('small', types + ' · ' + batch.rows.length + ' 条'),
      );
      row.append(
        label,
        button('查看详情', () => showBatch(batch, true)),
      );
      rows.append(row);
    }
    if (!state.history.length) rows.append(node('p', '暂无诊断批次', 'c1-empty'));
    renderDialog('诊断历史', [node('p', '当前工程会话 · 最近 20 批', 'muted'), rows], [close()]);
  }
  modal.addEventListener('beforetoggle', (event) => {
    if (!(event instanceof ToggleEvent) || event.newState !== 'open') return;
    if (nextHistory) showHistory();
    else renderCurrent();
    nextHistory = false;
  });
  modal.addEventListener('show-diagnostic-history', () => {
    if (modal.open) showHistory();
    else {
      nextHistory = true;
      modal.showModal();
    }
  });
  return () => {
    const state = read();
    const changedSession = session !== state.session;
    if (changedSession && modal.open) modal.close();
    if (initialized && !changedSession && lastBatch === state.current && lastChecked === state.checked) return;
    const priorScroll = changedSession ? 0 : list.scrollTop;
    const rowHeight = list.firstElementChild?.getBoundingClientRect().height || 1;
    const anchor = list.children[Math.floor(priorScroll / rowHeight)];
    const anchorKey = anchor instanceof HTMLElement ? anchor.dataset.diagnosticRow : undefined;
    const batch = state.current;
    const rows = batch?.rows.map((item) => {
      const row = node('div', '', 'c3-problem');
      row.dataset.diagnosticRow = rowKey(item);
      const copyOne = button('', () => void copy(batch, [item]), 'c3-copy-icon');
      copyOne.setAttribute('aria-label', '复制给 AI：' + item.presentation.headline);
      copyOne.title = '复制给 AI';
      copyOne.innerHTML = networkUiIcon('copy');
      const description = node('div', '', 'c3-problem-text');
      description.title = item.presentation.headline + '\n' + item.presentation.fact;
      description.append(node('strong', item.presentation.headline), node('span', item.presentation.fact));
      row.append(description, copyOne);
      return row;
    });
    list.replaceChildren(...(rows ?? [node('p', state.checked ? '本次检查未发现问题' : '尚未检查', 'c1-empty')]));
    const index =
      anchorKey && batch?.id === lastBatch?.id
        ? rows?.findIndex((row) => row.dataset.diagnosticRow === anchorKey)
        : undefined;
    list.scrollTop =
      priorScroll && index !== undefined && index >= 0 ? index * rowHeight + (priorScroll % rowHeight) : priorScroll;
    detail.disabled = copyAll.disabled = !batch;
    lastBatch = batch;
    lastChecked = state.checked;
    session = state.session;
    initialized = true;
  };
}
