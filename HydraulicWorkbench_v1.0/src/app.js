(function(){
  'use strict';
  const E=window.HydEngine,$=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=(n,d=2)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(d):'—';
  const initial=()=>({time:0,position:0,angle:0});
  let model=E.example(),state=initial(),mode='neutral',selected='act1',selectedKind='component',pending=null,running=false,history=[],redo=[],samples=[],lastFrame=0,lastRender=0,drag=null,sizing=null,toastTimer;
  const bounds={pressure:[0,2,0.01],displacement:[0.1,2000,0.1],rpm:[1,10000,1],etaV:[0.1,1,0.01],etaTotal:[0.1,1,0.01],setting:[0.1,70,0.1],nominalFlow:[0.1,3000,1],drop:[0,10,0.05],bore:[5,1000,1],rod:[0,999,1],stroke:[1,10000,1],loadExt:[0,10000,0.1],loadRet:[0,10000,0.1],eta:[0.1,1,0.01],torque:[0,100000,1],etaM:[0.1,1,0.01],diameter:[2,200,1],length:[0,1000,0.1],roughness:[0,1,0.001],K:[0,1000,0.1]};
  const labels={pressure:['油箱表压','MPa'],displacement:['排量','mL/r'],rpm:['转速','r/min'],etaV:['容积效率','0–1'],etaTotal:['总效率','0–1'],setting:['开启压差设定','MPa'],nominalFlow:['每通道标称流量','L/min'],drop:['标称流量下通道压降','MPa'],bore:['缸径','mm'],rod:['杆径','mm'],stroke:['行程','mm'],loadExt:['伸出阻力负载','kN'],loadRet:['缩回阻力负载','kN'],eta:['机械效率','0–1'],torque:['双向阻力转矩','N·m'],etaM:['机械效率','0–1'],diameter:['实际内径','mm'],length:['管路长度','m'],roughness:['绝对粗糙度','mm'],K:['局部阻力系数 K','—']};
  const info={tank:'所有回油与泵吸油均接 T 口。表压以大气压力为零。',pump:'Q = 排量 × 转速 × 容积效率。压力由负载、阻力和溢流阀共同确定。',relief:'设定值是阀前、阀后压差。全流量溢流时泵出口压力还包括溢流支路管损。',valve:'左位 P→A、B→T；右位 P→B、A→T。压降按 Δp = Δpₙ(Q/Qₙ)² 估算。',cylinder:'负载均为阻碍当前运动方向的正值；不含重力驱动下滑。推力计算计入回油背压。',motor:'普通连续回转马达，无转角限位。容积效率用于转速修正，泄漏并入回油。',wire:'画布上的长度仅用于排版。计算长度取此处输入；管内径不等于公称外径。'};
  function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
  function saveLocal(){try{localStorage.setItem('hydraulic-workbench-project-v1',JSON.stringify(model));}catch{}}
  function checkpoint(){history.push(E.clone(model));if(history.length>40)history.shift();redo=[];}
  function pause(){running=false;$('runBtn').textContent='▶ 运行';$('board').classList.remove('running');}
  function restartRecord(){pause();state.time=0;samples=[];lastFrame=0;}
  function changed(){restartRecord();pending=null;saveLocal();renderAll();}
  const referenceExample=()=>E.referenceExample();
  function setExample(kind){checkpoint();model=kind==='blank'?{format:'HydraulicWorkbench',version:1,name:'未命名基础回路',fluid:{density:870,viscosity:46},components:[],wires:[]}:kind==='reference'?referenceExample():E.example(kind);state=initial();mode='neutral';selected=model.components.find(c=>['cylinder','motor'].includes(c.type))?.id||null;selectedKind='component';changed();}
  function geo(c){
    const shapes={pump:{P:[0,-42,0,-1],S:[0,42,0,1]},tank:{T:[0,-30,0,-1]},relief:{P:[0,-36,0,-1],T:[0,36,0,1]},valve:{A:[-16,-60,0,-1],B:[16,-60,0,-1],P:[-16,60,0,1],T:[16,60,0,1]},cylinder:{A:[-60,50,0,1],B:[20,50,0,1]},motor:{A:[-55,30,-1,0],B:[55,30,1,0]}};
    return Object.fromEntries(Object.entries(shapes[c.type]).map(([p,[x,y,dx,dy]])=>[p,{x:c.x+x,y:c.y+y,dx,dy,localX:x,localY:y}]));
  }
  function coord(s){const [id,p]=s.split(':'),c=model.components.find(c=>c.id===id);return c?geo(c)[p]:null;}
  function route(w){const a=coord(w.from),b=coord(w.to);if(!a||!b)return '';
    const ac=model.components.find(c=>w.from.startsWith(c.id+':')),bc=model.components.find(c=>w.to.startsWith(c.id+':'));
    // Route around the default component bodies, recomputed after every drag.
    let pts;
    if(ac.type==='pump'&&bc.type==='valve'){const y=Math.min(ac.y-110,bc.y-95),x=Math.min(bc.x-125,ac.x+375);pts=[[a.x,a.y],[a.x,y],[x,y],[x,b.y+45],[b.x,b.y+45],[b.x,b.y]];}
    else if(ac.type==='pump'&&bc.type==='relief'){const y=Math.min(a.y,b.y)-28;pts=[[a.x,a.y],[a.x,y],[b.x,y],[b.x,b.y]];}
    else if(ac.type==='valve'&&bc.type==='tank'){const x=bc.x+130,y=Math.max(a.y+80,bc.y+55);pts=[[a.x,a.y],[a.x,y],[x,y],[x,b.y],[b.x,b.y]];}
    else if(ac.type==='relief'&&bc.type==='tank'){pts=[[a.x,a.y],[a.x,b.y],[b.x,b.y]];}
    else if(Math.abs(a.x-b.x)<2||Math.abs(a.y-b.y)<2)pts=[[a.x,a.y],[b.x,b.y]];
    else {const aa=[a.x+a.dx*22,a.y+a.dy*22],bb=[b.x+b.dx*22,b.y+b.dy*22],my=(aa[1]+bb[1])/2;pts=[[a.x,a.y],aa,[aa[0],my],[bb[0],my],bb,[b.x,b.y]];}
    return pts.map((p,i)=>(i?'L':'M')+p.join(' ')).join(' ');
  }
  function portMarkup(c){return Object.entries(geo(c)).map(([p,v])=>`<g class="port ${pending===c.id+':'+p?'active':''}" data-port="${c.id}:${p}" role="button" aria-label="${esc(c.label)} ${p} 油口" tabindex="0"><circle class="port-hit" cx="${v.localX}" cy="${v.localY}" r="13"/><circle class="port-dot" cx="${v.localX}" cy="${v.localY}" r="4.5"/><text x="${v.localX+9}" y="${v.localY+4}" font-size="11">${p}</text></g>`).join('');}
  const arrow=(x1,y1,x2,y2)=>`<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" marker-end="url(#arrow)"/>`;
  function symbol(c,r){
    let body='',captionY=65,captionX=0;
    if(c.type==='pump'){body=`<circle class="symbol" r="27"/><path class="symbol" d="M0 -42V-27 M0 27V42 M-27 0H-46"/><path d="M-8 -6L8 -6L0 -21Z" fill="#3c5169"/><text x="-57" y="5" text-anchor="middle">M</text>`;captionY=68;}
    if(c.type==='tank'){body='<path class="symbol" d="M0 -30V-9 M-32 -14V23H32V-14 M-26 7H26 M-26 15H26"/>';captionY=46;}
    if(c.type==='relief'){body=`<rect class="symbol" x="-20" y="-22" width="40" height="44"/><path class="symbol" d="M0 -36V-22 M0 22V36 M20 0H32L36 -8L42 8L48 -8L54 8L58 0H66"/><g class="symbol">${arrow(0,-15,0,15)}</g><text x="50" y="-20" text-anchor="middle">${fmt(c.params.setting,1)} MPa</text>`;captionY=61;}
    if(c.type==='valve'){
      body+=`<g class="valve-spool" transform="translate(${mode==='extend'?60:mode==='retract'?-60:0},0)">`;
      for(let i=0;i<3;i++){const x=(i-1)*60,m=['extend','neutral','retract'][i];let paths='';
        if(i===0)paths=arrow(-16,21,-16,-21)+arrow(16,-21,16,21);
        if(i===2)paths=arrow(-16,21,16,-21)+arrow(-16,-21,16,21);
        if(i===1)paths=c.center==='closed'?'<path d="M-16 -28V-12 M-23 -12H-9 M16 -28V-12 M9 -12H23 M-16 28V12 M-23 12H-9 M16 28V12 M9 12H23"/>':'<path d="M-16 -28V-12 M-23 -12H-9 M16 -28V-12 M9 -12H23 M-16 28V5H16V28"/>';
        body+=`<g transform="translate(${x},0)" data-switch="${m}" role="button" tabindex="0" aria-label="${['左位','中位','右位'][i]}"><rect class="valve-cell ${mode===m?'chosen':''}" x="-30" y="-30" width="60" height="60"/><g class="symbol" style="pointer-events:none;fill:none">${paths}</g></g>`;
      }
      body+='</g><path class="symbol" d="M-16 -60V-30 M16 -60V-30 M-16 30V60 M16 30V60"/>';captionX=115;captionY=72;
    }
    if(c.type==='cylinder'){
      const t=Math.max(0,Math.min(1,state.position/c.params.stroke)),px=-58+t*65;
      body=`<rect class="symbol" x="-83" y="-25" width="123" height="50"/><rect x="-81" y="-23" width="${px+81}" height="46" fill="#f6ddd8"/><rect x="${px+8}" y="-23" width="${32-px}" height="46" fill="#dcecf9"/><rect class="symbol" x="${px}" y="-23" width="8" height="46"/><rect class="symbol" x="${px+8}" y="-6" width="95" height="12"/><path class="symbol" d="M-60 25V50 M20 25V50"/><text x="-22" y="-42" text-anchor="middle" class="reading">${fmt(state.position,1)} / ${fmt(c.params.stroke,0)} mm</text>`;captionY=-62;
    }
    if(c.type==='motor'){
      body=`<circle class="symbol" r="32"/><path class="symbol" d="M-55 30H-35V0H-32 M55 30H35V0H32"/><path d="M-30 -8L-30 8L-15 0Z M30 -8L30 8L15 0Z" fill="#3c5169"/><g transform="rotate(${state.angle||0})"><circle cx="0" cy="0" r="8" fill="white" stroke="#597798"/><path d="M0 -18V-8 M8 0H18 M0 8V18 M-8 0H-18" stroke="#597798" stroke-width="2"/></g><text x="0" y="-47" text-anchor="middle" class="reading">${r.ok?fmt(r.rpm,0):'—'} r/min</text>`;captionY=-66;
    }
    const box=c.type==='valve'?[-160,-75,320,180]:c.type==='cylinder'?[-95,-78,205,140]:[-72,-77,145,160];
    return `<g data-component="${c.id}" class="component" transform="translate(${c.x},${c.y})" role="group" aria-label="${esc(c.label)}">${selected===c.id&&selectedKind==='component'?`<rect class="selection" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" rx="8"/>`:''}${body}<text class="caption" x="${captionX}" y="${captionY}" text-anchor="middle">${esc(c.label)}</text>${portMarkup(c)}</g>`;
  }
  function renderBoard(r){
    const defs='<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#3c5169"/></marker></defs>';
    const wires=model.wires.map(w=>{const v=r.ok?r.wireValues[w.id]:null,q=v?.flow||0;let color='#a8b3bf';if(Math.abs(q)>1e-6)color=v.pressureSide?'#d45e4f':'#297ac7';const path=route(w);return `<g data-wire="${w.id}"><path class="wire-hit" d="${path}"/><path class="wire ${selected===w.id&&selectedKind==='wire'?'selected':''}" d="${path}" stroke="${color}"/>${Math.abs(q)>1e-6?`<path class="flow-dashes" style="animation-direction:${q<0?'reverse':'normal'}" d="${path}"/>`:''}</g>`;}).join('');
    $('board').innerHTML=defs+wires+model.components.map(c=>symbol(c,r)).join('')+(model.components.length?'':'<text class="board-empty" x="500" y="260" text-anchor="middle">从左侧拖入元件，开始连接一个基础回路</text><text class="board-empty" x="500" y="300" text-anchor="middle" style="font-size:13px">也可以从「加载示例」开始</text>');
    $('connectionCount').textContent=`${model.components.length} 个元件 / ${model.wires.length} 条管线`;
    $('connectionHint').textContent=pending?'已选择 '+pending+'，请点击目标油口（Esc 取消）':'拖动元件调整位置，点击蓝色油口连接';
    $('board').classList.toggle('running',running);
  }
  const kv=(label,value)=>`<div class="kv"><span>${label}</span><b>${value}</b></div>`;
  function renderInspector(){
    const c=selectedKind==='component'?model.components.find(c=>c.id===selected):model.wires.find(w=>w.id===selected);
    if(!c){$('inspector').innerHTML='<div class="hint">点击画布上的元件或管线，在这里查看和修改参数。</div>';return;}
    const type=selectedKind==='wire'?'wire':c.type;
    let html=`<h3>${esc(type==='wire'?'液压管线':c.label)}</h3><div class="tag">${esc(c.id)}${type==='wire'?' · '+esc(c.from)+' ↔ '+esc(c.to):''}</div>`;
    if(type!=='wire')html+=`<label>元件名称<input id="componentLabel" value="${esc(c.label)}" maxlength="60"></label>`;
    if(type==='valve')html+=`<label>中位机能<select id="valveCenter"><option value="closed" ${c.center==='closed'?'selected':''}>O 型：P/T/A/B 全封闭</option><option value="tandem" ${c.center!=='closed'?'selected':''}>M 型：P→T，A/B 封闭</option></select></label>`;
    for(const [key,value]of Object.entries(c.params)){const spec=labels[key],b=bounds[key];if(!spec||!b)continue;html+=`<label>${spec[0]}<span>${spec[1]}</span><input data-param="${key}" type="number" value="${value}" min="${b[0]}" max="${b[1]}" step="any" required></label>`;}
    html+=`<p class="param-hint">${info[type]}</p>`;
    if(type==='cylinder')html+='<button id="sizeFromInspector" class="full">按负载与速度初选</button>';
    $('inspector').innerHTML=html;
    $('sizeFromInspector')?.addEventListener('click',openSizing);
    $('componentLabel')?.addEventListener('change',e=>{checkpoint();c.label=e.target.value.trim()||E.TYPES[c.type].name;changed();});
    $('valveCenter')?.addEventListener('change',e=>{checkpoint();c.center=e.target.value;changed();});
    $('inspector').querySelectorAll('[data-param]').forEach(el=>el.addEventListener('change',e=>{
      const input=e.target;input.setCustomValidity('');if(!input.reportValidity())return;
      const candidate=E.clone(model),entity=selectedKind==='wire'?candidate.wires.find(w=>w.id===selected):candidate.components.find(c=>c.id===selected);entity.params[input.dataset.param]=Number(input.value);
      const errs=E.validateModel(candidate);if(errs.length){input.setCustomValidity(errs[0]);input.reportValidity();return;}
      checkpoint();model=candidate;const cyl=model.components.find(c=>c.type==='cylinder');if(cyl)state.position=Math.min(state.position,cyl.params.stroke);changed();
    }));
  }
  function renderValues(r){
    $('clock').textContent='t = '+fmt(state.time,2)+' s';
    $('canvasTitle').textContent=running?'运行中 · 点击阀位换向':'回路编辑 / 静态计算预览';
    const hasCyl=r.actuatorType==='cylinder';
    const items=[['泵出口压力',r.pressure,'MPa',r.ok?r.status:'检查元件与连线'],['执行器进油流量',r.q,'L/min','泵总流量 '+fmt(r.Q)+' L/min'],[hasCyl?'活塞位置':'马达转速',hasCyl?state.position:r.rpm,hasCyl?'mm':'r/min',hasCyl?'速度 '+fmt(r.speed,1)+' mm/s':'转矩 '+fmt(r.torque,1)+' N·m'],['泵输入轴功率',r.shaftPower,'kW','包含泵效率和管路损失']];
    $('metrics').innerHTML=items.map(([label,val,unit,detail])=>`<div class="metric"><label>${label}</label><div class="value">${r.ok?fmt(val,val>999?0:2):'—'}<span class="unit">${unit}</span></div><small>${r.ok?esc(detail):'尚无有效结果'}</small></div>`).join('');
    if(!r.ok){$('status').className='status error';$('status').innerHTML='回路尚未就绪<ul>'+r.errors.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>';$('liveDetails').innerHTML='';return;}
    const warn=/溢流|压力受限/.test(r.status);$('status').className='status'+(warn?' warn':'');$('status').textContent=(running?'● 运行中':'○ 已暂停 · 下列数值为当前阀位计算')+'  /  '+r.status;
    let html='<h4>当前计算</h4>'+kv('执行器 A 口',fmt(r.pA)+' MPa')+kv('执行器 B 口',fmt(r.pB)+' MPa')+kv('回油流量',fmt(r.returnFlow)+' L/min')+kv('溢流支路流量',fmt(r.bypassFlow)+' L/min')+kv(hasCyl?'有效推力（当前方向）':'有效转矩',hasCyl?fmt(r.force)+' kN':fmt(r.torque)+' N·m')+kv('估计损耗功率',fmt(r.lossPower)+' kW');
    if(mode==='neutral')html+='<p class="notice">A/B 腔为理想封闭，困油压力未求解，故显示 —。</p>';
    if(selectedKind==='wire'&&r.wireValues[selected]){const v=r.wireValues[selected];html+='<h4>选中管线</h4>'+kv('流量',fmt(v.q)+' L/min')+kv('流速',fmt(v.v)+' m/s')+kv('雷诺数 Re',fmt(v.Re,0))+kv('流态',v.regime)+kv('管线压降',fmt(v.dp,4)+' MPa');}
    if(model.note)html+='<p class="notice">'+esc(model.note)+'</p>';
    for(const warning of r.warnings)html+='<p class="notice">'+esc(warning)+'</p>';
    $('liveDetails').innerHTML=html;
  }
  function renderPlot(){
    const key=$('plotMetric').value,unit={pressure:'MPa',position:'mm',q:'L/min',rpm:'r/min'}[key],list=samples.slice(-900),W=850,H=145,L=62,R=16,T=15,B=30;
    let html=`<line class="plot-axis" x1="${L}" y1="${H-B}" x2="${W-R}" y2="${H-B}"/><text class="plot-label" x="14" y="17">${unit}</text><text class="plot-label" x="${W-18}" y="${H-6}" text-anchor="end">时间 / s</text>`;
    if(list.length<2){html+='<text class="plot-label" x="440" y="65" text-anchor="middle">点击运行后记录曲线</text>';$('plot').innerHTML=html;return;}
    const minX=list[0].time,maxX=Math.max(minX+1,list.at(-1).time),values=list.map(d=>d[key]||0),low=Math.min(0,...values),high=Math.max(1,...values)*1.1;
    const x=v=>L+(v-minX)/(maxX-minX)*(W-L-R),y=v=>H-B-(v-low)/(high-low)*(H-T-B);
    for(let i=0;i<=3;i++){const v=low+(high-low)*i/3,yy=y(v);html+=`<line class="plot-axis" x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}"/><text class="plot-label" x="${L-8}" y="${yy+4}" text-anchor="end">${fmt(v,1)}</text>`;}
    for(let i=0;i<4;i++){const v=minX+(maxX-minX)*i/3;html+=`<text class="plot-label" x="${x(v)}" y="${H-12}" text-anchor="middle">${fmt(v,1)}</text>`;}
    html+='<path class="plot-line" d="'+list.map((d,i)=>(i?'L':'M')+fmt(x(d.time),2)+' '+fmt(y(d[key]||0),2)).join(' ')+'"/>';$('plot').innerHTML=html;
  }
  function renderAll(){
    $('projectName').value=model.name;$('density').value=model.fluid.density;$('viscosity').value=model.fluid.viscosity;
    $('undoBtn').disabled=!history.length;$('redoBtn').disabled=!redo.length;$('deleteBtn').disabled=!selected;
    document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
    const r=E.solve(model,state,mode);renderBoard(r);renderInspector();renderValues(r);renderPlot();
  }
  function chooseMode(m){mode=m;pending=null;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));const r=E.solve(model,state,mode);renderBoard(r);renderValues(r);}
  function add(type,x=430,y=200){if(model.components.length>=30){toast('此版最多保留 30 个绘图元件');return;}checkpoint();const id=type+'_'+Date.now().toString(36),c=E.component(type,id,Math.max(80,Math.min(900,x)),Math.max(85,Math.min(500,y)));if(type==='valve')c.center='closed';model.components.push(c);selected=id;selectedKind='component';changed();}
  function remove(){if(!selected)return;checkpoint();if(selectedKind==='component'){model.components=model.components.filter(c=>c.id!==selected);model.wires=model.wires.filter(w=>!w.from.startsWith(selected+':')&&!w.to.startsWith(selected+':'));}else model.wires=model.wires.filter(w=>w.id!==selected);selected=null;changed();}
  function connect(p){if(pending===p){pending=null;renderBoard(E.solve(model,state,mode));return;}if(!pending){pending=p;renderBoard(E.solve(model,state,mode));return;}if(pending.split(':')[0]===p.split(':')[0]){toast('请选择另一个元件的油口');return;}if(model.wires.some(w=>(w.from===p&&w.to===pending)||(w.from===pending&&w.to===p))){toast('这两个油口已经连接');pending=null;return;}checkpoint();const id='w_'+Date.now().toString(36);model.wires.push({id,from:pending,to:p,params:{...E.PIPE}});selected=id;selectedKind='wire';changed();}
  function point(ev){const svg=$('board'),p=svg.createSVGPoint();p.x=ev.clientX;p.y=ev.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());}
  $('board').addEventListener('pointerdown',e=>{
    const p=e.target.closest('[data-port]'),sw=e.target.closest('[data-switch]');if(p){e.stopPropagation();connect(p.dataset.port);return;}if(sw){chooseMode(sw.dataset.switch);return;}
    const cg=e.target.closest('[data-component]'),wg=e.target.closest('[data-wire]');
    if(cg){selected=cg.dataset.component;selectedKind='component';const c=model.components.find(c=>c.id===selected),pos=point(e);drag={id:c.id,x:pos.x,y:pos.y,cx:c.x,cy:c.y,before:E.clone(model),moved:false};$('board').setPointerCapture(e.pointerId);renderAll();}
    else if(wg){selected=wg.dataset.wire;selectedKind='wire';pending=null;renderAll();}
    else{selected=null;pending=null;renderAll();}
  });
  $('board').addEventListener('pointermove',e=>{if(!drag)return;const p=point(e);if(!drag.moved&&Math.hypot(p.x-drag.x,p.y-drag.y)<3)return;if(!drag.moved)restartRecord();drag.moved=true;const c=model.components.find(c=>c.id===drag.id);c.x=Math.max(80,Math.min(900,Math.round((drag.cx+p.x-drag.x)/5)*5));c.y=Math.max(85,Math.min(505,Math.round((drag.cy+p.y-drag.y)/5)*5));renderBoard(E.solve(model,state,mode));});
  const endDrag=()=>{if(drag?.moved){history.push(drag.before);redo=[];saveLocal();}drag=null;renderAll();};
  $('board').addEventListener('pointerup',endDrag);$('board').addEventListener('pointercancel',endDrag);
  $('board').addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const p=e.target.closest('[data-port]'),s=e.target.closest('[data-switch]');if(p){e.preventDefault();connect(p.dataset.port);}if(s){e.preventDefault();chooseMode(s.dataset.switch);}});
  $('board').addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';});
  $('board').addEventListener('drop',e=>{e.preventDefault();const type=e.dataTransfer.getData('text/plain');if(E.TYPES[type]){const p=point(e);add(type,p.x,p.y);}});
  const glyph={tank:'⊔',pump:'↑',relief:'↧',valve:'⇄',cylinder:'⊣',motor:'↻'};
  const sub={tank:'回油 / 吸油',pump:'排量 · 转速',relief:'限制系统压力',valve:'左位 / 中位 / 右位',cylinder:'伸出 / 缩回',motor:'正转 / 反转'};
  $('palette').innerHTML=Object.entries(E.TYPES).map(([type,t])=>`<button class="palette-item" data-type="${type}" draggable="true"><span class="mini">${glyph[type]}</span><span>${t.name}<small>${sub[type]}</small></span></button>`).join('');
  document.querySelectorAll('[data-type]').forEach(b=>{b.addEventListener('click',()=>add(b.dataset.type));b.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain',b.dataset.type));});
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>chooseMode(b.dataset.mode)));
  $('runBtn').addEventListener('click',()=>{if(running){pause();renderValues(E.solve(model,state,mode));return;}const r=E.solve(model,state,mode);if(!r.ok){toast('先补齐基础回路连线');renderAll();return;}running=true;lastFrame=0;$('runBtn').textContent='Ⅱ 暂停';$('board').classList.add('running');});
  $('resetBtn').addEventListener('click',()=>{pause();state=initial();samples=[];mode='neutral';renderAll();});
  function record(r){samples.push({time:state.time,position:state.position,pressure:r.pressure,q:r.q,rpm:r.rpm,power:r.shaftPower});if(samples.length>2000)samples.shift();}
  $('stepBtn').addEventListener('click',()=>{pause();const s=E.step(model,state,mode,0.05);state=s.state;if(s.result.ok)record(s.result);renderAll();});
  function tick(now){
    if(running){const dt=lastFrame?Math.min((now-lastFrame)/1000,0.05)*Number($('timeScale').value):0;const s=E.step(model,state,mode,dt);state=s.state;
      if(!s.result.ok){pause();renderAll();}else if(now-lastRender>80){record(s.result);renderBoard(s.result);renderValues(s.result);renderPlot();lastRender=now;}}
    lastFrame=now;requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  function undo(){if(!history.length)return;redo.push(E.clone(model));model=history.pop();state=initial();changed();}
  function redoAction(){if(!redo.length)return;history.push(E.clone(model));model=redo.pop();state=initial();changed();}
  $('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redoAction);$('deleteBtn').addEventListener('click',remove);
  document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;if(e.key==='Escape'){pending=null;renderBoard(E.solve(model,state,mode));}if(e.key==='Delete')remove();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redoAction();}});
  $('projectName').addEventListener('change',e=>{checkpoint();model.name=e.target.value.trim()||'未命名基础回路';saveLocal();$('undoBtn').disabled=false;$('redoBtn').disabled=true;});
  $('exampleSelect').addEventListener('change',e=>{if(e.target.value)setExample(e.target.value);e.target.value='';});
  for(const key of ['density','viscosity']){$(key).required=true;$(key).addEventListener('change',e=>{if(!e.target.reportValidity())return;checkpoint();model.fluid[key]=Number(e.target.value);changed();});}
  $('plotMetric').addEventListener('change',renderPlot);
  const fileName=s=>s.replace(/[\\/:*?"<>|]/g,'_').slice(0,70);
  function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=fileName(name);document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
  $('saveBtn').addEventListener('click',()=>{download(model.name+'.json',JSON.stringify(model,null,2),'application/json;charset=utf-8');toast('项目文件已交给浏览器保存');});
  $('importBtn').addEventListener('click',()=>$('importFile').click());
  $('importFile').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>2e6)throw Error('项目文件不能超过 2 MB');const m=JSON.parse(await f.text()),errors=E.validateModel(m);if(errors.length)throw Error(errors[0]);checkpoint();model=m;state=initial();mode='neutral';selected=null;changed();toast('项目已打开');}catch(err){toast('打开失败：'+err.message);}e.target.value='';});
  $('svgBtn').addEventListener('click',()=>{const svg=$('board').cloneNode(true);svg.setAttribute('xmlns','http://www.w3.org/2000/svg');svg.setAttribute('width','1000');svg.setAttribute('height','590');svg.removeAttribute('class');svg.querySelectorAll('.wire-hit,.port-hit,.flow-dashes,.selection').forEach(e=>e.remove());const style=document.createElementNS('http://www.w3.org/2000/svg','style');style.textContent=document.querySelector('style').textContent+'#board{width:1000px;height:590px;background:white}';svg.insertBefore(style,svg.firstChild);download(model.name+'.svg',new XMLSerializer().serializeToString(svg),'image/svg+xml;charset=utf-8');});
  $('csvBtn').addEventListener('click',()=>{
    const r=E.solve(model,state,mode);if(!r.ok){toast('回路未完成，暂时没有可导出的计算结果');return;}
    const rows=[['项目',model.name],['模型','准静态计算；非瞬态仿真'],['换向状态',mode],['工况',r.status],['参数','数值','单位'],['泵出口压力',r.pressure,'MPa'],['泵总流量',r.Q,'L/min'],['执行器流量',r.q,'L/min'],['回油流量',r.returnFlow,'L/min'],['溢流流量',r.bypassFlow,'L/min'],['A口压力',r.pA??'未求解','MPa'],['B口压力',r.pB??'未求解','MPa'],['活塞位置',state.position,'mm'],['活塞速度',r.speed,'mm/s'],['有效推力',r.force,'kN'],['马达转速',r.rpm,'r/min'],['有效转矩',r.torque,'N·m'],['泵输入轴功率',r.shaftPower,'kW'],['估计损耗功率',r.lossPower,'kW'],[],['元件编号','元件','参数','数值','单位']];
    for(const c of model.components)for(const [k,v]of Object.entries(c.params))rows.push([c.id,c.label,labels[k]?.[0]||k,v,labels[k]?.[1]||'']);
    rows.push([],['管线','起点','终点','内径 mm','长度 m','流量 L/min','流速 m/s','压降 MPa']);for(const w of model.wires){const v=r.wireValues[w.id];rows.push([w.id,w.from,w.to,w.params.diameter,w.params.length,v?.q,v?.v,v?.dp]);}
    rows.push([],['时间 s','泵出口压力 MPa','执行器流量 L/min','位置 mm','马达转速 r/min','输入轴功率 kW']);for(const s of samples)rows.push([s.time,s.pressure,s.q,s.position,s.rpm,s.power]);
    const cell=v=>{let s=v==null?'':String(v);if(typeof v==='string'&&/^[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    download(model.name+'_计算表.csv','\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  });
  $('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
  function openSizing(){pause();sizing=null;$('applySizeBtn').disabled=true;$('sizeResults').innerHTML='';const c=model.components.find(c=>c.type==='cylinder');if(c){$('sizingForm').elements.force.value=c.params.loadExt||1;$('sizingForm').elements.stroke.value=c.params.stroke;}$('sizeDialog').showModal();}
  $('sizeBtn').addEventListener('click',openSizing);
  $('sizingForm').addEventListener('submit',e=>{e.preventDefault();const f=e.target.elements,p=model.components.find(c=>c.type==='pump')?.params||E.TYPES.pump.params;try{sizing=E.sizeCylinder(Number(f.force.value),Number(f.speed.value),Number(f.pressure.value),Number(f.stroke.value),p.rpm,p.etaV,p.etaTotal);const s=sizing;$('sizeResults').innerHTML=`<div class="size-values">缸径 / 杆径：<b>Ø${s.bore} / Ø${s.rod} mm</b><br>所需流量：<b>${fmt(s.Q)} L/min</b><br>所需泵排量：${fmt(s.displacement)} mL/r → 候选 <b>${s.pump} mL/r</b><br>按候选排量，伸出速度约 <b>${fmt(s.actualSpeed,1)} mm/s</b><br>预算压力下输入轴功率约 <b>${fmt(s.power)} kW</b></div>`;$('applySizeBtn').disabled=!model.components.some(c=>c.type==='cylinder')||!model.components.some(c=>c.type==='pump');}catch(err){sizing=null;$('applySizeBtn').disabled=true;$('sizeResults').textContent=err.message;}});
  $('applySizeBtn').addEventListener('click',()=>{if(!sizing)return;const c=model.components.find(c=>c.type==='cylinder'),p=model.components.find(c=>c.type==='pump'),rv=model.components.find(c=>c.type==='relief');if(!c||!p)return;checkpoint();Object.assign(c.params,{bore:sizing.bore,rod:sizing.rod,stroke:sizing.stroke,loadExt:sizing.force,eta:0.95});p.params.displacement=sizing.pump;if(rv)rv.params.setting=sizing.pressure;delete model.note;state=initial();selected=c.id;selectedKind='component';$('sizeDialog').close();changed();toast('初选尺寸与排量已应用，请切换阀位检查两个方向');});
  try{const cached=localStorage.getItem('hydraulic-workbench-project-v1');if(cached){const m=JSON.parse(cached);if(!E.validateModel(m).length){model=m;selected=model.components.find(c=>['cylinder','motor'].includes(c.type))?.id||null;}}}catch{}
  renderAll();
  // Read-only snapshot for reproducible QA and future integrations.
  window.HydWorkbench={snapshot:()=>E.clone({model,state,mode,running,result:E.solve(model,state,mode)})};
})();
