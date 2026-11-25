// Runs the no-signup sample on /sample and renders the result.
(function () {
  const out = document.getElementById('out'), btn = document.getElementById('run');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const eur = (n) => Number(n).toFixed(2).replace('.', ',') + ' €';
  const nextStep = (reason) => {
    if (/buyer VAT invalid/i.test(reason || '')) return 'What to do: the buyer\'s VAT number did not pass the EU check. Ask the buyer for the right one, or issue without a VAT ID.';
    return 'What to do: we are not sure about this one, so we hold it instead of guessing.';
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.innerHTML = '<p class="mut">Running the checks. The EU VAT lookup can take a few seconds.</p>';
    try {
      const r = await fetch('/api/sample/run'), d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Something went wrong. Try again in a minute.');
      const cards = d.shipments.map((s) => {
        const held = s.status === 'held';
        const pill = held ? '<span class="pill p-held">Held</span>' : '<span class="pill p-uploaded">Invoice ready</span>';
        return '<div class="card"><p><b>Order:</b> ' + esc(s.order_id) + '<br><b>Buyer:</b> ' + esc(s.buyer) + '<br>' +
          (s.buyer_vat ? '<b>Buyer VAT:</b> ' + esc(s.buyer_vat) + '<br>' : '') +
          '<b>Total:</b> ' + eur(s.total) + '<br><b>Status:</b> ' + pill + '</p>' +
          (held && s.reason ? '<p class="err">' + esc(s.reason) + '</p><p>' + esc(nextStep(s.reason)) + '</p>' : '') + '</div>';
      }).join('');
      const invs = d.invoices.map((i) =>
        '<div class="card"><p><b>Invoice ' + esc(i.number) + '</b> · ' + eur(i.total) + '</p>' +
        '<p><a class="btn" href="/api/sample/pdf/' + encodeURIComponent(i.number) + '" target="_blank" rel="noopener">Open the invoice PDF</a></p></div>').join('');
      out.innerHTML = '<h2>Three orders, checked</h2>' + cards +
        '<h2>The invoices it built</h2>' + invs +
        '<p class="mut">All of this is made-up sample data. Nothing was stored and nothing was sent to Amazon.</p>' +
        '<p><a class="btn" href="/app">Try it with your own orders</a></p>';
    } catch (e) {
      out.innerHTML = '<p class="err">' + esc(e.message) + '</p>';
      btn.disabled = false;
    }
  });
})();
