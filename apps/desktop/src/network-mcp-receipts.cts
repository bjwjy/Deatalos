import { request } from 'node:http';
import { jsonObject, mcpFailure } from './network-mcp-project.cjs';
interface ReceiptHandle {
  readonly operationId: string;
  readonly port: number;
  readonly token: string;
  readonly expiresAt: number;
}
/** Per-stdio-process handles come only from an authenticated prepare response. Never accept a caller URL/token. */
export class McpProjectReceipts {
  #handles = new Map<string, ReceiptHandle>();
  constructor(readonly now: () => number = Date.now) {}
  #prune(): void {
    for (const [id, handle] of this.#handles) if (handle.expiresAt <= this.now()) this.#handles.delete(id);
  }
  accept(reply: Record<string, unknown>): Record<string, unknown> {
    this.#prune();
    if (!jsonObject(reply.value) || !('receipt' in reply.value)) return reply;
    const { receipt, ...value } = reply.value;
    const stripped = { ...reply, value };
    if (
      !jsonObject(receipt) ||
      Object.keys(receipt).sort().join(',') !== 'operationId,port,token,version' ||
      receipt.version !== 1 ||
      typeof receipt.operationId !== 'string' ||
      receipt.operationId !== value.operationId ||
      typeof receipt.port !== 'number' ||
      !Number.isInteger(receipt.port) ||
      receipt.port < 1 ||
      receipt.port > 65535 ||
      typeof receipt.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.token)
    )
      return mcpFailure('RECEIPT_INVALID', '另存为回执能力无效；请在工作台取消，未自动重试。');
    if (this.#handles.size >= 16 && !this.#handles.has(receipt.operationId))
      return mcpFailure('RECEIPT_LIMIT', '此客户端已保留16份回执；请查询现有结果，不要重复执行。');
    this.#handles.set(receipt.operationId, {
      operationId: receipt.operationId,
      port: receipt.port,
      token: receipt.token,
      expiresAt: this.#handles.get(receipt.operationId)?.expiresAt ?? this.now() + 15 * 60 * 1000,
    });
    return stripped;
  }
  read(operationId: unknown): Promise<Record<string, unknown>> {
    this.#prune();
    const handle = typeof operationId === 'string' ? this.#handles.get(operationId) : undefined;
    if (!handle)
      return Promise.resolve(mcpFailure('RECEIPT_NOT_FOUND', '此客户端没有该操作回执；不能据此推断文件未写入。'));
    return new Promise((resolve) => {
      const body = JSON.stringify({ operationId: handle.operationId });
      const call = request(
        {
          hostname: '127.0.0.1',
          port: handle.port,
          path: '/receipt',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + handle.token,
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 32768) call.destroy(new Error('Receipt too large'));
            else chunks.push(chunk);
          });
          response.on('error', () =>
            resolve(mcpFailure('RECEIPT_UNAVAILABLE', 'Receipt connection ended; file outcome is unknown.')),
          );
          response.on('end', () => {
            try {
              const reply: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve(
                jsonObject(reply) && typeof reply.ok === 'boolean'
                  ? reply
                  : mcpFailure('RECEIPT_INVALID', '回执响应格式无效。'),
              );
            } catch {
              resolve(mcpFailure('RECEIPT_INVALID', '回执响应格式无效。'));
            }
          });
        },
      );
      call.setTimeout(3000, () => call.destroy(new Error('Receipt timeout')));
      call.on('error', () =>
        resolve(mcpFailure('RECEIPT_UNAVAILABLE', '回执通道已关闭或不可达；文件结果未知，请核对工作台。')),
      );
      call.end(body);
    });
  }
}
