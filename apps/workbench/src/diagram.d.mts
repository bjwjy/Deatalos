import type { displayExport } from './application-bridge.mjs';

// The bounded legacy JavaScript geometry is shared by the UI and strict exporter.
type View = ReturnType<typeof displayExport>;
export const diagramDefs: string;
export const diagramStyles: string;
export function escapeXml(value: unknown): string;
export function diagramGeometry(
  view: View,
  editor?: {
    readonly pending?: string | null;
    readonly selected?: string | null;
    readonly selectedKind?: string | null;
    readonly interactive?: boolean;
  },
): {
  route(wire: View['model']['wires'][number]): string;
  symbol(component: View['model']['components'][number], result: View['result']): string;
};
