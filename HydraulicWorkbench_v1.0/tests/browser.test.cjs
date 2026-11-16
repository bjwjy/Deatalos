/* Run with Playwright installed; optional PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=process.env.HYD_QA_DIR||path.join(os.tmpdir(),'hydraulic-workbench-qa');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,acceptDownloads:true});
 const page=await context.newPage(),errors=[],network=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',req=>{if(/^https?:/.test(req.url()))network.push(req.url())});
 const snap=()=>page.evaluate(()=>window.HydWorkbench.snapshot());
 const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name)};
 const select=kind=>page.locator('#exampleSelect').selectOption(kind);
 const mode=value=>page.locator(`[data-mode="${value}"]`).click();
 const body=type=>page.locator(`[data-component="${type}"] .caption`);
 const change=async(key,value)=>{const p=page.locator(`[data-param="${key}"]`);await p.fill(String(value));await p.press('Tab');};
 async function wireClick(id){const p=await page.locator(`[data-wire="${id}"] .wire`).evaluate(el=>{const p=el.getPointAtLength(el.getTotalLength()*0.55),q=new DOMPoint(p.x,p.y).matrixTransform(el.getScreenCTM());return {x:q.x,y:q.y}});await page.mouse.click(p.x,p.y);}
 try {
 await page.goto(pathToFileURL(path.join(root,'app/index.html')).href);
 await check('Offline startup, default circuit and valve graphic aligned with active state',async()=>{
  assert.equal((await snap()).result.ok,true);assert.equal(await page.locator('.palette-item').count(),6);
  await mode('extend');assert.equal(await page.locator('.valve-spool').getAttribute('transform'),'translate(60,0)');
  assert.ok((await snap()).result.speed>100);
 });
 await check('Single step, continuous running, pause, reverse and reset',async()=>{
  await page.locator('#stepBtn').click();assert.ok((await snap()).state.position>5);
  await page.locator('#runBtn').click();await page.waitForFunction(()=>HydWorkbench.snapshot().state.position>35);await page.locator('#runBtn').click();
  const pos=(await snap()).state.position;assert.equal((await snap()).running,false);
  await mode('retract');await page.locator('#stepBtn').click();assert.ok((await snap()).state.position<pos);
  await page.locator('#resetBtn').click();assert.equal((await snap()).state.position,0);
 });
 await check('Parameter edit changes calculation and overload stops motion',async()=>{
  await mode('extend');await body('act1').click();await change('loadExt',100);
  assert.match((await snap()).result.status,/负载过大/);assert.equal((await snap()).result.speed,0);
  await change('loadExt',20);assert.ok((await snap()).result.speed>0);
  const before=(await snap()).model.components.find(c=>c.id==='act1').params.rod;
  await page.locator('[data-param="rod"]').fill('90');await page.locator('[data-param="rod"]').press('Tab');
  assert.equal((await snap()).model.components.find(c=>c.id==='act1').params.rod,before);
  await change('rod',36);
 });
 await check('O-center versus M-center unload behavior',async()=>{
  await body('valve1').click();await mode('neutral');assert.ok((await snap()).result.pressure>12);
  await page.locator('#valveCenter').selectOption('tandem');assert.ok((await snap()).result.pressure<1);
  await page.locator('#valveCenter').selectOption('closed');
 });
 await check('Drag component preserves connectivity and supports undo',async()=>{
  const before=(await snap()).model.components.find(c=>c.id==='act1');
  const b=await body('act1').boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+65,b.y+b.height/2+22,{steps:8});await page.mouse.up();
  const after=(await snap()).model.components.find(c=>c.id==='act1');assert.ok(after.x>before.x+30);assert.equal((await snap()).result.ok,true);
  await page.locator('#undoBtn').click();assert.equal((await snap()).model.components.find(c=>c.id==='act1').x,before.x);
 });
 await check('Delete wire, reconnect actual ports, edit line diameter, undo/redo',async()=>{
  await wireClick('w6');await page.locator('#deleteBtn').click();assert.equal((await snap()).result.ok,false);
  await page.locator('[data-port="valve1:A"]').click();await page.locator('[data-port="act1:A"]').click();
  assert.equal((await snap()).model.wires.length,7);assert.equal((await snap()).result.ok,true);
  const id=(await snap()).model.wires.at(-1).id;await change('diameter',12);assert.equal((await snap()).model.wires.find(w=>w.id===id).params.diameter,12);
  await page.locator('#undoBtn').click();assert.equal((await snap()).model.wires.find(w=>w.id===id).params.diameter,16);
  await page.locator('#redoBtn').click();assert.equal((await snap()).model.wires.find(w=>w.id===id).params.diameter,12);
 });
 await check('Build blank circuit using palette placement and seven explicit port connections',async()=>{
  await select('blank');
  const types=['tank','pump','relief','valve','cylinder'];
  for(let i=0;i<types.length;i++){
   await page.locator(`[data-type="${types[i]}"]`).click();
   const id=(await snap()).model.components.at(-1).id;
   const pos=[{x:120,y:465},{x:120,y:315},{x:365,y:355},{x:620,y:300},{x:625,y:105}][i];
   const from=await body(id).boundingBox();const point=await page.locator('#board').evaluate((el,p)=>{const v=new DOMPoint(p.x,p.y).matrixTransform(el.getScreenCTM());return{x:v.x,y:v.y}},pos);
   const c=(await snap()).model.components.at(-1);const scale=await page.locator('#board').evaluate(el=>el.getScreenCTM().a);
   await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(from.x+from.width/2+(pos.x-c.x)*scale,from.y+from.height/2+(pos.y-c.y)*scale,{steps:10});await page.mouse.up();
  }
  const cs=(await snap()).model.components,ids=Object.fromEntries(cs.map(c=>[c.type,c.id]));
  const pairs=[['pump:P','valve:P'],['pump:P','relief:P'],['relief:T','tank:T'],['valve:T','tank:T'],['tank:T','pump:S'],['valve:A','cylinder:A'],['valve:B','cylinder:B']];
  for(const pair of pairs)for(const port of pair){const[t,p]=port.split(':');await page.locator(`[data-port="${ids[t]}:${p}"]`).click();}
  assert.equal((await snap()).result.ok,true);await mode('extend');await page.locator('#stepBtn').click();assert.ok((await snap()).state.position>0);
 });
 await check('Sizing applies bore and pump displacement to the real circuit',async()=>{
  await select('cylinder');await page.locator('#sizeBtn').click();await page.locator('#sizingForm button[type="submit"]').click();
  assert.match(await page.locator('#sizeResults').textContent(),/Ø63/);await page.locator('#applySizeBtn').click();
  assert.equal((await snap()).model.components.find(c=>c.type==='cylinder').params.rod,38);
  await mode('extend');assert.equal((await snap()).result.ok,true);
 });
 await check('Motor runs both directions and reference sample is marked as demonstration',async()=>{
  await select('motor');await mode('extend');await page.locator('#stepBtn').click();assert.ok((await snap()).result.rpm>0);assert.ok((await snap()).state.angle>0);
  await mode('retract');assert.ok((await snap()).result.rpm<0);
  await select('reference');assert.equal((await snap()).model.components.find(c=>c.type==='cylinder').params.bore,25);assert.match((await snap()).model.note,/演示/);
 });
 await check('Project save/load, CSV and SVG export produce usable local files',async()=>{
  await select('cylinder');await mode('extend');for(let i=0;i<10;i++)await page.locator('#stepBtn').click();
  await page.locator('#projectName').fill('离线验收回路');await page.locator('#projectName').press('Tab');
  for(const[id,filename]of [['saveBtn','project.json'],['csvBtn','calculation.csv'],['svgBtn','circuit.svg']]){
   const event=page.waitForEvent('download');await page.locator('#'+id).click();const d=await event;await d.saveAs(path.join(out,filename));
   assert.ok(fs.statSync(path.join(out,filename)).size>100);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'project.json'),'utf8')).name,'离线验收回路');
  assert.match(fs.readFileSync(path.join(out,'calculation.csv'),'utf8'),/泵出口压力/);
  assert.match(fs.readFileSync(path.join(out,'circuit.svg'),'utf8'),/<svg/);
  await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
  await select('blank');await page.locator('#importFile').setInputFiles(path.join(out,'project.json'));await page.waitForFunction(()=>HydWorkbench.snapshot().model.name==='离线验收回路');assert.equal((await snap()).result.ok,true);
  await page.reload();assert.equal((await snap()).model.name,'离线验收回路');
  await page.locator('#importFile').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"format":"invalid"}')});
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('打开失败'));assert.equal((await snap()).model.name,'离线验收回路');
 });
 await check('Smaller desktop viewport fits horizontally; help opens',async()=>{
  await page.setViewportSize({width:1024,height:768});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.screenshot({path:path.join(out,'small-desktop.png'),fullPage:true});
  await page.locator('#helpBtn').click();assert.equal(await page.locator('#helpDialog').evaluate(el=>el.open),true);await page.locator('[data-close="helpDialog"]').click();
 });
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 const report={date:new Date().toISOString(),browser:await browser.version(),checks,passed:checks.length,errors,httpRequests:network,screenshots:['desktop.png','small-desktop.png']};
 fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }catch(e){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});throw e}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
