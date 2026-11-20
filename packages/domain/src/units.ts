// Scale factors convert legacy/display values to SI; rev is an explicit count.
export const unitScales = Object.freeze({
  pressure: { legacy: 'MPa', si: 'Pa', factor: 1e6 },
  displacement: { legacy: 'mL/r', si: 'm³/rev', factor: 1e-6 },
  angularSpeed: { legacy: 'r/min', si: 'rad/s', factor: (2 * Math.PI) / 60 },
  flow: { legacy: 'L/min', si: 'm³/s', factor: 1 / 60000 },
  length: { legacy: 'mm', si: 'm', factor: 1e-3 },
  pipeLength: { legacy: 'm', si: 'm', factor: 1 },
  linearSpeed: { legacy: 'mm/s', si: 'm/s', factor: 1e-3 },
  pipeSpeed: { legacy: 'm/s', si: 'm/s', factor: 1 },
  force: { legacy: 'kN', si: 'N', factor: 1000 },
  torque: { legacy: 'N·m', si: 'N·m', factor: 1 },
  viscosity: { legacy: 'mm²/s', si: 'm²/s', factor: 1e-6 },
  density: { legacy: 'kg/m³', si: 'kg/m³', factor: 1 },
  power: { legacy: 'kW', si: 'W', factor: 1000 },
  angle: { legacy: 'degree', si: 'rad', factor: Math.PI / 180 },
  area: { legacy: 'm²', si: 'm²', factor: 1 },
  time: { legacy: 's', si: 's', factor: 1 },
  ratio: { legacy: '0–1', si: '1', factor: 1 },
  coefficient: { legacy: '—', si: '1', factor: 1 },
} as const);
for (const scale of Object.values(unitScales)) Object.freeze(scale);
export type Quantity = keyof typeof unitScales;
function finiteKnown(value: number): number {
  // An invalid call is a programming defect: file inputs are parsed as Result
  // before conversion. In particular null must never coerce into known zero.
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError('Unit conversion requires a finite known value');
  return value;
}
export function toSI(quantity: Quantity, value: number): number {
  return finiteKnown(finiteKnown(value) * unitScales[quantity].factor);
}
export function fromSI(quantity: Quantity, value: number): number {
  return finiteKnown(finiteKnown(value) / unitScales[quantity].factor);
}

// Conversion primitives do not infer whether a legacy zero means known or unknown.
export type PhysicalValue =
  { readonly kind: 'known'; readonly value: number } | { readonly kind: 'unknown'; readonly reason: string };

/** Engineering display scales. Model parameters and serialized files retain SI. */
export interface EngineeringUnit {
  readonly label: string;
  readonly scale: number;
}
const unit = (label: string, scale: number): EngineeringUnit => ({ label, scale });
const engineeringUnits: Readonly<Record<string, readonly EngineeringUnit[]>> = {
  Pa: [unit('MPa', 1e6), unit('bar', 1e5)],
  m: [unit('mm', 0.001), unit('m', 1)],
  'm²': [unit('mm²', 1e-6), unit('cm²', 1e-4)],
  'm³': [unit('L', 0.001), unit('mL', 1e-6)],
  'm³/s': [unit('L/min', 1 / 60000), unit('mL/s', 1e-6)],
  'm³/rev': [unit('cm³/rev', 1e-6)],
  'm/s': [unit('mm/s', 0.001), unit('m/min', 1 / 60)],
  'rad/s': [unit('r/min', Math.PI / 30), unit('rad/s', 1)],
  rad: [unit('°', Math.PI / 180), unit('rad', 1)],
  N: [unit('kN', 1000), unit('N', 1)],
  W: [unit('kW', 1000), unit('W', 1)],
  'm²/s': [unit('mm²/s', 1e-6)],
  'N/m': [unit('N/mm', 1000)],
  'm³/rad': [unit('cm³/rad', 1e-6)],
  'm³/(s·Pa)': [unit('L/(min·MPa)', 1 / 6e10)],
  'Pa·s/m³': [unit('MPa/(L/min)', 6e10)],
};
export function engineeringUnitChoices(si: string, key = ''): readonly EngineeringUnit[] {
  if (key === 'frequencyRadPerS') return [unit('Hz', 2 * Math.PI), unit('rad/s', 1)];
  if (key === 'lengthM') return [unit('m', 1), unit('mm', 0.001)];
  return engineeringUnits[si] ?? [unit(si, 1)];
}

export function engineeringValueText(value: number | undefined, unitSI: string, key = ''): string {
  if (value === undefined) return '未设置';
  const choice = engineeringUnitChoices(unitSI, key)[0];
  if (!choice) throw new Error('Missing engineering unit');
  return Number((value / choice.scale).toPrecision(8)) + (choice.label === '1' ? '' : ' ' + choice.label);
}
