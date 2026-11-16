import { element } from './network-dom.mjs';
import { candidateLabels } from './network-ai-candidate-record.mjs';
import {
  candidateKinds,
  candidateStates,
  addCandidateRecord,
  createCandidateArchive,
  emptyCandidateRecords,
  updateCandidateRecord,
  type CandidateArchive,
  type CandidateFavorite,
  type CandidateKind,
  type CandidateRecord,
  type CandidateRecords,
  type CandidateState,
} from './network-ai-history-store.mjs';

type Tab = CandidateKind | 'favorites';
interface Hooks {
  open(id: string, focusApply?: boolean): void;
  reuse(favorite: CandidateFavorite): { readonly id: string } | { readonly message: string };
  report(message: string): void;
}

const time = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}
function button(label: string, action: () => void, className = 'c1-link') {
  const control = node('button', label, className);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}
/** Projects the real tool candidates into the card and the profile-local archive. */
export function createAiCandidateHistory(hooks: Hooks) {
  const archive = createCandidateArchive();
  const root = element('shortcutAI');
  const dialog = element('aiCandidateHistory');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('AI history dialog required');
  const modal = dialog;
  const body = element('aiCandidateHistoryBody');
  const footer = element('aiCandidateHistoryActions');
  let records: CandidateRecords = emptyCandidateRecords;
  let favorites: readonly CandidateFavorite[] = [];
  let pending = new Set<string>();
  let project = '',
    session = '',
    tab: Tab = 'parameter',
    cardStamp = '',
    loading = false,
    warned = false;
  let listActive = false;
  let queue = Promise.resolve();
  function storageError() {
    if (!warned) hooks.report('AI 历史与收藏的本机存储不可用，本次记录仍可查看。');
    warned = true;
  }
  function persist(update: (saved: CandidateArchive) => CandidateArchive) {
    const key = project;
    const epoch = session;
    if (!key) return;
    queue = queue
      .then(() => archive.access(key, update))
      .then(
        () => {},
        () => {
          if (session === epoch && project === key) storageError();
        },
      );
  }
  function openPending(id: string) {
    modal.close();
    hooks.open(id);
  }
  function renderCard() {
    const latest = new Map<string, CandidateRecord>();
    for (const kind of candidateKinds) {
      const entry = records[kind][0];
      if (entry && pending.has(entry.id)) latest.set(entry.id, entry);
    }
    const rows = [...latest.values()];
    const stamp = rows.map((row) => row.id).join('/') || 'empty';
    if (stamp === cardStamp) return;
    cardStamp = stamp;
    root.replaceChildren(
      ...(rows.length
        ? rows.map((entry) => {
            const row = node('div', '', 'c3-pending-row');
            const name = button(entry.title, () => hooks.open(entry.id), 'c3-candidate-name');
            name.title = entry.title;
            const label = node('div');
            label.append(name);
            if (entry.kinds.length === 2) label.append(node('small', '参数 + 元件 · 一次确认', 'muted'));
            row.append(
              label,
              button('应用', () => hooks.open(entry.id, true)),
            );
            return row;
          })
        : [node('p', '暂无待处理候选', 'c1-empty')]),
    );
  }
  function show(content: readonly HTMLElement[], actions: readonly HTMLElement[]) {
    body.replaceChildren(...content);
    footer.replaceChildren(...actions);
  }
  const close = () => button('关闭', () => modal.close(), 'dialog-button');
  const back = () => button('返回列表', showList, 'dialog-button');
  function details(entry: CandidateRecord, favorite?: CandidateFavorite) {
    if (!favorite && pending.has(entry.id)) {
      openPending(entry.id);
      return;
    }
    const detail = node('pre', entry.detail, 'c3-detail-diff');
    listActive = false;
    const summary = favorite ? '独立收藏' : candidateStates[entry.state];
    show(
      [
        node('h3', favorite?.name ?? entry.title),
        node('p', summary + ' · ' + entry.origin + ' · ' + time.format(entry.createdAt), 'muted'),
        detail,
      ],
      [back(), close()],
    );
  }
  function editFavorite(entry: CandidateRecord) {
    listActive = false;
    const existing = favorites.find((item) => item.entry.id === entry.id);
    const name = node('input');
    name.type = 'text';
    name.maxLength = 80;
    name.value = existing?.name ?? entry.title.slice(0, 80);
    const label = node('label', '收藏名称', 'dialog-control');
    label.append(name);
    const error = node('p', '', 'muted');
    error.setAttribute('role', 'status');
    const update = (favorite?: CandidateFavorite) => {
      const change = (items: readonly CandidateFavorite[]) => [
        ...(favorite ? [favorite] : []),
        ...items.filter((item) => item.entry.id !== entry.id),
      ];
      favorites = change(favorites);
      persist((saved) => ({ ...saved, favorites: change(saved.favorites) }));
      tab = 'favorites';
      showList();
    };
    const save = button(
      '保存收藏',
      () => {
        const value = name.value.trim();
        if (value) update({ name: value, entry });
        else {
          error.textContent = '请输入收藏名称。';
          name.focus();
        }
      },
      'dialog-button dialog-primary',
    );
    show(
      [node('h3', existing ? '管理收藏' : '保存收藏'), label, error],
      [back(), ...(existing ? [button('删除收藏', () => update(), 'dialog-button')] : []), save],
    );
    name.focus();
    name.select();
  }
  function showList() {
    listActive = true;
    const tabs = node('div', '', 'c3-history-tabs');
    tabs.setAttribute('aria-label', '候选分类');
    for (const kind of [...candidateKinds, 'favorites'] as const) {
      const control = button(kind === 'favorites' ? '收藏' : candidateLabels[kind], () => {
        tab = kind;
        showList();
        body.querySelector<HTMLButtonElement>('.c3-history-tabs [aria-pressed="true"]')?.focus();
      });
      control.setAttribute('aria-pressed', String(tab === kind));
      tabs.append(control);
    }
    const items: readonly { readonly entry: CandidateRecord; readonly favorite?: CandidateFavorite }[] =
      tab === 'favorites'
        ? favorites.map((favorite) => ({ entry: favorite.entry, favorite }))
        : records[tab].map((entry) => ({ entry }));
    const list = node('div', '', 'c3-history-list');
    const feedback = node('p', '', 'muted');
    feedback.setAttribute('role', 'status');
    for (const { entry, favorite } of items) {
      const row = node('div', '', 'c3-history-row');
      const info = node('div');
      const status = favorite
        ? entry.kinds.map((kind) => candidateLabels[kind]).join(' + ') + ' · 独立收藏'
        : candidateStates[entry.state] + ' · ' + time.format(entry.createdAt);
      info.append(
        node('strong', favorite?.name ?? entry.title),
        node('small', status + (entry.kinds.length === 2 ? ' · 同一笔混合提交' : '')),
      );
      const actions = node('div', '', 'c3-history-actions');
      actions.append(button('查看', () => details(entry, favorite)));
      if (entry.replay && !loading) {
        const saved = favorites.some((item) => item.entry.id === entry.id);
        actions.append(button(saved ? '管理收藏' : '收藏', () => editFavorite(entry)));
      }
      if (favorite)
        actions.append(
          button('复用', () => {
            const result = hooks.reuse(favorite);
            if ('id' in result) openPending(result.id);
            else feedback.textContent = result.message;
          }),
        );
      row.append(info, actions);
      list.append(row);
    }
    if (!items.length) list.append(node('p', loading ? '正在读取…' : '暂无记录', 'c1-empty'));
    const rule =
      tab === 'favorites'
        ? '收藏独立保留。复用会先生成候选。'
        : `当前 ${items.length} / 10 条，重开恢复每类最近 2 条。`;
    show([tabs, node('p', rule, 'muted'), feedback, list], [close()]);
  }
  modal.addEventListener('beforetoggle', (event) => {
    if (event instanceof ToggleEvent && event.newState === 'open') {
      tab = 'parameter';
      showList();
    }
  });
  element('closeAiCandidateHistory').addEventListener('click', () => modal.close());
  return {
    select(projectId: string, sessionId: string) {
      if (session === sessionId && project === projectId) return;
      project = projectId;
      session = sessionId;
      records = emptyCandidateRecords;
      favorites = [];
      pending = new Set();
      warned = false;
      loading = true;
      if (modal.open) modal.close();
      renderCard();
      queue = queue.then(async () => {
        try {
          const saved = await archive.access(projectId);
          if (session !== sessionId || project !== projectId) return;
          const merge = (kind: CandidateKind) =>
            [
              ...records[kind],
              ...saved.records[kind]
                .filter((entry) => !records[kind].some((row) => row.id === entry.id))
                .map((entry): CandidateRecord => (entry.state === 'pending' ? { ...entry, state: 'expired' } : entry)),
            ].slice(0, 10);
          records = { parameter: merge('parameter'), layout: merge('layout') };
          favorites = saved.favorites;
          renderCard();
        } catch {
          if (session === sessionId && project === projectId) storageError();
        } finally {
          if (session === sessionId && project === projectId) {
            loading = false;
            if (modal.open && listActive) showList();
          }
        }
      });
    },
    add(entry: CandidateRecord) {
      records = addCandidateRecord(records, entry, 10);
      persist((saved) => ({ ...saved, records: addCandidateRecord(saved.records, entry, 2) }));
      if (modal.open && listActive) showList();
    },
    mark(id: string, state: CandidateState) {
      const old = records.parameter.find((entry) => entry.id === id) ?? records.layout.find((entry) => entry.id === id);
      if (!old || old.state === state) return;
      records = updateCandidateRecord(records, id, state);
      persist((saved) => ({ ...saved, records: updateCandidateRecord(saved.records, id, state) }));
      if (modal.open && listActive) showList();
    },
    sync(ids: readonly string[]) {
      pending = new Set(ids);
      renderCard();
    },
  };
}
