import type { NetworkClipboard } from '@hyd/application' with { 'resolution-mode': 'import' };
import type { Result } from '@hyd/domain' with { 'resolution-mode': 'import' };

export interface SelectionClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
/** Accept project selections and bounded diagnostic reports. Never return arbitrary clipboard text. */
export function createNetworkClipboardAdapter(port: SelectionClipboardPort) {
  return async (input: unknown): Promise<Result<NetworkClipboard | true>> => {
    const { diagnostic } = await import('@hyd/domain');
    const { parseNetworkClipboardRequest, parseNetworkClipboardText } = await import('@hyd/application');
    if (input && typeof input === 'object' && 'action' in input && input.action === 'copy-diagnostic-report') {
      const text = 'text' in input ? input.text : null;
      if (typeof text !== 'string' || !text.length || text.length > 512_000 || text.includes('\0'))
        return {
          ok: false,
          diagnostics: [diagnostic('CLIPBOARD_CODES_INVALID', '/clipboard', '报错内容为空或超过可复制范围。')],
        };
      try {
        await port.writeText(text);
        if ((await port.readText()) === text) return { ok: true, value: true };
      } catch {
        // Keep the card and detail view open so the report is still readable.
      }
      return {
        ok: false,
        diagnostics: [diagnostic('CLIPBOARD_IO_FAILED', '/clipboard', '报错信息未复制，请重试。')],
      };
    }
    if (input && typeof input === 'object' && 'action' in input && input.action === 'copy-diagnostic-codes') {
      const codes = 'codes' in input ? input.codes : null;
      if (
        !Array.isArray(codes) ||
        codes.length < 1 ||
        codes.length > 256 ||
        !codes.every((code: unknown) => typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(code))
      )
        return {
          ok: false,
          diagnostics: [diagnostic('CLIPBOARD_CODES_INVALID', '/clipboard', '没有可复制的有效错误代码。')],
        };
      try {
        const text = [...new Set(codes)].join('\n');
        await port.writeText(text);
        if ((await port.readText()) === text) return { ok: true, value: true };
      } catch {
        // Report write failure without navigating away from the card.
      }
      return {
        ok: false,
        diagnostics: [diagnostic('CLIPBOARD_IO_FAILED', '/clipboard', '错误代码未复制，请重试。')],
      };
    }
    const request = parseNetworkClipboardRequest(input);
    if (!request.ok) return request;
    try {
      if (request.value.action === 'read') return parseNetworkClipboardText(await port.readText());
      const text = JSON.stringify(request.value.selection);
      const checked = parseNetworkClipboardText(text);
      if (!checked.ok) return checked;
      await port.writeText(text);
      if ((await port.readText()) !== text) throw new Error('write receipt mismatch');
      return { ok: true, value: true };
    } catch {
      return {
        ok: false,
        diagnostics: [diagnostic('CLIPBOARD_IO_FAILED', '/clipboard', '系统剪贴板读写未完成；当前编辑保留，请重试。')],
      };
    }
  };
}
