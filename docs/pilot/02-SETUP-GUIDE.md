# Local pilot setup guide (seller's machine)

1. Use a current desktop Chrome, Edge or Firefox on a computer you control and trust. Close browser extensions you do not need (extensions can read pages). A private or guest window is not suitable: it forgets the vault when it closes.
2. Open the InvoiceGuard `/local/loop` page. The older `/local` page is not for seller documents.
3. Create the vault: pick a password of at least 10 characters. A recovery key is shown once. Write it down on paper and keep it somewhere safe. Tick the box only after you have saved it. We never see either.
4. Set the auto-lock (5, 15 or 60 minutes) and keep retention on "keep" unless you decide otherwise. Retention is never switched on for you.
5. Get the two files for ONE period of at most 92 days:
   - the Amazon VAT invoice data report (VIDR) with **all statuses**, created after your last invoice uploads;
   - the invoice export of your accounting system for the same period, complete, with the Amazon documents identifiable.
6. For each file the page runs the preflight before storing it (procedure step 2). Fix every FAIL it reports; acknowledge each WARN only if you understand it.
7. Open the browser developer tools, Network tab, before importing, and keep it visible. It must show no requests while you load files. If any request appears after the page loaded, stop, do not continue, and tell us.
8. Backup: use "Download encrypted backup" only to a place you control. It is encrypted with your vault, and restoring needs your password.
