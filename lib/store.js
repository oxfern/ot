import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClassicLevel } from 'classic-level';
import { readAllRecordsFromDir } from './sstable.js';
import { deserializeOrExtractStrings, extractStrings } from './v8clone.js';

const ONETAB_EXTENSION_ID = 'chphlpgkkbolifaimnlloiipkdnihall';

// ──────────────────────────────────────────────────────────────────────────
// Discovery — find every OneTab-related LevelDB across Chrome profiles.
// OneTab has two storage backends:
//   1. chrome.storage.local  → "Local Extension Settings/<id>"  (legacy snapshot)
//   2. IndexedDB             → "IndexedDB/chrome-extension_<id>_0.indexeddb.leveldb"
// We surface both so the user can see all available data.
// ──────────────────────────────────────────────────────────────────────────

export function discoverStores() {
  const home = os.homedir();
  const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (!fs.existsSync(chromeRoot)) return [];

  const profiles = fs.readdirSync(chromeRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => n === 'Default' || /^Profile \d+$/.test(n));

  const stores = [];
  for (const profile of profiles) {
    const local = path.join(chromeRoot, profile, 'Local Extension Settings', ONETAB_EXTENSION_ID);
    if (fs.existsSync(local)) {
      stores.push({ profile, kind: 'local', path: local, size: dirSize(local) });
    }
    const idb = path.join(chromeRoot, profile, 'IndexedDB',
      `chrome-extension_${ONETAB_EXTENSION_ID}_0.indexeddb.leveldb`);
    if (fs.existsSync(idb)) {
      stores.push({ profile, kind: 'idb', path: idb, size: dirSize(idb) });
    }
  }
  return stores;
}

export function pickPrimaryStores(stores, profileFilter) {
  let candidates = stores;
  if (profileFilter) candidates = stores.filter(s => s.profile === profileFilter);
  // Heuristic: pick the largest store of each kind per profile (basically all of them).
  // We return ALL stores because we want maximum data extraction.
  return candidates;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

// Chrome holds an exclusive LOCK on every LevelDB while running. Copy first.
export function cloneToTemp(srcDir) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onetab-'));
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === 'LOCK') continue;
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(tmpRoot, entry.name));
  }
  return tmpRoot;
}

// ──────────────────────────────────────────────────────────────────────────
// Local Extension Settings — utf8/json keys + values.
// ──────────────────────────────────────────────────────────────────────────

export async function readLocalStore(srcDir) {
  const tmp = cloneToTemp(srcDir);
  const db = new ClassicLevel(tmp, { keyEncoding: 'utf8', valueEncoding: 'utf8' });
  await db.open();
  const out = [];
  for await (const [k, v] of db.iterator()) {
    out.push({ key: k, raw: v, parsed: tryParse(v) });
  }
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// IndexedDB — binary keys and values. Keys carry Chromium IDB framing,
// values are V8-serialized. OneTab serializes its state as a *string* of
// JSON inside IDB, so we can find and decode it heuristically.
// ──────────────────────────────────────────────────────────────────────────

// Chromium IndexedDB uses a custom comparator (idb_cmp1) that classic-level
// can't honor. We bypass the LevelDB engine entirely and parse the .ldb
// SSTable and .log files directly, then V8-deserialize each object-store
// value. Index entries (non-V8 IDB-encoded keys) are silently skipped.
export async function readIdbStore(srcDir) {
  const tmp = cloneToTemp(srcDir);
  const rawRecords = readAllRecordsFromDir(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });

  const out = [];
  for (const r of rawRecords) {
    if (!r.value || r.value.length < 5) continue;
    const res = deserializeOrExtractStrings(r.value);
    out.push({
      keyBuf: r.key,
      valueBuf: r.value,
      source: r.source,
      decoded: res.ok ? [res.value] : [],
      decodeError: res.ok ? null : res.error,
      strings: res.ok ? null : res.strings,
    });
  }
  return out;
}

// Pull every JSON-looking substring out of a binary IDB value.
// OneTab stores its tab groups as a JSON-encoded string, so V8's
// serializer just wraps it as a single string value. We scan the
// raw bytes for balanced JSON object/array literals.
function decodeIdbValue(buf) {
  if (!buf || !buf.length) return [];
  // Heuristic: walk bytes, when we see '{' or '[', try to extract a JSON
  // substring and parse it. Try the unescape-and-parse first, then plain.
  const text = buf.toString('utf8');
  const results = [];
  const tryEach = (s) => {
    for (const candidate of jsonSubstrings(s)) {
      const parsed = tryParse(candidate);
      if (parsed && (typeof parsed === 'object')) results.push(parsed);
    }
  };
  tryEach(text);
  // V8 sometimes stores strings as UTF-16LE. Try that view too.
  try {
    const utf16 = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf16le');
    if (utf16.includes('{')) tryEach(utf16);
  } catch { /* ignore */ }
  return results;
}

function* jsonSubstrings(s) {
  // Greedy balanced-brace scan. Skips characters inside strings.
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '[') continue;
    const end = findBalanced(s, i);
    if (end > i) {
      yield s.slice(i, end + 1);
      // Also try the variant where outer escaping is undone (state is often "{\"foo\":...}")
      // Find a quoted version starting one char before.
      if (s[i - 1] === '"') {
        const qEnd = findQuoteEnd(s, i - 1);
        if (qEnd > i) yield s.slice(i - 1, qEnd + 1);
      }
    }
  }
}

function findBalanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findQuoteEnd(s, qStart) {
  let esc = false;
  for (let i = qStart + 1; i < s.length; i++) {
    if (esc) { esc = false; continue; }
    if (s[i] === '\\') { esc = true; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
}

function tryParse(s) {
  if (typeof s !== 'string') return null;
  // Up to 2 levels of JSON-string-of-JSON unwrapping. OneTab does this in IDB
  // (and in legacy `stateMigratedToIDB`, which is JSON.stringify'd twice).
  let cur = s;
  for (let i = 0; i < 3; i++) {
    try {
      const next = JSON.parse(cur);
      if (typeof next === 'string') { cur = next; continue; }
      return next; // got an object/array/primitive
    } catch { return null; }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Schema-aware extraction — OneTab has two formats:
//   legacy: { state: [ {tabs: [...], createDate, isLocked, ...} ] }
//   modern: { tabGroups: [ {tabsMeta: [...], created, ...} ] }
// We accept either, plus best-effort field name fallbacks.
// ──────────────────────────────────────────────────────────────────────────

export function extractGroups(parsedValues) {
  // Phase 1: collect by-record types so we can both link the modern schema
  // (separate group + tab records linked via parentIds/childIds) and fall back
  // to the legacy schema (an array of groups with inline tabs).
  const modernGroups = new Map();  // id -> group record
  const modernTabs = new Map();    // id -> tab record
  const legacyGroups = [];

  for (const v of parsedValues) {
    if (!v) continue;
    walk(v, (val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (val.type === 'tab' && val.id) modernTabs.set(val.id, val);
        else if (val.type === 'group' && val.id) modernGroups.set(val.id, val);
      }
      if (Array.isArray(val) && looksLikeGroupArray(val)) {
        for (const g of val) legacyGroups.push(normalizeGroup(g));
      }
    });
  }

  // Phase 2: assemble — modern records take priority.
  const assembled = [];
  if (modernGroups.size) {
    for (const g of modernGroups.values()) {
      // System/root folders we don't surface as user groups.
      if (g.id === 'root' || g.id === 'quickList' || g.id === 'trash') continue;
      const tabs = [];
      const ids = Array.isArray(g.childIds) ? g.childIds : [];
      for (const tid of ids) {
        const t = modernTabs.get(tid);
        if (t) tabs.push({
          url: t.url ?? null,
          title: t.title ?? null,
          favIconUrl: t.favIconUrl ?? null,
          pinned: !!t.pinned,
          createDate: t.createDate ?? null,
          accessDate: t.accessDate ?? null,
        });
      }
      assembled.push({
        id: g.id,
        label: g.label ?? null,
        groupType: g.groupType ?? null,
        createDate: g.createDate ?? null,
        modifyDate: g.modifyDate ?? null,
        accessDate: g.accessDate ?? null,
        pinnedCount: g.pinnedCount ?? 0,
        shared: !!g.shared,
        shareKey: g.shareKey ?? null,
        isLocked: !!(g.isLocked ?? g.locked),
        isStarred: !!(g.isStarred ?? g.starred),
        tabs,
      });
    }
  }
  for (const g of legacyGroups) assembled.push(g);

  // Dedupe by id (same group might appear in both legacy snapshot and modern IDB).
  const seen = new Map();
  for (const g of assembled) {
    const key = g.id ?? JSON.stringify([g.label, g.createDate, g.tabs.length]);
    const prev = seen.get(key);
    if (!prev || prev.tabs.length < g.tabs.length) seen.set(key, g);
  }
  return [...seen.values()];
}

// Returns IDB metadata key/value pairs (OneTab stores settings like
// installDate, autoActionOnOpen, lastSeenVersion under this shape:
// { id: "<key>", value: <anything> }).
export function extractMetadata(parsedValues) {
  const meta = {};
  for (const v of parsedValues) {
    if (!v) continue;
    walk(v, (val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)
          && typeof val.id === 'string' && val.type === undefined && 'value' in val) {
        meta[val.id] = val.value;
      }
    });
  }
  return meta;
}

// Returns standalone tabs that didn't end up in a user-facing group (e.g.
// the ones currently in the "trash" system folder). Useful so the user
// sees every tab we found, even orphans.
export function extractOrphanTabs(parsedValues, groups) {
  const claimed = new Set();
  for (const g of groups) for (const t of g.tabs) if (t.url) claimed.add(`${g.id}::${t.url}`);

  const tabs = new Map();
  for (const v of parsedValues) {
    if (!v) continue;
    walk(v, (val) => {
      if (val && val.type === 'tab' && val.id && val.url) tabs.set(val.id, val);
    });
  }
  const orphans = [];
  const groupChildIds = new Set();
  for (const g of groups) groupChildIds.add(g.id);
  for (const t of tabs.values()) {
    const parents = Array.isArray(t.parentIds) ? t.parentIds : [];
    const inSurfacedGroup = parents.some(p => groupChildIds.has(p));
    if (!inSurfacedGroup) {
      orphans.push({
        url: t.url, title: t.title,
        parents,
        createDate: t.createDate,
        accessDate: t.accessDate,
      });
    }
  }
  return orphans;
}

function walk(v, visit) {
  visit(v);
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) walk(x, visit);
  }
}

function looksLikeGroupArray(arr) {
  if (!arr.length) return false;
  const first = arr[0];
  if (!first || typeof first !== 'object') return false;
  const hasTabs = Array.isArray(first.tabs) || Array.isArray(first.tabsMeta);
  const hasGroupShape = 'id' in first || 'createDate' in first || 'created' in first || 'label' in first;
  return hasTabs && hasGroupShape;
}

function normalizeGroup(g) {
  const tabsSrc = Array.isArray(g.tabsMeta) ? g.tabsMeta
                : Array.isArray(g.tabs) ? g.tabs : [];
  return {
    id: g.id ?? null,
    label: g.label ?? g.name ?? null,
    createDate: g.createDate ?? g.created ?? null,
    isLocked: !!(g.isLocked ?? g.locked),
    isStarred: !!(g.isStarred ?? g.starred),
    tabs: tabsSrc.map(t => ({
      url: t.url ?? null,
      title: t.title ?? null,
      favIconUrl: t.favIconUrl ?? null,
      pinned: !!t.pinned,
    })),
  };
}
