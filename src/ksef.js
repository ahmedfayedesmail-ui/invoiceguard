// FA(3) (KSeF) XML builder. Output is checked by tools/validate_xsd.py (schema-valid only).
// Held: this does NOT make PL an issuing country. The PL pack stays held until a verified rule is read.
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const m = n => Number(n).toFixed(2);
export function buildFa3(inv) {
  const need = ['sellerNip','sellerName','sellerAddr1','sellerAddr2','buyerName','buyerCountry','number','date','currency','lines'];
  for (const k of need) if (inv[k] === undefined || inv[k] === '' || inv[k] === null) throw new Error('FA3 missing field: ' + k);
  if (!/^\d{10}$/.test(inv.sellerNip)) throw new Error('FA3: seller NIP must be 10 digits');
  if (!Array.isArray(inv.lines) || !inv.lines.length) throw new Error('FA3: at least one line');
  const net = inv.lines.reduce((a, l) => a + l.qty * l.unitNet, 0);
  const rateOf = l => l.rate ?? inv.vatRate ?? 0;
  const buyerId = inv.buyerVatId
    ? `<KodUE>${esc(inv.buyerCountry)}</KodUE><NrVatUE>${esc(inv.buyerVatId.replace(/^[A-Z]{2}/, ''))}</NrVatUE>`
    : `<BrakID>1</BrakID>`;
  const rowXml = (l, n, before, rate = rateOf(l)) => `<FaWiersz><NrWierszaFa>${n}</NrWierszaFa><P_7>${esc(l.desc)}</P_7><P_8A>${esc(l.unit||'szt.')}</P_8A><P_8B>${l.qty}</P_8B><P_9A>${m(l.unitNet)}</P_9A><P_11>${m(l.qty*l.unitNet)}</P_11><P_12>${rate}</P_12>${before ? '<StanPrzed>1</StanPrzed>' : ''}</FaWiersz>`;
  const BASE = { 23: ['P_13_1','P_14_1'], 8: ['P_13_2','P_14_2'], 5: ['P_13_3','P_14_3'] };
  const allLines = [...inv.lines, ...((inv.corrects && Array.isArray(inv.corrects.before)) ? inv.corrects.before : [])];
  for (const l of allLines) if (!BASE[rateOf(l)]) throw new Error('FA3: only 23/8/5 rates are built; other rates held, not guessed');
  const c = inv.corrects;
  if (c) for (const k of ['number','date','reason']) if (!c[k]) throw new Error('FA3 correction missing field: corrects.' + k);
  if (c && c.ksefNumber && !/^\d{10}-\d{8}-[0-9A-F]{12}-[0-9A-F]{2}$/.test(c.ksefNumber)) throw new Error('FA3: malformed KSeF number');
  const before = c && c.before;
  if (before && (!Array.isArray(before) || !before.length)) throw new Error('FA3 correction: corrects.before must list the original lines');
  if (c && c.effect !== undefined && ![1, 2].includes(c.effect)) throw new Error('FA3 correction: corrects.effect must be 1 or 2');
  const rows = before
    ? before.map((l, i) => rowXml(l, i + 1, true)).join('') + inv.lines.map((l, i) => rowXml(l, before.length + i + 1, false)).join('')
    : inv.lines.map((l, i) => rowXml(l, i + 1, false)).join('');
  const sums = {};
  for (const l of inv.lines) sums[rateOf(l)] = (sums[rateOf(l)] || 0) + l.qty * l.unitNet;
  if (before) for (const l of before) sums[rateOf(l)] = (sums[rateOf(l)] || 0) - l.qty * l.unitNet;
  let gross = 0, totals = '';
  for (const r of [23, 8, 5]) {
    if (sums[r] === undefined) continue;
    const dn = Math.round(sums[r] * 100) / 100, dv = Math.round(dn * r) / 100;
    totals += `<${BASE[r][0]}>${m(dn)}</${BASE[r][0]}><${BASE[r][1]}>${m(dv)}</${BASE[r][1]}>`;
    gross += dn + dv;
  }
  const kind = c
    ? `<RodzajFaktury>KOR</RodzajFaktury><PrzyczynaKorekty>${esc(c.reason)}</PrzyczynaKorekty><TypKorekty>${c.effect || 2}</TypKorekty><DaneFaKorygowanej><DataWystFaKorygowanej>${c.date}</DataWystFaKorygowanej><NrFaKorygowanej>${esc(c.number)}</NrFaKorygowanej>${c.ksefNumber ? `<NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>${c.ksefNumber}</NrKSeFFaKorygowanej>` : '<NrKSeFN>1</NrKSeFN>'}</DaneFaKorygowanej>`
    : '<RodzajFaktury>VAT</RodzajFaktury>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>${new Date().toISOString().replace(/\.\d+Z$/,'Z')}</DataWytworzeniaFa><SystemInfo>InvoiceGuard</SystemInfo></Naglowek><Podmiot1><DaneIdentyfikacyjne><NIP>${inv.sellerNip}</NIP><Nazwa>${esc(inv.sellerName)}</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>${esc(inv.sellerAddr1)}</AdresL1><AdresL2>${esc(inv.sellerAddr2)}</AdresL2></Adres></Podmiot1><Podmiot2><DaneIdentyfikacyjne>${buyerId}<Nazwa>${esc(inv.buyerName)}</Nazwa></DaneIdentyfikacyjne><JST>2</JST><GV>2</GV></Podmiot2><Fa><KodWaluty>${esc(inv.currency)}</KodWaluty><P_1>${inv.date}</P_1><P_2>${esc(inv.number)}</P_2>${totals}<P_15>${m(gross)}</P_15><Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>${kind}${rows}</Fa></Faktura>`;
}
