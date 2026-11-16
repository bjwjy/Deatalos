import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { PDFDocument } from 'pdf-lib';
import { randomUUID } from 'node:crypto';
import { FileFailure } from './atomic-file.cjs';
import { calculationDocx } from './calculation-docx.cjs';
import { calculationPdf } from './calculation-pdf.cjs';
import type { NetworkArtifact } from '@hyd/application' with { 'resolution-mode': 'import' };
/** One owner for encoding and disposable print resources. No renderer-supplied HTML/URL/ZIP is accepted. */
export async function encodeNetworkArtifact(input: NetworkArtifact, current: () => boolean): Promise<Buffer> {
  const { parseCalculationBook, parseCalculationPdfSource, parseNetworkArtifact, exportLimits } =
    await import('@hyd/application');
  const parsed = parseNetworkArtifact(input);
  if (!parsed.ok) throw new FileFailure('FORMAL_ARTIFACT_INVALID', parsed.diagnostics.map((d) => d.message).join('；'));
  const artifact = parsed.value;
  let bytes: Buffer;
  if (
    artifact.format === 'csv' ||
    artifact.format === 'svg' ||
    artifact.format === 'hydcurve' ||
    artifact.format === 'md'
  )
    bytes = Buffer.from(artifact.text);
  else if (artifact.format === 'html') {
    const template = await readFile(path.join(__dirname, 'offline-curve-template.html'), 'utf8');
    if (template.split('__HYD_OFFLINE_DATA__').length !== 2)
      throw new FileFailure('OFFLINE_TEMPLATE_INVALID', '离线阅读器资源无效。');
    const escaped = artifact.text.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    bytes = Buffer.from(template.replace('__HYD_OFFLINE_DATA__', () => escaped));
  } else if (artifact.format === 'docx') {
    const raw: unknown = JSON.parse(artifact.text),
      book = parseCalculationBook(raw);
    if (!book.ok) throw new FileFailure('BOOK_INVALID', '计算书内容无效。');
    bytes = await calculationDocx(book.value);
  } else if (artifact.text.trimStart().startsWith('{')) {
    const raw: unknown = JSON.parse(artifact.text),
      book = parseCalculationPdfSource(raw);
    if (!book.ok) throw new FileFailure('BOOK_INVALID', 'PDF计算书源无效。');
    const pdf = await PDFDocument.load(await calculationPdf(book.value, current), { updateMetadata: false });
    pdf.setTitle(book.value.title);
    pdf.setSubject(book.value.source);
    pdf.setAuthor('HydraulicWorkbench');
    bytes = Buffer.from(await pdf.save());
  } else bytes = await renderDrawing(artifact.text, artifact.format, current);
  if (!current()) throw new FileFailure('RESPONSE_STALE', '正式文件整理期间工程已退役。');
  if (bytes.length > exportLimits.bytes)
    throw new FileFailure('EXPORT_SIZE_LIMIT', `正式文件${bytes.length}字节，超过4MB预算。`);
  return bytes;
}
async function renderDrawing(svg: string, format: 'pdf' | 'png' | 'jpg', current: () => boolean): Promise<Buffer> {
  const match = /^<svg [^>]*width="(\d+)mm" height="(\d+)mm"/.exec(svg),
    width = Number(match?.[1]),
    height = Number(match?.[2]);
  const valid = [
    [210, 297],
    [297, 210],
    [297, 420],
    [420, 297],
    [420, 594],
    [594, 420],
  ].some(([w, h]) => w === width && h === height);
  if (!valid) throw new FileFailure('DRAWING_PAGE_INVALID', '图纸幅面不是A4/A3/A2。');
  const raster = format !== 'pdf';
  const pixelWidth = Math.round((width * 144) / 25.4);
  const pixelHeight = Math.round((height * 144) / 25.4);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: raster,
      backgroundThrottling: !raster,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      partition: 'formal-print-' + randomUUID(),
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
      const size = raster
        ? `width:${pixelWidth}px;height:${pixelHeight}px;overflow:hidden;background:white`
        : `width:${width}mm;height:${height}mm`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; object-src 'none'"><style>@page{size:auto;margin:0}html,body{margin:0;padding:0;${size}}svg{display:block;${raster ? 'width:100%;height:100%' : ''}}</style></head><body>${svg}</body></html>`;
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      if (!current()) throw new FileFailure('RESPONSE_STALE', '打印前工程已退役。');
      if (raster) {
        // The emulated page size is independent of the host window and monitor DPI.
        const devtools = window.webContents.debugger;
        devtools.attach();
        await devtools.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: pixelWidth,
          height: pixelHeight,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const image: unknown = await devtools.sendCommand('Page.captureScreenshot', {
          format: format === 'png' ? 'png' : 'jpeg',
          ...(format === 'jpg' ? { quality: 92 } : {}),
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: pixelWidth, height: pixelHeight, scale: 1 },
        });
        if (!image || typeof image !== 'object' || !('data' in image) || typeof image.data !== 'string' || !image.data)
          throw new FileFailure('DRAWING_IMAGE_EMPTY', '图纸图像未生成。');
        return Buffer.from(image.data, 'base64');
      }
      const printed = await window.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: false,
        pageSize: { width: width / 25.4, height: height / 25.4 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        displayHeaderFooter: false,
      });
      // Chromium quantizes its page box to device units. Preserve vector coordinates
      // and top alignment while setting the ISO sheet box exactly, without rasterizing.
      const document = await PDFDocument.load(printed, { updateMetadata: false });
      const pages = document.getPages();
      const page = pages[0];
      if (pages.length !== 1 || !page)
        throw new FileFailure('DRAWING_PAGINATION_INVALID', '原理图必须恰好一页，未写文件。');
      const targetWidth = (width * 72) / 25.4,
        targetHeight = (height * 72) / 25.4;
      const previousHeight = page.getHeight();
      page.setSize(targetWidth, targetHeight);
      page.translateContent(0, targetHeight - previousHeight);
      return Buffer.from(await document.save());
    })();
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FileFailure('EXPORT_TIMEOUT', '图纸整理超过30秒，未写文件。')), 30000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}
