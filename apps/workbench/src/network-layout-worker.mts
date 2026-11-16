import { planNetworkLayout } from '@hyd/application';
import { ContractReader, diagnostic } from '@hyd/domain';

// Static compute-only adapter: same planner/score/search, no files, kernel or UI.
self.onmessage = (event: MessageEvent<unknown>) => {
  const r = new ContractReader(),
    o = r.object(event.data, '/layoutWorker', ['version', 'documentSessionId', 'revision', 'document', 'request']);
  r.constant(o.version, 1, '/layoutWorker/version');
  const documentSessionId = r.id(o.documentSessionId, '/layoutWorker/documentSessionId'),
    revision = r.number(o.revision, '/layoutWorker/revision', 0, Number.MAX_SAFE_INTEGER);
  const checked = r.finish({ document: o.document, request: o.request });
  try {
    const result =
      checked.ok && Number.isSafeInteger(revision)
        ? planNetworkLayout(checked.value.document, checked.value.request)
        : checked.ok
          ? {
              ok: false,
              diagnostics: [diagnostic('PROTOCOL_INVALID', '/layoutWorker/revision', '布局修订必须为非负整数。')],
            }
          : checked;
    self.postMessage({ version: 1, documentSessionId, revision, result });
  } catch (cause: unknown) {
    self.postMessage({
      version: 1,
      documentSessionId,
      revision,
      result: {
        ok: false,
        diagnostics: [
          diagnostic('LAYOUT_FAILED', '/layoutOperation', '后台整理未完成：' + String(cause).slice(0, 200)),
        ],
      },
    });
  }
};
