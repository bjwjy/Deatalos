import { parseOfflineCurve, type OfflineCurve } from '@hyd/application';

/** A self-contained browser presentation. Build embeds this compiled function and the same pure parser. */
export function offlineCurveReader(parse: typeof parseOfflineCurve): void {
  const element = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error('阅读器控件缺失：' + id);
    return node;
  };
  const input = (id: string) => {
    const node = element(id);
    if (!(node instanceof HTMLInputElement)) throw new Error('输入控件缺失');
    return node;
  };
  const select = (id: string) => {
    const node = element(id);
    if (!(node instanceof HTMLSelectElement)) throw new Error('选择控件缺失');
    return node;
  };
  const status = (text: string) => {
    element('message').textContent = text;
  };
  let data: OfflineCurve;
  let loadGeneration = 0;
  const load = (raw: unknown): boolean => {
    const parsed = parse(raw);
    if (!parsed.ok) {
      status(parsed.diagnostics.map((d) => d.message).join('；'));
      return false;
    }
    data = parsed.value;
    return true;
  };
  try {
    const raw: unknown = JSON.parse(element('curve-data').textContent ?? '');
    if (!load(raw)) {
      element('actions').setAttribute('disabled', '');
      return;
    }
  } catch {
    status('文件数据损坏，无法打开；请重新导出。');
    element('actions').setAttribute('disabled', '');
    return;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  const esc = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const short = (n: number) => Number(n.toPrecision(7)).toString();
  const wrap = (text: string) =>
    Array.from({ length: Math.max(1, Math.ceil([...text].length / 20)) }, (_, i) =>
      [...text].slice(i * 20, (i + 1) * 20).join(''),
    );
  const dimensions = (): readonly [number, number] =>
    data.state.paper === 'A4' ? [297, 210] : data.state.paper === 'A3' ? [420, 297] : [594, 420];
  const geometry = () => {
    const values = data.samples
      .filter((p) => p.timeS >= data.state.fromS && p.timeS <= data.state.toS)
      .flatMap((p) => (p.value === null ? [] : [p.value]));
    let min = Math.min(0, ...values),
      max = Math.max(0, ...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    return {
      min,
      max,
      x: (t: number) => 100 + ((t - data.state.fromS) / (data.state.toS - data.state.fromS)) * 800,
      y: (v: number) => 440 - ((v - min) / (max - min)) * 290,
    };
  };
  const sampleText = (p: OfflineCurve['samples'][number]) =>
    `样本 ${p.index} · tick ${p.tick} · t=${p.timeS} s · ${p.value === null ? '未知：' + p.reason : p.value + ' ' + data.unit + '；SI=' + p.si + ' ' + data.siUnit}`;
  function graphic(): string {
    const { min, max, x, y } = geometry();
    let path = '',
      continuous = false;
    const visible = data.samples.filter((p) => p.timeS >= data.state.fromS && p.timeS <= data.state.toS);
    for (const p of visible) {
      if (p.value === null) {
        continuous = false;
        continue;
      }
      path += `${continuous ? 'L' : 'M'}${x(p.timeS)} ${y(p.value)} `;
      continuous = true;
    }
    const grid: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = data.state.fromS + ((data.state.toS - data.state.fromS) * i) / 4,
        v = min + ((max - min) * i) / 4;
      grid.push(
        `<path d="M${x(t)} 150V440M100 ${y(v)}H900" stroke="#dde5e8"/><text x="${x(t)}" y="465" text-anchor="middle">${short(t)}</text><text x="90" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`,
      );
    }
    const zero = `<path d="M100 ${y(0)}H900${data.state.fromS === 0 ? 'M100 150V440' : ''}" stroke="#657982" stroke-width="1.5"/><text x="90" y="${y(0) + 4}" text-anchor="end">0</text>`;
    const marks = data.state.keys
      .flatMap((k) => {
        const p = visible.find((p) => p.index === k.sampleIndex);
        if (!p || p.value === null) return [];
        const lines = wrap(k.label),
          h = lines.length * 15 + 48;
        const bx = Math.max(8, Math.min(690, x(p.timeS) + 10 + k.offsetX)),
          by = Math.max(150, Math.min(435 - h, y(p.value) - h - 8 + k.offsetY));
        return [
          `<g data-key="${p.index}"><path d="M${x(p.timeS)} ${y(p.value)}L${bx} ${by + h / 2}" stroke="#b45309"/><rect x="${bx}" y="${by}" width="262" height="${h}" rx="4" fill="#fff7ed" stroke="#b45309"/>${lines.map((line, i) => `<text x="${bx + 8}" y="${by + 18 + i * 15}">${esc(line)}</text>`).join('')}<text x="${bx + 8}" y="${by + h - 23}">t=${short(p.timeS)} s · ${short(p.value)} ${esc(data.unit)}</text><text x="${bx + 8}" y="${by + h - 7}">样本 ${p.index} · tick ${p.tick}</text></g>`,
        ];
      })
      .join('');
    const [w, h] = dimensions();
    const metadata = JSON.stringify({
      format: 'HydraulicOfflineCurveImage',
      version: 1,
      snapshotId: data.snapshotId,
      source: JSON.parse(data.metadata),
      state: data.state,
    });
    return `<svg xmlns="${svgNS}" width="${w}mm" height="${h}mm" viewBox="0 0 960 570" role="img" aria-label="离线交互曲线"><title>${esc(data.state.title)}</title><metadata>${esc(metadata)}</metadata><rect width="960" height="570" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" font-size="12" fill="#183746">${Array.from({ length: Math.max(1, Math.ceil([...data.state.title].length / 40)) }, (_, i) => `<text data-title="true" x="100" y="${30 + i * 20}" font-size="18">${esc([...data.state.title].slice(i * 40, (i + 1) * 40).join(''))}</text>`).join('')}<text x="100" y="128">${esc(data.label)} (${esc(data.unit)})</text>${grid.join('')}${zero}<path d="M100 150V440H900V150Z" fill="none" stroke="#9babb2"/><path d="${path}" fill="none" stroke="#087e8b" stroke-width="2"/>${visible.flatMap((p) => (p.value === null ? [] : [`<circle data-sample="${p.index}" cx="${x(p.timeS)}" cy="${y(p.value)}" r="${data.state.keys.some((k) => k.sampleIndex === p.index) ? 4 : 2.5}" fill="${data.state.keys.some((k) => k.sampleIndex === p.index) ? '#bd4814' : '#087e8b'}"/>`])).join('')}${marks}<text x="500" y="490" text-anchor="middle">时间 t (s)</text><text x="100" y="515">来源 ${esc(data.snapshotId)} · ${data.samples.length} 个保留点 · 当前范围 ${short(data.state.fromS)}–${short(data.state.toS)} s</text><text x="100" y="536">只读真实采样；未知处断线，完整SI/来源/状态见metadata。读数显示完整数值，图面适度缩写。</text></g></svg>`;
  }
  function changed(next: OfflineCurve): boolean {
    if (!load(next)) return false;
    render();
    return true;
  }
  function render(): void {
    input('title').value = data.state.title;
    input('from').value = String(data.state.fromS);
    input('to').value = String(data.state.toS);
    select('paper').value = data.state.paper;
    element('chart').innerHTML = graphic();
    element('identity').textContent =
      `${data.snapshotId} · ${data.label} · ${data.samples.length}个保留点；未重新计算。`;
    element('metadata').textContent = data.metadata;
    select('sample').replaceChildren(
      ...data.samples.map((p) => {
        const option = document.createElement('option');
        option.value = String(p.index);
        option.textContent = sampleText(p);
        return option;
      }),
    );
    const list = element('keys');
    list.replaceChildren();
    for (const k of data.state.keys) {
      const row = document.createElement('div');
      row.className = 'key-row';
      row.dataset.key = String(k.sampleIndex);
      const name = document.createElement('label');
      name.textContent = `样本 ${k.sampleIndex} 标注`;
      const field = document.createElement('input');
      field.value = k.label;
      field.maxLength = 80;
      field.setAttribute('aria-label', `样本${k.sampleIndex}标注`);
      field.addEventListener('change', () =>
        changed({
          ...data,
          state: {
            ...data.state,
            keys: data.state.keys.map((p) => (p.sampleIndex === k.sampleIndex ? { ...p, label: field.value } : p)),
          },
        }),
      );
      name.append(field);
      row.append(name);
      for (const axis of ['offsetX', 'offsetY']) {
        const control = document.createElement('input');
        control.type = 'number';
        control.min = '-300';
        control.max = '300';
        control.value = String(axis === 'offsetX' ? k.offsetX : k.offsetY);
        control.setAttribute('aria-label', axis === 'offsetX' ? '水平偏移' : '垂直偏移');
        control.addEventListener('change', () =>
          changed({
            ...data,
            state: {
              ...data.state,
              keys: data.state.keys.map((p) =>
                p.sampleIndex === k.sampleIndex ? { ...p, [axis]: control.valueAsNumber } : p,
              ),
            },
          }),
        );
        row.append(control);
      }
      const remove = document.createElement('button');
      remove.textContent = '删除';
      remove.addEventListener('click', () => toggle(k.sampleIndex));
      row.append(remove);
      list.append(row);
    }
    element('hover').textContent = '移到实际采样点附近查看，点击固定，再点同一点取消。';
  }
  function toggle(index: number): void {
    const sample = data.samples.find((p) => p.index === index);
    if (!sample || sample.value === null) {
      status(sample ? sampleText(sample) : '样本不存在');
      return;
    }
    const exists = data.state.keys.some((k) => k.sampleIndex === index);
    if (!exists && data.state.keys.length >= 16) {
      status('最多16个固定标注，请先删除一个。');
      return;
    }
    changed({
      ...data,
      state: {
        ...data.state,
        keys: exists
          ? data.state.keys.filter((k) => k.sampleIndex !== index)
          : [...data.state.keys, { sampleIndex: index, label: data.label, offsetX: 0, offsetY: 0 }],
      },
    });
    status(exists ? '已取消固定标注。' : '已固定真实样本；可在下方修改文字和位置。');
  }
  const nearest = (event: MouseEvent) => {
    const svg = element('chart').querySelector('svg');
    if (!svg) return undefined;
    const rect = svg.getBoundingClientRect(),
      scale = Math.min(rect.width / 960, rect.height / 570);
    const sx = (event.clientX - rect.left - (rect.width - 960 * scale) / 2) / scale,
      sy = (event.clientY - rect.top - (rect.height - 570 * scale) / 2) / scale;
    const { x, y } = geometry();
    return data.samples
      .flatMap((p) =>
        p.value !== null && p.timeS >= data.state.fromS && p.timeS <= data.state.toS
          ? [{ p, d: Math.hypot(x(p.timeS) - sx, y(p.value) - sy) }]
          : [],
      )
      .sort((a, b) => a.d - b.d)
      .find((p) => p.d * scale <= 14)?.p;
  };
  element('chart').addEventListener('mousemove', (event) => {
    const p = nearest(event);
    element('hover').textContent = p ? sampleText(p) : '移到实际采样点附近查看；固定标注保持。';
  });
  element('chart').addEventListener('mouseleave', () => {
    element('hover').textContent = '固定标注已保留。';
  });
  element('chart').addEventListener('click', (event) => {
    const p = nearest(event);
    if (p) toggle(p.index);
  });
  function zoom(factor: number, center = (data.state.fromS + data.state.toS) / 2): void {
    const first = data.samples[0],
      last = data.samples.at(-1);
    if (!first || !last) return;
    const length = Math.min(
      last.timeS - first.timeS,
      Math.max((last.timeS - first.timeS) / 1000, (data.state.toS - data.state.fromS) * factor),
    );
    const fromS = Math.max(first.timeS, Math.min(last.timeS - length, center - length / 2));
    changed({ ...data, state: { ...data.state, fromS, toS: fromS + length } });
  }
  element('chart').addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.8 : 1.25);
    },
    { passive: false },
  );
  element('zoomIn').addEventListener('click', () => zoom(0.5));
  element('zoomOut').addEventListener('click', () => zoom(2));
  element('reset').addEventListener('click', () => {
    const first = data.samples[0],
      last = data.samples.at(-1);
    if (first && last) changed({ ...data, state: { ...data.state, fromS: first.timeS, toS: last.timeS } });
  });
  element('apply').addEventListener('click', () =>
    changed({
      ...data,
      state: {
        ...data.state,
        title: input('title').value,
        fromS: input('from').valueAsNumber,
        toS: input('to').valueAsNumber,
        paper: select('paper').value === 'A2' ? 'A2' : select('paper').value === 'A3' ? 'A3' : 'A4',
      },
    }),
  );
  select('sample').addEventListener('change', () => {
    const p = data.samples.find((p) => p.index === Number(select('sample').value));
    if (p) element('hover').textContent = sampleText(p);
  });
  element('toggleSample').addEventListener('click', () => toggle(Number(select('sample').value)));
  const safeJson = (value: unknown) =>
    JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  const download = (text: BlobPart, name: string, type: string) => {
    const blob = text instanceof Blob ? text : new Blob([text], { type });
    if (blob.size > 4_000_000) {
      status('成品超过4MB，未下载；请减少数据或图片幅面。');
      return;
    }
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status('已交给浏览器下载：' + name + '；请检查下载是否完成。');
  };
  element('saveHtml').addEventListener('click', () => {
    const clone = document.documentElement.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    const payload = clone.querySelector('#curve-data');
    if (!payload) return;
    payload.textContent = safeJson(data);
    download('<!doctype html>\n' + clone.outerHTML, '离线交互曲线.html', 'text/html;charset=utf-8');
  });
  element('saveJson').addEventListener('click', () =>
    download(safeJson(data), '曲线数据与状态.json', 'application/json;charset=utf-8'),
  );
  element('saveSvg').addEventListener('click', () => download(graphic(), '曲线图.svg', 'image/svg+xml;charset=utf-8'));
  element('savePng').addEventListener('click', () => {
    const [w, h] = dimensions();
    const blob = new Blob([graphic()], { type: 'image/svg+xml;charset=utf-8' }),
      url = URL.createObjectURL(blob),
      image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((w / 25.4) * 150);
        canvas.height = Math.round((h / 25.4) * 150);
        const context = canvas.getContext('2d');
        if (!context) {
          status('浏览器无法生成PNG，请保存SVG。');
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((result) => {
          if (result) download(result, '曲线图.png', 'image/png');
          else status('PNG编码失败，未保存。');
        }, 'image/png');
      } catch {
        status('PNG生成失败，建议保存SVG。');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      status('SVG加载失败，无法生成PNG。');
    };
    image.src = url;
  });
  input('loadJson').addEventListener('change', async () => {
    const file = input('loadJson').files?.[0];
    if (!file) return;
    const ticket = ++loadGeneration;
    input('loadJson').value = '';
    if (file.size > 4_000_000) {
      status('JSON超过4MB，未载入；当前数据保留。');
      return;
    }
    try {
      const text = await file.text();
      if (ticket !== loadGeneration) return;
      const raw: unknown = JSON.parse(text);
      if (load(raw)) {
        render();
        status('数据与图表状态已载入。');
      }
    } catch {
      status('文件不是有效曲线JSON，当前数据保留。');
    }
    input('loadJson').value = '';
  });
  render();
  status('离线文件已打开；修改后请保存交互副本，再重开副本恢复。');
}

/** Build-time trusted template. Desktop inserts only a parsed JSON payload at the marker. */
export function offlineCurveTemplate(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>离线交互曲线</title><style>body{margin:0;background:#f1f5f7;color:#173746;font:15px/1.6 'Microsoft YaHei',Arial,sans-serif}main{max-width:1200px;margin:auto;padding:24px}h1{font-size:24px;margin:0}fieldset{border:0;padding:0}section{background:white;border:1px solid #d4e0e5;border-radius:10px;padding:18px;margin-top:14px}.toolbar,.settings{display:flex;gap:12px;flex-wrap:wrap;align-items:end}label{display:grid;gap:4px}input,select,button{font:inherit;padding:7px 10px;border:1px solid #a9bfc9;border-radius:5px;background:white;color:inherit}button{cursor:pointer}button:hover{background:#e2f2f2}input[type=number]{width:140px}#title{width:260px}#chart svg{width:100%;height:auto;display:block;touch-action:none}#hover{min-height:28px;background:#edf7f7;padding:10px;overflow-wrap:anywhere}#message{color:#86531c;min-height:25px}.key-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.key-row input[type=number]{width:90px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}#identity{overflow-wrap:anywhere;color:#516c79}#sample{max-width:100%}@media(max-width:700px){main{padding:12px}section{padding:10px}.settings label{width:100%}#title{width:auto}}@media print{.toolbar,.settings,#message,#hover,#pointTools,#keys,details{display:none}body{background:white}main{padding:0}section{border:0;padding:0}}</style></head><body><main><h1>离线交互曲线</h1><p id="identity"></p><fieldset id="actions"><section class="toolbar"><button id="saveHtml">保存交互副本</button><button id="saveJson">保存数据与状态</button><label>载入曲线JSON<input id="loadJson" type="file" accept=".json,application/json"></label><button id="saveSvg">导出 SVG</button><button id="savePng">导出 PNG</button></section><section class="settings"><label>图表标题<input id="title" maxlength="160"></label><label>纸张<select id="paper"><option>A4</option><option>A3</option><option>A2</option></select></label><label>起始时间 s<input id="from" type="number" step="any"></label><label>结束时间 s<input id="to" type="number" step="any"></label><button id="apply">应用图表设置</button><button id="zoomIn">放大</button><button id="zoomOut">缩小</button><button id="reset">全范围</button></section><p id="message" role="status" aria-live="polite"></p><section><div id="chart"></div><p id="hover" aria-live="polite"></p><div id="pointTools"><label>精确读点<select id="sample"></select></label><button id="toggleSample">固定 / 取消此样本</button></div><div id="keys"></div></section><details><summary>来源、完整精度与使用说明</summary><p>移动到真实点附近读数，点击固定，再次点击同一点取消。滚轮或放大/缩小调整范围，也可输入起止时间。未知区间保持断线。标注文字/偏移在下方编辑；数据与标注只属于本文件，不会修改工程或推进仿真。图片只显示当前范围内的固定标注。保存交互副本后重开可恢复状态；原文件不会被静默覆盖。浏览器下载可被取消，请核对成品。本文件无联网依赖；格式验证不证明数据来源真实性。</p><pre id="metadata"></pre></details></fieldset></main><script type="application/json" id="curve-data">__HYD_OFFLINE_DATA__</script><script>(${offlineCurveReader.toString()})(${parseOfflineCurve.toString()});</script></body></html>`;
}
