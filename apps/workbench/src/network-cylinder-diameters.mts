import { engineeringInputValue, setEngineeringInputValue } from './network-engineering-inputs.mjs';

export function cylinderDiameterFields(hasRod: boolean): string {
  const diameters = [['bore', '缸径']];
  if (hasRod) diameters.push(['rod', '活塞杆直径']);
  return diameters
    .map(
      ([key, name]) =>
        `<label><span>${name} <small>mm</small></span><input id="cylinder-${key}" data-cylinder-diameter="${key}" data-engineering-unit="m" data-engineering-precision="10" type="number" step="any" min="0" required aria-label="${name}"></label>`,
    )
    .join('');
}

/** Keep the model's exact area values until the user edits a diameter. Older projects may have equal areas. */
export function bindCylinderDiameters(root: HTMLElement): void {
  const bore = root.querySelector<HTMLInputElement>('[data-cylinder-diameter="bore"]');
  const rod = root.querySelector<HTMLInputElement>('[data-cylinder-diameter="rod"]');
  const cap = root.querySelector<HTMLInputElement>('[data-param="geometry.capAreaM2"]');
  const annulus = root.querySelector<HTMLInputElement>('[data-param="geometry.rodSideAreaM2"]');
  if (!bore || !cap) return;
  const fromAreas = () => {
    const a = engineeringInputValue(cap);
    setEngineeringInputValue(bore, Math.sqrt((4 * a) / Math.PI));
    if (annulus && rod) {
      setEngineeringInputValue(rod, Math.sqrt((4 * (a - engineeringInputValue(annulus))) / Math.PI));
      rod.setCustomValidity('');
    }
    bore.setCustomValidity('');
  };
  const fromDiameters = () => {
    const d = engineeringInputValue(bore);
    const r = rod ? engineeringInputValue(rod) : 0;
    bore.setCustomValidity(d > 0 ? '' : '缸径必须大于零。');
    rod?.setCustomValidity(r >= 0 && r < d ? '' : '活塞杆直径必须小于缸径，且不能为负数。');
    if (!bore.validity.valid || (rod && !rod.validity.valid)) return;
    setEngineeringInputValue(cap, (Math.PI * d ** 2) / 4);
    if (annulus) setEngineeringInputValue(annulus, (Math.PI * (d ** 2 - r ** 2)) / 4);
  };
  bore.addEventListener('input', fromDiameters);
  rod?.addEventListener('input', fromDiameters);
  cap.addEventListener('input', fromAreas);
  annulus?.addEventListener('input', fromAreas);
  fromAreas();
}
