import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// emitPointAt reads its base dir at import time, so set the override *before*
// dynamically importing the module (static imports are hoisted above this).
describe('point-at signal', () => {
  let dir, emitPointAt;
  const readSignal = async (id) => JSON.parse(await readFile(join(dir, 'signals', `${id}.json`), 'utf8'));
  // Fields /session-attach + signals.py expect to be present on every signal.
  const SCHEMA = ['signal_id', 'kind', 'source', 'created_at', 'title', 'note',
    'session_id', 'cwd_hint', 'contract_url', 'state_url', 'context_path',
    'consumed_at', 'consumed_by'];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dg-webctx-'));
    process.env.DAG_GENERATOR_WEBCTX = dir;
    ({ emitPointAt } = await import('../src/server/pointat.mjs'));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('writes a schema-complete signal for a node handle', async () => {
    const r = await emitPointAt({ handle: '@node:severe', label: '$severe$', style: 'leaf' });
    expect(r.handle).toBe('@node:severe');
    const sig = await readSignal(r.signal_id);
    for (const k of SCHEMA) expect(sig).toHaveProperty(k);
    expect(sig.kind).toBe('dag-point-at');
    expect(sig.title).toContain('@node:severe');
    expect(sig.title).toContain('severe');      // TeX $…$ stripped for readability
    expect(sig.title).toContain('leaf');
    expect(sig.consumed_at).toBeNull();
    expect(sig.context_path).toBeNull();        // no crop supplied
  });

  it('writes the crop PNG and points context_path at it', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const r = await emitPointAt({ handle: '@edge:A->Y', style: 'causal', png });
    expect(r.crop).toBeTruthy();
    await access(r.crop);                        // crop file exists on disk
    const sig = await readSignal(r.signal_id);
    expect(sig.context_path).toBe(r.crop);
    expect(sig.title).toContain('@edge:A->Y');
    expect(sig.title).toContain('edge');
  });

  it('emits one signal covering several handles (multi-select)', async () => {
    const r = await emitPointAt({ handles: [
      { handle: '@node:X', label: '$X$', style: 'rv' },
      { handle: '@node:V0', label: '$V0$', style: 'rv' },
      { handle: '@edge:A->V1', style: 'causal' },
    ] });
    expect(r.handles).toEqual(['@node:X', '@node:V0', '@edge:A->V1']);
    const sig = await readSignal(r.signal_id);
    expect(sig.title).toContain('@node:X');
    expect(sig.title).toContain('@edge:A->V1');
    expect(sig.title).toContain('3 elements');
  });

  it('rejects a missing handle', async () => {
    await expect(emitPointAt({})).rejects.toThrow(/handle/);
    await expect(emitPointAt({ handles: [] })).rejects.toThrow(/handle/);
  });
});
