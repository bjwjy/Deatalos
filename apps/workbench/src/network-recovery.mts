import type { NetworkDraftSession } from '@hyd/application';
import { diagnostic, type Result } from '@hyd/domain';
import { element } from './network-dom.mjs';

interface RecoveryRow {
  readonly id: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly revision: number;
  readonly document: unknown;
}
interface RecoveryHooks {
  editor(): NetworkDraftSession;
  preferences(): { readonly intervalMs: number; readonly copies: number };
  restore(document: unknown): Promise<boolean>;
  toast(message: string): void;
}

function recoveryRows(input: unknown): RecoveryRow[] {
  if (!Array.isArray(input)) return [];
  const rows: unknown[] = input;
  return rows
    .slice(0, 20)
    .filter(
      (row): row is RecoveryRow =>
        !!row &&
        typeof row === 'object' &&
        'id' in row &&
        typeof row.id === 'string' &&
        'title' in row &&
        typeof row.title === 'string' &&
        'capturedAt' in row &&
        typeof row.capturedAt === 'string' &&
        Number.isFinite(Date.parse(row.capturedAt)) &&
        'revision' in row &&
        typeof row.revision === 'number' &&
        Number.isSafeInteger(row.revision) &&
        'document' in row,
    );
}

/** Profile-local snapshots. Writes and retention share one IndexedDB transaction. */
export function createNetworkRecovery(hooks: RecoveryHooks) {
  const dialog = element('networkRecovery');
  const select = element('recoveryCopyChoice');
  const restoreButton = element('restoreRecoveryCopy');
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !(select instanceof HTMLSelectElement) ||
    !(restoreButton instanceof HTMLButtonElement)
  )
    throw new Error('Recovery controls missing');
  const controls = { dialog, select, restoreButton, status: element('recoveryCopyStatus') };
  let opening: Promise<IDBDatabase> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observed: NetworkDraftSession | undefined;
  let lastRevision = -1;
  let writing = false;
  let restoring = false;
  let failed = false;
  let visible: RecoveryRow[] = [];
  let listing = 0;
  let preferences = hooks.preferences();

  function database(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('deatalos-network-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('copies', { autoIncrement: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }
  async function copies(): Promise<Result<readonly RecoveryRow[]>> {
    try {
      const db = await database();
      const rows = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('copies').objectStore('copies').getAll(null, 20);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { ok: true, value: recoveryRows(rows).reverse() };
    } catch {
      return {
        ok: false,
        diagnostics: [diagnostic('RECOVERY_UNAVAILABLE', '/recovery', '无法读取本机恢复副本；当前工程保留。')],
      };
    }
  }

  async function retain(row?: RecoveryRow): Promise<void> {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('copies', 'readwrite');
      const store = transaction.objectStore('copies');
      if (row) store.add(row);
      const request = store.openKeyCursor(null, 'prev');
      let trimming = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!trimming) {
          trimming = true;
          cursor.advance(preferences.copies);
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function stop(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function observe(): void {
    const editor = hooks.editor();
    if (editor !== observed) {
      stop();
      observed = editor;
      lastRevision = -1;
    }
    if (!editor.dirty || editor.revision === 0 || editor.revision === lastRevision || preferences.intervalMs === 0) {
      stop();
      return;
    }
    if (timer === undefined && !writing) timer = setTimeout(() => void checkpoint(), preferences.intervalMs);
  }

  async function checkpoint(): Promise<void> {
    timer = undefined;
    const editor = hooks.editor();
    if (observed !== editor || !editor.dirty || editor.revision === 0 || editor.revision === lastRevision) return;
    const revision = editor.revision;
    const row = {
      id: editor.documentSessionId + ':' + revision,
      title: editor.document.title,
      revision,
      capturedAt: new Date().toISOString(),
      document: editor.document,
    };
    writing = true;
    try {
      if (new TextEncoder().encode(JSON.stringify(row.document)).byteLength > 2_000_000)
        throw new Error('Recovery document too large');
      await retain(row);
      if (observed === editor) lastRevision = revision;
      failed = false;
      if (controls.dialog.open) void list();
    } catch {
      if (!failed) hooks.toast('自动恢复副本未写入，可手动保存当前工程。');
      failed = true;
    } finally {
      writing = false;
      observe();
    }
  }

  async function list(): Promise<void> {
    const ticket = ++listing;
    const previous = controls.select.value;
    controls.restoreButton.disabled = true;
    controls.status.textContent = '正在读取本机副本…';
    try {
      const db = await database();
      const rows = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('copies').objectStore('copies').getAll(null, 20);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (ticket !== listing || !controls.dialog.open) return;
      visible = recoveryRows(rows).reverse();
      controls.select.replaceChildren(
        ...visible.map(
          (row) =>
            new Option(
              `${row.title} · ${new Date(row.capturedAt).toLocaleString('zh-CN')} · 修订 ${row.revision}`,
              row.id,
            ),
        ),
      );
      controls.select.value = visible.some((row) => row.id === previous) ? previous : (visible[0]?.id ?? '');
      controls.status.textContent = visible.length ? `本机最近 ${visible.length} 份副本` : '本机暂无恢复副本。';
      controls.restoreButton.disabled = !visible.length || restoring;
    } catch {
      if (ticket !== listing || !controls.dialog.open) return;
      visible = [];
      controls.select.replaceChildren();
      controls.status.textContent = '无法读取本机副本，请稍后再试。';
    }
  }

  controls.dialog.addEventListener('toggle', () => {
    if (controls.dialog.open) void list();
  });
  element('closeRecoveryCopies').addEventListener('click', () => controls.dialog.close());
  controls.restoreButton.addEventListener('click', async () => {
    const row = visible.find((entry) => entry.id === controls.select.value);
    if (!row || restoring) return;
    restoring = true;
    controls.restoreButton.disabled = true;
    try {
      if (await hooks.restore(row.document)) controls.dialog.close();
    } finally {
      restoring = false;
      controls.restoreButton.disabled = !visible.length;
    }
  });

  return {
    async summaries() {
      const rows = await copies();
      return rows.ok
        ? {
            ok: true as const,
            value: rows.value.map(({ id, title, capturedAt, revision }) => ({ id, title, capturedAt, revision })),
          }
        : rows;
    },
    async read(id: string): Promise<Result<unknown>> {
      const rows = await copies();
      if (!rows.ok) return rows;
      const row = rows.value.find((entry) => entry.id === id);
      return row
        ? { ok: true, value: row.document }
        : {
            ok: false,
            diagnostics: [diagnostic('RECOVERY_NOT_FOUND', '/recovery', '所选本机恢复副本已不存在；请重新列出副本。')],
          };
    },
    observe,
    reconfigure(): void {
      const next = hooks.preferences();
      if (next.intervalMs !== preferences.intervalMs) stop();
      const trim = next.copies < preferences.copies;
      preferences = next;
      if (trim) void retain().catch(() => hooks.toast('未能整理恢复副本，已有副本保留。'));
      observe();
    },
  };
}
