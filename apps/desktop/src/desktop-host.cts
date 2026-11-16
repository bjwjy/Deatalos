import { NetworkProjectReceipts } from './network-project-receipts.cjs';
import { rendererResources } from './renderer-resources.cjs';
import { createNetworkClipboardAdapter } from './network-clipboard.cjs';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, clipboard } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Result } from '@hyd/domain' with { 'resolution-mode': 'import' };
import { NetworkToolServer } from './network-tool-server.cjs';
import { NetworkToolDiscovery } from './network-tool-discovery.cjs';
import type { NetworkToolTarget } from './network-tool-target.cjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, openSample, saveSample } from './file-probe.cjs';
import type { ProbeResult } from './file-probe.cjs';
import { ProjectFiles } from './project-files.cjs';
import { KernelController } from './kernel-controller.cjs';
import { NetworkProjectFiles } from './network-project-files.cjs';
import { loadWorkbench } from './workbench-navigation.cjs';

/** Fixed by the entry module; no renderer or file can change application identity. */
export function startDesktop(host: 'teaching' | 'advanced'): void {
  const identity =
    host === 'teaching'
      ? { name: '液压教学展示', id: 'local.hydraulic.teaching', page: 'index.html' }
      : { name: 'Deatalos', id: 'local.hydraulic.advanced', page: 'network.html' };
  app.name = identity.name;
  // Keep source runs out of the installed app's shell group and its cached Electron icon.
  const taskbarAppId = host === 'advanced' && !app.isPackaged ? `${identity.id}.deatalos.dev.transparent` : identity.id;
  app.setAppUserModelId(taskbarAppId);
  const origin = 'hydapp://workbench';
  const indexUrl = `${origin}/index.html`;
  const networkUrl = `${origin}/network.html`;
  const primaryUrl = `${origin}/${identity.page}`;
  const probeUrl = `${origin}/probe.html`;
  const rendererDirectory = path.join(__dirname, 'renderer');
  const customUserData = process.env.HYD_USER_DATA_DIR;
  if (customUserData && !path.isAbsolute(customUserData)) throw new Error('HYD_USER_DATA_DIR must be absolute');
  const demoOption = '--hyd-demo-project=';
  let startupProject =
    host === 'advanced'
      ? process.argv.find((argument) => argument.startsWith(demoOption))?.slice(demoOption.length)
      : undefined;
  if (startupProject !== undefined && (!path.isAbsolute(startupProject) || path.extname(startupProject) !== '.hydx'))
    throw new Error('示范快捷方式需要绝对路径的 .hydx 工程。');
  const dataRoot = path.join(app.getPath('appData'), 'HydraulicWorkbench');
  const demoRoot = startupProject
    ? path.join(
        dataRoot,
        'demos',
        createHash('sha256').update(path.normalize(startupProject)).digest('hex').slice(0, 24),
      )
    : dataRoot;
  // Even a shared custom root must not merge locks, recovery or runtime sessions.
  const userData = path.join(customUserData ?? demoRoot, host);
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  const sampleDirectory = process.env.HYD_SPIKE_DIR ?? path.join(app.getPath('userData'), 'f01-samples');
  if (!path.isAbsolute(sampleDirectory)) throw new Error('HYD_SPIKE_DIR must be absolute');
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }

  protocol.registerSchemesAsPrivileged([
    { scheme: 'hydapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  const resources = rendererResources();

  let mainWindow: BrowserWindow | undefined;
  let probeWindow: BrowserWindow | undefined;
  let dialogBusy = false;
  let allowClose = false;
  let kernel: KernelController | undefined;
  const toolWaiters = new Map<string, { resolve(value: Result<unknown>): void; cancel(): void }>();
  const toolError = (code: string, message: string): Result<never> => ({
    ok: false,
    diagnostics: [{ code, field: '/tools', severity: 'error', message, suggestion: '重新启用接口并读取当前工程。' }],
  });
  let toolTarget: () => NetworkToolTarget | null = () => null;
  const projectReceipts = new NetworkProjectReceipts();
  let activeToolConnection: string | null = null;
  const toolServer = new NetworkToolServer(
    (request, connectionId, signal) =>
      new Promise<Result<unknown>>((resolve) => {
        activeToolConnection = connectionId;
        const window = mainWindow;
        if (
          !window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed() ||
          window.webContents.getURL() !== networkUrl ||
          signal.aborted
        ) {
          resolve(toolError('TOOL_RETIRED', '工作台不可用。'));
          return;
        }
        const id = 'req_' + randomUUID().replaceAll('-', '').slice(0, 30);
        const cancel = () => {
          if (!toolWaiters.has(id)) return;
          toolWaiters.delete(id);
          signal.removeEventListener('abort', cancel);
          if (!window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send('network-tools:cancel', { id });
          resolve(toolError('TOOL_RETIRED', '请求失联、超时或接口已关闭。'));
        };
        toolWaiters.set(id, {
          cancel,
          resolve: (value) => {
            toolWaiters.delete(id);
            signal.removeEventListener('abort', cancel);
            resolve(value);
          },
        });
        signal.addEventListener('abort', cancel, { once: true });
        window.webContents.send('network-tools:request', { id, connectionId, request });
      }).then((reply) =>
        request.method === 'file_prepare' &&
        (request.params.action.kind === 'project' ||
          (request.params.action.kind === 'save' && request.params.action.mode === 'as'))
          ? projectReceipts.register(
              connectionId,
              request.params.base,
              reply,
              request.params.action.kind === 'project' ? request.params.action : undefined,
            )
          : reply,
      ),
    () => {
      void stopTools();
    },
    () => toolTarget(),
  );
  const registryDirectory =
    process.env.HYD_TOOLS_REGISTRY_DIR ?? path.join(app.getPath('appData'), 'HydraulicWorkbench/ai-active');
  if (!path.isAbsolute(registryDirectory)) throw new Error('HYD_TOOLS_REGISTRY_DIR must be absolute');
  mkdirSync(registryDirectory, { recursive: true });
  const toolDiscovery = new NetworkToolDiscovery(toolServer, userData, undefined, {
    registryDirectory,
    target: () => toolTarget(),
  });
  async function stopTools(reason: 'explicit' | 'transition' = 'explicit'): Promise<Result<true>> {
    activeToolConnection = null;
    if (reason === 'transition') projectReceipts.retirePending();
    else await projectReceipts.stop();
    for (const waiter of [...toolWaiters.values()]) waiter.cancel();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('network-tools:disabled');
    return await toolDiscovery.stop();
  }
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    // F06 must approve the close before resources are destroyed. Cancellation keeps a usable service.
    if (mainWindow && !mainWindow.isDestroyed() && !allowClose) {
      event.preventDefault();
      if (mainWindow.webContents.getURL() !== networkUrl) kernel?.suspend();
      mainWindow.webContents.send('project:close-request');
      return;
    }
    if (!kernel) return;
    event.preventDefault();
    const closing = kernel;
    kernel = undefined;
    void Promise.all([closing.close(), stopTools()]).finally(() => {
      quitting = true;
      app.quit();
    });
  });
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  function createWindow(url: string, title: string, preload?: string): BrowserWindow {
    const iconPath =
      host === 'advanced'
        ? path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '../resources'), 'icons/deatalos.ico')
        : undefined;
    const window = new BrowserWindow({
      width: url === probeUrl ? 760 : 1440,
      height: url === probeUrl ? 560 : 1000,
      // Show the shell immediately. Waiting for ready-to-show hides renderer
      // startup failures and leaves the normal terminal looking hung.
      title,
      ...(host === 'advanced' && url === networkUrl && process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#00000000', symbolColor: '#45484d', height: 48 },
          }
        : {}),
      ...(iconPath ? { icon: iconPath } : {}),
      show: host !== 'advanced',
      autoHideMenuBar: true,
      backgroundColor: '#f5f7fa',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        ...(preload ? { preload } : {}),
      },
    });
    if (iconPath) {
      if (process.platform === 'win32') {
        // Supply the complete shell identity; icon-only metadata can retain Electron's taskbar icon.
        // The source launcher restores its existing development profile and debug configuration.
        const relaunchTarget = app.isPackaged
          ? process.execPath
          : path.resolve(__dirname, '../../../启动进阶工作台.cmd');
        const runtimeIcon = path.join(process.resourcesPath, 'icons/deatalos.ico');
        window.setAppDetails({
          appId: taskbarAppId,
          // A content-addressed source runtime also gives the shell a fresh icon-cache path.
          appIconPath: existsSync(runtimeIcon) ? runtimeIcon : iconPath,
          appIconIndex: 0,
          relaunchCommand: `"${relaunchTarget}"`,
          relaunchDisplayName: identity.name,
        });
      }
      window.show();
    }
    window.on('page-title-updated', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.once('ready-to-show', () => {
      window.show();
      window.focus();
    });
    window.webContents.on('did-finish-load', () => {
      console.error(`Workbench loaded: ${url}`);
      window.show();
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.error('Workbench renderer load failed:', { errorCode, errorDescription, validatedURL });
      window.show();
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('Workbench renderer exited:', details);
      window.show();
    });
    void loadWorkbench(window, url, (title, message) => dialog.showErrorBox(title, message));
    return window;
  }

  function showProbe(): void {
    if (probeWindow && !probeWindow.isDestroyed()) {
      probeWindow.focus();
      return;
    }
    probeWindow = createWindow(probeUrl, 'F01 隔离文件试验', path.join(__dirname, 'preload.cjs'));
    probeWindow.on('closed', () => {
      probeWindow = undefined;
    });
  }

  function trustedProbe(event: IpcMainInvokeEvent): boolean {
    return (
      !!probeWindow &&
      !probeWindow.isDestroyed() &&
      event.sender === probeWindow.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url === probeUrl
    );
  }

  async function runProbe(event: IpcMainInvokeEvent, action: 'open' | 'save', args: unknown[]): Promise<ProbeResult> {
    if (!trustedProbe(event) || args.length !== 0) return failure('INVALID_REQUEST', '文件试验请求无效。');
    const window = probeWindow;
    if (!window) return failure('CLOSED', '试验窗口已关闭。');
    if (dialogBusy) return failure('BUSY', '请先完成当前文件对话框。');
    dialogBusy = true;
    try {
      mkdirSync(sampleDirectory, { recursive: true });
      if (action === 'save') {
        const result = await dialog.showSaveDialog(window, {
          title: 'F01：仅保存隔离样本（不覆盖已有文件）',
          defaultPath: path.join(sampleDirectory, `sample-${Date.now()}.hyd-f01.json`),
          filters: [{ name: '隔离读写试验样本', extensions: ['hyd-f01.json'] }],
        });
        if (result.canceled || !result.filePath) return { status: 'cancelled' };
        return await saveSample(sampleDirectory, result.filePath);
      }
      const result = await dialog.showOpenDialog(window, {
        title: 'F01：打开刚才保存的隔离样本',
        defaultPath: sampleDirectory,
        filters: [{ name: '隔离读写试验样本', extensions: ['hyd-f01.json'] }],
        properties: ['openFile'],
      });
      const selected = result.filePaths[0];
      if (result.canceled || !selected) return { status: 'cancelled' };
      return await openSample(sampleDirectory, selected);
    } catch (error: unknown) {
      console.error('F01 dialog failed:', error);
      return failure('DIALOG_ERROR', '文件对话框未完成，请重试。');
    } finally {
      dialogBusy = false;
    }
  }

  app
    .whenReady()
    .then(async () => {
      const discoveryCleanup = await toolDiscovery.initialize();
      if (!discoveryCleanup.ok) console.error('TOOL_DISCOVERY_CLEANUP_FAILED');
      protocol.handle('hydapp', async (request) => {
        const url = new URL(request.url);
        const mime = resources.get(url.pathname);
        if (
          url.host !== 'workbench' ||
          url.username ||
          url.password ||
          url.search ||
          !mime ||
          request.method !== 'GET' ||
          (['/index.html', '/network.html'].includes(url.pathname) && request.url !== primaryUrl)
        ) {
          return new Response('未找到本地资源', { status: 404 });
        }
        try {
          const bytes = await readFile(path.join(rendererDirectory, url.pathname.slice(1)));
          return new Response(new Uint8Array(bytes), {
            headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' },
          });
        } catch (error: unknown) {
          console.error('Local resource read failed:', error);
          return new Response('本地资源暂不可用', { status: 500 });
        }
      });
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith(`blob:${origin}/`) });
      });
      ipcMain.handle('f01:save-sample', (event, ...args: unknown[]) => runProbe(event, 'save', args));
      ipcMain.handle('f01:open-sample', (event, ...args: unknown[]) => runProbe(event, 'open', args));
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'F01 试验',
            submenu: [
              { label: '隔离文件读写试验', click: showProbe },
              { type: 'separator' },
              { role: 'quit', label: '退出' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'copy', label: '复制' },
              { role: 'paste', label: '粘贴' },
              { role: 'selectAll', label: '全选' },
            ],
          },
        ]),
      );
      mainWindow = createWindow(primaryUrl, identity.name, path.join(__dirname, 'project-preload.cjs'));
      // The product uses its page file menu; retain the isolated probe menu only for its own window/test seam.
      mainWindow.setMenu(null);
      const toolSender = (event: IpcMainInvokeEvent) =>
        !!mainWindow &&
        event.sender === mainWindow.webContents &&
        event.senderFrame === event.sender.mainFrame &&
        event.senderFrame.url === networkUrl;
      ipcMain.handle('network:theme', (event, ...args: unknown[]) => {
        const theme = args[0];
        if (
          host !== 'advanced' ||
          process.platform !== 'win32' ||
          !mainWindow ||
          !toolSender(event) ||
          args.length !== 1 ||
          (theme !== 'neutral' && theme !== 'silver' && theme !== 'oat' && theme !== 'coral')
        )
          return false;
        const symbolColor = theme === 'coral' ? '#e2ddd7' : '#45484d';
        // The renderer's title bar supplies the background, including during the theme reveal.
        mainWindow.setTitleBarOverlay({ symbolColor });
        return true;
      });
      let drawingModalMinimizable: boolean | undefined;
      const releaseDrawingModal = () => {
        if (drawingModalMinimizable === undefined) return;
        mainWindow?.setMinimizable(drawingModalMinimizable);
        drawingModalMinimizable = undefined;
      };
      ipcMain.handle('network:drawing-modal', (event, ...args: unknown[]) => {
        if (
          host !== 'advanced' ||
          process.platform !== 'win32' ||
          !mainWindow ||
          !toolSender(event) ||
          args.length !== 1 ||
          typeof args[0] !== 'boolean'
        )
          return false;
        if (args[0]) {
          drawingModalMinimizable ??= mainWindow.isMinimizable();
          mainWindow.setMinimizable(false);
        } else releaseDrawingModal();
        return true;
      });
      const selectionClipboard = createNetworkClipboardAdapter(clipboard);
      ipcMain.handle('network:clipboard', (event, ...args: unknown[]) =>
        host === 'advanced' && toolSender(event) && args.length === 1
          ? selectionClipboard(args[0])
          : {
              ok: false,
              diagnostics: [
                {
                  code: 'CLIPBOARD_SENDER_INVALID',
                  field: '/clipboard',
                  severity: 'error',
                  message: '剪贴板入口只允许进阶主窗口使用。',
                  suggestion: '在进阶工作台中使用元件复制或粘贴。',
                },
              ],
            },
      );
      ipcMain.handle('network-tools:start', (event, ...args: unknown[]) =>
        toolSender(event) && args.length === 0
          ? toolDiscovery.start()
          : toolError('TOOL_SENDER_INVALID', '接口仅能在自由网络工作台启用。'),
      );
      ipcMain.handle('network-tools:stop', async (event, ...args: unknown[]) => {
        return toolSender(event) && args.length === 0
          ? await stopTools()
          : toolError('TOOL_SENDER_INVALID', '接口仅能在进阶工作台切换。');
      });
      ipcMain.handle(
        'network-tools:lifecycle',
        (event, ...args: unknown[]) =>
          toolSender(event) && args.length === 1 && projectReceipts.phase(args[0], activeToolConnection),
      );
      ipcMain.handle('network-tools:reply', async (event, ...args: unknown[]) => {
        if (!toolSender(event) || args.length !== 1) return false;
        const { checkJson } = await import('@hyd/domain');
        const { parseServiceResult } = await import('@hyd/application');
        const input = args[0];
        if (
          !checkJson(input).ok ||
          !input ||
          typeof input !== 'object' ||
          !('id' in input) ||
          typeof input.id !== 'string' ||
          !('result' in input) ||
          Object.keys(input).some((k) => !['id', 'result'].includes(k))
        )
          return false;
        const waiter = toolWaiters.get(input.id);
        if (!waiter) return false;
        const result = parseServiceResult(input.result);
        if (Buffer.byteLength(JSON.stringify(result)) > 4194304) {
          waiter.cancel();
          return false;
        }
        waiter.resolve(result);
        return true;
      });
      const createKernelController = () =>
        new KernelController(
          __dirname,
          app.isPackaged ? path.join(process.resourcesPath, 'kernel-e00d') : path.join(__dirname, 'kernel-runtime'),
          path.join(app.getPath('userData'), 'kernel-e00d-sessions'),
        );
      kernel = createKernelController();
      let kernelNavigationPending = false;
      mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (!mainFrame || inPlace) return;
        kernelNavigationPending = true;
        releaseDrawingModal();
        void stopTools();
        // A new renderer starts its sequence at one. Retire the entire old owner,
        // including pending replies and native processes, rather than weakening replay checks.
        const previous = kernel;
        kernel = createKernelController();
        void previous?.close().catch((cause: unknown) => console.error('Kernel navigation cleanup failed:', cause));
      });
      mainWindow.webContents.on('did-navigate', () => {
        kernelNavigationPending = false;
      });
      mainWindow.webContents.on('did-stop-loading', () => {
        // Failed or cancelled navigation leaves the existing renderer available.
        kernelNavigationPending = false;
      });
      ipcMain.handle('kernel:request', (event, ...args: unknown[]) => {
        if (
          !mainWindow ||
          event.sender !== mainWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== primaryUrl ||
          args.length !== 1
        )
          return {
            ok: false,
            diagnostics: [
              {
                code: 'KERNEL_SENDER_INVALID',
                severity: 'error',
                field: '/kernel',
                message: '内核请求窗口或来源无效。',
                suggestion: '使用主工作台操作。',
              },
            ],
          };
        // The old renderer sends its final pause during unload, after navigation
        // starts. Never let that sequence advance the new renderer's controller.
        if (kernelNavigationPending)
          return {
            ok: false,
            diagnostics: [
              {
                code: 'RESPONSE_STALE',
                severity: 'error',
                field: '/kernel',
                message: '页面正在切换，旧页面运行请求已退役。',
              },
            ],
          };
        return (
          kernel?.request(args[0]) ?? {
            ok: false,
            diagnostics: [
              {
                code: 'RUNTIME_CLOSED',
                severity: 'error',
                field: '/kernel',
                message: '应用正在关闭。',
                suggestion: '重新打开应用。',
              },
            ],
          }
        );
      });
      mainWindow.on('blur', () => {
        if (mainWindow?.webContents.getURL() !== networkUrl) kernel?.suspend();
      });
      mainWindow.webContents.on('render-process-gone', () => {
        releaseDrawingModal();
        void stopTools();
        void kernel?.invalidate();
      });
      const files = new ProjectFiles(app.getPath('userData'), {
        open: async () => {
          if (!mainWindow) return null;
          const result = await dialog.showOpenDialog(mainWindow, {
            title: '打开液压工程（原文件保留）',
            filters: [{ name: '液压工程', extensions: ['hydx', 'json'] }],
            properties: ['openFile'],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        save: async (defaultPath, format = 'hydx') => {
          if (!mainWindow) return null;
          const result = await dialog.showSaveDialog(mainWindow, {
            title:
              format === 'hydx'
                ? '保存液压工程（新文件重名自动编号）'
                : '导出' + format.toUpperCase() + '（重名自动编号）',
            defaultPath,
            filters: [
              {
                name: format === 'hydx' ? '液压工程（第二版格式）' : format === 'csv' ? 'CSV 表格数据' : 'SVG 矢量图',
                extensions: [format],
              },
            ],
          });
          return result.canceled ? null : (result.filePath ?? null);
        },
        question: async (purpose) => {
          if (!mainWindow) return 'cancel';
          const result = await dialog.showMessageBox(
            mainWindow,
            purpose === 'transition'
              ? {
                  type: 'question',
                  title: '未保存的工程',
                  message: '当前工程有未保存内容，如何继续？',
                  buttons: ['保存', '放弃', '取消'],
                  defaultId: 2,
                  cancelId: 2,
                  noLink: true,
                }
              : {
                  type: 'question',
                  title: '工程恢复',
                  message: '发现恢复副本，是否恢复列表中的最新一份？',
                  detail: '恢复后需要另存；其他副本可从恢复列表选择。',
                  buttons: ['恢复最新', '稍后'],
                  defaultId: 1,
                  cancelId: 1,
                  noLink: true,
                },
          );
          return purpose === 'transition'
            ? ((['save', 'discard', 'cancel'] as const)[result.response] ?? 'cancel')
            : result.response === 0
              ? 'recover'
              : 'later';
        },
      });
      const networkFiles = new NetworkProjectFiles(
        async (defaultPath, format = 'hydx') => {
          if (!mainWindow) return null;
          const result = await dialog.showSaveDialog(mainWindow, {
            title: format === 'hydproj' ? '新建工程文件夹（重名自动编号）' : '保存网络工程/结果（新文件重名自动编号）',
            defaultPath,
            filters: [
              {
                name:
                  format === 'hydproj'
                    ? '文件夹工程'
                    : format === 'hydx'
                      ? '液压网络工程'
                      : format === 'csv'
                        ? 'CSV 表格数据'
                        : format === 'pdf'
                          ? 'PDF 文件'
                          : format === 'png' || format === 'jpg'
                            ? format.toUpperCase() + ' 原理图'
                            : format === 'hydcurve'
                              ? '曲线数据文件'
                              : format === 'html'
                                ? '离线交互曲线 HTML'
                                : format === 'md'
                                  ? 'Markdown任务书'
                                  : format === 'docx'
                                    ? 'Word 计算书'
                                    : 'SVG 矢量图',
                extensions: [format],
              },
            ],
          });
          return result.canceled ? null : (result.filePath ?? null);
        },
        {},
        true,
      );
      toolTarget = () => networkFiles.toolTarget();
      ipcMain.handle('network:startup-project', (event) =>
        Boolean(
          startupProject &&
          mainWindow &&
          event.sender === mainWindow.webContents &&
          event.senderFrame === event.sender.mainFrame &&
          event.senderFrame.url === networkUrl,
        ),
      );
      ipcMain.handle('network:request', async (event, ...args: unknown[]) => {
        if (
          !mainWindow ||
          event.sender !== mainWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== networkUrl ||
          args.length !== 1 ||
          !args[0] ||
          typeof args[0] !== 'object'
        )
          return {
            status: 'error',
            diagnostics: [
              {
                code: 'FILE_SENDER_INVALID',
                severity: 'error',
                field: '/files',
                message: '网络文件请求窗口或来源无效。',
                suggestion: '使用网络工作台操作。',
              },
            ],
          };
        const { parseNetworkFileRequest } = await import('@hyd/application');
        const parsedRequest = parseNetworkFileRequest(args[0]);
        if (!parsedRequest.ok) return { status: 'error', diagnostics: parsedRequest.diagnostics };
        const request = parsedRequest.value;
        const transition =
          request.action === 'open' || request.action === 'create' || request.action === 'activate' ? request : null;
        if (
          transition?.requestId &&
          !projectReceipts.claimProject(
            transition.requestId,
            transition.sessionId,
            transition.action,
            transition.action === 'open' && transition.importCopy === true,
          )
        )
          return {
            status: 'error',
            diagnostics: [
              {
                code: 'PROJECT_OPERATION_RETIRED',
                field: '/files',
                severity: 'error',
                message: '工程切换未获准或已执行；当前工程保留。',
                suggestion: '核对原操作回执，不要自动重试。',
              },
            ],
          };
        const observeTransition = (outcome: Parameters<NetworkProjectReceipts['observeProject']>[2]) => {
          if (transition?.requestId)
            projectReceipts.observeProject(transition.requestId, transition.sessionId, outcome);
        };
        try {
          if (request.action === 'choose-export-directory') {
            const chosen = await dialog.showOpenDialog(mainWindow, {
              title: '选择默认导出目录',
              properties: ['openDirectory'],
            });
            const directory = chosen.filePaths[0];
            return !chosen.canceled && directory ? { status: 'ok', path: directory } : { status: 'cancelled' };
          }
          if (request.action === 'create') {
            const result = await networkFiles.create(request.document, request.sessionId);
            if (result.status !== 'ok') {
              observeTransition(result);
              return result;
            }
            if (result.operation !== 'open') return result;
            observeTransition({
              status: 'ok',
              projectId: result.document.projectId,
              path: result.path,
              requiresSaveAs: false,
            });
            await stopTools('transition');
            kernel?.suspend();
            await kernel?.invalidate();
            return { status: 'ok', document: result.document, requiresSaveAs: false, migration: [], path: result.path };
          }
          if (request.action === 'activate' && typeof request.sessionId === 'string') {
            const result = await networkFiles.activateDraft(request.document, request.sessionId);
            if (result.ok) {
              observeTransition({
                status: 'ok',
                projectId: request.document.projectId,
                path: '',
                requiresSaveAs: true,
              });
              await stopTools('transition');
              kernel?.suspend();
              await kernel?.invalidate();
            } else observeTransition({ status: 'error', diagnostics: result.diagnostics });
            return result.ok
              ? { status: 'ok', sessionId: request.sessionId }
              : { status: 'error', diagnostics: result.diagnostics };
          }
          if (
            request.action === 'open' &&
            typeof request.sessionId === 'string' &&
            request.context &&
            typeof request.context === 'object'
          ) {
            if (!mainWindow) {
              observeTransition({ status: 'cancelled' });
              return { status: 'cancelled' };
            }
            let chosenPath = startupProject;
            startupProject = undefined;
            if (!chosenPath) {
              const chosen = await dialog.showOpenDialog(mainWindow, {
                title: '打开液压网络工程（原文件保留）',
                filters: [{ name: '工程入口或旧单文件', extensions: ['hydproj', 'hydx', 'json'] }],
                properties: ['openFile'],
              });
              if (chosen.canceled || !chosen.filePaths[0]) {
                observeTransition({ status: 'cancelled' });
                return { status: 'cancelled' };
              }
              chosenPath = chosen.filePaths[0];
            }
            const loaded = await networkFiles.open(chosenPath, request.context, request.sessionId, request.importCopy);
            if (loaded.ok) {
              observeTransition({
                status: 'ok',
                projectId: loaded.value.document.projectId,
                path: chosenPath,
                requiresSaveAs: loaded.value.requiresSaveAs,
              });
              await stopTools('transition');
              kernel?.suspend();
              await kernel?.invalidate();
            } else observeTransition({ status: 'error', diagnostics: loaded.diagnostics });
            return loaded.ok
              ? {
                  status: 'ok',
                  document: loaded.value.document,
                  sourceVersion: loaded.value.source.version,
                  requiresSaveAs: loaded.value.requiresSaveAs,
                  migration: loaded.value.migration?.changes ?? [],
                  path: chosenPath,
                }
              : { status: 'error', diagnostics: loaded.diagnostics };
          }
          if (request.action === 'save' && request.capture && typeof request.capture === 'object') {
            const result = await networkFiles.save(request.capture, request.saveAs);
            if (request.saveAs) {
              projectReceipts.observe(request.capture, result);
              if (result.status === 'ok') await stopTools('transition');
            }
            return result;
          }
          if (
            request.action === 'export' &&
            typeof request.sessionId === 'string' &&
            typeof request.requestId === 'string'
          )
            return await networkFiles.exportArtifact(
              request.sessionId,
              request.requestId,
              request.artifact,
              request.category,
              request.destination,
              request.defaultDirectory,
            );
          if (request.action === 'close' && typeof request.sessionId === 'string') {
            allowClose = true;
            setTimeout(() => mainWindow?.close(), 0);
            return { status: 'ok', sessionId: request.sessionId };
          }
          return {
            status: 'error',
            diagnostics: [
              {
                code: 'FILE_REQUEST_INVALID',
                severity: 'error',
                field: '/files',
                message: '不支持的网络文件操作。',
                suggestion: '刷新工程会话后重试。',
              },
            ],
          };
        } catch (error) {
          console.error('Network file operation failed:', error);
          observeTransition({
            status: 'error',
            diagnostics: [
              {
                code: 'FILE_OPERATION_FAILED',
                severity: 'error',
                field: '/files',
                message: '文件操作未取得确定结果；请检查本机状态，不要自动重试。',
                suggestion: '核对本机工作台和目标文件。',
              },
            ],
          });
          return {
            status: 'error',
            diagnostics: [
              {
                code: 'FILE_OPERATION_FAILED',
                severity: 'error',
                field: '/files',
                message: '网络工程文件操作失败，当前工程保留。',
                suggestion: '检查路径、权限和文件占用后重试。',
              },
            ],
          };
        }
      });
      ipcMain.handle('project:request', async (event, ...args: unknown[]) => {
        if (
          !mainWindow ||
          event.sender !== mainWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== indexUrl ||
          args.length !== 1
        )
          return {
            status: 'error',
            diagnostics: [
              {
                code: 'FILE_SENDER_INVALID',
                severity: 'error',
                field: '/files',
                message: '文件请求窗口或来源无效。',
                suggestion: '使用主工作台操作。',
              },
            ],
          };
        const request = args[0];
        if (
          request &&
          typeof request === 'object' &&
          'action' in request &&
          ['open', 'save', 'export', 'question', 'close'].includes(String(request.action))
        )
          kernel?.suspend();
        const result = await files.request(request);
        if (
          result.status === 'ok' &&
          request &&
          typeof request === 'object' &&
          'action' in request &&
          ['open', 'activate', 'close'].includes(String(request.action))
        )
          await kernel?.invalidate();
        if (
          result.status === 'ok' &&
          request &&
          typeof request === 'object' &&
          'action' in request &&
          request.action === 'close'
        ) {
          allowClose = true;
          setTimeout(() => mainWindow?.close(), 0);
        }
        return result;
      });
      mainWindow.on('close', (event) => {
        if (allowClose) return;
        event.preventDefault();
        mainWindow?.webContents.send('project:close-request');
      });
      mainWindow.on('closed', () => {
        void stopTools();
        mainWindow = undefined;
        app.quit();
      });
    })
    .catch((error) => {
      console.error('Desktop startup failed:', error);
      app.exit(1);
    });
  app.on('window-all-closed', () => app.quit());
}
