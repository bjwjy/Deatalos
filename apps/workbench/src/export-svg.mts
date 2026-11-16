import { positionDisplayName } from '@hyd/domain';
import type { ExportSnapshot } from '@hyd/application';
import type { displayExport } from './application-bridge.mjs';
import { diagramGeometry, diagramDefs, diagramStyles, escapeXml as xml } from './diagram.mjs';

/** Uses the same committed vector geometry as the board, with explicit standalone styles. */
export function exportSvg(snapshot: ExportSnapshot, view: ReturnType<typeof displayExport>): string {
  const { route, symbol } = diagramGeometry(view, { interactive: false });
  const r = view.result;
  const paths = view.model.wires.map((w) => {
    const value = r.ok ? r.wireValues[w.id] : null;
    const color = value && Math.abs(value.flow) > 1e-6 ? (value.pressureSide ? '#d45e4f' : '#297ac7') : '#a8b3bf';
    return { id: w.id, path: route(w), color };
  });
  const xs: number[] = [],
    ys: number[] = [];
  for (const c of view.model.components) {
    xs.push(c.x - 560, c.x + 560);
    ys.push(c.y - 110, c.y + 130);
  }
  for (const wire of paths) {
    const numbers = wire.path.match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = numbers[i],
        y = numbers[i + 1];
      if (x !== undefined && y !== undefined) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const left = xs.length ? Math.min(...xs) - 24 : 0,
    top = ys.length ? Math.min(...ys) - 160 : 0;
  const width = Math.max(1000, xs.length ? Math.max(...xs) - left + 24 : 1000);
  const height = Math.max(590, ys.length ? Math.max(...ys) - top + 40 : 590);
  const point = snapshot.point;
  const selection = {
    diagram: '纯图（无运行结果）',
    preview: '静态预览（不计入轨迹）',
    'current-run': '当前轨迹末步',
    history: '历史轨迹末步',
  }[snapshot.selection.kind];
  const note = point
    ? `计算步 ${point.state.tick} / ${point.state.timeS} s / ${point.controls.valves.map((c) => (snapshot.document.design.components.find((v) => v.id === c.componentId)?.label || '换向阀') + '：' + positionDisplayName(c.positionId)).join('；')}`
    : '实例初始几何；不代表已求解';
  const result = r.ok
    ? `泵出口 ${r.pressure.toFixed(2)} MPa · 执行器流量 ${r.q.toFixed(2)} L/min`
    : '没有有效计算结果；图形不代表该回路已被求解器支持';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.ceil((1000 * height) / width)}" viewBox="${left} ${top} ${width} ${height}" role="img" aria-label="${xml(snapshot.document.title)}">
<title>${xml(snapshot.document.title)} · ${xml(selection)}</title>
<desc>可编辑矢量回路；准静态教学模型；未知值不是零。${xml(snapshot.assumptions.join(' '))}</desc>
<metadata id="result-snapshot">${xml(JSON.stringify(snapshot))}</metadata>
<style>${diagramStyles}</style>${diagramDefs}
<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white"/>
<g fill="#203047" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="14">
<text x="${left + 24}" y="${top + 28}">${xml(snapshot.document.title)} · ${xml(selection)}</text>
<text x="${left + 24}" y="${top + 52}">${xml(note)}</text>
<text x="${left + 24}" y="${top + 76}">${xml(result)}</text>
<text x="${left + 24}" y="${top + 100}">准静态动作演示；${snapshot.record.samplesTruncated || snapshot.record.eventsTruncated ? '记录已截断，不能声称完整重放' : '采样与控制来源见技术元数据'}；未知值用 —</text></g>
${paths.map((w) => `<g data-wire="${w.id}"><path class="wire" d="${w.path}" stroke="${w.color}"/></g>`).join('')}
${view.model.components.map((c) => symbol(c, r)).join('')}
</svg>`;
}
