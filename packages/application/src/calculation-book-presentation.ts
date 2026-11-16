import type { CalculationBook, BookMath } from './formal-export.js';

const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const latexText = (s: string) =>
  s.replace(
    /[\\{}$&#%_^~]/g,
    (c) =>
      ({
        '\\': '\\textbackslash{}',
        '{': '\\{',
        '}': '\\}',
        $: '\\$',
        '&': '\\&',
        '#': '\\#',
        '%': '\\%',
        _: '\\_',
        '^': '\\textasciicircum{}',
        '~': '\\textasciitilde{}',
      })[c] ?? c,
  );
const symbols: Readonly<Record<string, string>> = Object.freeze({
  π: '\\pi ',
  ω: '\\omega ',
  η: '\\eta ',
  ρ: '\\rho ',
  μ: '\\mu ',
  ν: '\\nu ',
  α: '\\alpha ',
  β: '\\beta ',
  γ: '\\gamma ',
  δ: '\\delta ',
  θ: '\\theta ',
  λ: '\\lambda ',
  σ: '\\sigma ',
  τ: '\\tau ',
  φ: '\\phi ',
  ψ: '\\psi ',
  ε: '\\varepsilon ',
  Δ: '\\Delta ',
  Ω: '\\Omega ',
  Σ: '\\Sigma ',
  '×': '\\times ',
  '−': '-',
  '≈': '\\approx ',
  '≤': '\\leq ',
  '≥': '\\geq ',
  '±': '\\pm ',
  '∞': '\\infty ',
  '²': '^{2}',
  '³': '^{3}',
  '·': '\\cdot ',
});
/** Only fixed math macros and escaped text are emitted; source strings are never TeX commands. */
function mathText(s: string): string {
  return (s.match(/[\p{Script=Han}]+|./gu) ?? [])
    .map((c) => symbols[c] ?? (/^[A-Za-z0-9 +\-*/=().,:;\[\]]$/.test(c) ? c : `\\text{${latexText(c)}}`))
    .join('');
}
export function bookMathLatex(value: BookMath): string {
  switch (value.kind) {
    case 'text':
      return mathText(value.text);
    case 'row':
      return value.items.map(bookMathLatex).join('');
    case 'fraction':
      return `\\frac{${bookMathLatex(value.numerator)}}{${bookMathLatex(value.denominator)}}`;
    case 'root':
      return `\\sqrt{${bookMathLatex(value.value)}}`;
    case 'script':
      return `{${bookMathLatex(value.base)}}${value.subscript ? `_{${mathText(value.subscript)}}` : ''}${value.superscript ? `^{${mathText(value.superscript)}}` : ''}`;
  }
}
export function bookMathMl(value: BookMath): string {
  switch (value.kind) {
    case 'text':
      return `<mtext>${xml(value.text)}</mtext>`;
    case 'row':
      return `<mrow>${value.items.map(bookMathMl).join('')}</mrow>`;
    case 'fraction':
      return `<mfrac>${bookMathMl(value.numerator)}${bookMathMl(value.denominator)}</mfrac>`;
    case 'root':
      return `<msqrt>${bookMathMl(value.value)}</msqrt>`;
    case 'script':
      return value.subscript && value.superscript
        ? `<msubsup>${bookMathMl(value.base)}<mtext>${xml(value.subscript)}</mtext><mtext>${xml(value.superscript)}</mtext></msubsup>`
        : value.subscript
          ? `<msub>${bookMathMl(value.base)}<mtext>${xml(value.subscript)}</mtext></msub>`
          : `<msup>${bookMathMl(value.base)}<mtext>${xml(value.superscript)}</mtext></msup>`;
  }
}
/** Shared Word-mode preview and trusted PDF body; no scripts, URLs, styles or raw markup from data. */
export function calculationBookMarkup(book: CalculationBook): string {
  return `<article class="calculation-book"><h3>${xml(book.title)}</h3><p>${xml(book.introduction)}</p>${book.sections.map((section) => `<section${section.keepTogether ? ' class="book-keep-together"' : ''}><h4>${xml(section.heading)}</h4>${section.equations.map((value) => (book.formulaFormat === 'latex' ? `<pre class="book-latex">${xml(bookMathLatex(value))}</pre>` : `<div class="book-equation"><math display="block">${bookMathMl(value)}</math></div>`)).join('')}${section.paragraphs.map((p) => `<p>${xml(p)}</p>`).join('')}${section.rows.length ? '<table>' + section.rows.map((row, i) => '<tr>' + row.map((cell) => `<${i === 0 ? 'th' : 'td'}>${xml(cell)}</${i === 0 ? 'th' : 'td'}>`).join('') + '</tr>').join('') + '</table>' : ''}</section>`).join('')}</article>`;
}
