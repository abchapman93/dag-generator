import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

// A 1x1 PNG — enough to prove the inlining path without a fixture file.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// asks.mjs reads its base dir at import time, so set the override *before*
// dynamically importing (static imports are hoisted above this).
describe('outbound asks', () => {
  // The store is laid out as a real ~/.claude/web-context so outbound.py — which
  // resolves it from $HOME and takes no env override — can be pointed at the SAME
  // store the JS reader uses. That's what makes the interop test below meaningful.
  let home, dir, outDir, listAsks, answerAsk;

  const ask = (over = {}) => ({
    ask_id: 'A', created_at: '2026-07-24T17:30:00Z',
    prompt: 'Which layout do you want for the SWIG?',
    options: [{ id: 'compact', label: 'Compact', image: null },
              { id: 'spread', label: 'Spread out', image: null }],
    allow_free_text: true, target: 'dag-generator', source_session: null,
    answered_at: null, answer: null, ...over,
  });
  const write = (a) => writeFile(join(outDir, `${a.ask_id}.json`), JSON.stringify(a, null, 2));
  const readRaw = async (id) => JSON.parse(await readFile(join(outDir, `${id}.json`), 'utf8'));

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dg-asks-'));
    dir = join(home, '.claude', 'web-context');
    outDir = join(dir, 'outbound');
    await mkdir(outDir, { recursive: true });
    process.env.DAG_GENERATOR_WEBCTX = dir;
    ({ listAsks, answerAsk } = await import('../src/server/asks.mjs'));
  });
  afterAll(async () => { await rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
  });

  it('returns no asks when the store does not exist', async () => {
    await rm(outDir, { recursive: true, force: true });
    expect(await listAsks({ target: 'dag-generator' })).toEqual([]);   // not an error
  });

  it('returns unanswered asks, newest first', async () => {
    await write(ask({ ask_id: 'old', created_at: '2026-07-24T10:00:00Z' }));
    await write(ask({ ask_id: 'new', created_at: '2026-07-24T18:00:00Z' }));
    const got = await listAsks({ target: 'dag-generator' });
    expect(got.map((a) => a.ask_id)).toEqual(['new', 'old']);
    expect(got[0].prompt).toContain('SWIG');
    expect(got[0].options.map((o) => o.id)).toEqual(['compact', 'spread']);
  });

  it('excludes answered asks so the card stops rendering', async () => {
    await write(ask({ ask_id: 'done', answered_at: '2026-07-24T18:05:00Z', answer: { label: 'Compact' } }));
    await write(ask({ ask_id: 'open' }));
    expect((await listAsks({ target: 'dag-generator' })).map((a) => a.ask_id)).toEqual(['open']);
  });

  it('matches its own target plus untargeted asks, and skips other surfaces', async () => {
    await write(ask({ ask_id: 'mine', target: 'dag-generator' }));
    await write(ask({ ask_id: 'any', target: null }));        // null = any open surface
    await write(ask({ ask_id: 'theirs', target: 'lounge-editor' }));
    const ids = (await listAsks({ target: 'dag-generator' })).map((a) => a.ask_id).sort();
    expect(ids).toEqual(['any', 'mine']);
  });

  it('returns every ask when the poller names no target', async () => {
    await write(ask({ ask_id: 'mine', target: 'dag-generator' }));
    await write(ask({ ask_id: 'theirs', target: 'lounge-editor' }));
    expect((await listAsks()).length).toBe(2);
  });

  it('inlines an option preview as a data URI and never leaks its path', async () => {
    const png = join(dir, 'preview.png');
    await writeFile(png, Buffer.from(PNG_B64, 'base64'));
    await write(ask({ options: [{ id: 'compact', label: 'Compact', image: png }] }));
    const [got] = await listAsks({ target: 'dag-generator' });
    expect(got.options[0].image.startsWith('data:image/png;base64,')).toBe(true);
    expect(JSON.stringify(got)).not.toContain(dir);   // pixels or nothing — no paths
  });

  it('degrades to a text-only option when the preview is missing or not an image', async () => {
    const txt = join(dir, 'notes.txt');
    await writeFile(txt, 'not an image');
    await write(ask({ options: [
      { id: 'gone', label: 'Gone', image: join(dir, 'no-such.png') },
      { id: 'wrong', label: 'Wrong type', image: txt },
    ] }));
    const [got] = await listAsks({ target: 'dag-generator' });
    expect(got.options.map((o) => o.image)).toEqual([null, null]);
    expect(got.options.map((o) => o.label)).toEqual(['Gone', 'Wrong type']);
  });

  it('skips a malformed file instead of failing the whole poll', async () => {
    await writeFile(join(outDir, 'broken.json'), '{ not json');
    await write(ask({ ask_id: 'fine' }));
    expect((await listAsks({ target: 'dag-generator' })).map((a) => a.ask_id)).toEqual(['fine']);
  });

  it('stamps an answer so the ask drops out of the next poll', async () => {
    await write(ask({ ask_id: 'A' }));
    const stamped = await answerAsk('A', { answer: 'Compact', optionId: 'compact' });
    expect(stamped.answer).toEqual({ label: 'Compact', option_id: 'compact' });
    expect(stamped.answered_at).toBeTruthy();
    expect(await listAsks({ target: 'dag-generator' })).toEqual([]);
    expect((await readRaw('A')).answer.label).toBe('Compact');
  });

  it('keeps the FIRST answer when two tabs race the same card', async () => {
    await write(ask({ ask_id: 'A' }));
    await answerAsk('A', { answer: 'Compact', optionId: 'compact' });
    const second = await answerAsk('A', { answer: 'Spread out', optionId: 'spread' });
    expect(second.answer.label).toBe('Compact');            // untouched, not clobbered
    expect((await readRaw('A')).answer.label).toBe('Compact');
  });

  it('returns null for an unknown ask', async () => {
    expect(await answerAsk('nope', { answer: 'x' })).toBeNull();
  });

  it('refuses an ask_id that would walk out of the store', async () => {
    await writeFile(join(dir, 'outside.json'), JSON.stringify(ask({ ask_id: 'outside' })));
    expect(await answerAsk('../outside', { answer: 'x' })).toBeNull();
    expect(await answerAsk('..', { answer: 'x' })).toBeNull();
    expect(await answerAsk('', { answer: 'x' })).toBeNull();
    // the file outside the store is untouched
    expect(JSON.parse(await readFile(join(dir, 'outside.json'), 'utf8')).answered_at).toBeNull();
  });

  // The store is a filesystem contract with two implementations (outbound.py for
  // any session, asks.mjs for this surface). This is the test that catches them
  // drifting apart — the failure mode the contract exists to prevent.
  it('round-trips against the portable outbound.py', async () => {
    const script = join(process.env.HOME, '.claude', 'skills', 'session-bridge', 'scripts', 'outbound.py');
    const env = { ...process.env, HOME: home };   // point outbound.py at this store

    await run('python3', [script, 'emit', '--prompt', 'Which tree encoding?',
      '--option', 'Categories as nodes', '--option', 'Tests as nodes',
      '--target', 'dag-generator'], { env });

    // Read what Python wrote, through the JS reader.
    const [got] = await listAsks({ target: 'dag-generator' });
    expect(got.prompt).toBe('Which tree encoding?');
    expect(got.options.map((o) => o.id)).toEqual(['categories-as-nodes', 'tests-as-nodes']);
    expect(got.allow_free_text).toBe(true);

    // Answer through the JS writer, read it back through Python.
    await answerAsk(got.ask_id, { answer: 'Tests as nodes', optionId: 'tests-as-nodes' });
    const { stdout } = await run('python3', [script, 'get', got.ask_id], { env });
    const seen = JSON.parse(stdout);
    expect(seen.answered_at).toBeTruthy();
    expect(seen.answer).toEqual({ label: 'Tests as nodes', option_id: 'tests-as-nodes' });

    // And an answered ask is no longer listed on either side.
    expect(await listAsks({ target: 'dag-generator' })).toEqual([]);
    const { stdout: listed } = await run('python3', [script, 'list', '--target', 'dag-generator'], { env });
    expect(JSON.parse(listed)).toEqual([]);
  });
});
