import { request as httpRequest } from 'node:http';
import { boundedRead } from './atomic-file.cjs';
import { mcpCredential } from './network-tool-discovery.cjs';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { NetworkProjectFiles } from './network-project-files.cjs';
import type { NetworkToolRequest } from '@hyd/application' with { 'resolution-mode': 'import' };

export function mcpFailure(code: string, message: string) {
  return { ok: false, diagnostics: [{ code, field: '/tools', severity: 'error', message }] };
}

export function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const projectName =
  /^(?!CON(?:\.|$)|PRN(?:\.|$)|AUX(?:\.|$)|NUL(?:\.|$)|(?:COM|LPT)[0-9¹²³](?:\.|$))[^<>:"/\\|?*\x00-\x1f]{1,80}$/iu;
export function validProjectName(value: unknown): value is string {
  return typeof value === 'string' && projectName.test(value) && value.trim() === value && !value.endsWith('.');
}

function migrationContext() {
  return { projectId: randomUUID(), timestamp: new Date().toISOString(), appVersion: '0.9.0-e06' };
}

export async function existingProjectDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error('PROJECT_DIRECTORY_INVALID');
  return directory;
}

export async function createMcpProject(root: string, name: string, commands: unknown) {
  const { createNetworkDraft } = await import('@hyd/project-io');
  const { planNetworkToolCommands } = await import('@hyd/application');
  const draft = createNetworkDraft(migrationContext());
  if (!draft.ok) return draft;
  let document = { ...draft.value, title: name };
  if (commands !== undefined) {
    const planned = planNetworkToolCommands(document, commands);
    if (!planned.ok) return planned;
    document = planned.value.document;
  }
  const files = new NetworkProjectFiles(async () => path.join(root, name + '.hydproj'));
  const result = await files.create(document, randomUUID(), 'exact');
  if (result.status === 'error') return { ok: false, diagnostics: result.diagnostics };
  if (result.status !== 'ok' || result.operation !== 'open' || !result.path)
    return mcpFailure('PROJECT_CREATE_FAILED', '未取得新工程入口。');
  return {
    ok: true,
    value: {
      projectId: document.projectId,
      entryPath: result.path,
      components: document.design.components.length,
      connections: document.design.connections.length,
    },
  };
}

export async function readMcpProject(directory: string) {
  const files = new NetworkProjectFiles(async () => null);
  const result = await files.open(path.join(directory, '工程.hydproj'), migrationContext(), randomUUID());
  return result.ok ? { ok: true, value: { snapshotKind: 'saved', ...result.value } } : result;
}

interface LiveTarget {
  readonly directory: string;
  readonly projectId: string;
  readonly connectionId: string;
  readonly discoveryPath: string;
}

export async function callLiveProject(
  target: LiveTarget,
  request: NetworkToolRequest,
): Promise<Record<string, unknown>> {
  try {
    const { parseNetworkFolderEntry } = await import('@hyd/project-io');
    const manifest = parseNetworkFolderEntry(
      JSON.parse((await boundedRead(path.join(target.directory, '工程.hydproj'), 16384)).toString('utf8')),
    );
    if (
      !manifest.ok ||
      manifest.value.projectId !== target.projectId ||
      (await realpath(target.directory)).toLowerCase() !== path.resolve(target.directory).toLowerCase()
    )
      return mcpFailure('TARGET_MISMATCH', '当前文件夹与已授权工程不一致，请重新查找工程。');
    const record: unknown = JSON.parse((await boundedRead(target.discoveryPath, 16384)).toString('utf8'));
    if (
      !jsonObject(record) ||
      record.format !== 'DeatalosMcpConnection' ||
      record.version !== 1 ||
      record.protection !== 'windows-dpapi-current-user' ||
      record.connectionId !== target.connectionId ||
      typeof record.protectedToken !== 'string' ||
      typeof record.endpoint !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/mcp\/live$/.test(record.endpoint)
    )
      return mcpFailure('TARGET_MISMATCH', 'MCP 连接记录已失效，请在工作台重新开启 AI 操作。');
    const endpoint = new URL(record.endpoint);
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.length > 1048576) return mcpFailure('PAYLOAD_LIMIT', '请求超过 1 MB。');
    const token = await mcpCredential('unprotect', record.protectedToken);
    const { directory, projectId, connectionId } = target;
    const connection = Buffer.from(JSON.stringify({ directory, projectId, connectionId })).toString('base64');
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = httpRequest(
        endpoint,
        {
          method: 'POST',
          agent: false,
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
            'content-length': payload.length,
            'x-hydraulic-target': connection,
          },
        },
        async (res) => {
          try {
            const parts: Buffer[] = [];
            let size = 0;
            for await (const part of res) {
              const bytes = Buffer.from(part);
              size += bytes.length;
              if (size > 4194304) throw Error('PAYLOAD_LIMIT');
              parts.push(bytes);
            }
            const reply: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
            if (!jsonObject(reply)) throw Error('INVALID_REPLY');
            if (reply.ok === false && Array.isArray(reply.diagnostics)) {
              resolve(reply);
              return;
            }
            if (
              res.statusCode !== 200 ||
              res.headers['x-hydraulic-connection'] !== connectionId ||
              reply.ok !== true ||
              reply.protocol !== 'HydraulicTools' ||
              reply.version !== 1 ||
              reply.requestId !== request.requestId
            )
              throw Error('INVALID_REPLY');
            resolve(reply);
          } catch (error) {
            reject(error);
          }
        },
      );
      req.once('error', reject);
      req.end(payload);
    });
  } catch {
    return mcpFailure('LIVE_TOOL_FAILED', '未取得目标工作台的有效响应。请检查「允许 AI 操作」，再通过 MCP 查找工程。');
  }
}
