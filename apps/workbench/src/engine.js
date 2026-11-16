(function(root,factory){const api=factory(typeof module==='object'?require('./friction.js'):root.HydFriction,typeof module==='object'?require('@hyd/domain').legacyParameterView():root.HydParameterSpecs);if(typeof module==='object')module.exports=api;else root.HydEngine=api;})(typeof globalThis!=='undefined'?globalThis:this,function(Friction,Specs){
  'use strict';
  const VERSION='1.0.0-experimental';
  if(!Specs)throw new Error('Build and load parameter-specs.js before the legacy renderer engine.');
  const TYPES=Specs.types;
  const PIPE=Specs.groups.pipe.defaults;
  const clone=o=>JSON.parse(JSON.stringify(o));
  const port=(id,p)=>id+':'+p;
  function component(type,id,x,y){return {id,type,x,y,label:TYPES[type].name,params:clone(TYPES[type].params)};}
  function example(kind='cylinder'){
    const components=[component('tank','tank1',120,465),component('pump','pump1',120,315),component('relief','relief1',365,355),component('valve','valve1',620,300),component(kind,'act1',625,105)];
    components.find(c=>c.type==='valve').center='closed';
    const pairs=[['pump1:P','valve1:P'],['pump1:P','relief1:P'],['relief1:T','tank1:T'],['valve1:T','tank1:T'],['tank1:T','pump1:S'],['valve1:A','act1:A'],['valve1:B','act1:B']];
    return {format:'HydraulicWorkbench',version:1,name:kind==='motor'?'基础马达换向回路':'基础油缸换向回路',fluid:clone(Specs.groups.fluid.defaults),components,wires:pairs.map((a,i)=>({id:'w'+(i+1),from:a[0],to:a[1],params:{...PIPE,diameter:i===4?25:16}}))};
  }
  function validateModel(m){
    const errors=[];
    if(!m||m.format!=='HydraulicWorkbench'||m.version!==1)return ['文件不是支持的液压实验台项目（版本 1）。'];
    if(typeof m.name!=='string'||!m.name.trim()||m.name.length>100)errors.push('项目名称应为 1–100 个字符。');
    if(!Array.isArray(m.components)||!Array.isArray(m.wires)||m.components.length>30||m.wires.length>60)return ['元件或连线数据不正确，最多 30 个元件、60 条管线。'];
    const numeric=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)errors.push(label+'须在 '+min+'–'+max+' 之间。');};
    for(const [key,b] of Object.entries(Specs.groups.fluid.bounds))numeric(m.fluid?.[key],b[0],b[1],key);
    const bounds=Specs.bounds;
    const ids=new Set(),ports=new Set();
    for(const c of m.components){
      if(!c||!TYPES[c.type]||typeof c.id!=='string'||!/^[-\w]{1,40}$/.test(c.id)||ids.has(c.id)){errors.push('元件类型或编号无效／重复。');continue;}
      ids.add(c.id);TYPES[c.type].ports.forEach(p=>ports.add(port(c.id,p)));
      if(typeof c.label!=='string'||c.label.length>60)errors.push('元件名称过长或无效。');
      numeric(c.x,60,940,'元件横坐标');numeric(c.y,65,540,'元件纵坐标');
      for(const k of Object.keys(TYPES[c.type].params)){const [lo,hi]=bounds[k];numeric(c.params?.[k],lo,hi,c.label+' · '+k);}
      if(c.type==='cylinder'&&c.params?.rod>=c.params?.bore)errors.push('活塞杆直径必须小于缸径。');
      if(c.type==='pump'&&c.params?.etaTotal>c.params?.etaV)errors.push('泵总效率不能大于容积效率。');
      if(c.type==='valve'&&c.center!==undefined&&!['closed','tandem'].includes(c.center))errors.push('换向阀中位机能无效。');
    }
    const wireIds=new Set(),pairs=new Set();
    for(const w of m.wires){
      if(!w||typeof w.id!=='string'||!/^[-\w]{1,40}$/.test(w.id)||wireIds.has(w.id)){errors.push('管线编号无效／重复。');continue;}
      wireIds.add(w.id);
      if(!ports.has(w.from)||!ports.has(w.to)||w.from===w.to)errors.push('管线油口不存在或连接到了自身。');
      const key=[w.from,w.to].sort().join('|');if(pairs.has(key))errors.push('同一对油口不能重复连接。');pairs.add(key);
      for(const [key,b] of Object.entries(Specs.groups.pipe.bounds))numeric(w.params?.[key],b[0],b[1],key);
    }
    return errors;
  }
  function referenceExample(){
    const m=example();m.name='小臂尺寸参考 · 演示工况';
    Object.assign(m.components.find(c=>c.type==='cylinder').params,{bore:25,rod:16,stroke:500,loadExt:1,loadRet:0.5});
    m.components.find(c=>c.type==='pump').params.displacement=4;m.components.find(c=>c.type==='relief').params.setting=6.3;
    m.note='几何尺寸 25/16/500 mm 参考用户既有设计型号；负载、泵与阀参数为独立演示设定，不是原设计复现。';return m;
  }
  function topology(m){
    const errors=validateModel(m);if(errors.length)return {errors};
    const groups={};for(const type of Object.keys(TYPES))groups[type]=m.components.filter(c=>c.type===type);
    for(const type of ['tank','pump','relief','valve'])if(groups[type].length!==1)errors.push('此实验版需要恰好 1 个'+TYPES[type].name+'。');
    const acts=[...groups.cylinder,...groups.motor];if(acts.length!==1)errors.push('此实验版支持 1 个执行器：液压缸或液压马达。');
    if(errors.length)return {errors};
    const [tank,pump,relief,valve,act]=[groups.tank[0],groups.pump[0],groups.relief[0],groups.valve[0],acts[0]];
    const get=(a,b)=>m.wires.find(w=>(w.from===a&&w.to===b)||(w.from===b&&w.to===a));
    const links={};
    const need=(key,a,b,label)=>{const w=get(a,b);if(!w)errors.push('缺少连线：'+label+'。');else links[key]={wire:w,a,b};};
    need('supply',port(pump.id,'P'),port(valve.id,'P'),'泵 P → 换向阀 P');
    need('reliefIn',port(pump.id,'P'),port(relief.id,'P'),'泵 P → 溢流阀 P');
    need('reliefOut',port(relief.id,'T'),port(tank.id,'T'),'溢流阀 T → 油箱 T');
    need('return',port(valve.id,'T'),port(tank.id,'T'),'换向阀 T → 油箱 T');
    need('suction',port(tank.id,'T'),port(pump.id,'S'),'油箱 T → 泵 S');
    let reversed=false;
    if(get(port(valve.id,'A'),port(act.id,'A'))&&get(port(valve.id,'B'),port(act.id,'B'))){
      need('A',port(valve.id,'A'),port(act.id,'A'),'A → A');need('B',port(valve.id,'B'),port(act.id,'B'),'B → B');
    }else if(get(port(valve.id,'A'),port(act.id,'B'))&&get(port(valve.id,'B'),port(act.id,'A'))){
      reversed=true;need('A',port(valve.id,'A'),port(act.id,'B'),'A → B');need('B',port(valve.id,'B'),port(act.id,'A'),'B → A');
    }else errors.push('执行器两油口须分别连接换向阀 A、B（允许交叉连接）。');
    if(m.wires.length!==7)errors.push('基础回路应有 7 条管线；此版不求解额外支路或并联管网。');
    return {errors,tank,pump,relief,valve,act,links,reversed};
  }
  function solve(m,state={position:0,angle:0},mode='neutral',checked){
    const t=checked||topology(m);if(t.errors.length)return {ok:false,errors:t.errors};
    if(!['extend','neutral','retract'].includes(mode))return {ok:false,errors:['换向状态无效。']};
    const pp=t.pump.params, ap=t.act.params, vp=t.valve.params, pt=t.tank.params.pressure;
    const Q=pp.displacement*pp.rpm*pp.etaV/1000;
    const loss=(key,q)=>{const p=t.links[key].wire.params;return Friction.pipe(q,p.diameter,p.length,p.roughness,p.K,m.fluid.density,m.fluid.viscosity);};
    const vl=q=>vp.drop*(q/vp.nominalFlow)**2;
    const reliefP=q=>pt+t.relief.params.setting+loss('reliefIn',q).dp+loss('reliefOut',q).dp;
    const supplyToA=mode==='extend';
    const physicalExt=supplyToA!==t.reversed;
    const direction=mode==='neutral'?0:physicalExt?1:-1;
    const areaA=t.act.type==='cylinder'?Math.PI*(ap.bore/1000)**2/4:0;
    const areaB=t.act.type==='cylinder'?Math.PI*((ap.bore/1000)**2-(ap.rod/1000)**2)/4:0;
    const ai=physicalExt?areaA:areaB,ao=physicalExt?areaB:areaA;
    const ratio=t.act.type==='cylinder'?ao/ai:1;
    const targetLoad=t.act.type==='cylinder'?(physicalExt?ap.loadExt:ap.loadRet):ap.torque;
    const fixedDP=t.act.type==='cylinder'?targetLoad*1000/(ap.eta*ai)/1e6:2*Math.PI*targetLoad/(ap.displacement*1e-6*ap.etaM)/1e6;
    const inKey=supplyToA?'A':'B',outKey=supplyToA?'B':'A';
    const required=q=>{
      if(mode==='neutral')return pt+loss('supply',q).dp+vl(q)+loss('return',q).dp;
      const qr=q*ratio,pout=pt+loss('return',qr).dp+vl(qr)+loss(outKey,qr).dp;
      return fixedDP+pout*ratio+loss(inKey,q).dp+vl(q)+loss('supply',q).dp;
    };
    const pos=Math.max(0,Math.min(ap.stroke||0,state.position||0));
    const end=t.act.type==='cylinder'&&mode!=='neutral'&&(direction>0?pos>=ap.stroke-1e-9:pos<=1e-9);
    let q=Q,p=required(Q),status=mode==='neutral'?'中位卸荷':physicalExt?(t.act.type==='cylinder'?'伸出':'正转'):(t.act.type==='cylinder'?'缩回':'反转');
    if(mode==='neutral'&&t.valve.center==='closed'){q=0;p=reliefP(Q);status='O 型中位 · 全流量溢流';}
    else if(end){q=0;p=reliefP(Q);status='行程终点 · 溢流';}
    else if(required(0)>reliefP(Q)){q=0;p=reliefP(Q);status='负载过大 · 停滞溢流';}
    else if(p>reliefP(0)){
      let lo=0,hi=Q;for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(required(mid)>reliefP(Q-mid))hi=mid;else lo=mid;}
      q=(lo+hi)/2;p=required(q);status=mode==='neutral'?'中位阻力过大 · 部分溢流':'压力受限 · 部分溢流';
    }
    const qb=Math.max(0,Q-q),qr=mode==='neutral'?q:q*ratio;
    const suction=loss('suction',Q);
    const pS=pt-suction.dp;
    let pin=null,pout=null,pA=null,pB=null,force=0,torque=0,speed=0,rpm=0;
    if(mode!=='neutral'){
      pin=p-loss('supply',q).dp-vl(q)-loss(inKey,q).dp;
      pout=pt+loss('return',qr).dp+vl(qr)+loss(outKey,qr).dp;
      pA=physicalExt?pin:pout;pB=physicalExt?pout:pin;
      if(t.act.type==='cylinder'){
        force=(pin*ai-pout*ao)*1e6*ap.eta/1000;
        speed=direction*q/60000/ai*1000;
      }else{
        torque=(pin-pout)*1e6*ap.displacement*1e-6*ap.etaM/(2*Math.PI);
        rpm=direction*1000*q*ap.etaV/ap.displacement;
      }
    }
    const flows={supply:q,reliefIn:qb,reliefOut:qb,return:qr,suction:Q,A:mode==='neutral'?0:supplyToA?q:-qr,B:mode==='neutral'?0:supplyToA?-qr:q};
    const wireValues={};for(const [key,l]of Object.entries(t.links)){const val=loss(key,flows[key]);wireValues[l.wire.id]={...val,flow:flows[key]*(l.wire.from===l.a?1:-1),role:key,pressureSide:['supply','reliefIn'].includes(key)||(['A','B'].includes(key)&&flows[key]>0)};}
    const hydraulicPower=(p-pS)*Q/60,shaftPower=hydraulicPower/pp.etaTotal;
    const actuatorPower=t.act.type==='cylinder'?force*Math.abs(speed)/1000:torque*Math.abs(rpm)*2*Math.PI/60/1000;
    const warnings=[];
    if(Object.values(wireValues).some(w=>w.regime==='过渡区估算'))warnings.push('部分管线处于过渡流区，摩擦系数使用插值估算。');
    if(suction.v>1.5)warnings.push('吸油管流速超过 1.5 m/s，请检查管径与泵样本。');
    if(pS< -0.08)warnings.push('估计吸油口表压较低；当前模型未校核气蚀。');
    return {ok:true,status,mode,direction,actuatorType:t.act.type,position:pos,Q,q:mode==='neutral'?0:q,returnFlow:mode==='neutral'?0:qr,bypassFlow:qb,pressure:p,pS,pA,pB,force,torque,speed,rpm,hydraulicPower,shaftPower,actuatorPower,lossPower:Math.max(0,shaftPower-actuatorPower),wireValues,warnings,stroke:ap.stroke||null,areaA,areaB};
  }
  function step(m,state,mode,dt){
    const r=solve(m,state,mode);if(!r.ok)return {state,result:r};
    const seconds=Math.max(0,Math.min(0.1,dt));
    const next={...state,time:(state.time||0)+seconds};
    if(r.actuatorType==='cylinder')next.position=Math.max(0,Math.min(r.stroke,(state.position||0)+r.speed*seconds));
    else next.angle=((state.angle||0)+r.rpm*6*seconds)%360;
    return {state:next,result:solve(m,next,mode)};
  }
  function sizeCylinder(force,speed,pressure,stroke,rpm=Specs.types.pump.params.rpm,etaV=Specs.types.pump.params.etaV,etaTotal=Specs.types.pump.params.etaTotal){
    if(![force,speed,pressure,stroke,rpm,etaV,etaTotal].every(Number.isFinite)||force<=0||speed<=0||pressure<=1.5||stroke<=0||rpm<=0||etaV<=0||etaV>1||etaTotal<=0||etaTotal>etaV)throw Error('请填写正数，压力预算须大于 1.5 MPa，泵效率须满足 0 < 总效率 ≤ 容积效率 ≤ 1。');
    const bores=[25,32,40,50,63,80,100,125,160,200,250,320,400,500];
    // Explicit preliminary assumptions: 1 MPa supply allowance, 0.5 MPa back pressure,
    // rod/bore = 0.6, cylinder mechanical efficiency 0.95. Not a strength check.
    const effectiveP=pressure-1-0.5*(1-0.6**2);
    const theoretical=Math.sqrt(4*force*1000/(Math.PI*effectiveP*1e6*0.95))*1000;
    const bore=bores.find(d=>{const rod=Math.round(d*0.6);return Math.PI/4*((pressure-1)*d*d-0.5*(d*d-rod*rod))*0.95/1000>=force;});if(!bore)throw Error('所需缸径超出本版 500 mm 候选上限。');
    const rod=Math.round(bore*0.6),area=Math.PI*(bore/1000)**2/4;
    const Q=area*speed/1000*60000,disp=Q*1000/(rpm*etaV);
    const disps=[4,6.3,10,16,20,25,32,40,50,63,80,100,125,160,200,250,315,400,500];
    const pump=disps.find(d=>d>=disp);if(!pump)throw Error('泵排量超出本版候选上限。');
    const actualQ=pump*rpm*etaV/1000;
    return {bore,rod,stroke,theoretical,Q,displacement:disp,pump,actualQ,actualSpeed:actualQ/60000/area*1000,power:pressure*actualQ/60/etaTotal,pressure,force,etaTotal};
  }
  return {VERSION,TYPES,PIPE,clone,component,example,referenceExample,validateModel,topology,solve,step,sizeCylinder};
});
