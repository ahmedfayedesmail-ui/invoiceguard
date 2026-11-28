import { DatabaseSync } from 'node:sqlite';
import { openIntelReader, sealSellerEvidence } from '../src/intel/store.js';

const [dbPath, sellerId] = process.argv.slice(2);
if (!dbPath || !sellerId) throw new Error('Usage: node intel-seal-worker.mjs <db-path> <seller-id>');
const writerDb = new DatabaseSync(dbPath, { timeout: 5000 });
const readerDb = openIntelReader(dbPath);
try {
  const result = sealSellerEvidence({ writerDb, readerDb, sellerId });
  process.stdout.write(JSON.stringify({ added: result.added, head: result.head }));
} finally {
  readerDb.close();
  writerDb.close();
}
