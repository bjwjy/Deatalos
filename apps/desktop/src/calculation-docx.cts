import type { BookMath, CalculationBook } from '@hyd/application' with { 'resolution-mode': 'import' };
const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const run = (s: string, bold = false) =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="000000"/></w:rPr><w:t xml:space="preserve">${xml(s)}</w:t></w:r>`;
const paragraph = (s: string, style = 'Normal', keepWithNext = false) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/>${keepWithNext ? '<w:keepNext/>' : ''}<w:wordWrap w:val="1"/></w:pPr>${run(s)}</w:p>`;
function mathXml(value: BookMath): string {
  switch (value.kind) {
    case 'text':
      return `<m:r><m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><m:t xml:space="preserve">${xml(value.text)}</m:t></m:r>`;
    case 'row':
      return value.items.map(mathXml).join('');
    case 'fraction':
      return `<m:f><m:num>${mathXml(value.numerator)}</m:num><m:den>${mathXml(value.denominator)}</m:den></m:f>`;
    case 'root':
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mathXml(value.value)}</m:e></m:rad>`;
    case 'script': {
      const base = `<m:e>${mathXml(value.base)}</m:e>`,
        sub = `<m:sub>${mathXml({ kind: 'text', text: value.subscript })}</m:sub>`,
        sup = `<m:sup>${mathXml({ kind: 'text', text: value.superscript })}</m:sup>`;
      return value.subscript && value.superscript
        ? `<m:sSubSup>${base}${sub}${sup}</m:sSubSup>`
        : value.subscript
          ? `<m:sSub>${base}${sub}</m:sSub>`
          : `<m:sSup>${base}${sup}</m:sSup>`;
    }
  }
}
function equation(value: BookMath, continued: boolean): string {
  return `<w:p><w:pPr><w:pStyle w:val="Equation"/><w:keepLines/>${continued ? '<w:keepNext/>' : ''}</w:pPr><m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${mathXml(value)}</m:oMath></m:oMathPara></w:p>`;
}
function table(rows: readonly (readonly string[])[], keepTogether = false): string {
  if (!rows.length) return '';
  const widths = [2324, 3600, 3374];
  return `<w:tbl><w:tblPr><w:tblW w:w="9298" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.map((row, i) => `<w:tr>${keepTogether || i === 0 ? '<w:trPr>' + (keepTogether ? '<w:cantSplit/>' : '') + (i === 0 ? '<w:tblHeader/>' : '') + '</w:trPr>' : ''}${row.map((cell, j) => `<w:tc><w:tcPr><w:tcW w:w="${widths[j]}" w:type="dxa"/><w:vAlign w:val="center"/>${i === 0 ? '<w:shd w:fill="E6EEF5"/>' : i % 2 === 0 ? '<w:shd w:fill="F6F8FA"/>' : ''}</w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/>${keepTogether && i < rows.length - 1 ? '<w:keepNext/>' : ''}<w:wordWrap w:val="1"/></w:pPr>${run(cell, i === 0)}</w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>${paragraph('')}`;
}
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** Fixed, macro-free OOXML parts. The only input is parsed text/table content, never a ZIP or relationship. */
export async function calculationDocx(book: CalculationBook): Promise<Buffer> {
  const { bookMathLatex } = await import('@hyd/application');
  const body =
    paragraph(book.title, 'Title') +
    paragraph(book.introduction) +
    book.sections
      .map(
        (section) =>
          paragraph(section.heading, 'Heading1') +
          section.equations
            .map((value, i) =>
              book.formulaFormat === 'latex'
                ? paragraph(bookMathLatex(value), 'LatexCode')
                : equation(value, i < section.equations.length - 1 || section.paragraphs.length > 0),
            )
            .join('') +
          section.paragraphs.map((p) => paragraph(p, 'Normal', section.keepTogether)).join('') +
          table(section.rows, section.keepTogether),
      )
      .join('');
  const parts: [string, string][] = [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="${ns}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1304" w:bottom="1020" w:left="1304" w:header="567" w:footer="510"/><w:cols w:space="425"/></w:sectPr></w:body></w:document>`,
    ],
    [
      'word/styles.xml',
      `<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:eastAsia="宋体" w:cs="Cambria"/><w:color w:val="000000"/><w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="120" w:line="300" w:lineRule="auto"/><w:wordWrap w:val="1"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:after="300"/></w:pPr><w:rPr><w:b/><w:sz w:val="38"/><w:color w:val="000000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/><w:color w:val="000000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Equation"><w:name w:val="Equation"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="160"/><w:spacing w:before="40" w:after="110" w:line="300" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="270" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="LatexCode"><w:name w:val="LaTeX source"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="160"/><w:wordWrap w:val="1"/><w:spacing w:before="40" w:after="110"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:style></w:styles>`,
    ],
    [
      'word/_rels/document.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/></Relationships>',
    ],
    [
      'word/footer1.xml',
      `<w:ftr xmlns:w="${ns}"><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>${run('第 ')}<w:fldSimple w:instr="PAGE">${run('1')}</w:fldSimple>${run(' 页')}</w:p></w:ftr>`,
    ],
    [
      'docProps/core.xml',
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(book.title)}</dc:title><dc:creator>HydraulicWorkbench</dc:creator><dc:description>${xml(book.source)}</dc:description></cp:coreProperties>`,
    ],
    ['customXml/item1.xml', `<hydraulic-source version="1">${xml(book.metadata)}</hydraulic-source>`],
  ];
  return zipStored(parts);
}
/** Small fixed-part ZIP writer (stored method, UTF-8 names, CRC-32). No archive inputs/extraction. */
function zipStored(parts: readonly (readonly [string, string])[]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, xmlText] of parts) {
    const data = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + xmlText),
      filename = Buffer.from(name),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(
    central.reduce((n, b) => n + b.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
