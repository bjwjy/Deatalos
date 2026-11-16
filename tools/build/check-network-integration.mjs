import { integrationCatalog, validateIntegration, probeDefinition } from '../project/network-integration.mjs';
const catalog = integrationCatalog(),
  issues = validateIntegration(catalog),
  probes = [];
for (const definition of catalog.creation) {
  const result = probeDefinition(definition);
  if (!result.ok) issues.push(definition.id + ': ' + JSON.stringify(result.diagnostics));
  else probes.push(result.value);
}
console.log(
  JSON.stringify(
    { definitions: catalog.definitions.length, creation: catalog.creation.length, probes, issues },
    null,
    2,
  ),
);
if (issues.length) process.exitCode = 1;
