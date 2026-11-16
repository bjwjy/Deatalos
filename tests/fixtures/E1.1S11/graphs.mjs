import {basicBuilder,good} from '../E04B/graphs.mjs';
import {parseNetworkProject,networkDefinition,networkDefaultParameters,configurePumpRelief} from '@hyd/domain';
export {good};
export const definitions=[
 ['directional-2-2',['P','A'],[[0,1]]],['directional-3-2',['P','A'],[[0,1,1]]],
 ['directional-2-3',['P','A','T'],[[1,2]]],['directional-3-3',['P','A','T'],[[0,1,2]]],
 ['directional-2-4',['P','A','T','B'],[[3,4]]],['directional-3-4',['P','A','T','B'],[[0,3,4],[3,4,5]]],
 ['directional-2-5',['P','A','T','B','R'],[[6,7]]],['directional-3-5',['P','A','T','B','R'],[[0,6,7]]],
];
export function permutations(values){return values.length===0?[[]]:[...new Set(values)].flatMap(value=>permutations(values.filter((_v,i)=>i!==values.indexOf(value))).map(rest=>[value,...rest]));}
function addPump(b,back,delivery=back){
 const pump=b.add('pump','pump'),def=networkDefinition('teaching:pump',3);
 Object.assign(pump,{definition:{id:def.id,version:def.version},model:{id:def.model.id,version:def.model.version},parameters:structuredClone(networkDefaultParameters(def.id,def.version))});
 pump.parameters.storage.initialPressurePa=back;pump.parameters.storage.deliveryInitialPressurePa=delivery;
}
export function valveGraph(name,functions,pressures={P:5.1e6,A:1.3e6,T:1e5,B:2.2e6,R:4e5}){
 const ports=definitions.find(d=>d[0]===name)[1],slots=functions.length===2?['extend','retract']:['extend','neutral','retract'];
 const b=basicBuilder('s11-'+name);b.add('valve',name,{kind:'valve',positionId:slots[0]}, {positions:Object.fromEntries(slots.map((slot,i)=>[slot+'Function',functions[i]]))});
 for(const port of ports){b.source('bound-'+port,pressures[port]);b.edge('edge-'+port,'bound-'+port+':P','valve:'+port);}
 return b.finish();
}
export function directPumpCylinder({enabled=true,area=1e-5,back=1e5,external=false,position=.19,stroke=.2,maximum=3e6}={}){
 const b=basicBuilder('s11-direct-cylinder');b.tank('tank',back);addPump(b,back);
 b.add('cylinder','cylinder',{kind:'cylinder',positionM:position,velocityMPerS:0,capPressurePa:back,rodPressurePa:back},{geometry:{strokeM:stroke},mechanics:{externalForceN:0,pistonDampingNsPerM:500}});
 b.edge('suction','tank:T','pump:S');b.edge('delivery','pump:P','cylinder:A');b.edge('return','cylinder:B','tank:T');
 if(external){b.add('external','relief',undefined,{hydraulic:{settingDifferentialPa:2e6,maximumAreaM2:1e-5}});b.edge('external-in','pump:P','external:P');b.edge('external-out','external:T','tank:T');}
 return good(configurePumpRelief(b.finish(),'pump',{enabled,settingDifferentialPa:maximum,maximumAreaM2:area,flowCoefficient:.67}));
}
export function pumpPressureFixture(differential,back=1e5){
 const b=basicBuilder('s11-relief-pressure');addPump(b,back,back+differential);b.source('supply',back+differential);b.tank('tank',back);b.edge('p','pump:P','supply:P');b.edge('s','pump:S','tank:T');
 b.project.design.components.find(c=>c.id==='pump').parameters.drive.angularSpeedRadPerS=0; // Isolate the relief constitutive law; rotating-pump coupling is checked in the end-stop cases.
 return good(configurePumpRelief(b.finish(),'pump',{enabled:true,settingDifferentialPa:3e6,maximumAreaM2:1e-5,flowCoefficient:.67}));
}
