export function pressureProbeGauge(_color: number, pressurePa: number | null, drawingScale = 1): string {
  const hue = '#354b62',
    value = pressurePa === null ? '—' : (pressurePa / 1e6).toFixed(2);
  // Fixed display span only; this dial never clamps or alters the measured value used by conditions.
  const angle = ((180 + Math.min(1, Math.max(0, (pressurePa ?? 0) / 1e7)) * 180) * Math.PI) / 180;
  const ticks = Array.from({ length: 7 }, (_, i) => {
    const a = ((180 + i * 30) * Math.PI) / 180;
    return `<path d="M${Math.cos(a) * 26} ${Math.sin(a) * 26}L${Math.cos(a) * 22} ${Math.sin(a) * 22}"/>`;
  }).join('');
  return `<circle r="33" fill="white" stroke="${hue}" stroke-width="2.5" data-probe-ring="true"/><g stroke="${hue}" stroke-width="1.5">${ticks}</g><path d="M0 0L${pressurePa === null ? '14 -16' : `${Math.cos(angle) * 19} ${Math.sin(angle) * 19}`}" stroke="${pressurePa === null ? '#94a3ad' : '#16838b'}" stroke-width="2.5"/><circle r="2.5" fill="${hue}"/><text text-anchor="middle" y="16" fill="${hue}" stroke="none" font-size="${10 / drawingScale}" font-family="Arial">${value}</text><text text-anchor="middle" y="27" fill="#617783" stroke="none" font-size="${6 / drawingScale}">MPa</text>`;
}
export function controllerSymbol(_color: number): string {
  return '<g data-dynamic-controller="true"><rect x="-60" y="-32" width="120" height="64" rx="9"/><path d="M-43 13V1h12V-13h12V13h12V-3H5"/><text x="30" y="5" text-anchor="middle" fill="#354b62" stroke="none" font-size="15">控制</text></g>';
}
export function pressureGaugePictogram(): string {
  return (
    '<svg viewBox="-45 -40 90 105" aria-hidden="true">' +
    pressureProbeGauge(1, null) +
    '<path d="M0 33V60" stroke="#354b62" stroke-width="2.5"/></svg>'
  );
}
