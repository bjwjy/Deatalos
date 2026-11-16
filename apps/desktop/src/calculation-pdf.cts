import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CalculationBook } from '@hyd/application' with { 'resolution-mode': 'import' };
import { FileFailure } from './atomic-file.cjs';

/** Only a parsed book reaches this adapter. User content cannot select markup, CSS, scripts or resources. */
export async function calculationPdf(book: CalculationBook, current: () => boolean): Promise<Buffer> {
  const { calculationBookMarkup } = await import('@hyd/application');
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      partition: 'book-print-' + randomUUID(),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ftp://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; object-src 'none'"><style>@page{size:A4 portrait;margin:20mm 23mm 18mm}html,body{margin:0;padding:0;color:#000}body{font:12pt SimSun,宋体,Cambria,serif;line-height:1.5}h3{font-size:19pt;text-align:center;margin:0 0 6mm}h4{font-size:12.5pt;margin:5mm 0 2mm;break-after:avoid;break-inside:avoid}p{margin:0 0 3mm;overflow-wrap:anywhere;orphans:2;widows:2}.book-keep-together{break-inside:avoid}.book-equation{margin:2mm 0 3mm;break-inside:avoid}.book-equation:has(+.book-equation){break-after:avoid}math{font-family:'Cambria Math',Cambria,SimSun,serif;font-size:12pt;text-align:left}table{border-collapse:collapse;width:100%;font-size:11pt;table-layout:fixed}td,th{border:1px solid #999;padding:2mm;overflow-wrap:anywhere}tr{break-inside:avoid}</style></head><body>${calculationBookMarkup(book)}</body></html>`;
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      if (!current()) throw new FileFailure('RESPONSE_STALE', '计算书打印前工程已退役。');
      const bytes = await window.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
      });
      if (!current()) throw new FileFailure('RESPONSE_STALE', '计算书打印期间工程已退役。');
      return Buffer.from(bytes);
    })();
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FileFailure('EXPORT_TIMEOUT', '计算书PDF整理超过30秒，未写文件。')), 30000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}
