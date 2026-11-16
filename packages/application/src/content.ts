import type { ProjectDocument } from '@hyd/domain';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}
export function content(document: ProjectDocument): string {
  const { updatedAt: _timestamp, ...saved } = document;
  return canonical(saved);
}
export function physicalContent(document: ProjectDocument): string {
  return canonical({
    ...document.design,
    components: document.design.components.map((c) => {
      const { label: _label, ...physical } = c;
      return physical;
    }),
    provenance: { solver: document.provenance.preferredSolverId, model: document.provenance.modelVersion },
  });
}
export function copyDocument(document: ProjectDocument) {
  return {
    ...document,
    design: {
      ...document.design,
      fluid: { ...document.design.fluid },
      components: document.design.components.map((c) => ({ ...c, params: { ...c.params } })),
      connections: document.design.connections.map((c) => ({
        ...c,
        from: { ...c.from },
        to: { ...c.to },
        params: { ...c.params },
      })),
      initialConditions: {
        actuators: document.design.initialConditions.actuators.map((a) => ({ ...a })),
        valves: document.design.initialConditions.valves.map((v) => ({ ...v })),
      },
    },
    layout: {
      components: document.layout.components.map((p) => ({ ...p })),
      routes: document.layout.routes.map((r) => ({ ...r })),
    },
  };
}
