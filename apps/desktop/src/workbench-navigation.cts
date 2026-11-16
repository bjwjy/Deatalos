import type { BrowserWindow } from 'electron';

/** A replacement navigation or a destroyed window is not a failed installation. */
export async function loadWorkbench(
  window: BrowserWindow,
  url: string,
  reportFailure: (title: string, message: string) => void,
): Promise<boolean> {
  try {
    await window.loadURL(url);
    return true;
  } catch (error: unknown) {
    const aborted =
      error !== null &&
      typeof error === 'object' &&
      (('code' in error && error.code === 'ERR_ABORTED') || ('errno' in error && error.errno === -3));
    if (window.isDestroyed() || aborted) {
      console.error('Workbench navigation cancelled:', url, error);
      return false;
    }
    console.error('Failed to load local workbench:', url, error);
    window.show();
    reportFailure('工作台加载失败', '无法加载本地工作台。请保留启动日志以排查资源加载问题。');
    return false;
  }
}
