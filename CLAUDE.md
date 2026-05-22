# Working in this repo

This is a small Node CLI that reads OneTab Chrome extension data straight off
disk. It exists because OneTab's modern data lives in Chromium's IndexedDB,
which uses a custom comparator (`idb_cmp1`) that off-the-shelf LevelDB
libraries refuse to open, and the values are V8 structured-clone blobs wrapped
in a Blink envelope. None of that is solvable with a one-liner — the layered
decoder is the whole point of the project.

## Architecture (read these in order)

1. `lib/sstable.js` — pure JS reader for LevelDB on-disk formats: `.ldb`
   SSTables (footer → index block → data blocks, Snappy-decompressed) and
   `.log` files (32K block framing, fragment reassembly, WriteBatch parsing).
   Bypasses the comparator entirely. No dependency on `classic-level`.
2. `lib/v8clone.js` — minimal V8 structured-clone deserializer. Strips the
   Chromium IDB envelope (`varint leveldb_version` → `0xff varint blink_ver` →
   optional `0xfe + 12B trailer` → `0xff varint v8_ver`), then walks V8 tags
   (objects, dense/sparse arrays, strings 1B / UTF-8 / UTF-16, ints, doubles,
   dates, back-refs). Has a fallback that pulls printable strings when a tag
   it doesn't know about appears.
3. `lib/store.js` — discovery + dispatch. Local-storage LevelDBs go through
   `classic-level`; IDB LevelDBs go through the SSTable reader. Also contains
   `extractGroups`, `extractMetadata`, `extractOrphanTabs` which understand
   OneTab's schema (groups and tabs as separate records linked by
   `parentIds` / `childIds`, plus legacy inline-tab format as a fallback).
4. `lib/report.js` — formatting / summarization. No I/O.
5. `bin/onetab.js` — argument parsing, command dispatch, output. Thin layer.

## Non-obvious constraints

- **Chrome holds an exclusive LOCK on every LevelDB while running.** Never
  open Chrome's files directly — `cloneToTemp` in `lib/store.js` copies
  everything except the `LOCK` file to a tempdir first. The tempdir is
  cleaned up by the reader.
- **The IDB value wrapper has TWO `0xff` version tags.** The first one is
  Blink's wrapper version (typically 21), often followed by a trailer
  offset block (`0xfe` + 8B BE offset + 4B BE size). The second `0xff` is
  the V8 serializer version (typically 15). Then the actual value tag.
  Easy to skip past the wrong one.
- **Most IDB records are not object-store values.** ~485 of the ~707 records
  in a typical OneTab install are index entries (IDB-encoded keys stored as
  values). They will fail V8 deserialization. That's expected — silently skip.
- **The SSTable magic is `0xdb4775248b80fb57` written little-endian.** On
  disk the last 8 bytes of the 48-byte footer are `57 fb 80 8b 24 75 47 db`.
  `readUInt32LE` of those gives `LO=0x8b80fb57`, `HI=0xdb477524`. Off-by-one
  on this and the reader silently returns zero records.
- **OneTab's `root`, `quickList`, and `trash` are system groups.** Filter
  them out before surfacing groups to the user. Tabs whose only parent is
  `trash` are reported via `orphans`, not `groups`.

## Personal-data hygiene

This tool reads someone's full browsing history. Treat every test artifact
accordingly:

- **Never commit extracted data.** `.gitignore` blocks `*.export.json`,
  `export*.json`, and `sample-data/`. Don't add fixture files derived from
  a real OneTab profile.
- **Never paste real URLs, titles, or group labels** into commit messages,
  PRs, issues, or docs. When you need an example, invent one.
- **No hardcoded local paths.** Use `os.homedir()` + `path.join`. The only
  hardcoded value should be the OneTab extension ID
  (`chphlpgkkbolifaimnlloiipkdnihall`), which is public.

## How to verify changes

There is no automated test suite — the only ground truth is real OneTab data,
which we don't commit. Manual verification flow:

```bash
node bin/onetab.js stats     # must report > 0 groups and > 0 tabs
node bin/onetab.js raw --kind idb | head -20   # decoded objects visible
node bin/onetab.js export | node -e 'process.stdin.on("data",d=>{}); process.stdin.on("end",()=>{})'
# (the export should be valid JSON; pipe through `jq .` if you want)
```

Numbers that should look sane on a healthy install:

- IDB records: a few hundred to a couple thousand
- Decoded V8 values: ~30% of IDB records (the rest are index entries)
- groups + orphans ≈ user's mental count of OneTab groups (modulo trash)

## When extending the tool

- New OneTab schema fields: add them to `normalizeGroup` in `lib/store.js`,
  and surface them through `summarize` / commands as needed.
- New V8 tags: add to the `TAGS` table in `lib/v8clone.js` and a `case` in
  `readValue`. Don't silently accept unknowns — let the fallback string
  extractor catch them so we notice in `raw`.
- New platforms (Linux / Windows): extend `discoverStores` with the right
  Chrome profile root. The reader code below `discoverStores` is platform-
  agnostic.

## Dependencies

Keep them minimal. Currently:

- `classic-level` — only for the legacy `chrome.storage.local` store.
- `snappy` — for SSTable block decompression.

Don't add a runtime dep for argument parsing, formatting, or HTTP — there's
no need.
