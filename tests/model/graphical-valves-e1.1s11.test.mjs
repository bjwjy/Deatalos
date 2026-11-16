import {test} from 'node:test';
import assert from 'node:assert/strict';
import { directionalFunctionOptions, networkValvePaths, parseNetworkProject, configureDirectionalValve, directionalValveSettings } from '@hyd/domain';
import { parseNetworkValveLibrary, captureNetworkValvePreset, putNetworkValvePreset, emptyNetworkValveLibrary, createNetworkDraftSession } from '@hyd/application';
import { encodeNetworkProject,parseNetworkFile } from '@hyd/project-io';
import { networkSymbol } from '../../apps/workbench/dist/network-symbols.mjs';
import { componentLibraryEntries } from '../../apps/workbench/dist/network-component-library.mjs';
import { networkCreationDefinitions } from '@hyd/domain';
import {graphicalValveGraph} from '../fixtures/E1.1S11/graphical-valves.mjs';
import {valveGraph,good} from '../fixtures/E1.1S11/graphs.mjs';
import {groups} from '../benchmarks/E1.1S11/manifold-reference.mjs';

test('graphical catalog covers all 3/4-port partitions, independent slot choices and roundtrips',()=>{
  for(const [ports,count] of [[2,2],[3,5],[4,15],[5,20]]) {
    const choices=directionalFunctionOptions(ports);assert.equal(choices.length,count);
    for(const fn of choices) {
      const graph=graphicalValveGraph(ports,[fn.code,fn.code,fn.code]),valve=graph.design.components.find((item)=>item.id==='valve');
      const paths=networkValvePaths(valve,'neutral');
      const reachable=new Set(paths.flat());assert.deepEqual([...reachable].sort(),groups[fn.code].flat().sort());
      const svg=networkSymbol(valve);for(const port of reachable) assert.ok(svg.includes(port));
      assert.deepEqual(good(parseNetworkFile(good(encodeNetworkProject(graph)))).document,graph);
    }
  }
});
test('v1 keeps strict history while explicit changes upgrade to v2 and undo restores the exact original',()=>{
  const old=valveGraph('directional-3-4',[4,0,3]),valve=old.design.components.find((item)=>item.id==='valve');
  const settings=directionalValveSettings(valve,'extend');assert.deepEqual(good(configureDirectionalValve(old,'valve',settings)),old);
  const next=good(configureDirectionalValve(old,'valve',{...settings,functions:{extend:4,neutral:15,retract:4}}));
  assert.equal(next.design.components.find((item)=>item.id==='valve').definition.version,2);
  const editor=good(createNetworkDraftSession(old,'graphical-valve',true));good(editor.commit(next,editor.revision,'physical'));assert.equal(editor.undo(),true);assert.deepEqual(editor.document,old);assert.equal(editor.redo(),true);
  const corrupt=structuredClone(old);corrupt.design.components.find((item)=>item.id==='valve').parameters.positions.neutralFunction=15;assert.equal(parseNetworkProject(corrupt).ok,false);
  const invalid=structuredClone(graphicalValveGraph(3,[1,11,2]));invalid.design.components.find((item)=>item.id==='valve').parameters.positions.neutralFunction=15;assert.equal(parseNetworkProject(invalid).ok,false);
});
test('personal valve presets validate versions, capacity and names and expose one system valve entry',()=>{
  const graph=graphicalValveGraph(4,[4,14,3]);const before=JSON.stringify(graph);
  const entry=good(captureNetworkValvePreset(graph,'valve','preset_one','常用浮动阀'));
  const library=good(putNetworkValvePreset(emptyNetworkValveLibrary,entry));
  const restored=good(parseNetworkValveLibrary(JSON.parse(JSON.stringify(library))));assert.deepEqual(restored,library);
  const updated=good(putNetworkValvePreset(library,{...entry,id:'preset_two'}));assert.equal(updated.entries.length,2);assert.equal(updated.entries[1].name,'常用浮动阀1');assert.equal(updated.entries[0].id,'preset_one');
  assert.equal(parseNetworkValveLibrary({...library,version:2}).ok,false);
  assert.equal(parseNetworkValveLibrary({...library,entries:Array.from({length:65},(_,i)=>({...entry,id:'p'+i,name:'阀'+i}))}).ok,false);
  assert.equal(parseNetworkValveLibrary({...library,entries:[{...entry,initialPosition:'unknown'}]}).ok,false);
  assert.equal(captureNetworkValvePreset(graph,'valve','preset_empty','  ').ok,false);
  const visible=componentLibraryEntries(networkCreationDefinitions,library.entries);
  assert.deepEqual(visible.filter((item)=>item.typeId==='valve'&&!item.favorite).map((item)=>item.name),['换向阀']);
  assert.equal(visible.filter((item)=>item.favorite).length,1);assert.equal(JSON.stringify(graph),before);
});
