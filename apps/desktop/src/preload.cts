import { contextBridge, ipcRenderer } from 'electron';
import type { ProbeResult } from './file-probe.cjs';

// No arbitrary channel, path, payload, Node API, or ipcRenderer object is exposed.
contextBridge.exposeInMainWorld(
  'f01Probe',
  Object.freeze({
    save: (): Promise<ProbeResult> => ipcRenderer.invoke('f01:save-sample'),
    open: (): Promise<ProbeResult> => ipcRenderer.invoke('f01:open-sample'),
  }),
);
