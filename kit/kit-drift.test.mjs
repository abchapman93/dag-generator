// Vendored from ~/Code/collab-lab/kit/vendor-template/ alongside sync-vendor.mjs.
//
// The vendored kit copies are mechanical duplicates of ~/Code/collab-lab/kit.
// Drift between them is how the anchor rule once grew four implementations, so
// drift fails the suite and re-running the sync script fixes it.
//
// This test is the actual guard. The portfolio drift checker (Claude Setup,
// tools/component_drift.py) is a backstop that runs when someone runs it; this
// runs on every `npm test` in the repo that owns the copy.
//
// Two skips, both deliberate:
//   - source kit absent (fresh clone, CI): the vendored copies are then the
//     working truth, and the check re-arms wherever collab-lab exists.
//   - no stamp yet: vendoring has never run here, so there is nothing to hold.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { KIT_SRC, VENDOR, VENDORED, manifest, readStamp, shippableSurface } from './sync-vendor.mjs';

const sourcePresent = await access(KIT_SRC).then(() => true, () => false);
const stamp = await readStamp();
const skip = !sourcePresent
  ? 'source kit not on this machine'
  : !stamp ? 'no VENDOR-STAMP.json yet — run the sync script' : false;

test('vendored kit files are byte-identical to the source kit', { skip }, async () => {
  const files = await manifest();
  assert.ok(files.length > 0, 'empty manifest — the sync script has never run');
  for (const rel of files) {
    const [src, ven] = await Promise.all([
      readFile(join(KIT_SRC, rel), 'utf8').catch(() => null),
      readFile(join(VENDOR, rel), 'utf8').catch(() => null),
    ]);
    assert.notEqual(src, null, `${rel} missing from the source kit — manifest stale?`);
    assert.notEqual(ven, null, `${rel} missing from the vendor copy — run the sync script`);
    assert.equal(ven, src, `${rel} differs from the source kit — run the sync script`);
  }
});

// Surface-mode consumers take whatever the kit ships, so a module added since
// the last sync is a real gap and the byte-comparison above already fails on it
// (manifest() re-derives from the live kit). This test exists to make the
// REASON legible in the output rather than surfacing as a bare missing file.
test('the source kit has not grown modules this copy never synced', { skip }, async () => {
  if (VENDORED) return;                      // manifest mode: a subset is the point
  const added = (await shippableSurface()).filter((f) => !(stamp.files ?? []).includes(f));
  assert.deepEqual(added, [],
    `the kit gained ${added.length} module(s) since this copy was stamped `
    + `(${stamp.commit?.slice(0, 7)}, ${stamp.synced_at?.slice(0, 10)}) — `
    + `run the sync script to take them: ${added.join(', ')}`);
});
