import PDFDocument from 'pdfkit';
import { LABELS, legacyLangs, refLine } from './lang.js';
const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const eur = (n, c = 'EUR') => `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c === 'EUR' ? '€' : c}`;
// The rate printed next to a line is the rate its VAT was computed with. A whole percent prints as a
// whole number (21%), anything finer prints with its decimals (7.5%) instead of being rounded to a
// rate the document does not use.
const pct = (r) => { const p = Number(r) * 100; return Math.abs(p - Math.round(p)) < 1e-9 ? String(Math.round(p)) : String(Math.round(p * 100) / 100); };

export function renderPdf(inv) {
  const langs = legacyLangs(inv), both = langs.length > 1;
  const tr = (l, k) => LABELS[l]?.[k] ?? k;
  const uniq = (k, sep) => [...new Set(langs.map(l => tr(l, k)))].join(sep);
  const T = (k) => uniq(k, ' / ');
  const TL = (k) => uniq(k + ':', ' / ').replace(/:( \/ [^:]*):/g, '$1:');
  const TH = (k) => uniq(k, both ? '\n' : '');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: inv.number } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const rect = inv.type === 'rectificativa';
    doc.font('Helvetica-Bold').fontSize(both ? 13 : 18).text(T(rect ? 'FACTURA RECTIFICATIVA' : 'FACTURA'), 50, 50, { width: 285 });
    doc.font('Helvetica').fontSize(10).text(`${TL('Nº')} ${inv.number}`, 350, 52, { align: 'right', width: 195 }).text(`${TL('Fecha')} ${dmy(inv.issueDate)}`, 350, 66, { align: 'right', width: 195 });
    if (inv.operationDate) doc.text(`${TL('Fecha de operación')} ${dmy(inv.operationDate)}`, 250, 80, { align: 'right', width: 295 });
    let y = 110;
    const block = (title, p, x) => {
      doc.font('Helvetica-Bold').fontSize(9).text(title, x, y);
      doc.font('Helvetica').fontSize(10).text([p.name, p.vat ? `NIF/VAT: ${p.vat}` : p.nif ? `NIF/VAT: ${p.nif}` : null, p.registrationNo ? `Reg. no.: ${p.registrationNo}` : null, ...(Array.isArray(p.address) ? p.address : [p.address])].filter(Boolean).join('\n'), x, y + 13, { width: 230 });
    };
    block(T('EMISOR'), inv.seller, 50); block(T('CLIENTE'), inv.buyer, 310);
    y = 200;
    if (rect) {
      doc.rect(50, y, 495, 52 + 13 * (langs.length - 1)).stroke('#999');
      doc.font('Helvetica-Bold').fontSize(9).text(T('RECTIFICA A'), 58, y + 6);
      doc.font('Helvetica').fontSize(10).text(langs.map(l => refLine(l, inv.rectifies.number, dmy(inv.rectifies.issueDate), inv.mode)).join('\n'), 58, y + 19, { width: 480 })
        ;
      doc.text(`${TL('Motivo')} ${inv.rectifies.reason}`, 58, y + 19 + 13 * langs.length, { width: 480 });
      y += 66 + 13 * (langs.length - 1);
    }
    doc.font('Helvetica-Bold').fontSize(9);
    const cols = [50, 255, 310, 360, 410, 480];
    ['Descripción', 'Cant.', 'P. unit.', 'IVA %', 'Base', 'Cuota'].map(TH).forEach((h, i) => doc.text(h, cols[i], y, { width: i ? 50 : 200, align: i ? 'right' : 'left' }));
    y += both ? 28 : 16; doc.moveTo(50, y - 3).lineTo(545, y - 3).stroke('#999'); doc.font('Helvetica').fontSize(9);
    for (const l of inv.lines) {
      doc.text(l.description ?? '', cols[0], y, { width: 200 }); const h = doc.heightOfString(l.description ?? '', { width: 200 });
      [String(l.qty), eur(l.unitExcl, inv.currency), `${pct(l.rate)}%`, eur(l.excl, inv.currency), eur(l.vat, inv.currency)].forEach((v, i) => doc.text(v, cols[i + 1], y, { width: i === 4 ? 65 : 50, align: 'right' }));
      y += Math.max(h, 12) + 6; if (y > 700) { doc.addPage(); y = 50; }
    }
    y += 6; doc.moveTo(300, y).lineTo(545, y).stroke('#999'); y += 8;
    [['Base imponible', inv.totals.excl], ['IVA', inv.totals.vat]].forEach(([k, v]) => { doc.font('Helvetica').text(T(k), 300, y, { width: 130 }).text(eur(v, inv.currency), 430, y, { width: 115, align: 'right' }); y += 14; });
    doc.font('Helvetica-Bold').fontSize(11).text(T('TOTAL'), 300, y, { width: 130 }).text(eur(inv.totals.incl, inv.currency), 430, y, { width: 115, align: 'right' });
    y += 30; doc.font('Helvetica').fontSize(9);
    if (inv.vatNote) doc.text(inv.vatNote.text, 50, y, { width: 495 }), y += 24;
    if (inv.payment) {
      const pl = [inv.payment.dueDate && `Payment due: ${inv.payment.dueDate}`, inv.payment.discountTerms && `Early-payment discount: ${inv.payment.discountTerms}`, inv.payment.latePenaltyRate && `Late-payment penalty: ${inv.payment.latePenaltyRate}`, inv.payment.recoveryIndemnity && `Recovery-cost indemnity: ${inv.payment.recoveryIndemnity}`].filter(Boolean);
      if (pl.length) { doc.fillColor('#000').text(pl.join('\n'), 50, y, { width: 495 }); y += 12 * pl.length + 8; }
    }
    if (inv.orderId) doc.fillColor('#555').text(`${TL('Pedido Amazon')} ${inv.orderId}${inv.poNumber ? `   PO: ${inv.poNumber}` : ''}`, 50, y);
    doc.end();
  });
}

// Issued invoices never change, so a rendered PDF is reusable. Cached by a hash of the invoice document, bounded by bytes,
// and identical concurrent renders share one job.
import { createHash as _h } from 'node:crypto';
const PDF_MAX_BYTES = Number(process.env.PDF_CACHE_MB ?? 64) * 1048576, pdfCache = new Map(), pdfJobs = new Map(); let pdfBytes = 0;
export async function renderPdfCached(inv) {
  const key = _h('sha256').update(JSON.stringify(inv)).digest('hex'), hit = pdfCache.get(key);
  if (hit) { pdfCache.delete(key); pdfCache.set(key, hit); return hit; }
  if (pdfJobs.has(key)) return pdfJobs.get(key);
  const job = renderPdf(inv).then(buf => { pdfCache.set(key, buf); pdfBytes += buf.length; while (pdfBytes > PDF_MAX_BYTES && pdfCache.size > 1) { const k = pdfCache.keys().next().value; pdfBytes -= pdfCache.get(k).length; pdfCache.delete(k); } return buf; }).finally(() => pdfJobs.delete(key));
  pdfJobs.set(key, job); return job;
}
export const pdfCacheStats = () => ({ entries: pdfCache.size, bytes: pdfBytes });
