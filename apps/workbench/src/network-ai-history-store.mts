export const candidateKinds = ['parameter', 'layout'] as const;
export type CandidateKind = (typeof candidateKinds)[number];
export const candidateStates = {
  pending: '待确认',
  applied: '已应用',
  rejected: '已拒绝',
  replaced: '已替换',
  expired: '已过期',
  failed: '应用失败',
} as const;
export type CandidateState = keyof typeof candidateStates;

export interface CandidateRecord {
  readonly id: string;
  readonly kinds: readonly CandidateKind[];
  readonly title: string;
  readonly origin: string;
  readonly detail: string;
  readonly createdAt: number;
  readonly state: CandidateState;
  readonly replay: { readonly commands: string; readonly targets: string } | null;
}
export interface CandidateFavorite {
  readonly name: string;
  readonly entry: CandidateRecord;
}
export interface CandidateArchive {
  readonly records: CandidateRecords;
  readonly favorites: readonly CandidateFavorite[];
}
export type CandidateRecords = Readonly<Record<CandidateKind, readonly CandidateRecord[]>>;
export const emptyCandidateRecords: CandidateRecords = { parameter: [], layout: [] };

function isRecord(value: unknown): value is CandidateRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('kinds' in value) ||
    !Array.isArray(value.kinds) ||
    !value.kinds.length ||
    value.kinds.length > 2 ||
    !value.kinds.every((kind: unknown) => kind === 'parameter' || kind === 'layout') ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    !('origin' in value) ||
    typeof value.origin !== 'string' ||
    !('detail' in value) ||
    typeof value.detail !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    !('state' in value) ||
    typeof value.state !== 'string' ||
    !Object.hasOwn(candidateStates, value.state) ||
    !('replay' in value)
  )
    return false;
  const replay = value.replay;
  return (
    replay === null ||
    (typeof replay === 'object' &&
      replay !== null &&
      'commands' in replay &&
      typeof replay.commands === 'string' &&
      'targets' in replay &&
      typeof replay.targets === 'string')
  );
}

function isFavorite(value: unknown): value is CandidateFavorite {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= 80 &&
    'entry' in value &&
    isRecord(value.entry) &&
    value.entry.replay !== null
  );
}

function isRecords(value: unknown): value is CandidateRecords {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parameter' in value &&
    Array.isArray(value.parameter) &&
    value.parameter.length <= 2 &&
    value.parameter.every(isRecord) &&
    'layout' in value &&
    Array.isArray(value.layout) &&
    value.layout.length <= 2 &&
    value.layout.every(isRecord)
  );
}

export function addCandidateRecord(records: CandidateRecords, entry: CandidateRecord, limit: number): CandidateRecords {
  const add = (kind: CandidateKind) =>
    entry.kinds.includes(kind) ? [entry, ...records[kind]].slice(0, limit) : records[kind];
  return { parameter: add('parameter'), layout: add('layout') };
}

export function updateCandidateRecord(records: CandidateRecords, id: string, state: CandidateState): CandidateRecords {
  const update = (kind: CandidateKind) => records[kind].map((row) => (row.id === id ? { ...row, state } : row));
  return { parameter: update('parameter'), layout: update('layout') };
}

/** Profile-local archive. Transactions update one project without writing project files or AI credentials. */
export function createCandidateArchive() {
  let database: Promise<IDBDatabase> | undefined;
  function open() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('deatalos-ai-candidate-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projects');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('AI候选存储被占用'));
    }).catch((error: unknown) => {
      database = undefined;
      throw error;
    });
    return database;
  }
  async function access(
    projectId: string,
    update?: (archive: CandidateArchive) => CandidateArchive,
  ): Promise<CandidateArchive> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('projects', update ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('projects');
      const request = store.get(projectId);
      let archive: CandidateArchive = { records: emptyCandidateRecords, favorites: [] };
      request.onsuccess = () => {
        const stored: unknown = request.result;
        if (stored !== undefined) {
          if (
            typeof stored !== 'object' ||
            stored === null ||
            !('version' in stored) ||
            stored.version !== 1 ||
            !('records' in stored) ||
            !isRecords(stored.records) ||
            !('favorites' in stored) ||
            !Array.isArray(stored.favorites) ||
            !stored.favorites.every(isFavorite)
          ) {
            transaction.abort();
            return;
          }
          archive = { records: stored.records, favorites: stored.favorites };
        }
        if (update) store.put({ version: 1, ...update(archive) }, projectId);
      };
      transaction.oncomplete = () => resolve(archive);
      transaction.onabort = () => reject(transaction.error ?? new Error('AI候选存储无法读取'));
      transaction.onerror = () => reject(transaction.error);
    });
  }
  return { access };
}
