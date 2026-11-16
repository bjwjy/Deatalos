import { ContractReader, valueReasonDisplay } from '@hyd/domain';
import type { CalculationStep, ResultValue } from '@hyd/engineering';

/** Bounded presentation tree, shared by MathML preview and native Word equations. No evaluation or XML input. */
export type BookMath =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'row'; readonly items: readonly BookMath[] }
  | { readonly kind: 'fraction'; readonly numerator: BookMath; readonly denominator: BookMath }
  | { readonly kind: 'script'; readonly base: BookMath; readonly subscript: string; readonly superscript: string }
  | { readonly kind: 'root'; readonly value: BookMath };
const t = (text: string): BookMath => ({ kind: 'text', text });
const row = (...items: BookMath[]): BookMath => ({ kind: 'row', items });
const f = (numerator: BookMath, denominator: BookMath): BookMath => ({ kind: 'fraction', numerator, denominator });
const script = (base: BookMath, subscript = '', superscript = ''): BookMath => ({
  kind: 'script',
  base,
  subscript,
  superscript,
});
const root = (value: BookMath): BookMath => ({ kind: 'root', value });
const par = (value: BookMath): BookMath => row(t('('), value, t(')'));
const mul = (...items: BookMath[]): BookMath => row(...items.flatMap((item, i) => (i ? [t(' × '), item] : [item])));
const add = (a: BookMath, b: BookMath): BookMath => row(a, t(' + '), b);
const minus = (a: BookMath, b: BookMath): BookMath => row(a, t(' − '), b);
const square = (a: BookMath): BookMath => script(a, '', '2');
const symbol = (name: string): BookMath => {
  const [base = '', ...sub] = name.split('_');
  return sub.length ? script(t(base), sub.join(',')) : t(base);
};
export function bookNumber(value: number): string {
  return Number(value.toPrecision(6)).toString();
}
function numberMath(value: number): BookMath {
  const [mantissa = '', exponent] = bookNumber(value).split('e');
  return exponent === undefined
    ? t(mantissa.replace('-', '−'))
    : mul(t(mantissa.replace('-', '−')), script(t('10'), '', String(Number(exponent))));
}
export function bookResult(value: ResultValue, unit: string): string {
  return value.kind === 'known'
    ? bookNumber(value.value) + (unit === '1' ? '' : ' ' + unit)
    : `${value.kind === 'unknown' ? '未知' : '不适用'}：${valueReasonDisplay(value.reason)}`;
}
type Variable = (name: string, reference?: string) => BookMath;
type Many = (operation: 'max' | 'sum', pattern: RegExp, name: string) => BookMath;
type Template = (v: Variable, many: Many) => BookMath;
const equation = (name: string, rhs: BookMath) => row(symbol(name), t(' = '), rhs);
const orificeDrop = (v: Variable) =>
  f(mul(v('ρ', 'rho'), square(par(f(v('q'), mul(v('C_q', 'Cq'), v('A_有效', 'Aeff')))))), t('2'));
const velocityHead = (v: Variable) => f(mul(v('ρ', 'rho'), square(v('u'))), t('2'));

/** Finite renderers for the existing CalculationRecord formulas, algebraically unchanged. Results are never recomputed. */
const templates: Readonly<Record<string, Template>> = {
  'Dmin=sqrt(4F/[pi*0.95*(p-1MPa-0.5MPa*(1-0.6²))])': (v) =>
    equation(
      'D_min',
      root(
        f(
          mul(t('4'), v('F', 'forceN')),
          mul(
            t('π'),
            t('0.95'),
            par(
              minus(
                minus(v('p', 'pressureBudgetPa'), numberMath(1e6)),
                mul(numberMath(0.5e6), par(minus(t('1'), square(t('0.6'))))),
              ),
            ),
          ),
        ),
      ),
    ),
  'd=round(D_mm*0.6) mm': (v) =>
    equation('d', f(row(t('取整'), par(mul(t('1000'), v('D', 'bore'), t('0.6')))), t('1000'))),
  'A_A=pi*D²/4': (v) => equation('A_A', f(mul(t('π'), square(v('D', 'bore'))), t('4'))),
  'A_B=pi*(D²-d²)/4': (v) =>
    equation('A_B', f(mul(t('π'), par(minus(square(v('D', 'bore')), square(v('d', 'rod'))))), t('4'))),
  'Qreq=A_A*v': (v) => equation('Q_req', mul(v('A_A', 'capArea'), v('v', 'speedMPerS'))),
  'Dreq=Qreq/[(omega/(2*pi))*eta_v]': (v) =>
    equation(
      'V_g,req',
      f(
        v('Q_req', 'flow'),
        mul(f(v('ω', 'pumpAngularSpeedRadPerS'), mul(t('2'), t('π'))), v('η_v', 'volumetricEfficiency')),
      ),
    ),
  'Qest=Dselected*(omega/(2*pi))*eta_v': (v) =>
    equation(
      'Q_est',
      mul(
        v('V_g', 'pumpDisplacement'),
        f(v('ω', 'pumpAngularSpeedRadPerS'), mul(t('2'), t('π'))),
        v('η_v', 'volumetricEfficiency'),
      ),
    ),
  'vest=Qest/A_A': (v) => equation('v_est', f(v('Q_est', 'estimatedFlow'), v('A_A', 'capArea'))),
  'Pshaft=pBudget*Qest/eta_total': (v) =>
    equation('P', f(mul(v('p', 'pressureBudgetPa'), v('Q_est', 'estimatedFlow')), v('η', 'totalEfficiency'))),
  'p=(F/eta_m+pReturn*Aout)/Ain+dpSupply': (v) =>
    equation(
      'p',
      add(
        f(
          add(f(v('F', 'resistingLoad'), v('η_m', 'eta_m')), mul(v('p_回', 'returnPressure'), v('A_出', 'Aout'))),
          v('A_进', 'Ain'),
        ),
        v('Δp', 'supplyLoss'),
      ),
    ),
  'p=2*pi*T/(D*eta_m)+pReturn+dpSupply': (v) =>
    equation(
      'p',
      add(
        add(
          f(mul(t('2'), t('π'), v('T', 'resistingLoad')), mul(v('V_g', 'D'), v('η_m', 'eta_m'))),
          v('p_回', 'returnPressure'),
        ),
        v('Δp', 'supplyLoss'),
      ),
    ),
  'p=2*pi*(T+Tviscous)/(D*eta_m)+pReturn+dpSupply': (v) =>
    equation(
      'p',
      add(
        add(
          f(
            mul(t('2'), t('π'), par(add(v('T_外', 'resistingLoad'), v('T_黏', 'Tviscous')))),
            mul(v('V_g', 'D'), v('η_m', 'eta_m')),
          ),
          v('p_回', 'returnPressure'),
        ),
        v('Δp_供', 'supplyLoss'),
      ),
    ),
  'p=dpGiven+pReturn+dpSupply': (v) =>
    equation('p', add(add(v('Δp_给定', 'dpGiven'), v('p_回', 'returnPressure')), v('Δp_供', 'supplyLoss'))),
  'Q=Ain*v/eta_v': (v) => equation('Q', f(mul(v('A_进', 'Ain'), v('v', 'speed')), v('η_v', 'eta_v'))),
  'v=q/Ain': (v) => equation('v_实', f(v('q_实', 'q'), v('A_进', 'Ain'))),
  'q=sqrt(max(pP-p0,0)/K)': (v) =>
    equation('q_实', root(f(row(t('max'), par(row(minus(v('p_P', 'pP'), v('p_0', 'p0')), t(', 0')))), v('K')))),
  'Qreturn=Aout*v': (v) => equation('Q_回', mul(v('A_出', 'Aout'), v('v', 'speed'))),
  'Fs=F0+k*x': (v) => equation('F_弹', add(v('F_0', 'F0'), mul(v('k'), v('x')))),
  'p=(F/eta_m+Fs)/Ain+dpSupply': (v) =>
    equation(
      'p',
      add(
        f(add(f(v('F', 'resistingLoad'), v('η_m', 'eta_m')), v('F_弹', 'Fspring')), v('A_A', 'Ain')),
        v('Δp', 'supplyLoss'),
      ),
    ),
  'Fmargin=Fs-pA*A-F/eta_m': (v) =>
    equation(
      'F_裕量',
      minus(
        minus(v('F_弹', 'Fspring'), mul(v('p_A', 'returnPressure'), v('A_A', 'Ain'))),
        f(v('F', 'resistingLoad'), v('η_m', 'eta_m')),
      ),
    ),
  'dp=R*qA': (v) => equation('Δp', mul(v('R'), v('q_A', 'qA'))),
  'dp=pA-pB': (v) => equation('Δp', minus(v('p_A', 'pA'), v('p_B', 'pB'))),
  's=(pB-pA)+r*(pX-pA)-pSet': (v) =>
    equation(
      's',
      minus(
        add(par(minus(v('p_B', 'pB'), v('p_A', 'pA'))), mul(v('r'), par(minus(v('p_X', 'pX'), v('p_A', 'pA'))))),
        v('p_设定', 'pSet'),
      ),
    ),
  'g=clamp(s/band,0,1)': (v) => equation('g', row(t('clip'), par(row(f(v('s'), v('Δp_调节带', 'band')), t(', 0, 1'))))),
  'dp=pPump-pC': (v) => equation('Δp', minus(v('p_泵', 'pPump'), v('p_C', 'pC'))),
  'dpOpen=dpCrack+r*max(pX-pA,0)': (v) =>
    equation(
      'Δp_开启',
      add(
        v('Δp_弹簧', 'dpCrack'),
        mul(v('r'), row(t('max'), par(row(minus(v('p_X', 'pX'), v('p_A', 'pA')), t(', 0'))))),
      ),
    ),
  'dp=pA-pB-dpOpen': (v) => equation('Δp_有效', minus(minus(v('p_A', 'pA'), v('p_B', 'pB')), v('Δp_开启', 'dpOpen'))),
  'Q=sqrt(dp/K)': (v) => equation('Q', root(f(v('Δp', 'dp'), v('K')))),
  'Q=f*sqrt(max(dp,0)/K)': (v) =>
    equation('Q', mul(v('f'), root(f(row(t('max'), par(row(v('Δp', 'dp'), t(', 0')))), v('K'))))),
  'g=clamp((min(pA,pB)-pMin)/band,0,1)': (v) =>
    equation(
      'g',
      row(
        t('clip'),
        par(
          row(
            f(
              minus(row(t('min'), par(row(v('p_A', 'pA'), t(', '), v('p_B', 'pB')))), v('p_最小', 'pMin')),
              v('Δp_开启带', 'band'),
            ),
            t(', 0, 1'),
          ),
        ),
      ),
    ),
  'pXmin=pRef+(pB-pRef+crack)/r': (v) =>
    equation(
      'p_X,min',
      add(v('p_参考', 'pRef'), f(add(minus(v('p_B', 'pB'), v('p_参考', 'pRef')), v('Δp_开启', 'crack')), v('r'))),
    ),
  'margin=pX-pXmin': (v) => equation('Δp_裕量', minus(v('p_X', 'pX'), v('p_X,min', 'pXmin'))),
  'pA=pBase+dpFilter': (v) => equation('p_A', add(v('p_基础', 'pBase'), v('Δp_滤芯', 'dpFilter'))),
  'pY=pTank+dpFilter': (v) => equation('p_Y', add(v('p_箱', 'pTank'), v('Δp_滤芯', 'dpFilter'))),
  'pA=pBase+dpFilter+dpPipe': (v) =>
    equation('p_A', add(add(v('p_基础', 'pBase'), v('Δp_滤芯', 'dpFilter')), v('Δp_管', 'dpPipe'))),
  'pY=pTank+dpFilter+dpPipe': (v) =>
    equation('p_Y', add(add(v('p_箱', 'pTank'), v('Δp_滤芯', 'dpFilter')), v('Δp_管', 'dpPipe'))),
  'u=4*q/(pi*D^2)': (v) => equation('u', f(mul(t('4'), v('q')), mul(t('π'), square(v('D'))))),
  'Re=u*D/nu': (v) => equation('Re', f(mul(v('u'), v('D')), v('ν', 'nu'))),
  'dpF=f*(L/D)*rho*u^2/2': (v) => equation('Δp_沿程', mul(v('f'), f(v('L'), v('D')), velocityHead(v))),
  'dpK=K*rho*u^2/2': (v) => equation('Δp_局部', mul(v('K'), velocityHead(v))),
  'dpPipe=dpF+dpK': (v) => equation('Δp_管', add(v('Δp_沿程', 'dpF'), v('Δp_局部', 'dpK'))),
  'dpPipe=dpPipe1+dpPipe2': (v) => equation('Δp_管', add(v('Δp_管1', 'dpPipe1'), v('Δp_管2', 'dpPipe2'))),
  'dpPipe=sum(dpPipe_i)': () => equation('Δp_管', row(t('Σ'), par(symbol('Δp_管,i')))),
  'pY=pTank+dpTap': (v) => equation('p_Y', add(v('p_箱', 'pTank'), v('Δp_取压', 'dpTap'))),
  'dpPipe=dpPipe1+dpPipe2+dpPipe3': (v) =>
    equation('Δp_管', add(add(v('Δp_管1', 'dpPipe1'), v('Δp_管2', 'dpPipe2')), v('Δp_管3', 'dpPipe3'))),
  'dpPipe=dpPipe1+dpPipe2+dpPipe3+dpPipe4': (v) =>
    equation(
      'Δp_管',
      add(add(v('Δp_管1', 'dpPipe1'), v('Δp_管2', 'dpPipe2')), add(v('Δp_管3', 'dpPipe3'), v('Δp_管4', 'dpPipe4'))),
    ),
  'pB=pA+dpPilot': (v) => equation('p_B', add(v('p_A', 'pA'), v('Δp_液控阀', 'dpPilot'))),
  'pX=pDrive+areaRatio*pB': (v) =>
    equation('p_X', add(v('p_负载', 'pDrive'), mul(v('α_腔面积比', 'areaRatio'), v('p_B', 'pB')))),
  'dp=dpComp*(q/qNominal)^2': (v) =>
    equation('Δp_计量', mul(v('Δp_补偿', 'dpComp'), square(par(f(v('q_A', 'q'), v('q_标称', 'qNominal')))))),
  'qP=qWork+qBypass': (v) => equation('q_P', add(v('q_工作', 'qWork'), v('q_旁通', 'qBypass'))),
  'qBypass=Cq*Aeff*sqrt(2*(pP-pT)/rho)': (v) =>
    equation(
      'q_旁通',
      mul(
        v('C_q', 'Cq'),
        v('A_有效', 'Aeff'),
        root(f(mul(t('2'), par(minus(v('p_P', 'pP'), v('p_T', 'pT')))), v('ρ', 'rho'))),
      ),
    ),
  'pA=pCylinder+dpDownstream': (v) => equation('p_A', add(v('p_缸', 'pCylinder'), v('Δp_阀后', 'dpDownstream'))),
  'pThreshold=pY+setting': (v) => equation('p_门槛', add(v('p_Y', 'pY'), v('p_设定', 'setting'))),
  'pP=pA+dpValve': (v) => equation('p_P', add(v('p_A', 'pA'), v('Δp_阀', 'dpValve'))),
  'pPump=pP+dpUpstream': (v) => equation('p_泵出口', add(v('p_P', 'pP'), v('Δp_阀前', 'dpUpstream'))),
  'dp=rho*(q/(Cq*Aeff))^2/2': (v) => equation('Δp', orificeDrop(v)),
  'pilotDrop=crack+rho*(q/(Cq*Aeff))^2/2': (v) => equation('Δp', add(v('Δp_开启', 'crack'), orificeDrop(v))),
  'qLimit=Cq*Aeff*sqrt(2*dpComp/rho)': (v) =>
    equation(
      'q_上限',
      mul(v('C_q', 'Cq'), v('A_计量', 'Aeff'), root(f(mul(t('2'), v('Δp_补偿', 'dpComp')), v('ρ', 'rho')))),
    ),
  'f=clip((setting+pY-pA)/band)': (v) =>
    equation(
      'f',
      row(
        t('clip'),
        par(
          row(f(minus(add(v('p_设定', 'setting'), v('p_Y', 'pY')), v('p_A', 'pA')), v('Δp_带宽', 'band')), t(', 0, 1')),
        ),
      ),
    ),
  'f=clip((pP-pY-setting)/band)': (v) =>
    equation(
      'f',
      row(
        t('clip'),
        par(
          row(
            f(minus(minus(v('p_P', 'pP'), v('p_Y', 'pY')), v('p_设定', 'setting')), v('Δp_带宽', 'band')),
            t(', 0, 1'),
          ),
        ),
      ),
    ),
  'dp=dpRated*(qA/qRated)^2': (v) =>
    equation('Δp', mul(v('Δp_额定', 'dpRated'), square(par(f(v('q_A', 'qA'), v('q_额定', 'qRated')))))),
  'p_H=p_tap': (v) => equation('p_H', v('p_测点', 'p_H')),
  'p_H-p_trip': (v) => equation('Δp_动作', minus(v('p_H'), v('p_动作', 'p_trip'))),
  'sum=pBase+dpDevices': (v) => equation('p_合计', add(v('p_基础', 'pBase'), v('Δp_附件', 'dpDevices'))),
  'sum=pBase+dpDevices+dpValve': (v) =>
    equation('p_合计', add(add(v('p_基础', 'pBase'), v('Δp_附件', 'dpDevices')), v('Δp_阀', 'dpValve'))),
  'sum=pBase+dpDevices+dpPipe': (v) =>
    equation('p_合计', add(add(v('p_基础', 'pBase'), v('Δp_附件', 'dpDevices')), v('Δp_管', 'dpPipe'))),
  'sum=pBase+dpDevices+dpPipe+dpValve': (v) =>
    equation(
      'p_合计',
      add(add(add(v('p_基础', 'pBase'), v('Δp_附件', 'dpDevices')), v('Δp_管', 'dpPipe')), v('Δp_阀', 'dpValve')),
    ),
  'Q=D*omega/(2*pi*eta_v)': (v) =>
    equation('Q', f(mul(v('V_g', 'D'), v('ω', 'speed')), mul(t('2'), t('π'), v('η_v', 'eta_v')))),
  'pSource=max(pBranch)': (_v, many) => equation('p_源', many('max', /:pressure$/, 'p')),
  'Qsource=sum(QBranch)': (_v, many) => equation('Q_源', many('sum', /:flow$/, 'Q')),
  'P=(pSource-pTank)*Qsource/eta_total': (v) =>
    equation(
      'P',
      f(mul(par(minus(v('p_源', 'pSource'), v('p_箱', 'pTank'))), v('Q_源', 'Qsource')), v('η', 'eta_total')),
    ),
  'Dreq=max(Qphase)/[(omega/(2*pi))*eta_v]': (v, many) =>
    equation(
      'V_g,req',
      f(many('max', /^phase\d+:flow$/, 'Q'), mul(f(v('ω', 'omega'), mul(t('2'), t('π'))), v('η_v', 'eta_v'))),
    ),
  'Qavailable=Dsaved*(omega/(2*pi))*eta_v': (v) =>
    equation('Q_泵', mul(v('V_g', 'Dsaved'), f(v('ω', 'omega'), mul(t('2'), t('π'))), v('η_v', 'eta_v'))),
  'Qavailable=Dphase*(omega/(2*pi))*eta_v': (v) =>
    equation('Q_泵', mul(v('V_工况', 'Dphase'), f(v('ω', 'omega'), mul(t('2'), t('π'))), v('η_v', 'eta_v'))),
  'Ppeak=max(Pphase)': (_v, many) => equation('P_max', many('max', /^phase\d+:power$/, 'P')),
  'p_A*A_A-p_B*A_B': (v) =>
    equation(
      'F_h',
      minus(mul(v('p_A', 'A.pressure'), v('A_A', 'capArea')), mul(v('p_B', 'B.pressure'), v('A_B', 'rodArea'))),
    ),
  'q_A/A_A': (v) => equation('v_A', f(v('q_A', 'A.flow'), v('A_A', 'capArea'))),
  '-q_B/A_B': (v) => equation('v_B', f(row(t('−'), v('q_B', 'B.flow')), v('A_B', 'rodArea'))),
  '(p_P-p_S)*(-q_P)': (v) =>
    equation(
      'P_h',
      mul(par(minus(v('p_P', 'P.pressure'), v('p_S', 'S.pressure'))), par(row(t('−'), v('q_P', 'P.flow')))),
    ),
  '(p_A-p_B)*D/(2*pi)': (v) =>
    equation(
      'T',
      f(
        mul(par(minus(v('p_A', 'A.pressure'), v('p_B', 'B.pressure'))), v('V_g', 'hydraulic.displacementM3PerRev')),
        mul(t('2'), t('π')),
      ),
    ),
};
function templateFor(formula: string): Template | undefined {
  const key = formula.split(/[；，]/)[0] ?? '';
  if (templates[key]) return templates[key];
  const drop = /^p_([ABPST])-p_([ABPST])$/.exec(key);
  if (drop)
    return (v) =>
      equation('Δp', minus(v('p_' + drop[1], drop[1] + '.pressure'), v('p_' + drop[2], drop[2] + '.pressure')));
  const power = /^p_([ABPT])\*q_\1\+p_([ABPT])\*q_\2$/.exec(key);
  if (power)
    return (v) =>
      equation(
        'P_h',
        add(
          mul(v('p_' + power[1], power[1] + '.pressure'), v('q_' + power[1], power[1] + '.flow')),
          mul(v('p_' + power[2], power[2] + '.pressure'), v('q_' + power[2], power[2] + '.flow')),
        ),
      );
  return undefined;
}
export function stepBookMath(step: CalculationStep): {
  readonly equations: readonly BookMath[];
  readonly paragraphs: readonly string[];
} {
  const template = templateFor(step.formula);
  if (!template) {
    const selection = step.key === 'bore' || step.key === 'pumpDisplacement';
    const parameter = step.formula.includes('model parameter') || step.formula === 'L=用户给定行程';
    return {
      equations: [],
      paragraphs: [
        (selection ? '按教学规格向上初选：' : parameter ? '采用值：' : '结果：') +
          bookResult(step.display.value, step.display.unit),
      ],
    };
  }
  const missing: string[] = [];
  const variable: Variable = (name, reference = name) => {
    const input = step.inputs.find((item) => item.reference === reference);
    if (!input || input.value.kind !== 'known') {
      missing.push(reference);
      return symbol(name);
    }
    return input.value.value < 0 ? par(numberMath(input.value.value)) : numberMath(input.value.value);
  };
  const many: Many = (operation, pattern, name) => {
    const inputs = step.inputs.filter((input) => pattern.test(input.reference));
    if (!inputs.length) missing.push(name);
    const values = inputs.map((input, i) => variable(name + '_' + (i + 1), input.reference));
    return operation === 'max'
      ? row(t('max'), par(row(...values.flatMap((value, i) => (i ? [t(', '), value] : [value])))))
      : row(...values.flatMap((value, i) => (i ? [t(' + '), value] : [value])));
  };
  const formula = template(
    (name) => symbol(name),
    (operation, _pattern, name) => row(t(operation === 'max' ? 'max' : 'Σ'), par(symbol(name + '_i'))),
  );
  const substitution = template(variable, many);
  if (missing.length || step.value.kind !== 'known')
    return {
      equations: [formula],
      paragraphs: [bookResult(step.display.value, step.display.unit)],
    };
  const result = [t(' ≈ '), numberMath(step.value.value)];
  if (step.unit !== '1') result.push(t(' ' + step.unit));
  if (step.unit !== step.display.unit && step.display.value.kind === 'known')
    result.push(t(' ≈ '), numberMath(step.display.value.value), t(' ' + step.display.unit));
  return { equations: [formula, row(substitution, ...result)], paragraphs: [] };
}

export function readBookMath(input: unknown, r: ContractReader, path: string, depth = 0): BookMath {
  if (depth > 16) {
    r.fail('BOOK_MATH_DEPTH', path, '公式结构超过层数限制。');
    return t('');
  }
  const o = r.object(input, path, [
    'kind',
    'text',
    'items',
    'numerator',
    'denominator',
    'base',
    'subscript',
    'superscript',
    'value',
  ]);
  const text = (value: unknown, field: string) => {
    const s = r.text(value, path + '/' + field, 0, 300);
    if (/[\u0000-\u001f\uFFFE\uFFFF]/.test(s)) r.fail('BOOK_MATH_TEXT', path, '公式含不可输出字符。');
    return s;
  };
  const child = (value: unknown, field: string) => readBookMath(value, r, path + '/' + field, depth + 1);
  if (o.kind === 'text') return t(text(o.text, 'text'));
  if (o.kind === 'row')
    return {
      kind: 'row',
      items: r.array(o.items, path + '/items', 1000).map((value, i) => child(value, 'items/' + i)),
    };
  if (o.kind === 'fraction') return f(child(o.numerator, 'numerator'), child(o.denominator, 'denominator'));
  if (o.kind === 'script')
    return script(child(o.base, 'base'), text(o.subscript, 'subscript'), text(o.superscript, 'superscript'));
  if (o.kind === 'root') return root(child(o.value, 'value'));
  r.fail('BOOK_MATH_KIND', path, '不支持的公式结构。');
  return t('');
}
