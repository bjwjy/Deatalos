let fieldId = 0;

/** A row may also contain action buttons. Only its input should receive native label activation. */
export function associateFieldLabel(label: HTMLLabelElement): void {
  const control = label.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  if (!control) return;
  if (!control.id) control.id = 'network-field-' + ++fieldId;
  label.htmlFor = control.id;
}

export function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing workbench element: ' + id);
  return value;
}
/** Preserve text nodes and avoid invalidating layout for unchanged status labels. */
export function setText(target: Element, value: string): void {
  if (target.textContent !== value) target.textContent = value;
}
export const escapeHtml = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
export function boardElement(): SVGSVGElement {
  const value = document.getElementById('board');
  if (!(value instanceof SVGSVGElement)) throw new Error('Workbench board must be SVG');
  return value;
}
