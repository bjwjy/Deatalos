'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../src/engine.js'),F=require('../src/friction.js');
const near=(actual,expected,tol=1e-9)=>assert.ok(Math.abs(actual-expected)<=tol*Math.max(1,Math.abs(expected)),`${actual} != ${expected}`);
const get=(m,type)=>m.components.find(c=>c.type===type);
function ideal(kind='cylinder') { const m=E.example(kind); for(const w of m.wires)Object.assign(w.params,{length:0,K:0});get(m,'valve').params.drop=0; return m; }

test('Clamond matches published reference and independently solved Colebrook equation',()=>{
 near(F.clamond(1e5,1e-4),0.01851386607747165,1e-13);
 for(const Re of [4000,1e4,1e5,1e7])for(const rough of [0,1e-4,0.01]){
   let lo=0.001,hi=0.2;
   for(let i=0;i<100;i++){const f=(lo+hi)/2,residual=1/Math.sqrt(f)+2*Math.log10(rough/3.7+2.51/(Re*Math.sqrt(f)));if(residual>0)lo=f;else hi=f;}
   near(F.clamond(Re,rough),(lo+hi)/2,1e-11);
 }
});
test('Laminar loss matches Hagen-Poiseuille; direction does not change magnitude',()=>{
 const q=10,d=0.016,L=2,rho=870,nu=46e-6;
 const expected=128*(rho*nu)*L*(q/60000)/(Math.PI*d**4)/1e6;
 near(F.pipe(q,16,L,0,0,rho,46).dp,expected);
 near(F.pipe(-q,16,L,0,0,rho,46).dp,expected);
 assert.equal(F.pipe(0,16,L,0,0,rho,46).dp,0);
 assert.equal(F.factor(3000,0.001).regime,'过渡区估算');
});
test('No-loss cylinder pressure, velocity, power and both chamber flows match hand calculation',()=>{
 const m=ideal(),c=get(m,'cylinder').params;get(m,'tank').params.pressure=0.3;
 const aa=Math.PI*0.063**2/4,ab=Math.PI*(0.063**2-0.036**2)/4,Q=21.344;
 const ext=E.solve(m,{position:250},'extend'),ret=E.solve(m,{position:250},'retract');
 near(ext.Q,Q);near(ext.pressure,20000/(c.eta*aa)/1e6+0.3*ab/aa);
 near(ext.speed,Q/60000/aa*1000);near(ext.returnFlow,Q*ab/aa);near(ext.force,20);
 near(ret.pressure,10000/(c.eta*ab)/1e6+0.3*aa/ab);near(ret.speed,-Q/60000/ab*1000);near(ret.returnFlow,Q*aa/ab);near(ret.force,10);
 near(ext.shaftPower,(ext.pressure-0.3)*Q/60/0.85);
 assert.ok(ret.returnFlow>Q);assert.ok(ext.actuatorPower<=ext.shaftPower);
});
test('Default circuit includes valve and laminar line losses with force balance',()=>{
 const r=E.solve(E.example(),{position:100},'extend');
 near(r.pressure,6.9687378071317765);near(r.speed,114.11785018404012);
 near(r.pA*r.areaA*1e6-r.pB*r.areaB*1e6,20000/0.95);
 near(r.wireValues.w1.q,r.wireValues.w6.q);near(r.wireValues.w7.q,r.wireValues.w4.q);
});
test('O-center dumps all flow through relief; M-center unloads and preserves position',()=>{
 const m=ideal(),closed=E.solve(m,{position:200},'neutral');
 near(closed.pressure,12);near(closed.bypassFlow,closed.Q);assert.equal(closed.pA,null);assert.equal(closed.q,0);
 get(m,'valve').center='tandem';const open=E.step(m,{position:200,time:0},'neutral',0.1);
 near(open.result.pressure,0);near(open.result.bypassFlow,0);near(open.result.wireValues.w4.q,open.result.Q);near(open.state.position,200);
});
test('Overload stalls instead of displaying impossible speed; stroke stops and then reverses',()=>{
 const m=ideal();get(m,'cylinder').params.loadExt=100;
 const r=E.solve(m,{position:100},'extend');assert.match(r.status,/负载过大/);near(r.speed,0);near(r.bypassFlow,r.Q);assert.ok(r.force<100);
 const a=ideal(),step=E.step(a,{position:499.9,time:0},'extend',0.1);near(step.state.position,500);near(step.result.q,0);assert.match(step.result.status,/终点/);
 const back=E.step(a,step.state,'retract',0.1);assert.ok(back.state.position<500);assert.ok(back.result.speed<0);
});
test('Partial bypass satisfies pump continuity and relief branch pressure balance',()=>{
 const m=E.example();get(m,'relief').params.setting=6.9;
 const r=E.solve(m,{position:100},'extend');assert.match(r.status,/部分溢流/);assert.ok(r.q>0&&r.q<r.Q);
 near(r.q+r.bypassFlow,r.Q);near(r.pressure,6.9+r.wireValues.w2.dp+r.wireValues.w3.dp);near(r.force,20);
});
test('Motor torque and speed include both efficiencies in forward and reverse',()=>{
 const m=ideal('motor'),a=E.solve(m,{},'extend'),b=E.solve(m,{},'retract');
 near(a.pressure,2*Math.PI*80/(80e-6*0.9)/1e6);near(a.rpm,21.344*1000*0.92/80);near(a.torque,80);
 near(b.rpm,-a.rpm);near(a.q,a.returnFlow);near(a.actuatorPower,a.hydraulicPower*0.9*0.92);
});
test('Swapping actuator ports reverses motion; wire drawing direction preserves physics and coloring',()=>{
 const m=E.example(),before=E.solve(m,{position:250},'retract');
 [m.wires[5].to,m.wires[6].to]=[m.wires[6].to,m.wires[5].to];
 const a=E.solve(m,{position:250},'extend');near(a.speed,before.speed);near(a.pressure,before.pressure);
 for(const w of m.wires)[w.from,w.to]=[w.to,w.from];
 const b=E.solve(m,{position:250},'extend');near(b.pressure,a.pressure);near(b.speed,a.speed);
 assert.equal(b.wireValues.w6.pressureSide,true);assert.equal(b.wireValues.w6.flow,-a.wireValues.w6.flow);
});
test('Invalid imported numbers and incompatible topology are rejected',()=>{
 for(const change of [m=>get(m,'cylinder').params.rod=63,m=>get(m,'pump').params.rpm=NaN,m=>m.fluid.density=0,m=>m.name='',m=>m.wires[0].to='missing:P',m=>get(m,'pump').params.etaTotal=0.99]){const m=E.example();change(m);assert.ok(E.validateModel(m).length);assert.equal(E.solve(m).ok,false);}
 const m=E.example();m.wires.pop();assert.equal(E.solve(m).ok,false);
 const x=E.example();x.components.push(E.component('motor','m2',200,100));assert.equal(E.solve(x).ok,false);
});
test('Preliminary sizing meets assumed load and target speed; chosen pump uses actual efficiency',()=>{
 const s=E.sizeCylinder(20,100,10,500,1450,0.92,0.8);
 assert.equal(s.bore,63);assert.equal(s.rod,38);assert.equal(s.pump,16);
 const aa=Math.PI*(s.bore/1000)**2/4,ab=aa-Math.PI*(s.rod/1000)**2/4;
 assert.ok(((10-1)*aa-0.5*ab)*1e6*0.95>=20000);assert.ok(s.actualSpeed>=100);
 near(s.power,10*s.actualQ/60/0.8);assert.throws(()=>E.sizeCylinder(20,100,1,500));
});
test('Pressure and flow remain finite across representative parameter sweep',()=>{
 for(const load of [0,5,20,100])for(const setting of [1,7,20])for(const mode of ['extend','neutral','retract']){
  const m=E.example();get(m,'cylinder').params.loadExt=load;get(m,'cylinder').params.loadRet=load;get(m,'relief').params.setting=setting;
  const r=E.solve(m,{position:200},mode);assert.equal(r.ok,true);
  for(const k of ['pressure','Q','q','returnFlow','speed','shaftPower'])assert.ok(Number.isFinite(r[k]),k);
  assert.ok(r.q>=0&&r.q<=r.Q+1e-8);assert.ok(r.actuatorPower<=r.shaftPower+1e-8);
 }
});
