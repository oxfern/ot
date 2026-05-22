#!/usr/bin/env node
import fs from 'node:fs';
import {
  discoverStores, pickPrimaryStores,
  readLocalStore, readIdbStore,
  extractGroups, extractMetadata, extractOrphanTabs,
} from '../lib/store.js';
import { summarize, fmtDate, bar, trunc, hostOf } from '../lib/report.js';

const COMMANDS = ['stats', 'raw', 'groups', 'tabs', 'domains', 'export', 'paths', 'meta', 'orphans', 'help'];

function usage() {
  console.log(`onetab — read your OneTab Chrome extension data from disk

USAGE
  onetab [command] [--profile <name>] [--kind local|idb] [--path <dir>]

COMMANDS
  stats      (default)  Big-picture summary: counts, dates, top domains
  paths                 Show every OneTab LevelDB store on disk (local + IDB)
  raw                   Dump every LevelDB record across discovered stores
  groups                List every saved tab group
  tabs                  List every saved tab (title + URL)
  domains               Top domains across all saved tabs
  meta                  OneTab extension settings (install date, etc.)
  orphans               Tabs not in any visible group (e.g. trash)
  export                Emit everything we found as JSON on stdout
  help                  This message

FLAGS
  --profile <name>      Filter by Chrome profile (Default, Profile 1, …)
  --kind local|idb      Restrict to one storage backend
  --path <dir>          Read a specific LevelDB directory directly
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] && !args[0].startsWith('--') ? args[0] : 'stats');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();
  if (!COMMANDS.includes(cmd)) {
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }

  const flags = parseFlags(args);
  const stores = resolveStores(flags);
  if (!stores.length) {
    console.error('No OneTab storage found. Pass --path to read a LevelDB directory directly.');
    process.exit(1);
  }

  if (cmd === 'paths') return cmdPaths(stores);

  // Read all stores, merge results.
  const readings = [];
  for (const s of stores) {
    try {
      const records = s.kind === 'idb' ? await readIdbStore(s.path) : await readLocalStore(s.path);
      readings.push({ store: s, records });
    } catch (err) {
      console.error(`! ${s.profile}/${s.kind} unreadable: ${err.message}`);
    }
  }

  if (cmd === 'raw') return cmdRaw(readings);

  const parsedValues = collectParsed(readings);
  const groups = extractGroups(parsedValues);
  const meta = extractMetadata(parsedValues);
  const orphans = extractOrphanTabs(parsedValues, groups);

  switch (cmd) {
    case 'stats':   return cmdStats(readings, groups, meta, orphans);
    case 'groups':  return cmdGroups(groups);
    case 'tabs':    return cmdTabs(groups);
    case 'domains': return cmdDomains(groups);
    case 'meta':    return cmdMeta(meta);
    case 'orphans': return cmdOrphans(orphans);
    case 'export':  return cmdExport(groups, meta, orphans, readings);
  }
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--profile') flags.profile = args[++i];
    else if (a === '--kind') flags.kind = args[++i];
    else if (a === '--path') flags.path = args[++i];
  }
  return flags;
}

function resolveStores(flags) {
  if (flags.path) {
    const kind = flags.kind ?? (flags.path.includes('indexeddb') ? 'idb' : 'local');
    return [{ profile: '(custom)', kind, path: flags.path, size: 0 }];
  }
  let all = discoverStores();
  if (flags.kind) all = all.filter(s => s.kind === flags.kind);
  return pickPrimaryStores(all, flags.profile);
}

function collectParsed(readings) {
  const values = [];
  for (const r of readings) {
    for (const rec of r.records) {
      if (rec.parsed) values.push(rec.parsed);
      if (rec.decoded) values.push(...rec.decoded);
    }
  }
  return values;
}

function cmdPaths(stores) {
  if (!stores.length) return console.log('(no stores)');
  for (const s of stores) {
    console.log(`${s.profile.padEnd(12)}  ${s.kind.padEnd(5)}  ${humanSize(s.size).padStart(8)}  ${s.path}`);
  }
}

function cmdRaw(readings) {
  for (const r of readings) {
    console.log(`\n══ ${r.store.profile} / ${r.store.kind} ══════════════════════════════════════════`);
    console.log(`   ${r.store.path}`);
    console.log(`   ${r.records.length} record(s)`);

    if (r.store.kind === 'local') {
      console.log();
      for (const rec of r.records) {
        console.log(`── key: ${JSON.stringify(rec.key)}  (${Buffer.byteLength(rec.raw, 'utf8')} bytes)`);
        console.log(`   parsed: ${describeValue(rec.parsed)}`);
        const preview = rec.raw.length > 300 ? rec.raw.slice(0, 300) + ' …' : rec.raw;
        console.log(`   raw:    ${preview}\n`);
      }
      continue;
    }

    const decoded = r.records.filter(x => x.decoded.length);
    const skipped = r.records.length - decoded.length;
    console.log(`   ${decoded.length} V8-decoded value(s), ${skipped} non-value records (indexes, metadata)\n`);

    for (const rec of decoded.slice(0, 12)) {
      const v = rec.decoded[0];
      const keyHex = rec.keyBuf.toString('hex').slice(0, 40);
      console.log(`── ${rec.source}  key ${rec.keyBuf.length}B (${keyHex}…)  value ${rec.valueBuf.length}B`);
      console.log(`   shape: ${describeValue(v)}`);
      if (v && typeof v === 'object') {
        const preview = JSON.stringify(v).slice(0, 220);
        console.log(`   ${preview}${preview.length === 220 ? '…' : ''}`);
      }
      console.log();
    }
    if (decoded.length > 12) console.log(`   … and ${decoded.length - 12} more decoded value(s)\n`);
  }
}

function describeValue(v) {
  if (v == null) return 'null/unparseable';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return `object{${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}`;
  }
  return `${typeof v}: ${String(v).slice(0, 80)}`;
}

function printableSlice(buf, n) {
  let s = '';
  for (let i = 0; i < Math.min(n, buf.length); i++) {
    const b = buf[i];
    s += (b >= 32 && b < 127) ? String.fromCharCode(b) : '·';
  }
  return s;
}

function humanSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function cmdStats(readings, groups, meta, orphans) {
  console.log(`OneTab storage`);
  for (const r of readings) {
    const decoded = r.records.filter(x => (x.decoded?.length ?? 0) > 0).length;
    const tail = r.store.kind === 'idb' ? `  (${decoded} V8-decoded)` : '';
    console.log(`  ${r.store.profile.padEnd(12)}  ${r.store.kind.padEnd(5)}  ${r.records.length} record(s)  ${humanSize(r.store.size)}${tail}`);
  }
  console.log();

  const s = summarize(groups);
  console.log(`Saved data`);
  console.log(`  groups          ${s.totalGroups}`);
  console.log(`  tabs            ${s.totalTabs}`);
  console.log(`  unique domains  ${s.uniqueDomains}`);
  console.log(`  median group    ${s.median} tabs`);
  console.log(`  named groups    ${s.named}`);
  console.log(`  locked groups   ${s.locked}`);
  console.log(`  starred groups  ${s.starred}`);
  console.log(`  pinned tabs     ${s.pinned}`);
  console.log(`  w/ favicon      ${s.withFavicon}\n`);

  console.log(`Timeline`);
  console.log(`  oldest group : ${fmtDate(s.oldest)}`);
  console.log(`  newest group : ${fmtDate(s.newest)}\n`);

  if (s.largest.length) {
    console.log(`Largest groups`);
    const max = s.largest[0].count;
    for (const g of s.largest) {
      console.log(`  ${String(g.count).padStart(4)}  ${bar(g.count, max, 18)}  ${trunc(g.label || '(unnamed)', 30).padEnd(30)}  ${fmtDate(g.date)}`);
    }
    console.log();
  }

  if (s.topDomains.length) {
    console.log(`Top domains`);
    const max = s.topDomains[0][1];
    for (const [d, n] of s.topDomains) {
      console.log(`  ${String(n).padStart(4)}  ${bar(n, max, 18)}  ${d}`);
    }
    console.log();
  }

  if (orphans.length) {
    console.log(`Other tabs found`);
    console.log(`  orphan tabs (not in a visible group, e.g. trash): ${orphans.length}\n`);
  }

  const metaKeys = Object.keys(meta);
  if (metaKeys.length) {
    console.log(`Extension metadata (${metaKeys.length} key${metaKeys.length === 1 ? '' : 's'})`);
    const interesting = ['installDate', 'lastSeenVersion', 'autoActionOnOpen', 'displayMode', 'theme'];
    for (const k of interesting) {
      if (k in meta) {
        let v = meta[k];
        if (k === 'installDate' && typeof v === 'number') v = `${fmtDate(new Date(v))} (${v})`;
        console.log(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
      }
    }
  }
}

function cmdGroups(groups) {
  for (const g of groups) {
    const flags = `${g.isLocked ? 'L' : '-'}${g.isStarred ? '★' : '-'}`;
    console.log(`${flags}  ${String(g.tabs.length).padStart(4)} tabs  ${fmtDate(g.createDate)}  ${trunc(g.label || '(unnamed)', 60)}`);
  }
  console.log(`\n${groups.length} group(s)`);
}

function cmdTabs(groups) {
  let n = 0;
  for (const g of groups) {
    for (const t of g.tabs) {
      n++;
      console.log(`${trunc(t.title || '(no title)', 70).padEnd(70)}  ${t.url ?? ''}`);
    }
  }
  console.log(`\n${n} tab(s)`);
}

function cmdDomains(groups) {
  const counts = new Map();
  for (const g of groups) for (const t of g.tabs) {
    const h = hostOf(t.url);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] ?? 0;
  for (const [d, n] of sorted) {
    console.log(`${String(n).padStart(5)}  ${bar(n, max, 24)}  ${d}`);
  }
  console.log(`\n${sorted.length} unique domain(s)`);
}

function cmdMeta(meta) {
  const keys = Object.keys(meta).sort();
  if (!keys.length) return console.log('(no metadata records)');
  for (const k of keys) {
    let v = meta[k];
    if (k.endsWith('Date') && typeof v === 'number') v = `${fmtDate(new Date(v))}  (${v})`;
    console.log(`${k.padEnd(28)}  ${JSON.stringify(v)}`);
  }
}

function cmdOrphans(orphans) {
  for (const t of orphans) {
    console.log(`${fmtDate(t.createDate)}  ${trunc(t.title || '(no title)', 60).padEnd(60)}  ${t.url}`);
  }
  console.log(`\n${orphans.length} orphan tab(s)`);
}

function cmdExport(groups, meta, orphans, readings) {
  const payload = {
    extractedAt: new Date().toISOString(),
    sources: readings.map(r => ({
      profile: r.store.profile,
      kind: r.store.kind,
      path: r.store.path,
      records: r.records.length,
    })),
    meta,
    groups,
    orphans,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main().catch(err => {
  console.error('error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
