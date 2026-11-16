import { parseCurveCapture, type NetworkExportCapture } from '@hyd/application';

interface SavedRun {
  readonly id: string;
  readonly tick: number;
  readonly capture: NetworkExportCapture;
}
const runId = (capture: NetworkExportCapture) => capture.view.point.identity.simulationSessionId;

/** Two prior runs plus the current checkpoint. A refresh replaces the same run by identity. */
export function createCurveHistory(report: (message: string) => void) {
  let opening: Promise<IDBDatabase> | undefined;
  let reportedFailure = false;
  const last = new Map<string, number>();
  function database(): Promise<IDBDatabase> {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open('deatalos-curve-history', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('projects');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return opening;
  }
  async function list(projectId: string): Promise<readonly NetworkExportCapture[]> {
    const db = await database();
    const rows = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('projects').objectStore('projects').get(projectId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!Array.isArray(rows)) return [];
    const valid: NetworkExportCapture[] = [];
    for (const row of rows.slice(0, 3)) {
      if (!row || typeof row !== 'object' || !('capture' in row)) continue;
      const parsed = parseCurveCapture(row.capture);
      if (parsed.ok && parsed.value.view.document.projectId === projectId) valid.push(parsed.value);
    }
    if (valid.length < Math.min(rows.length, 3)) report('部分本机曲线历史无法读取，已保留仍有效的记录。');
    return valid;
  }
  async function remember(capture: NetworkExportCapture): Promise<void> {
    if (capture.selection !== 'current' || capture.samples.length < 2) return;
    const project = capture.view.document.projectId;
    const id = runId(capture);
    const tick = capture.samples.at(-1)?.identity.tick;
    if (tick === undefined) return;
    const key = project + ':' + id;
    if ((last.get(key) ?? -1) >= tick) return;
    try {
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('projects', 'readwrite');
        const store = transaction.objectStore('projects');
        const request = store.get(project);
        request.onsuccess = () => {
          const previous: unknown = request.result;
          const rows: SavedRun[] = [];
          if (Array.isArray(previous))
            for (const row of previous.slice(0, 3)) {
              if (
                row &&
                typeof row === 'object' &&
                typeof row.id === 'string' &&
                typeof row.tick === 'number' &&
                'capture' in row
              )
                rows.push(row);
            }
          const existing = rows.find((row) => row.id === id);
          if (!existing || existing.tick < tick)
            store.put([{ id, tick, capture }, ...rows.filter((row) => row.id !== id)].slice(0, 3), project);
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
      if (last.size >= 128) last.clear();
      last.set(key, tick);
      reportedFailure = false;
    } catch {
      if (!reportedFailure) report('曲线历史未能写入本机存储，本次记录仍可查看。');
      reportedFailure = true;
    }
  }
  return { list, remember };
}
