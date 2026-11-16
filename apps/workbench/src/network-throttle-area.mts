import { diagnostic, type Result } from '@hyd/domain';
/** UI adapter only. Engineering documents and kernel commands remain SI. */
export const throttleAreaMm2 = (areaM2: number): number => areaM2 * 1_000_000;
export function throttleAreaFromInput(value: string, maximumM2: number): Result<number> {
  if (!value.trim())
    return { ok: false, diagnostics: [diagnostic('PARAMETER_INVALID', '/opening', '请填写开口面积；空白不代表零。')] };
  const mm2 = Number(value),
    maximumMm2 = throttleAreaMm2(maximumM2);
  if (!Number.isFinite(mm2) || mm2 < 0 || mm2 > maximumMm2)
    return {
      ok: false,
      diagnostics: [diagnostic('PARAMETER_INVALID', '/opening', `开口面积须在0～${maximumMm2} mm²之间。`)],
    };
  // Preserve the exact model endpoint when decimal unit conversion rounds by an ulp.
  return { ok: true, value: mm2 === maximumMm2 ? maximumM2 : mm2 / 1_000_000 };
}
