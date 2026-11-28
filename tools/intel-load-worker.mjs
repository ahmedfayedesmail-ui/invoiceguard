// Worker for tools/intel-load.mjs: seals one seller in its own process and reports time and peak memory. Synthetic data only.
import { DatabaseSync } from 'node:sqlite';
import { openIntelReader, sealSellerEvidence } from '../src/intel/store.js';
const [dbPath, sellerId] = process.argv.slice(2);
const writerDb = new DatabaseSync(dbPath, { timeout: 60000 }); const readerDb = openIntelReader(dbPath);
const t0 = performance.now();
try {
  const r = sealSellerEvidence({ writerDb, readerDb, sellerId });
  process.stdout.write(JSON.stringify({ sellerId, added: r.added, seq: r.head.sequence, hash: r.head.hash, ms: Math.round(performance.now() - t0), maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), coverage: r.coverage.status }));
} finally { readerDb.close(); writerDb.close(); }
