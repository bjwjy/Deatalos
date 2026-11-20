import { contextBridge, ipcRenderer } from 'electron';
import type { FileReply, FileRequest } from '@hyd/application' with { 'resolution-mode': 'import' };

contextBridge.exposeInMainWorld(
  'projectFiles',
  Object.freeze({
    request: (request: FileRequest): Promise<FileReply> => ipcRenderer.invoke('project:request', request),
    onCloseRequested: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on('project:close-request', listener);
      return () => ipcRenderer.removeListener('project:close-request', listener);
    },
  }),
);

contextBridge.exposeInMainWorld(
  'frameFiles',
  Object.freeze({
    open: () => ipcRenderer.invoke('frame-file:open'),
    save: (template: unknown) => ipcRenderer.invoke('frame-file:save', template),
  }),
);

// Narrow v3 service seam; no arbitrary channel, path, library or native command.
contextBridge.exposeInMainWorld(
  'hydraulicKernel',
  Object.freeze({
    request: (request: unknown): Promise<unknown> => ipcRenderer.invoke('kernel:request', request),
    onInitializationProgress: (callback: (sequence: number, percent: number, stage: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, sequence: number, percent: number, stage: string) =>
        callback(sequence, percent, stage);
      ipcRenderer.on('kernel:initialization-progress', listener);
      return () => ipcRenderer.removeListener('kernel:initialization-progress', listener);
    },
  }),
);

contextBridge.exposeInMainWorld(
  'networkFiles',
  Object.freeze({
    request: (request: unknown): Promise<unknown> => ipcRenderer.invoke('network:request', request),
    hasStartupProject: async (): Promise<boolean> => (await ipcRenderer.invoke('network:startup-project')) === true,
    onCloseRequested: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on('project:close-request', listener);
      return () => ipcRenderer.removeListener('project:close-request', listener);
    },
  }),
);

contextBridge.exposeInMainWorld(
  'networkTools',
  Object.freeze({
    start: (): Promise<unknown> => ipcRenderer.invoke('network-tools:start'),
    stop: (): Promise<unknown> => ipcRenderer.invoke('network-tools:stop'),
    lifecycle: (input: unknown): Promise<boolean> => ipcRenderer.invoke('network-tools:lifecycle', input),
    reply: (input: unknown): Promise<boolean> => ipcRenderer.invoke('network-tools:reply', input),
    onRequest: (callback: (input: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => callback(input);
      ipcRenderer.on('network-tools:request', listener);
      return () => ipcRenderer.removeListener('network-tools:request', listener);
    },
    onCancel: (callback: (input: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => callback(input);
      ipcRenderer.on('network-tools:cancel', listener);
      return () => ipcRenderer.removeListener('network-tools:cancel', listener);
    },
    onDisabled: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on('network-tools:disabled', listener);
      return () => ipcRenderer.removeListener('network-tools:disabled', listener);
    },
  }),
);

contextBridge.exposeInMainWorld(
  'networkClipboard',
  Object.freeze({ request: (value: unknown): Promise<unknown> => ipcRenderer.invoke('network:clipboard', value) }),
);

contextBridge.exposeInMainWorld(
  'networkAppearance',
  Object.freeze({
    applyTheme: (value: unknown): Promise<boolean> => ipcRenderer.invoke('network:theme', value),
    setDrawingModal: (open: boolean): Promise<boolean> => ipcRenderer.invoke('network:drawing-modal', open),
  }),
);
