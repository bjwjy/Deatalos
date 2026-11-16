import { execFile } from 'node:child_process';
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

/** Only the bundled Windows client can resolve DPAPI and authenticate a live target. */
export function callLiveProject(directory: string, request: NetworkToolRequest): Promise<Record<string, unknown>> {
  const executable = path.join(__dirname, 'agent', 'HydraulicTool.exe');
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      ['--project', directory],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 + 1024 },
      (error, stdout, stderr) => {
        try {
          const reply: unknown = JSON.parse(stdout || stderr);
          if (
            jsonObject(reply) &&
            (reply.ok === false ||
              (!error &&
                reply.ok === true &&
                reply.requestId === request.requestId &&
                reply.protocol === 'HydraulicTools' &&
                reply.version === 1))
          ) {
            resolve(reply);
            return;
          }
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
        }
        resolve(
          mcpFailure(
            error?.code === 'ENOENT' ? 'TOOL_CLIENT_MISSING' : 'LIVE_TOOL_FAILED',
            '当前工作台调用未完成。请核对源码构建、工程目录和工作台的「允许 AI 操作」。',
          ),
        );
      },
    );
    // The exit callback also handles startup failures and early pipe closure.
    child.stdin?.on('error', () => child.kill());
    child.stdin?.end(JSON.stringify(request));
  });
}
