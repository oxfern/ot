// Minimal reader for the LevelDB on-disk formats that OneTab/Chromium use.
// Goal: extract every key/value pair regardless of the comparator named in
// the MANIFEST. We bypass the comparator entirely by reading SSTables (.ldb)
// and log files (.log) directly.
//
// Refs:
//   - SSTable format: https://github.com/google/leveldb/blob/main/doc/table_format.md
//   - Log format:     https://github.com/google/leveldb/blob/main/doc/log_format.md

import fs from 'node:fs';
import snappy from 'snappy';

// LevelDB SSTable magic = 0xdb4775248b80fb57 (little-endian on disk)
const SST_MAGIC_LO = 0x8b80fb57;
const SST_MAGIC_HI = 0xdb477524;

const COMP_NONE = 0;
const COMP_SNAPPY = 1;

// ──────────────────────────────────────────────────────────────────────────
// Varint
// ──────────────────────────────────────────────────────────────────────────

function readVarint(buf, off) {
  let result = 0, shift = 0;
  for (;;) {
    const b = buf[off++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  }
  return { value: result >>> 0, next: off };
}

function readVarint64(buf, off) {
  // OneTab values aren't > 2^31, but be safe.
  let lo = 0, hi = 0, shift = 0;
  for (;;) {
    const b = buf[off++];
    if (shift < 28) {
      lo |= (b & 0x7f) << shift;
    } else if (shift < 32) {
      lo |= (b & 0x7f) << shift;
      hi |= (b & 0x7f) >>> (32 - shift);
    } else {
      hi |= (b & 0x7f) << (shift - 32);
    }
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 70) throw new Error('varint64 too long');
  }
  return { lo: lo >>> 0, hi: hi >>> 0, next: off };
}

// ──────────────────────────────────────────────────────────────────────────
// SSTable (.ldb)
// ──────────────────────────────────────────────────────────────────────────

export function readSSTable(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 48) return [];

  // Footer: metaindex_handle, index_handle, 8-byte magic. Padded to 48 bytes.
  const footerStart = buf.length - 48;
  const magicLo = buf.readUInt32LE(footerStart + 40);
  const magicHi = buf.readUInt32LE(footerStart + 44);
  if (magicLo !== SST_MAGIC_LO || magicHi !== SST_MAGIC_HI) {
    return []; // not a valid SSTable
  }

  // Skip metaindex; read index handle (offset, size varints).
  let p = footerStart;
  // metaindex handle
  const m1 = readVarint(buf, p); p = m1.next;
  const m2 = readVarint(buf, p); p = m2.next;
  // index handle
  const idxOff = readVarint(buf, p); p = idxOff.next;
  const idxSz = readVarint(buf, p);

  const indexBlock = readBlock(buf, idxOff.value, idxSz.value);
  const pairs = [];
  for (const entry of iterateBlock(indexBlock)) {
    // entry.value is a BlockHandle (offset, size varints)
    const h1 = readVarint(entry.value, 0);
    const h2 = readVarint(entry.value, h1.next);
    const dataBlock = readBlock(buf, h1.value, h2.value);
    for (const kv of iterateBlock(dataBlock)) {
      pairs.push({ key: kv.key, value: kv.value });
    }
  }
  return pairs;
}

function readBlock(buf, offset, size) {
  // Block layout on disk: <size bytes of block data><1 byte compression type><4 byte CRC>
  const compType = buf[offset + size];
  const raw = buf.subarray(offset, offset + size);
  if (compType === COMP_NONE) return Buffer.from(raw);
  if (compType === COMP_SNAPPY) return snappy.uncompressSync(raw);
  throw new Error(`unsupported block compression: ${compType}`);
}

function* iterateBlock(block) {
  // Block: <records...><restarts (uint32[])><num_restarts uint32>
  const numRestarts = block.readUInt32LE(block.length - 4);
  const restartsStart = block.length - 4 - numRestarts * 4;

  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < restartsStart) {
    const shared = readVarint(block, pos); pos = shared.next;
    const unshared = readVarint(block, pos); pos = unshared.next;
    const vlen = readVarint(block, pos); pos = vlen.next;
    const keyTail = block.subarray(pos, pos + unshared.value); pos += unshared.value;
    const value = block.subarray(pos, pos + vlen.value); pos += vlen.value;
    const key = Buffer.concat([prevKey.subarray(0, shared.value), keyTail]);
    yield { key, value };
    prevKey = key;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Log file (.log)  — sequence of 32K blocks, each with framed records.
// Each WriteBatch payload begins with: seq(8) + count(4), then operations:
//   type(1) + varint(klen) + key + [varint(vlen) + value if put]
// ──────────────────────────────────────────────────────────────────────────

const BLOCK_SIZE = 32768;
const HEADER_SIZE = 7; // 4 CRC + 2 length + 1 type
const REC_FULL = 1, REC_FIRST = 2, REC_MIDDLE = 3, REC_LAST = 4;

export function readLog(filePath) {
  const buf = fs.readFileSync(filePath);
  const records = [];
  let fragmentParts = [];

  let pos = 0;
  while (pos + HEADER_SIZE <= buf.length) {
    const blockEnd = Math.min(pos + (BLOCK_SIZE - (pos % BLOCK_SIZE)), buf.length);
    while (pos + HEADER_SIZE <= blockEnd) {
      const length = buf.readUInt16LE(pos + 4);
      const type = buf[pos + 6];
      const dataStart = pos + HEADER_SIZE;
      if (type === 0 || length === 0) { pos = blockEnd; break; } // padding / end of block
      const data = buf.subarray(dataStart, dataStart + length);
      pos = dataStart + length;

      if (type === REC_FULL) {
        records.push(Buffer.from(data));
      } else if (type === REC_FIRST) {
        fragmentParts = [Buffer.from(data)];
      } else if (type === REC_MIDDLE) {
        fragmentParts.push(Buffer.from(data));
      } else if (type === REC_LAST) {
        fragmentParts.push(Buffer.from(data));
        records.push(Buffer.concat(fragmentParts));
        fragmentParts = [];
      }
    }
  }

  // Parse each WriteBatch.
  const pairs = [];
  for (const wb of records) {
    if (wb.length < 12) continue;
    let p = 12; // skip seq(8) + count(4)
    while (p < wb.length) {
      const type = wb[p++];
      if (type !== 1 && type !== 0) break; // 1 = put, 0 = del
      const klen = readVarint(wb, p); p = klen.next;
      const key = wb.subarray(p, p + klen.value); p += klen.value;
      let value = Buffer.alloc(0);
      if (type === 1) {
        const vlen = readVarint(wb, p); p = vlen.next;
        value = wb.subarray(p, p + vlen.value); p += vlen.value;
      }
      pairs.push({ key, value, deletion: type === 0 });
    }
  }
  return pairs;
}

// ──────────────────────────────────────────────────────────────────────────
// Convenience: read every (key, value) from a Chromium IDB LevelDB by
// scanning .ldb and .log files directly — skipping the comparator check.
// ──────────────────────────────────────────────────────────────────────────

export function readAllRecordsFromDir(dir) {
  const all = [];
  for (const name of fs.readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (name.endsWith('.ldb')) {
      try {
        for (const p of readSSTable(full)) all.push({ source: name, ...p });
      } catch (err) {
        console.error(`! ${name}: ${err.message}`);
      }
    } else if (name.endsWith('.log')) {
      try {
        for (const p of readLog(full)) all.push({ source: name, ...p });
      } catch (err) {
        console.error(`! ${name}: ${err.message}`);
      }
    }
  }
  return all;
}
