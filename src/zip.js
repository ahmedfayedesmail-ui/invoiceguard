// Minimal ZIP writer (store, no compression). PDFs are already compressed. No dependencies.
import { crc32 } from 'node:zlib';
const DOS_MIN = Date.UTC(1980, 0, 1), DOS_MAX = Date.UTC(2107, 11, 31, 23, 59, 58);
/**
 * The timestamp a pack's archive carries: the newest issue date inside it. The same pack therefore
 * zips to the same bytes on every re-export, instead of embedding the moment of the download.
 */
export function packStamp(rows) {
  let t = 0;
  for (const r of rows) { const v = Date.parse(String(r?.issued_at ?? '')); if (Number.isFinite(v) && v > t) t = v; }
  return new Date(t || DOS_MIN);
}
export function makeZip(files, date = new Date()) { // files: [{ name, data: Buffer }]
  const parts = [], central = []; let off = 0;
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }, u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  // Fixed DOS timestamp: read in UTC so the archive does not depend on the server's time zone, and clamped
  // into the DOS range so an odd date can never write a wrapped-around timestamp.
  const at = date instanceof Date && Number.isFinite(date.getTime()) ? new Date(Math.min(Math.max(date.getTime(), DOS_MIN), DOS_MAX)) : new Date(DOS_MIN);
  const dosTime = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1), dosDate = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data), crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
    parts.push(local, data);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name]));
    off += local.length + data.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(off), u16(0)]);
}
