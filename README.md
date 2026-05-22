# ot — OneTab CLI

A CLI that reads your [OneTab](https://chromewebstore.google.com/detail/onetab/chphlpgkkbolifaimnlloiipkdnihall)
Chrome extension data **directly off disk**. No browser automation, no network,
no extension API. Just your Chrome profile's storage files.

It handles every layer OneTab/Chrome puts between you and the data:

- `chrome.storage.local` LevelDB (the legacy snapshot)
- Chromium IndexedDB LevelDB (where current OneTab data lives), including the
  custom `idb_cmp1` comparator that prevents normal LevelDB libraries from
  opening it
- Snappy-compressed SSTable blocks
- LevelDB log fragmentation
- Blink's IDB value envelope (`version varint + wrapper version + trailer offset`)
- V8's structured-clone format

## Install

```bash
npm install
```

Requires Node ≥ 20. Built and tested on macOS; the Chrome path discovery
covers `~/Library/Application Support/Google/Chrome/{Default,Profile N}`.

## Usage

```bash
node bin/onetab.js [command] [flags]
```

Available commands:

| Command   | What it shows |
|-----------|---------------|
| `stats`   | (default) summary: groups, tabs, top domains, install date |
| `paths`   | every OneTab LevelDB store discovered on disk |
| `groups`  | each tab group with size, label, creation date |
| `tabs`    | every saved tab (title + URL) |
| `domains` | top domains across all saved tabs |
| `meta`    | extension settings (install date, theme, share prefs, …) |
| `orphans` | tabs not in any visible group (e.g. items in the trash folder) |
| `raw`     | dump every LevelDB record we found, decoded where possible |
| `export`  | emit everything as JSON on stdout |

Flags:

- `--profile <name>` — pick a specific Chrome profile (`Default`, `Profile 1`, …)
- `--kind local|idb` — restrict to one storage backend
- `--path <dir>` — read a LevelDB directory directly

### Examples

```bash
node bin/onetab.js                    # default stats
node bin/onetab.js groups             # list groups
node bin/onetab.js export > out.json  # full dump (gitignored)
node bin/onetab.js raw --kind idb     # see decoded V8 records
```

## How it works

1. **Discovery** — walk Chrome's profile directories looking for OneTab's
   storage in two places: the legacy `chrome.storage.local` directory and the
   modern `IndexedDB/chrome-extension_<id>_0.indexeddb.leveldb`.
2. **Lock-free copy** — Chrome holds an exclusive LOCK on every LevelDB while
   running, so we copy the files to a tempdir before reading.
3. **Two readers** —
   - Local store: opened with `classic-level` (plain LevelDB).
   - IndexedDB store: parsed directly from `.ldb` SSTables and `.log` files,
     bypassing the `idb_cmp1` comparator that LevelDB refuses to honor.
4. **Decode** — IDB values are wrapped:
   `varint(leveldb_version)` → `0xff varint(blink_wrapper_version)` →
   optional `0xfe + 12-byte trailer info` → `0xff varint(v8_version)` →
   V8 structured-clone bytes. A minimal V8 deserializer reconstructs the
   original JS objects.
5. **Assemble** — modern OneTab stores groups and tabs as separate records
   linked via `parentIds` / `childIds`. We reconstruct the tree.

## Project layout

```
bin/onetab.js   CLI entry point
lib/store.js    discovery, dispatch, schema extraction
lib/sstable.js  SSTable + log reader (Snappy, restart-array iteration)
lib/v8clone.js  V8 structured-clone deserializer
lib/report.js   summarization + formatting helpers
```

## Caveats

- Read-only. The tool never writes back to Chrome's storage.
- macOS paths only out of the box. Linux/Windows discovery would need its own
  branch in `discoverStores`.
- OneTab schema is undocumented and changes between versions. Tested against
  OneTab 2.14.
