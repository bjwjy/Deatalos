import {
  parseKernelServiceRequest,
  parseServiceResult,
  createNetworkRuntimeResponseReader,
  parseNetworkFileRequest,
  parseNetworkFileOutcome,
  parseExportArtifact,
  parseNetworkClipboard,
  type NetworkClipboard,
  type KernelServiceRequest,
  type NetworkFileRequest,
  type NetworkFileOutcome,
  type NetworkRuntimeView,
  type ExportArtifact,
} from '@hyd/application';
import { diagnostic, type Result } from '@hyd/domain';

declare global {
  interface Window {
    networkClipboard: { request(value: unknown): Promise<unknown> };
    hydraulicKernel: {
      request(value: unknown): Promise<unknown>;
      onInitializationProgress(callback: (sequence: number, percent: number, stage: string) => void): () => void;
    };
    networkFiles: {
      request(value: unknown): Promise<unknown>;
      hasStartupProject(): Promise<boolean>;
      onCloseRequested(callback: () => void): () => void;
    };
  }
}
async function kernel(request: unknown): Promise<Result<unknown>> {
  const parsed = parseKernelServiceRequest(request);
  if (!parsed.ok) return parsed;
  return parseServiceResult(await window.hydraulicKernel.request(parsed.value));
}
const runtimeReader = createNetworkRuntimeResponseReader();
export async function requestRuntime(request: unknown): Promise<Result<NetworkRuntimeView>> {
  const parsed = parseKernelServiceRequest(request);
  if (!parsed.ok) return parsed;
  const command: KernelServiceRequest =
    parsed.value.action === 'state' && parsed.value.version === 2 && runtimeReader.canReference(parsed.value.expected)
      ? { ...parsed.value, view: 'reference-v1' }
      : parsed.value;
  const read = runtimeReader.begin(command);
  return read(await window.hydraulicKernel.request(command));
}
/** Page content is parsed at the existing captureNetworkExport boundary. */
export const requestRecords = (request: KernelServiceRequest): Promise<Result<unknown>> => kernel(request);
export async function requestNetworkFile(request: NetworkFileRequest): Promise<NetworkFileOutcome> {
  const parsed = parseNetworkFileRequest(request);
  if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
  try {
    const reply = parseNetworkFileOutcome(parsed.value, await window.networkFiles.request(parsed.value));
    if (reply.ok && reply.value.status === 'ok' && ['open', 'activate', 'close'].includes(reply.value.operation))
      runtimeReader.clear();
    return reply.ok ? reply.value : { status: 'error', diagnostics: reply.diagnostics };
  } catch (cause) {
    return {
      status: 'error',
      diagnostics: [diagnostic('FILE_OPERATION_FAILED', '/files', String(cause).slice(0, 1000))],
    };
  }
}
export function parseExportReply(input: unknown): Result<ExportArtifact> {
  const result = parseServiceResult(input);
  return result.ok ? parseExportArtifact(result.value) : result;
}

export async function readSelectionClipboard(): Promise<Result<NetworkClipboard>> {
  try {
    const result = parseServiceResult(await window.networkClipboard.request({ action: 'read' }));
    return result.ok ? parseNetworkClipboard(result.value) : result;
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic('CLIPBOARD_IO_FAILED', '/clipboard', '无法读取系统剪贴板；当前工程未改变。')],
    };
  }
}
export async function copyDiagnosticReport(text: string): Promise<boolean> {
  try {
    const result = parseServiceResult(
      await window.networkClipboard.request({ action: 'copy-diagnostic-report', text }),
    );
    return result.ok && result.value === true;
  } catch {
    return false;
  }
}
export async function writeSelectionClipboard(selection: NetworkClipboard): Promise<Result<true>> {
  try {
    const result = parseServiceResult(await window.networkClipboard.request({ action: 'write', selection }));
    return !result.ok
      ? result
      : result.value === true
        ? { ok: true, value: true }
        : {
            ok: false,
            diagnostics: [diagnostic('CLIPBOARD_IO_FAILED', '/clipboard', '剪贴板写入没有有效确认；未剪切任何对象。')],
          };
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic('CLIPBOARD_IO_FAILED', '/clipboard', '无法写入系统剪贴板；未剪切任何对象。')],
    };
  }
}
