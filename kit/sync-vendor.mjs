// Vendored from ~/Code/collab-lab/kit/vendor-template/ (edit only the CONFIG block).
// This is the canonical vendoring mechanism for the collab kit. Before it
// existed every consumer improvised: two repos hand-copied this file to each
// other, three more open-coded a recursive cpSync with no stamp and no test,
// and the drift that followed was invisible until someone went looking.
//
//   node <wherever you put this>/sync-vendor.mjs
//
// The paired kit-drift.test.mjs holds every vendored file byte-identical and
// fails the consumer's own suite the moment one drifts. That test is the point
// of the whole exercise — a periodic external scan finds drift days later, a
// red suite finds it immediately. Copy both files or neither.
//
// Source kit defaults to ~/Code/collab-lab/kit; override with COLLAB_LAB_KIT.

import { copyFile, mkdir, writeFile, readdir, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

// ---------------------------------------------------------------- CONFIG ---

// Where the vendored copies land, relative to THIS file.
const VENDOR_SUBDIR = 'vendor';

// Either an explicit list of kit-relative paths, or null for "everything the
// kit ships". Prefer an explicit list when you knowingly take a subset —
// research-lounge vendors 10 of 19 files because it has its own rail, and
// declaring that is what stops the checker calling the other 9 "missing".
// null is right when you genuinely want the whole surface and want new kit
// modules to arrive on the next sync.
export const VENDORED = [
  'asks.mjs',
  'server/signals.mjs',
  'server/outbound.mjs',
  'server/channels.mjs',
  'server/doc.mjs',
  'frontend/ask-cards.mjs',
  'frontend/ask-cards.css',
  'frontend/rail.mjs',
  'frontend/rail.css',
  'frontend/channel-picker.mjs',
  'frontend/channel-picker.css',
];

// ------------------------------------------------------------ MECHANISM ---

const HERE = dirname(fileURLToPath(import.meta.url));
export const KIT_SRC = process.env.COLLAB_LAB_KIT || join(homedir(), 'Code', 'collab-lab', 'kit');
export const VENDOR = join(HERE, VENDOR_SUBDIR);
export const STAMP = join(HERE, 'VENDOR-STAMP.json');

// What the kit ships. Its own tests, README and this very template are not
// part of the distributable surface. vendor-template/ matters more than it
// looks: it lives INSIDE kit/, so without this line every consumer vendors a
// copy of the vendoring machinery as if it were a kit module — caught on the
// first adoption, after learning had already taken two of them.
const NOT_SHIPPED = (rel) =>
  rel.startsWith(`test${sep}`)
  || rel.startsWith(`vendor-template${sep}`)
  || rel === 'README.md';

export async function shippableSurface(root = KIT_SRC) {
  const out = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(root, join(entry.parentPath ?? entry.path, entry.name));
    if (!NOT_SHIPPED(rel)) out.push(rel);
  }
  return out.sort();
}

// The manifest the drift test will hold. Resolved from the stamp when this
// module is merely imported, so the test never has to touch the source kit to
// learn what it is supposed to be checking.
export async function manifest() {
  if (VENDORED) return VENDORED;
  // Surface mode always re-derives from the live kit, never from the stamp.
  // Reading the stamp here would make a kit module added since the last sync
  // invisible to the drift test, which is the whole failure this guards.
  return shippableSurface(KIT_SRC);
}

export async function readStamp() {
  try {
    return JSON.parse(await readFile(STAMP, 'utf8'));
  } catch { return null; }
}

// Copy only when run as a script. The drift test imports from this file, and a
// test that silently repairs the drift it checks for would hide exactly what it
// exists to catch. The NODE_TEST_CONTEXT half is load-bearing: `node --test`
// over a directory runs every .mjs in it as a test file with argv[1] set to
// that file's own path, which defeats the argv guard on its own.
if (process.argv[1] === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  await access(KIT_SRC).catch(() => {
    console.error(`No kit at ${KIT_SRC}. Clone collab-lab or set COLLAB_LAB_KIT.`);
    process.exit(1);
  });

  const files = VENDORED ?? await shippableSurface(KIT_SRC);
  for (const rel of files) {
    await mkdir(dirname(join(VENDOR, rel)), { recursive: true });
    await copyFile(join(KIT_SRC, rel), join(VENDOR, rel));
  }
  console.log(`vendored ${files.length} kit file(s) -> ${relative(process.cwd(), VENDOR)}`);

  // The kit carries no version field, so the source repo's commit is the pin.
  //
  // `mode` is not decoration. It says whether `files` is a DECLARATION or a
  // SNAPSHOT, and the portfolio drift checker needs the difference: for
  // 'manifest' the list is what this copy deliberately takes, so anything
  // outside it is "not vendored"; for 'surface' the list is merely what existed
  // at sync time, so a kit module added since is MISSING, not excluded.
  // Without this distinction a whole-surface consumer would look permanently
  // in-sync while falling behind — the exact blindness the checker was just
  // fixed to stop.
  const commit = execFileSync('git', ['-C', KIT_SRC, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(STAMP, JSON.stringify({
    source: KIT_SRC,
    commit,
    synced_at: new Date().toISOString(),
    mode: VENDORED ? 'manifest' : 'surface',
    files,
  }, null, 2) + '\n');
  console.log(`stamped ${commit} (${VENDORED ? 'manifest' : 'surface'} mode)`);
}
