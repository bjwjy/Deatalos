import type { NetworkDefinition } from './network-registry.js';
import { immutable } from './reader.js';

/** Single-port ideal polytropic gas storage, distinct from liquid compliance. */
export const accumulatorDefinition: NetworkDefinition = immutable({
  id: 'teaching:accumulator',
  version: 1,
  typeId: 'accumulator',
  model: { id: 'teaching:accumulator', version: '0.8.0', solverId: 'hopsan' },
  evidence: 'runtime-candidate',
  ports: [{ id: 'H', domain: 'hydraulic', positiveFlow: 'into-component', anchor: [0, 48, 0, 1] }],
  drawingBounds: { left: -31, right: 31, top: -49, bottom: 53 },
  groups: {
    gas: [
      { key: 'totalVolumeM3', unit: 'm³', minimum: 1e-6, maximum: 1, defaultValue: 0.001 },
      { key: 'prechargeAbsolutePa', unit: 'Pa', minimum: 1e4, maximum: 20e6, defaultValue: 1.1e6 },
      { key: 'polytropicExponent', unit: '1', minimum: 1, maximum: 1.4, defaultValue: 1.4 },
      { key: 'minimumGasFraction', unit: '1', minimum: 0.01, maximum: 0.9, defaultValue: 0.25 },
    ],
    hydraulic: [{ key: 'portResistancePaSPerM3', unit: 'Pa·s/m³', minimum: 1e8, maximum: 1e13, defaultValue: 1e10 }],
  },
  initialKind: 'accumulator',
  control: 'none',
  flowPolicy: 'bidirectional',
});
