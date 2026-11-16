import type { NetworkRuntimeView, NetworkToolDiagnosticSnapshot } from '@hyd/application';
import {
  diagnosticCardPresentation,
  diagnosticCategory,
  type DisplayDiagnostic,
  type NetworkProject,
} from '@hyd/domain';

export type DiagnosticTarget =
  | { readonly kind: 'port'; readonly componentId: string; readonly portId: string; readonly signal: boolean }
  | { readonly kind: 'component' | 'node' | 'connection'; readonly id: string };

export interface DiagnosticSubject {
  readonly object: string;
  readonly headlineSubject?: string;
  readonly target?: DiagnosticTarget;
}

export interface DiagnosticRow {
  readonly diagnostic: DisplayDiagnostic;
  readonly type: string;
  readonly object: string;
  readonly target?: DiagnosticTarget;
  readonly presentation: ReturnType<typeof diagnosticCardPresentation>;
}
export interface DiagnosticBatch {
  readonly id: number;
  readonly source: string;
  readonly project: string;
  readonly revision: number;
  readonly run: string | null;
  readonly tick: number | null;
  readonly rows: readonly DiagnosticRow[];
}
export interface DiagnosticView {
  readonly session: string;
  readonly revision: number;
  readonly checked: boolean;
  readonly current: DiagnosticBatch | undefined;
  readonly history: readonly DiagnosticBatch[];
  readonly information: readonly DiagnosticRow[];
}

function diagnosticKey(item: DisplayDiagnostic): string {
  return JSON.stringify([item.code, item.field, item.componentId, item.severity, item.message, item.suggestion]);
}
function unique(items: readonly DisplayDiagnostic[]): DisplayDiagnostic[] {
  return [...new Map(items.map((item) => [diagnosticKey(item), item])).values()];
}

/** Per-document-session presentation history. Runtime input has already passed service identity checks. */
export function createDiagnosticBatches(
  subjectFor: (item: DisplayDiagnostic, project: NetworkProject | null) => DiagnosticSubject,
) {
  let session = '',
    revision = 0,
    serial = 0;
  let checked = false;
  let history: DiagnosticBatch[] = [];
  let operation: DiagnosticBatch | undefined;
  let live: DiagnosticBatch | undefined;
  let seenRuntime: NetworkRuntimeView | null | undefined;
  let information: readonly DiagnosticRow[] = [];
  let operationInformation: readonly DiagnosticRow[] = [];
  function rows(items: readonly DisplayDiagnostic[], document: NetworkProject | null): DiagnosticRow[] {
    return unique(items).map((diagnostic) => {
      const subject = subjectFor(diagnostic, document);
      return {
        diagnostic,
        object: subject.object,
        ...(subject.target ? { target: subject.target } : {}),
        presentation: diagnosticCardPresentation(diagnostic, subject.headlineSubject ?? subject.object),
        type: diagnosticCategory(diagnostic),
      };
    });
  }
  function save(batch: DiagnosticBatch) {
    const index = history.findIndex((item) => item.id === batch.id);
    history =
      index < 0 ? [batch, ...history].slice(0, 20) : history.map((item) => (item.id === batch.id ? batch : item));
  }
  return {
    select(nextSession: string, nextRevision: number) {
      if (nextSession === session && nextRevision === revision) return;
      if (nextSession !== session) {
        history = [];
        serial = 0;
      }
      session = nextSession;
      revision = nextRevision;
      checked = false;
      operation = live = undefined;
      seenRuntime = undefined;
      information = [];
      operationInformation = [];
    },
    clearOperation() {
      operation = undefined;
      operationInformation = [];
    },
    operation(items: readonly DisplayDiagnostic[], source: string, document: NetworkProject | null, project: string) {
      operation = undefined;
      operationInformation = rows(
        items.filter((item) => item.severity === 'info'),
        document,
      );
      const actionable = rows(
        items.filter((item) => item.severity !== 'info'),
        document,
      );
      if (!actionable.length) return;
      checked = true;
      operation = { id: ++serial, source, project, revision, run: null, tick: null, rows: actionable };
      save(operation);
    },
    runtime(runtime: NetworkRuntimeView | null) {
      if (runtime === seenRuntime) return;
      seenRuntime = runtime;
      information = runtime
        ? rows(
            runtime.diagnostics.filter((item) => item.severity === 'info'),
            runtime.document,
          )
        : [];
      if (runtime?.status === 'ready') checked = true;
      const items =
        runtime?.diagnostics.filter(
          (item) => item.severity !== 'info' && (!runtime.running || item.severity === 'error'),
        ) ?? [];
      if (!runtime || !items.length) {
        live = undefined;
        return;
      }
      checked = true;
      const run = runtime.identity?.simulationSessionId ?? null;
      const tick = runtime.identity?.tick ?? null;
      // A failed or paused state can be read repeatedly. Keep one batch until it recovers or another event arrives.
      const current = live?.run === run && live.tick === tick ? live : undefined;
      const previous = current?.rows.map((row) => row.diagnostic) ?? [];
      const priorKeys = new Set(previous.map(diagnosticKey));
      const combined = [...unique(items).filter((item) => !priorKeys.has(diagnosticKey(item))), ...previous];
      if (current && combined.length === previous.length) return;
      live = {
        id: current?.id ?? ++serial,
        source: '运行报错',
        project: runtime.document.title,
        revision,
        run,
        tick,
        rows: rows(combined, runtime.document),
      };
      save(live);
    },
    get view(): DiagnosticView {
      const current = operation && operation.id > (live?.id ?? -1) ? operation : live;
      return { session, revision, checked, current, history, information: [...operationInformation, ...information] };
    },
  };
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(/\b(?:file|https?):\/\/[^\s"'<>，。；、）]+/gi, '[地址已隐藏]')
    .replace(/(?:[A-Z]:[\\/]|\\\\(?=[^\\\s]+\\))[^\r\n"'<>，。；、）\]\u3000]+/gi, '[本机路径已隐藏]')
    .replace(/(\bBearer\s+)[A-Z0-9._~+\/=-]+/gi, '$1[凭证已隐藏]')
    .replace(
      /((?:authorization|api[-_ ]?key|(?:[A-Z_]+_)?token|密码|密钥|令牌)\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|\[[^\]\r\n]*\]|[^\s,;，。；]+)/gi,
      '$1[凭证已隐藏]',
    );
}

/** Keep the existing local tool response bounded even for large diagnostic batches. */
export function diagnosticToolSnapshot(view: DiagnosticView): NetworkToolDiagnosticSnapshot {
  const text = (value: string) => {
    const safe = redactDiagnosticText(value);
    if (safe.length <= 320) return safe;
    return safe.slice(0, 319).replace(/[\uD800-\uDBFF]$/, '') + '…';
  };
  const currentBatchId = view.current?.id ?? null;
  return {
    state: view.current
      ? 'current'
      : view.history.length
        ? 'historical-only'
        : view.checked
          ? 'checked-clear'
          : 'not-checked',
    currentBatchId,
    batches: view.history.map((batch) => ({
      id: batch.id,
      source: text(batch.source),
      physicsRevision: batch.revision,
      run: batch.run,
      tick: batch.tick,
      rowCount: batch.rows.length,
      rows: batch.rows.slice(0, 12).map(({ diagnostic, object, presentation, target }, rowIndex) => ({
        rowIndex,
        locatable: target !== undefined,
        code: text(diagnostic.code),
        field: text(diagnostic.field || '整体'),
        severity: text(diagnostic.severity ?? 'error'),
        object: text(object),
        headline: text(presentation.headline),
        fact: text(presentation.fact),
        next: text(presentation.next),
        raw: text(diagnostic.message),
      })),
    })),
  };
}
