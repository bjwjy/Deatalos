// Independent connectivity inventory, not imported from product tables.
export const groups = {
  0:[],1:[['P','A']],2:[['A','T']],3:[['P','B'],['A','T']],4:[['P','A'],['B','T']],5:[['P','T']],
  6:[['P','B'],['A','T']],7:[['P','A'],['B','R']],8:[['P','B']],9:[['B','T']],10:[['A','B']],
  11:[['P','A','T']],12:[['P','A','B']],13:[['P','B','T']],14:[['A','B','T']],15:[['P','A','B','T']],
  16:[['P','T'],['A','B']],17:[['P','A','B','T','R']],18:[['B','R']],19:[['A','R']],20:[['P','R']],21:[['A','B','T','R']],
};
// Independent fixed-pressure sharp-edged branches. Newton iteration on the
// zero-volume mass balance, rather than the native TLM quadratic/bisection.
export function manifoldReference(code, pressure, area=1e-5, rho=870, cq=.67) {
  const result=Object.fromEntries(Object.keys(pressure).map((port)=>[port,0]));
  for(const group of groups[code]) {
    const values=group.map((port)=>pressure[port]), low=Math.min(...values),high=Math.max(...values);
    if(low===high) continue;
    if(group.length===2) {
      const dp=values[0]-values[1],flow=cq*area*Math.sqrt(2*Math.abs(dp)/rho)*Math.sign(dp);
      result[group[0]]+=flow;result[group[1]]-=flow;continue;
    }
    let hub=values.reduce((sum,value)=>sum+value,0)/values.length, a=low,b=high;
    for(let iteration=0;iteration<120;iteration++) {
      const balance=values.reduce((sum,value)=>sum+Math.sign(value-hub)*Math.sqrt(Math.abs(value-hub)),0);
      if(Math.abs(balance)<1e-10) break;
      if(balance>0) a=hub;else b=hub;
      const derivative=-values.reduce((sum,value)=>sum+.5/Math.sqrt(Math.max(1e-12,Math.abs(value-hub))),0);
      const next=hub-balance/derivative;
      hub=next>a&&next<b?next:(a+b)/2;
    }
    for(const port of group) result[port]=cq*area*Math.sqrt(4*Math.abs(pressure[port]-hub)/rho)*Math.sign(pressure[port]-hub);
  }
  return result;
}
