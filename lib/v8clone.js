// Minimal V8 structured-clone deserializer — enough to handle the values
// Chromium's IndexedDB stores for the OneTab extension.
//
// Format references:
//   - V8: src/objects/value-serializer.cc (SerializationTag enum)
//   - Blink: blink/renderer/bindings/core/v8/serialization/serialization_tag.h
//
// We support: objects, dense arrays, sparse arrays, strings (1-byte, UTF-8,
// UTF-16), numbers (int32, uint32, double), booleans, null, undefined,
// dates, and object back-references. Unsupported tags throw.

const TAGS = {
  kVersion: 0xFF,                  //
  kPadding: 0x00,                  // '\0'
  kVerifyObjectCount: 0x3F,        // '?'
  kTheHole: 0x2D,                  // '-'
  kUndefined: 0x5F,                // '_'
  kNull: 0x30,                     // '0'
  kTrue: 0x54,                     // 'T'
  kFalse: 0x46,                    // 'F'
  kInt32: 0x49,                    // 'I'
  kUint32: 0x55,                   // 'U'
  kDouble: 0x4E,                   // 'N'
  kBigInt: 0x5A,                   // 'Z'
  kUtf8String: 0x53,               // 'S'
  kOneByteString: 0x22,            // '"'
  kTwoByteString: 0x63,            // 'c'
  kObjectReference: 0x5E,          // '^'
  kBeginJSObject: 0x6F,            // 'o'
  kEndJSObject: 0x7B,              // '{'
  kBeginSparseJSArray: 0x61,       // 'a'
  kEndSparseJSArray: 0x40,         // '@'
  kBeginDenseJSArray: 0x41,        // 'A'
  kEndDenseJSArray: 0x24,          // '$'
  kDate: 0x44,                     // 'D'
  kTrueObject: 0x79,               // 'y'
  kFalseObject: 0x78,              // 'x'
  kNumberObject: 0x6E,             // 'n'
  kStringObject: 0x73,             // 's'
  kRegExp: 0x52,                   // 'R'
};

// Blink + V8 wrapper tags
const BLINK_TRAILER_OFFSET = 0xFE;
const V8_VERSION_TAG       = 0xFF;

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.objects = []; // for back-references
  }

  eof() { return this.pos >= this.buf.length; }

  readByte() {
    if (this.eof()) throw new Error('unexpected EOF');
    return this.buf[this.pos++];
  }

  peekByte() { return this.buf[this.pos]; }

  readVarint() {
    let result = 0, shift = 0;
    for (;;) {
      const b = this.readByte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('varint too long');
    }
    return result >>> 0;
  }

  readZigzag() {
    const u = this.readVarint();
    return (u >>> 1) ^ -(u & 1);
  }

  readDouble() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readBytes(n) {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function deserialize(buf) {
  const r = new Reader(buf);
  skipEnvelope(r);
  return readValue(r);
}

// Chromium IDB object-store values are encoded as:
//   varint(leveldb_version)
//   V8_VERSION_TAG (0xff) varint(blink_wrapper_version)
//   [if blink_wrapper_version >= 2: 0xfe + 8-byte trailer offset + 4-byte trailer size]
//   V8_VERSION_TAG (0xff) varint(v8_version)
//   <V8 structured-clone value bytes>
//
// We skip every wrapper byte and land on the V8 value tag.
function skipEnvelope(r) {
  // LevelDB-level varint version prefix (always present).
  r.readVarint();

  // First V8 version tag — this is actually the Blink wrapper version tag.
  if (r.peekByte() === V8_VERSION_TAG) {
    r.readByte();
    const blinkVer = r.readVarint();
    if (blinkVer >= 2 && r.peekByte() === BLINK_TRAILER_OFFSET) {
      r.readByte();
      r.pos += 12; // 8-byte trailer offset + 4-byte trailer size
    }
  }

  // Second V8 version tag — the actual V8 serializer version.
  if (r.peekByte() === V8_VERSION_TAG) {
    r.readByte();
    r.readVarint();
  }
}

function readValue(r) {
  while (true) {
    const tag = r.readByte();
    switch (tag) {
      case TAGS.kPadding:           continue;
      case TAGS.kVerifyObjectCount: r.readVarint(); continue;
      case TAGS.kUndefined:         return undefined;
      case TAGS.kNull:              return null;
      case TAGS.kTrue:              return true;
      case TAGS.kFalse:             return false;
      case TAGS.kInt32:             return r.readZigzag();
      case TAGS.kUint32:            return r.readVarint();
      case TAGS.kDouble:            return r.readDouble();
      case TAGS.kOneByteString: {
        const len = r.readVarint();
        return r.readBytes(len).toString('latin1');
      }
      case TAGS.kUtf8String: {
        const len = r.readVarint();
        return r.readBytes(len).toString('utf8');
      }
      case TAGS.kTwoByteString: {
        const len = r.readVarint();
        const bytes = r.readBytes(len);
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf16le');
      }
      case TAGS.kDate: {
        const ms = r.readDouble();
        return new Date(ms);
      }
      case TAGS.kBeginJSObject: {
        const obj = {};
        r.objects.push(obj);
        while (r.peekByte() !== TAGS.kEndJSObject) {
          const key = readValue(r);
          const val = readValue(r);
          obj[String(key)] = val;
        }
        r.readByte();
        r.readVarint(); // num properties
        return obj;
      }
      case TAGS.kBeginDenseJSArray: {
        const len = r.readVarint();
        const arr = new Array(len);
        r.objects.push(arr);
        for (let i = 0; i < len; i++) arr[i] = readValue(r);
        // After elements: optional sparse properties. They appear as
        // (key,value) pairs until kEndDenseJSArray.
        while (r.peekByte() !== TAGS.kEndDenseJSArray) {
          const key = readValue(r);
          const val = readValue(r);
          arr[String(key)] = val;
        }
        r.readByte();
        r.readVarint(); // properties_written
        r.readVarint(); // length
        return arr;
      }
      case TAGS.kBeginSparseJSArray: {
        const len = r.readVarint();
        const arr = new Array(len);
        r.objects.push(arr);
        while (r.peekByte() !== TAGS.kEndSparseJSArray) {
          const key = readValue(r);
          const val = readValue(r);
          arr[String(key)] = val;
        }
        r.readByte();
        r.readVarint(); // properties_written
        r.readVarint(); // length
        return arr;
      }
      case TAGS.kObjectReference: {
        const id = r.readVarint();
        return r.objects[id];
      }
      case TAGS.kRegExp: {
        const pattern = readValue(r);
        const flags = r.readVarint();
        return { __regexp: pattern, __flags: flags };
      }
      case TAGS.kStringObject: {
        return new String(readValue(r)).toString();
      }
      case TAGS.kNumberObject: return r.readDouble();
      case TAGS.kTrueObject:   return true;
      case TAGS.kFalseObject:  return false;
      case TAGS.kBigInt: {
        const bitfield = r.readVarint();
        const byteLength = bitfield >> 1;
        r.readBytes(byteLength);
        return null; // we don't need bigints
      }
      default:
        // Unknown tag — bail. Caller will fall back to string extraction.
        throw new Error(`unknown V8 tag 0x${tag.toString(16)} at offset ${r.pos - 1}`);
    }
  }
}

// Best-effort: try to deserialize, otherwise pull every embedded string
// (one-byte/utf8/utf16) so we still capture URLs and titles.
export function deserializeOrExtractStrings(buf) {
  try {
    const v = deserialize(buf);
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, error: err.message, strings: extractStrings(buf) };
  }
}

export function extractStrings(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const tag = buf[i];
    if (tag === TAGS.kOneByteString || tag === TAGS.kUtf8String) {
      const { len, consumed } = peekVarint(buf, i + 1);
      if (len > 0 && len < 4096 && i + 1 + consumed + len <= buf.length) {
        const slice = buf.subarray(i + 1 + consumed, i + 1 + consumed + len);
        const s = tag === TAGS.kOneByteString ? slice.toString('latin1') : slice.toString('utf8');
        if (isPlausibleString(s)) {
          out.push(s);
          i = i + 1 + consumed + len - 1;
        }
      }
    } else if (tag === TAGS.kTwoByteString) {
      const { len, consumed } = peekVarint(buf, i + 1);
      if (len > 0 && len < 8192 && i + 1 + consumed + len <= buf.length) {
        const slice = buf.subarray(i + 1 + consumed, i + 1 + consumed + len);
        const s = Buffer.from(slice).toString('utf16le');
        if (isPlausibleString(s)) {
          out.push(s);
          i = i + 1 + consumed + len - 1;
        }
      }
    }
  }
  return out;
}

function peekVarint(buf, off) {
  let result = 0, shift = 0, consumed = 0;
  while (off + consumed < buf.length) {
    const b = buf[off + consumed++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { len: result >>> 0, consumed };
    shift += 7;
    if (shift > 35) return { len: 0, consumed: 0 };
  }
  return { len: 0, consumed: 0 };
}

function isPlausibleString(s) {
  if (!s) return false;
  // Filter out junk: must be mostly printable.
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c < 127) printable++;
    else if (c === 9 || c === 10 || c === 13) printable++;
  }
  return printable / s.length > 0.8;
}
