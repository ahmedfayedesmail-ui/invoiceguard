# Security preflight (all must pass before real files are loaded)

| # | Gate | How it is checked | Stop if |
|---|---|---|---|
| 1 | Vault is active | The page shows the unlock gate first and the status bar shows it unlocked; real storage shows only opaque encrypted records (automated in `test/vault-ui.test.js`; the seller can look in the browser's Application > IndexedDB tab: values are unreadable) | any readable seller text in storage |
| 2 | Correct route | The address ends in `/local/loop`. Not `/local` | the older page is open |
| 3 | Zero outbound network | Developer tools > Network stays empty after the page loaded while importing and reading findings. The page's content security policy also blocks fetch, XHR, beacons and form posts (tested) | any request after load |
| 4 | No sensitive values in logs | The code has no logging calls and error messages carry no file values (static scan and tests) | a console message that shows file content |
| 5 | Evidence bundle is plaintext | The "evidence bundle" download is a readable file by design, made by the seller's click. The seller stores it where they choose, or deletes it. The encrypted backup is the protected copy | seller does not want a plaintext file: do not create the bundle |
| 6 | Backup and deletion work | Seller tries: encrypted backup download, then delete one import (impact is shown first), then restore on a test vault if desired | restore or delete fails |
| 7 | Production gates closed | Public manual upload remains disabled on the live service; the loop page is served only where the page is enabled for the pilot; nothing is deployed for the pilot | any hosted upload route is open |

Stop immediately if seller data is found outside the protected workflow or if any unexpected network request appears. Tell the developer only that a gate failed, never the data.
