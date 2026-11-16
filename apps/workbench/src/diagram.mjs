export function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu, '�')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export const diagramDefs =
  '<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#3c5169"/></marker></defs>';
export const diagramStyles =
  '.wire{fill:none;stroke-width:2.7;stroke-linejoin:round;stroke-linecap:round}.component .symbol{fill:white;stroke:#3c5169;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.component text{font-family:"Segoe UI","Microsoft YaHei",sans-serif;fill:#4c617a;stroke:none;font-size:12px}.port-dot{fill:#fff;stroke:#3579be;stroke-width:2}.valve-cell{stroke:#3c5169;stroke-width:1.8;fill:white}.valve-cell.chosen{fill:#e5efff;stroke:#377dcc}.component .caption{fill:#536984;font-size:12px}.component .reading{fill:#9b6e35;font-size:11px}.board-empty{fill:#69788c;font-size:16px}';

// Shared vector geometry: the workbench and exported drawing call these same functions.
export function diagramGeometry(view, editor = {}) {
  const { model, state, valves } = view;
  const { pending = null, selected = null, selectedKind = null, interactive = true } = editor;
  const esc = escapeXml;
  const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');
  function geo(c) {
    const shapes = {
      pump: { P: [0, -42, 0, -1], S: [0, 42, 0, 1] },
      tank: { T: [0, -30, 0, -1] },
      relief: { P: [0, -36, 0, -1], T: [0, 36, 0, 1] },
      valve: { A: [-16, -60, 0, -1], B: [16, -60, 0, -1], P: [-16, 60, 0, 1], T: [16, 60, 0, 1] },
      cylinder: { A: [-60, 50, 0, 1], B: [20, 50, 0, 1] },
      motor: { A: [-55, 30, -1, 0], B: [55, 30, 1, 0] },
    };
    return Object.fromEntries(
      Object.entries(shapes[c.type]).map(([p, [x, y, dx, dy]]) => [
        p,
        { x: c.x + x, y: c.y + y, dx, dy, localX: x, localY: y },
      ]),
    );
  }
  function coord(s) {
    const [id, p] = s.split(':'),
      c = model.components.find((c) => c.id === id);
    return c ? geo(c)[p] : null;
  }
  function route(w) {
    const a = coord(w.from),
      b = coord(w.to);
    if (!a || !b) return '';
    const ac = model.components.find((c) => w.from.startsWith(c.id + ':')),
      bc = model.components.find((c) => w.to.startsWith(c.id + ':'));
    // Route around the default component bodies, recomputed after every drag.
    let pts;
    if (ac.type === 'pump' && bc.type === 'valve') {
      const y = Math.min(ac.y - 110, bc.y - 95),
        x = Math.min(bc.x - 125, ac.x + 375);
      pts = [
        [a.x, a.y],
        [a.x, y],
        [x, y],
        [x, b.y + 45],
        [b.x, b.y + 45],
        [b.x, b.y],
      ];
    } else if (ac.type === 'pump' && bc.type === 'relief') {
      const y = Math.min(a.y, b.y) - 28;
      pts = [
        [a.x, a.y],
        [a.x, y],
        [b.x, y],
        [b.x, b.y],
      ];
    } else if (ac.type === 'valve' && bc.type === 'tank') {
      const x = bc.x + 130,
        y = Math.max(a.y + 80, bc.y + 55);
      pts = [
        [a.x, a.y],
        [a.x, y],
        [x, y],
        [x, b.y],
        [b.x, b.y],
      ];
    } else if (ac.type === 'relief' && bc.type === 'tank') {
      pts = [
        [a.x, a.y],
        [a.x, b.y],
        [b.x, b.y],
      ];
    } else if (Math.abs(a.x - b.x) < 2 || Math.abs(a.y - b.y) < 2)
      pts = [
        [a.x, a.y],
        [b.x, b.y],
      ];
    else {
      const aa = [a.x + a.dx * 22, a.y + a.dy * 22],
        bb = [b.x + b.dx * 22, b.y + b.dy * 22],
        my = (aa[1] + bb[1]) / 2;
      pts = [[a.x, a.y], aa, [aa[0], my], [bb[0], my], bb, [b.x, b.y]];
    }
    return pts.map((p, i) => (i ? 'L' : 'M') + p.join(' ')).join(' ');
  }
  function portMarkup(c) {
    return Object.entries(geo(c))
      .map(
        ([p, v]) =>
          `<g class="port ${pending === c.id + ':' + p ? 'active' : ''}" data-port="${c.id}:${p}" role="button" aria-label="${esc(c.label)} ${p} 油口" tabindex="0">${interactive ? `<circle class="port-hit" cx="${v.localX}" cy="${v.localY}" r="13"/>` : ''}<circle class="port-dot" cx="${v.localX}" cy="${v.localY}" r="4.5"/><text x="${v.localX + 9}" y="${v.localY + 4}" font-size="11">${p}</text></g>`,
      )
      .join('');
  }
  const arrow = (x1, y1, x2, y2) => `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" marker-end="url(#arrow)"/>`;
  function symbol(c, r) {
    let body = '',
      captionY = 65,
      captionX = 0;
    if (c.type === 'pump') {
      body = `<circle class="symbol" r="27"/><path class="symbol" d="M0 -42V-27 M0 27V42 M-27 0H-46"/><path d="M-8 -6L8 -6L0 -21Z" fill="#3c5169"/><text x="-57" y="5" text-anchor="middle">M</text>`;
      captionY = 68;
    }
    if (c.type === 'tank') {
      body = '<path class="symbol" d="M0 -30V-9 M-32 -14V23H32V-14 M-26 7H26 M-26 15H26"/>';
      captionY = 46;
    }
    if (c.type === 'relief') {
      body = `<rect class="symbol" x="-20" y="-22" width="40" height="44"/><path class="symbol" d="M0 -36V-22 M0 22V36 M20 0H32L36 -8L42 8L48 -8L54 8L58 0H66"/><g class="symbol">${arrow(0, -15, 0, 15)}</g><text x="50" y="-20" text-anchor="middle">${fmt(c.params.setting, 1)} MPa</text>`;
      captionY = 61;
    }
    if (c.type === 'valve') {
      const valve = valves.find((v) => v.componentId === c.id);
      if (!valve) throw new Error('Valve display missing instance: ' + c.id);
      const mode = valve.displayPositionId;
      body += `<g class="valve-spool" transform="translate(${mode === 'extend' ? 60 : mode === 'retract' ? -60 : 0},0)">`;
      for (let i = 0; i < 3; i++) {
        const x = (i - 1) * 60,
          m = ['extend', 'neutral', 'retract'][i];
        let paths = '';
        if (i === 0) paths = arrow(-16, 21, -16, -21) + arrow(16, -21, 16, 21);
        if (i === 2) paths = arrow(-16, 21, 16, -21) + arrow(-16, -21, 16, 21);
        if (i === 1)
          paths =
            c.center === 'closed'
              ? '<path d="M-16 -28V-12 M-23 -12H-9 M16 -28V-12 M9 -12H23 M-16 28V12 M-23 12H-9 M16 28V12 M9 12H23"/>'
              : '<path d="M-16 -28V-12 M-23 -12H-9 M16 -28V-12 M9 -12H23 M-16 28V5H16V28"/>';
        body += `<g transform="translate(${x},0)" data-switch="${m}" role="button" tabindex="0" aria-label="${esc(c.label)} ${['左位', '中位', '右位'][i]}方格：只选中"><rect class="valve-cell ${mode === m ? 'chosen' : ''} ${valve.effectivePositionId === m ? 'effective-step' : ''}" x="-30" y="-30" width="60" height="60"/><g class="symbol" style="pointer-events:none;fill:none">${paths}</g></g>`;
      }
      body += '</g><path class="symbol" d="M-16 -60V-30 M16 -60V-30 M-16 30V60 M16 30V60"/>';
      captionX = 115;
      captionY = 72;
      const names = { extend: '左位', neutral: '中位', retract: '右位' };
      const source = { design: '设计初态', preview: '请求预览', step: '成功步', kernel: '内核状态' }[valve.source];
      body += `<text class="reading" x="115" y="89" text-anchor="middle" data-valve-id="${esc(c.id)}" data-valve-source="${valve.source}" data-display-position="${mode}" data-effective-position="${valve.effectivePositionId ?? ''}">${source}：${names[mode]}${valve.source === 'preview' ? '（非有效步）' : ''}</text>`;
    }
    if (c.type === 'cylinder') {
      const t = Math.max(0, Math.min(1, state.position / c.params.stroke)),
        px = -58 + t * 65;
      body = `<rect class="symbol" x="-83" y="-25" width="123" height="50"/><rect x="-81" y="-23" width="${px + 81}" height="46" fill="#f6ddd8"/><rect x="${px + 8}" y="-23" width="${32 - px}" height="46" fill="#dcecf9"/><rect class="symbol" x="${px}" y="-23" width="8" height="46"/><rect class="symbol" x="${px + 8}" y="-6" width="95" height="12"/><path class="symbol" d="M-60 25V50 M20 25V50"/><text x="-22" y="-42" text-anchor="middle" class="reading">${r.ok ? fmt(state.position, 1) : '—'} / ${fmt(c.params.stroke, 0)} mm</text>`;
      captionY = -62;
    }
    if (c.type === 'motor') {
      body = `<circle class="symbol" r="32"/><path class="symbol" d="M-55 30H-35V0H-32 M55 30H35V0H32"/><path d="M-30 -8L-30 8L-15 0Z M30 -8L30 8L15 0Z" fill="#3c5169"/><g transform="rotate(${state.angle || 0})"><circle cx="0" cy="0" r="8" fill="white" stroke="#597798"/><path d="M0 -18V-8 M8 0H18 M0 8V18 M-8 0H-18" stroke="#597798" stroke-width="2"/></g><text x="0" y="-47" text-anchor="middle" class="reading">${r.ok ? fmt(r.rpm, 0) : '—'} r/min</text>`;
      captionY = -66;
    }
    const box =
      c.type === 'valve' ? [-160, -75, 320, 180] : c.type === 'cylinder' ? [-95, -78, 205, 140] : [-72, -77, 145, 160];
    return `<g data-component="${c.id}" class="component" transform="translate(${c.x},${c.y})" role="group" ${interactive ? 'tabindex="0"' : ''} aria-label="${esc(c.label)}">${selected === c.id && selectedKind === 'component' ? `<rect class="selection" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" rx="8"/>` : ''}${body}<text class="caption" x="${captionX}" y="${captionY}" text-anchor="middle">${esc(c.label)}</text>${portMarkup(c)}</g>`;
  }

  return { route, symbol };
}
