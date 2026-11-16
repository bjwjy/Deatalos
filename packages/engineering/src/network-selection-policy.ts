import { immutable } from '@hyd/domain';
import { selectionSeries } from './network-catalog.js';

export const preferredCylinderBoresMm = [25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 320, 400, 500] as const;
export const teachingCylinderRodMm = (boreMm: number): number => Math.round(boreMm * 0.6);

/** Search preferences only. Registered definitions and local user constraints still own the hard domain. */
export const networkSelectionPolicy = immutable({
  version: 'e13s09-steady-selection-0.1' as const,
  budgetModes: ['automatic', 'fixed', 'range'] as const,
  cylinderPairsMm: preferredCylinderBoresMm.map((bore) => ({ bore, rod: teachingCylinderRodMm(bore) })),
  cylinderSource: '软件教学缸径系列和 0.6 杆径比取整，实际产品组合待核对',
  displacementM3PerRev: selectionSeries.displacementCm3PerRev.map((value) => value / 1e6),
  displacementSource: selectionSeries.version,
  maximumBudgetPa: 70e6,
  automaticBudget: '保留自动起点；各工况有已接通的溢流边界时，才按需求提高试算预算。',
  limitations: '稳态初选；额定能力、过量供油及动态表现需另行核对。溢流开启压差保持原设定。',
});
