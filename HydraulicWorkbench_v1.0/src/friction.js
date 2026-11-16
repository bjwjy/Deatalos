/* JavaScript port of fluids.friction.Clamond.
 * Copyright (C) 2016-2025 Caleb Bell. MIT; see third_party/fluids-LICENSE.txt.
 * Original source provenance: third_party/source-provenance.json.
 */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.HydFriction=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function clamond(Re,eD){
    const X1=eD*Re*0.123968186335417546, X2=Math.log(Re)-0.77939748845568194;
    let F=X2-0.2, X1F=X1+F, X1F1=1+X1F;
    let E=(Math.log(X1F)-0.2)/X1F1;
    F-=(X1F1+0.5*E)*E*X1F/(X1F1+E*(1+E/3));
    X1F=X1+F; X1F1=1+X1F; E=(Math.log(X1F)+F-X2)/X1F1;
    const b=X1F1+E*(1+E/3); F=b/(b*F-(X1F1+0.5*E)*E*X1F);
    return 1.3254745276195995*F*F;
  }
  // Transition treatment is this application's approximation, not a fluids API port.
  function factor(Re,eD){
    if(Re<=0)return {f:0,regime:'静止'};
    if(Re<=2300)return {f:64/Re,regime:'层流'};
    if(Re>=4000)return {f:clamond(Re,eD),regime:'湍流'};
    const t=(Re-2300)/1700;
    return {f:(1-t)*64/2300+t*clamond(4000,eD),regime:'过渡区估算'};
  }
  function pipe(q,d,length,roughness,K,density,viscosity){
    const D=d/1000, Q=Math.abs(q)/60000, v=Q/(Math.PI*D*D/4), Re=v*D/(viscosity*1e-6);
    const z=factor(Re,roughness/d);
    return {q:Math.abs(q),v,Re,f:z.f,regime:z.regime,dp:(z.f*length/D+K)*density*v*v/2/1e6};
  }
  return {clamond,factor,pipe};
});
