import {
  networkDefinitions,
  networkCreationDefinitions,
  networkInitialKinds,
  networkInitialFor,
  networkCreationParameters,
  networkStepCapability,
  networkPortActive,
  isNetworkActuatorType,
} from '@hyd/domain';
import { networkLayoutProfiles } from '@hyd/application';
import { hopsanMappingRegistrations, networkStateAdapterTypes, compileHopsan } from '@hyd/engine';
import { networkResultAdapterTypes } from '@hyd/engineering';
import { createNetworkDraft } from '@hyd/project-io';
import { networkSymbol, networkSymbolTypes } from '../../apps/workbench/dist/network-symbols.mjs';
import { networkComponentEditingTypes } from '../../apps/workbench/dist/network-component-editing.mjs';

export function integrationCatalog() {
  return {
    definitions: networkDefinitions,
    creation: networkCreationDefinitions,
    initialKinds: networkInitialKinds,
    mappings: hopsanMappingRegistrations,
    symbols: networkSymbolTypes,
    states: networkStateAdapterTypes,
    results: networkResultAdapterTypes,
    editing: networkComponentEditingTypes,
    layout: networkLayoutProfiles,
  };
}
/** Cross-layer development check only; it does not certify physical models. */
export function validateIntegration(catalog) {
  const issues = [],
    keys = new Set(),
    hydraulicPortsByType = new Map();
  for (const definition of catalog.definitions) {
    const key = definition.id + '/' + definition.version;
    if (keys.has(key)) issues.push(key + ': duplicate definition');
    keys.add(key);
    if (!catalog.initialKinds.includes(definition.initialKind)) issues.push(key + ': missing initial factory');
    if (!catalog.symbols.includes(definition.typeId)) issues.push(key + ': missing symbol');
    if (!catalog.editing.includes(definition.typeId)) issues.push(key + ': missing editing policy');
    const profile = Object.hasOwn(catalog.layout, definition.typeId) ? catalog.layout[definition.typeId] : undefined;
    if (!profile) issues.push(key + ': missing layout profile');
    else if (
      (profile.role === 'actuator') !== isNetworkActuatorType(definition.typeId) ||
      (profile.role === 'controller') !== (definition.role === 'controller')
    )
      issues.push(key + ': layout role disagrees with definition');
    const hydraulic = hydraulicPortsByType.get(definition.typeId) ?? new Set();
    hydraulicPortsByType.set(definition.typeId, hydraulic);
    const ports = new Set();
    for (const port of definition.ports) {
      if (
        ports.has(port.id) ||
        port.anchor.length !== 4 ||
        !port.anchor.every(Number.isFinite) ||
        !(
          (port.domain === 'hydraulic' && port.positiveFlow === 'into-component') ||
          (port.domain === 'signal' && ['input', 'output'].includes(port.direction))
        )
      )
        issues.push(key + ': invalid port/anchor');
      ports.add(port.id);
      if (port.domain === 'hydraulic') {
        hydraulic.add(port.id);
        if (profile && !Object.hasOwn(profile.ports, port.id)) issues.push(key + ': missing layout port ' + port.id);
      } else if (profile && Object.hasOwn(profile.ports, port.id)) {
        issues.push(key + ': signal port marked hydraulic in layout ' + port.id);
      }
    }
    if (!ports.size && definition.role !== 'controller') issues.push(key + ': missing ports');
    if (
      definition.role === 'controller' &&
      (ports.size ||
        definition.initialKind !== 'none' ||
        definition.control !== 'none' ||
        definition.model.solverId !== 'application')
    )
      issues.push(key + ': invalid application-only control role');
    for (const [group, parameters] of Object.entries(definition.groups)) {
      const names = new Set();
      for (const parameter of parameters) {
        if (
          names.has(parameter.key) ||
          !parameter.unit ||
          ![parameter.minimum, parameter.maximum, parameter.defaultValue].every(Number.isFinite) ||
          parameter.minimum > parameter.defaultValue ||
          parameter.defaultValue > parameter.maximum
        )
          issues.push(key + ': invalid SI parameter ' + group);
        names.add(parameter.key);
      }
    }
    if (
      (definition.control === 'position' && definition.initialKind !== 'valve') ||
      (definition.control === 'opening-area' && definition.initialKind !== 'throttle')
    )
      issues.push(key + ': control/initial mismatch');
  }
  for (const [type, profile] of Object.entries(catalog.layout)) {
    const hydraulic = hydraulicPortsByType.get(type);
    if (!hydraulic) issues.push(type + ': layout profile has no definition');
    else
      for (const port of Object.keys(profile.ports))
        if (!hydraulic.has(port)) issues.push(type + ': layout port has no hydraulic definition ' + port);
  }
  for (const definition of catalog.creation) {
    const key = definition.id + '/' + definition.version;
    if (!keys.has(key)) issues.push(key + ': creation definition missing');
    if (
      !catalog.mappings.some((mapping) => mapping.id === definition.id && mapping.versions.includes(definition.version))
    )
      issues.push(key + ': missing backend mapping');
    if (!catalog.states.includes(definition.typeId)) issues.push(key + ': missing state policy');
    if (!catalog.results.includes(definition.typeId)) issues.push(key + ': missing result policy');
  }
  for (const mapping of catalog.mappings)
    for (const version of mapping.versions) {
      if (!keys.has(mapping.id + '/' + version))
        issues.push(mapping.id + '/' + version + ': mapping has no definition');
    }
  return issues;
}

/** A small valid graph per creation definition verifies real adapter port output.
 * Pressure boundaries are explicit test inputs, never defaults for user designs. */
export function probeDefinition(definition) {
  const draft = createNetworkDraft({
    projectId: 'integration-check',
    timestamp: '2026-10-23T00:00:00.000Z',
    appVersion: 'M03',
  });
  if (!draft.ok) throw new Error(JSON.stringify(draft.diagnostics));
  const component = {
    id: 'tested',
    typeId: definition.typeId,
    label: definition.id,
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters: networkCreationParameters(definition),
  };
  const initial = networkInitialFor(component);
  if (!initial.ok) return initial;
  if (definition.role === 'controller') {
    if (
      definition.ports.length ||
      initial.value !== null ||
      !networkSymbol(component).includes('data-component-id="tested"')
    )
      throw new Error('Invalid unconnected controller projection');
    return {
      ok: true,
      value: {
        definition: definition.id,
        version: definition.version,
        ports: [],
        role: 'application-control',
        physicalModel: false,
        controls: 0,
        initialKind: 'none',
      },
    };
  }
  const hydraulicPorts = definition.ports.filter((p) => p.domain === 'hydraulic' && networkPortActive(component, p.id));
  const boundaries = hydraulicPorts.map((_port, i) => ({
    id: 'boundary' + i,
    typeId: 'pressure-source',
    label: '显式测试边界',
    definition: { id: 'teaching:pressure-source', version: 1 },
    model: { id: 'teaching:pressure-source', version: '0.1.0' },
    parameters: { hydraulic: { pressurePa: 1e5 } },
  }));
  const document = {
    ...draft.value,
    design: {
      ...draft.value.design,
      pressureReference:
        definition.typeId === 'accumulator'
          ? { kind: 'gauge', absoluteReferencePa: 1e5 }
          : draft.value.design.pressureReference,
      components: [component, ...boundaries],
      initialConditions: initial.value ? [initial.value] : [],
      connections: hydraulicPorts.map((port, i) => ({
        id: 'edge' + i,
        kind: 'ideal',
        from: { kind: 'port', componentId: 'tested', portId: port.id },
        to: { kind: 'port', componentId: 'boundary' + i, portId: 'P' },
      })),
    },
    layout: {
      ...draft.value.layout,
      components: [component, ...boundaries].map((c, i) => ({ componentId: c.id, x: i * 100, y: 0 })),
      routes: hydraulicPorts.map((_port, i) => ({ connectionId: 'edge' + i, mode: 'auto' })),
    },
  };
  if (['pressure-source', 'tank'].includes(definition.typeId)) {
    const throttle = {
      id: 'restriction',
      typeId: 'throttle',
      label: '显式测试负载',
      definition: { id: 'teaching:throttle', version: 1 },
      model: { id: 'teaching:throttle', version: '0.1.0' },
      parameters: { hydraulic: { maximumAreaM2: 1e-6, flowCoefficient: 0.67 } },
    };
    document.design.components.push(throttle);
    document.design.initialConditions.push({ componentId: 'restriction', kind: 'throttle', openingAreaM2: 1e-6 });
    document.design.connections[0].to = { kind: 'port', componentId: 'restriction', portId: 'A' };
    document.design.connections.push({
      id: 'load',
      kind: 'ideal',
      from: { kind: 'port', componentId: 'restriction', portId: 'B' },
      to: { kind: 'port', componentId: 'boundary0', portId: 'P' },
    });
    document.layout.components.push({ componentId: 'restriction', x: 200, y: 0 });
    document.layout.routes.push({ connectionId: 'load', mode: 'auto' });
  }
  // Match the product's established model-specific clock policy instead of a separate test policy.
  // This registry/mapping probe does not qualify unsupported steps; their rejection remains mandatory.
  const nativeStepS = networkStepCapability(document.design.components).automaticStepS;
  const mapped = compileHopsan(document, {
    nativeStepS,
    junctionPolicy: 'tlm-limit',
    initialPressurePa: 1e5,
    volumeScale: 1,
    constraintPressureTolerancePa: 1,
  });
  if (!mapped.ok) return mapped;
  const missing = hydraulicPorts.filter(
    (port) => !mapped.value.ports.some((binding) => binding.key === `p:tested:${port.id}`),
  );
  if (missing.length) throw new Error('Missing mapped ports: ' + JSON.stringify(missing));
  if (!networkSymbol(component).includes('data-component-id="tested"')) throw new Error('Missing symbol instance');
  return {
    ok: true,
    value: {
      definition: definition.id,
      nativeStepS,
      version: definition.version,
      ports: hydraulicPorts.map((port) => port.id),
      initialKind: initial.value?.kind ?? 'none',
      controls: mapped.value.controls.filter((control) => control.componentId === 'tested').length,
    },
  };
}
