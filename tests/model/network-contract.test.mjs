import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { parseNetworkProject, parseNetworkSnapshot, initialNetworkControls, requestNetworkControls, networkDefinitions,
  networkParameter, networkDefaultParameters, networkCapabilities, parseDocument } from '@hyd/domain';
import { parseNetworkFile, encodeNetworkProject, encodeNetworkResult, networkProjectSchema, parseProject, upgradeNetworkDocument } from '@hyd/project-io';
import { createNetworkDraftSession } from '@hyd/application';
const good=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const bad=(r,code)=>{assert.equal(r.ok,false,JSON.stringify(r));assert.ok(r.diagnostics.some(d=>d.code===code),JSON.stringify(r));assert.equal('value'in r,false);};
const fixture=JSON.parse(await readFile('tests/fixtures/E00B/dual-contract.json','utf8'));
const runtime=JSON.parse(await readFile('tests/fixtures/E00B/runtime-contract.json','utf8'));
const context={projectId:'upgrade-fixture',timestamp:'2026-10-18T00:00:00.000Z',appVersion:'E00B-contract-1'};
const output=path.resolve(process.env.E00B_OUTPUT??'artifacts/verification/E00B/implementation/checks');
await mkdir(output,{recursive:true});
const validate=new Ajv({strictSchema:false,allErrors:true}).compile(networkProjectSchema());

test('only the parser-owned frozen project can be reused for repeated validation', () => {
  const input = structuredClone(fixture);
  const parsed = good(parseNetworkProject(input));
  assert.equal(good(parseNetworkProject(parsed)), parsed);
  assert.ok(Object.isFrozen(parsed.design.components[0].parameters));

  input.design.components[0].id = '';
  bad(parseNetworkProject(Object.freeze(input)), 'IDENTIFIER_INVALID');
  assert.equal(good(parseNetworkProject(parsed)), parsed);

  const copied = structuredClone(parsed);
  assert.notEqual(good(parseNetworkProject(copied)), copied);
});

test('v3 SI nodes roundtrip, old readers reject, no hidden volume, no runtime serialization',async()=>{
  const doc=good(parseNetworkProject(fixture));assert.ok(validate(doc),JSON.stringify(validate.errors));
  const bytes=good(encodeNetworkProject(doc));const loaded=good(parseNetworkFile(bytes));assert.deepEqual(loaded.document,doc);assert.equal(loaded.requiresSaveAs,false);
  bad(parseProject(bytes),'VERSION_UNSUPPORTED');bad(parseDocument(doc),'VERSION_UNSUPPORTED');
  const without=structuredClone(fixture);without.design.components=without.design.components.filter(c=>c.id!=='volume');without.layout.components=without.layout.components.filter(c=>c.componentId!=='volume');
  without.design.initialConditions=without.design.initialConditions.filter(c=>c.componentId!=='volume');without.design.connections=without.design.connections.filter(c=>c.id!=='volume-link');without.layout.routes=without.layout.routes.filter(c=>c.connectionId!=='volume-link');
  const ideal=good(parseNetworkProject(without));assert.equal(ideal.design.nodes.length,1);assert.equal(ideal.design.components.some(c=>c.typeId==='volume'),false);
  const injected=structuredClone(fixture);injected.runtime=runtime;bad(parseNetworkProject(injected),'UNKNOWN_FIELD');
  await writeFile(path.join(output,'dual-contract.hydx'),bytes);
});

test('parameter groups, correlation, zero/missing/null and unsupported versions are explicit',()=>{
  const pump=networkDefaultParameters('builtin:pump',1),motor=networkDefaultParameters('builtin:motor',1);
  assert.ok(Math.abs(pump.legacy.displacementM3PerRev-16e-6)<1e-18);assert.ok(Math.abs(motor.legacy.displacementM3PerRev-80e-6)<1e-18);
  assert.equal(networkParameter('teaching:cylinder',1,'geometry','strokeM').unit,'m');
  assert.equal(networkParameter('teaching:cylinder',1,'mechanics','strokeM'),undefined);
  const alter=edit=>{const d=structuredClone(fixture);edit(d);return parseNetworkProject(d);};
  bad(alter(d=>delete d.design.components[0].parameters.hydraulic.pressurePa),'PARAMETER_INVALID');
  bad(alter(d=>d.design.components[0].parameters.hydraulic.pressurePa=null),'PARAMETER_INVALID');
  good(alter(d=>d.design.components[0].parameters.hydraulic.pressurePa=0));
  bad(alter(d=>d.design.components[0].definition.version=2),'DEFINITION_UNSUPPORTED');
  bad(alter(d=>delete d.design.components[0].definition),'FILE_INVALID');
  bad(alter(d=>d.design.components[0].model.version='future'),'MODEL_UNSUPPORTED');
  bad(alter(d=>d.design.components.find(c=>c.id==='cylinder1').parameters.geometry.rodSideAreaM2=.01),'PARAMETER_INVALID');
  bad(alter(d=>d.design.initialConditions.find(c=>c.componentId==='cylinder1').positionM=2),'PARAMETER_INVALID');
  bad(alter(d=>d.design.components.find(c=>c.id==='valve1').parameters.spool.maximumTravelM=.0001),'PARAMETER_INVALID');
});

test('instance/port/node/initial/layout identities reject duplicates, dangling refs and fake node volume',()=>{
  for(const [edit,code] of [
    [d=>d.design.components.push(structuredClone(d.design.components[0])),'DUPLICATE_ID'],
    [d=>d.design.connections[0].from.portId='wrong','ENDPOINT_INVALID'],
    [d=>d.design.connections[1].to.nodeId='absent','REFERENCE_INVALID'],
    [d=>d.design.nodes[0].volumeM3=.0001,'UNKNOWN_FIELD'],
    [d=>d.design.initialConditions.push(structuredClone(d.design.initialConditions[0])),'DUPLICATE_ID'],
    [d=>d.layout.nodes[0].nodeId='absent','REFERENCE_INVALID'],
    [d=>d.design.connections.push({...d.design.connections[0],id:'repeat'}),'ENDPOINT_INVALID'],
  ]){const d=structuredClone(fixture);edit(d);bad(parseNetworkProject(d),code);}
});

test('registered symbol anchors/port validation share the same definition, coverage is scoped',()=>{
  for(const d of networkDefinitions){assert.ok(Object.isFrozen(d));assert.equal(new Set(d.ports.map(p=>p.id)).size,d.ports.length);
    for(const p of d.ports){assert.ok(['hydraulic','signal'].includes(p.domain));if(p.domain==='hydraulic')assert.equal(p.positiveFlow,'into-component');else assert.ok(['input','output'].includes(p.direction));assert.ok(p.anchor.every(Number.isFinite));}}
  const cap=good(networkCapabilities(fixture));assert.equal(cap.productionReady,false);assert.ok(cap.diagnostics.some(d=>d.code==='GRAPH_MAPPING_UNVERIFIED'));
  assert.equal(networkDefinitions.find(d=>d.id==='teaching:check-valve').evidence,'unverified');
  assert.equal(networkDefinitions.find(d=>d.id==='teaching:throttle').evidence,'spike-verified');
});

for(const name of ['cylinder','motor','reference-arm'])test(`v1/v2 ${name}: migrate to v3, physical pipes and source bytes preserved`,async()=>{
  const file=`tests/fixtures/v1/${name}.json`,before=await readFile(file),old=good(parseProject(before,context)).document;
  const loaded=good(parseNetworkFile(before,context));assert.equal(loaded.requiresSaveAs,true);assert.equal(loaded.source.text,before.toString('utf8'));
  assert.equal(loaded.document.provenance.preferredSolverId,'legacy-basic');assert.equal(loaded.document.design.fluid.bulkModulusPa,null);assert.deepEqual(loaded.document.design.nodes,[]);
  for(const [i,c] of loaded.document.design.connections.entries()){assert.equal(c.kind,'pipe');assert.deepEqual(c.parameters,old.design.connections[i].params);assert.equal(c.from.componentId,old.design.connections[i].from.componentId);}
  assert.deepEqual(good(upgradeNetworkDocument(old)),loaded.document);assert.ok(validate(loaded.document),JSON.stringify(validate.errors));
  assert.deepEqual(good(parseNetworkFile(good(encodeNetworkProject(loaded.document)))).document,loaded.document);
  assert.deepEqual(await readFile(file),before);await writeFile(path.join(output,`${name}-v3.hydx`),good(encodeNetworkProject(loaded.document)));
});

test('legacy missing valve.center remains M; design initial valve position is preserved',async()=>{
  const old=JSON.parse(await readFile('tests/fixtures/v1/cylinder.json','utf8'));delete old.components.find(c=>c.type==='valve').center;
  const loaded=good(parseNetworkFile(JSON.stringify(old),context));assert.equal(loaded.document.design.components.find(c=>c.typeId==='valve').definition.id,'builtin:valve-m');
  assert.ok(loaded.migration.changes.some(c=>c.code==='LEGACY_M_CENTER'));
  const v2=structuredClone(good(parseProject(JSON.stringify(old),context)).document);v2.design.initialConditions.valves[0].positionId='retract';
  assert.equal(good(parseNetworkFile(JSON.stringify(v2))).document.design.initialConditions.find(v=>v.kind==='valve').positionId,'retract');
});

test('two instances have distinct initial/request/effective/state; controls do not mutate design',()=>{
  const doc=good(parseNetworkProject(fixture)),before=JSON.stringify(doc),controls=initialNetworkControls(doc);
  assert.equal(controls[0].positionId,'extend');assert.equal(controls[1].positionId,'retract');
  const changed=good(requestNetworkControls(doc,controls,[{componentId:'valve1',kind:'position',positionId:'neutral'}]));
  assert.equal(changed.find(c=>c.componentId==='valve2').positionId,'retract');assert.equal(JSON.stringify(doc),before);
  const point=good(parseNetworkSnapshot(doc,runtime,runtime.identity));assert.notEqual(point.states[0].effectivePositionId,point.states[1].effectivePositionId);
  assert.notEqual(point.states[2].positionM,point.states[3].positionM);assert.ok(Object.isFrozen(point.states));
  bad(requestNetworkControls(doc,controls,[{componentId:'source',kind:'position',positionId:'extend'}]),'CONTROL_INVALID');
  bad(requestNetworkControls(doc,controls,[controls[0],controls[0]]),'DUPLICATE_ID');
});

test('native step vs host interval, state/result refs, unknown vs zero, stale controls and units',()=>{
  const doc=good(parseNetworkProject(fixture)),valid=good(parseNetworkSnapshot(doc,runtime,runtime.identity));
  assert.equal(valid.clock.nativeStepS,.0001);assert.equal(valid.clock.advanceIntervalS,.01);assert.equal(valid.readings[0].value.value,0);assert.equal(valid.readings[1].value.kind,'unknown');
  const mutate=(edit,code)=>{const r=structuredClone(runtime);edit(r);bad(parseNetworkSnapshot(doc,r,runtime.identity),code);};
  mutate(r=>r.identity.controlSequence--,'RESPONSE_STALE');mutate(r=>r.clock.nativeStepS=.1,'CLOCK_INVALID');
  mutate(r=>r.readings[0].unit='MPa','UNIT_INVALID');mutate(r=>r.states[0].componentId='absent','STATE_INVALID');
  mutate(r=>r.readings[0].location.portId='absent','REFERENCE_INVALID');mutate(r=>r.readings[1].value={kind:'known',value:null},'PARAMETER_INVALID');
  mutate(r=>r.readings[2].location.nodeId='absent','REFERENCE_INVALID');mutate(r=>r.readings[3].location.connectionId='absent','REFERENCE_INVALID');
  mutate(r=>r.solver.id='legacy-basic','MODEL_UNSUPPORTED');
  mutate(r=>r.solver.version='unknown-version','MODEL_UNSUPPORTED');
  mutate(r=>r.solver.modelSetVersion='unknown-model-set','MODEL_UNSUPPORTED');
  mutate(r=>r.clock.nativeStepS=.01,'CLOCK_INVALID');
});

test('atomic design transaction undo/redo, saved baseline, cancelled/failed and captured exports',async()=>{
  const doc=good(parseNetworkProject(fixture)),app=good(createNetworkDraftSession(doc,'contract-session',true));
  const edit=structuredClone(doc);edit.design.nodes[0].label='updated';good(app.commit(edit));assert.equal(app.snapshot().dirty,true);
  assert.equal(app.undo(),true);assert.deepEqual(app.snapshot().document.design.nodes,doc.design.nodes);assert.equal(app.snapshot().dirty,false);assert.equal(app.redo(),true);
  for(const outcome of ['cancelled','failed']){const capture=good(app.captureSave(outcome));assert.ok(app.confirmSave(capture,outcome));assert.equal(app.snapshot().dirty,true);}
  const capture=good(app.captureSave('capture'));const later=structuredClone(app.snapshot().document);later.title='later';good(app.commit(later));assert.ok(app.confirmSave(capture,'saved'));assert.equal(app.snapshot().dirty,true);assert.equal(app.confirmSave(capture,'saved'),false);
  const exported=JSON.parse(new TextDecoder().decode(good(encodeNetworkResult(doc,runtime,runtime.identity))));
  assert.deepEqual(exported.document.design.nodes,doc.design.nodes);assert.equal(exported.point.readings[1].value.kind,'unknown');assert.equal(exported.document.design.initialConditions.find(c=>c.componentId==='valve2').positionId,'retract');
  bad(parseNetworkFile(JSON.stringify(exported)),'FILE_INVALID');
  await writeFile(path.join(output,'result-contract.json'),good(encodeNetworkResult(doc,runtime,runtime.identity)));
});

test('invalid JSON/resource/future versions, getters and circular objects rejected without partial repair',()=>{
  bad(parseNetworkFile('{'),'FILE_INVALID');bad(parseNetworkFile(new Uint8Array([255])),'FILE_INVALID');bad(parseNetworkFile(JSON.stringify({...fixture,version:4})),'VERSION_UNSUPPORTED');
  const circular={};circular.child=circular;bad(parseNetworkProject(circular),'FILE_INVALID');
  bad(parseNetworkProject(Object.defineProperty({},'format',{get(){throw new Error('getter executed');},enumerable:true})),'FILE_INVALID');
  bad(parseNetworkFile(' '.repeat(2_000_001)),'FILE_TOO_LARGE');
});
