// CLI wrapper: node tools/backup.mjs [dbFile] [backupDir]
// The app also runs this automatically every 6 hours (see src/app.js); this is for manual runs.
import { backupNow } from '../src/backup.js';
const r = backupNow(process.argv[2] ?? process.env.DB_FILE ?? 'invoiceguard.db', process.argv[3]);
console.log(JSON.stringify(r));
