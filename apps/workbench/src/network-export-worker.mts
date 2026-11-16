import { exportNetworkCsv, exportNetworkLearningCsv, type NetworkExportCapture } from '@hyd/application';
import { exportNetworkSvg } from './network-export-svg.mjs';
import type { PressureBands } from './network-pressure.mjs';

// Internal worker receives only the renderer's validated immutable capture.
// It owns no kernel, file, Node or network capabilities.
self.onmessage = (
  event: MessageEvent<{
    format: 'csv' | 'svg' | 'learning';
    capture: NetworkExportCapture;
    labels: 'all' | 'none';
    pressureBands: PressureBands;
  }>,
) => {
  const { format, capture, labels, pressureBands } = event.data;
  self.postMessage(
    format === 'csv'
      ? exportNetworkCsv(capture)
      : format === 'learning'
        ? exportNetworkLearningCsv(capture)
        : exportNetworkSvg(capture, labels, pressureBands),
  );
};
