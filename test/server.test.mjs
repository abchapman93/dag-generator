import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, readdir, readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server/app.mjs';
import * as formula from '../src/engine/formula.mjs';
import { layout } from '../src/engine/layout.mjs';

const run = promisify(execFile);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const OUTBOUND = join(process.env.HOME, '.claude', 'skills', 'session-bridge', 'scripts', 'outbound.py');
const hasOutbound = await access(OUTBOUND).then(() => true, () => false);

const model = (src = 'Y ~ A + L, A ~ L') => layout(formula.parse(src).model);

// The web-context is laid out as a real ~/.claude/web-context under a temp HOME,
// so outbound.py (which resolves the store from $HOME) writes the same store
// the server reads. Asks are made by the real Python emitter: that is the
// interop check between the session's writer and this surface's reader.
describe.skipIf(!hasOutbound)('server on the kit', () => {
  let home, ctx, server, base;
  const env = () => ({ ...process.env, HOME: home });

  const api = async (method, path, body) => {
    const res = await fetch(`${base}dag/api${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const emitAsk = async (args) => {
    const { stdout } = await run('python3', [OUTBOUND, 'emit', ...args], { env: env() });
    // emit prints the path of the ask file it wrote
    return stdout.trim().split('/').pop().replace(/\.json$/, '');
  };
  const askFile = async (id) => JSON.parse(await readFile(join(ctx, 'outbound', `${id}.json`), 'utf8'));
  const signalFiles = async () => {
    const dir = join(ctx, 'signals');
    const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
    return Promise.all(names.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))));
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dg-server-'));
    ctx = join(home, '.claude', 'web-context');
    await mkdir(ctx, { recursive: true });
    await new Promise((resolve) => {
      const app = createApp({ webContext: ctx, configsDir: join(home, 'configs'), baseUrl: 'http://127.0.0.1:0/' });
      server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/`; resolve(); });
    });
  });
  afterAll(async () => {
    server?.close();
    await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(join(ctx, 'signals'), { recursive: true, force: true });
    await rm(join(ctx, 'outbound'), { recursive: true, force: true });
  });

  it('serves the kit and the engine to the page', async () => {
    for (const p of ['kit/ask-cards.mjs', 'kit/rail.mjs', 'kit/channel-picker.mjs', 'kit/asks.mjs', 'engine/patch.mjs']) {
      expect((await fetch(base + p)).status, p).toBe(200);
    }
  });

  describe('signals', () => {
    it('point-at: dag-generator kind, handles, PNG crop under context/', async () => {
      const { body } = await api('POST', '/signal', {
        handles: [{ handle: '@node:A', label: '$A$', style: 'rv' }, { handle: '@edge:A->Y', label: '', style: 'causal' }],
        png: PNG, note: 'this one', channel: 'ch_1',
      });
      expect(body.kind).toBe('dag-generator-point-at');
      const [sig] = await signalFiles();
      expect(sig.kind).toBe('dag-generator-point-at');
      expect(sig.channel).toBe('ch_1');
      expect(sig.context_path).toMatch(/context\/.*\.png$/);
      await access(sig.context_path);
    });

    it('message and ping kinds', async () => {
      expect((await api('POST', '/signal', { note: 'hi' })).body.kind).toBe('dag-generator-message');
      expect((await api('POST', '/signal', {})).body.kind).toBe('dag-generator-ping');
    });
  });

  describe('asks', () => {
    it('lists asks written by outbound.py, and an answer stamps the ask', async () => {
      const id = await emitAsk(['--prompt', 'Which layout?', '--option', 'Compact', '--option', 'Spread', '--target', 'dag-generator']);
      const { body: asks } = await api('GET', '/asks?target=dag-generator');
      expect(asks.map((a) => a.ask_id)).toEqual([id]);
      expect(asks[0].stale).toBe(false);

      const { body } = await api('POST', '/signal', { note: 'Compact', in_reply_to: id, option_id: 'compact' });
      expect(body.kind).toBe('dag-generator-answer');
      expect((await askFile(id)).answered_at).toBeTruthy();
      const { stdout } = await run('python3', [OUTBOUND, 'get', id], { env: env() });
      expect(JSON.parse(stdout).answer).toEqual({ label: 'Compact', option_id: 'compact' });
    });

    it('a comment rides in_reply_to without stamping the ask', async () => {
      const id = await emitAsk(['--prompt', 'Q?', '--option', 'Yes', '--target', 'dag-generator']);
      await api('POST', '/signal', { note: 'thinking', in_reply_to: id, comment: true });
      expect((await askFile(id)).answered_at).toBeNull();
      expect((await signalFiles()).length).toBe(1);
    });

    it('dismiss writes no signal', async () => {
      const id = await emitAsk(['--prompt', 'Q?', '--option', 'Yes', '--target', 'dag-generator']);
      const { status } = await api('POST', `/asks/${id}/dismiss`, {});
      expect(status).toBe(200);
      expect(await signalFiles()).toEqual([]);
      expect((await api('GET', '/asks')).body).toEqual([]);
    });

    it('channels: asks filter null-passes, other channels are hidden', async () => {
      const mine = await emitAsk(['--prompt', 'mine', '--option', 'ok', '--target', 'dag-generator', '--channel', 'ch_a']);
      await emitAsk(['--prompt', 'theirs', '--option', 'ok', '--target', 'dag-generator', '--channel', 'ch_b']);
      const open = await emitAsk(['--prompt', 'anyone', '--option', 'ok', '--target', 'dag-generator']);
      const ids = (await api('GET', '/asks?channel=ch_a')).body.map((a) => a.ask_id).sort();
      expect(ids).toEqual([mine, open].sort());
    });

    it('channel picker routes create, list and archive', async () => {
      const { body: ch } = await api('POST', '/channels', { name: 'dag work' });
      expect(ch.channel_id).toBeTruthy();
      expect((await api('GET', '/channels')).body.channels.some((c) => c.channel_id === ch.channel_id)).toBe(true);
      expect((await api('POST', `/channels/${ch.channel_id}/archive`)).status).toBe(200);
    });
  });

  describe('current DAG and mirror', () => {
    it('writes the mirror and reports state', async () => {
      const { status, body } = await api('PUT', '/current', { slug: null, name: 'Scratch', model: model() });
      expect(status).toBe(200);
      expect(body.mirror).toMatch(/mirrors\/dag-generator-scratch$/);
      const md = await readFile(join(body.mirror, 'dag.md'), 'utf8');
      expect(md).toContain(`model version: ${body.version}`);
      expect(md).toContain('@edge:A->Y');
      expect(md).toContain('(unsaved — only in the open page)');
      expect(await readFile(join(body.mirror, 'dag.svg'), 'utf8')).toMatch(/^<svg/);
      const state = (await api('GET', '/state')).body;
      expect(state).toMatchObject({ surface: 'dag-generator', current: { slug: null, nodes: 3, edges: 3 } });
      expect((await api('GET', '/current')).body.model.nodes).toHaveLength(3);
    });

    it('refuses an unsafe slug', async () => {
      expect((await api('PUT', '/current', { slug: '../x', model: model() })).status).toBe(400);
    });
  });

  describe("Claude's drafts", () => {
    it('mints a claude- slug and refuses once Alec has edited it', async () => {
      const first = await api('PUT', '/claude/configs', { title: 'Adherence DAG', model: model() });
      expect(first.body.slug).toBe('claude-adherence-dag');
      expect(first.body.url).toContain('?config=claude-adherence-dag');
      expect((await api('PUT', '/claude/configs', { title: 'Adherence DAG', model: model() })).body.replaced).toBe(true);

      const list = (await api('GET', '/configs')).body;
      expect(list.find((c) => c.slug === 'claude-adherence-dag')).toMatchObject({ origin: 'claude', last_writer: 'claude' });

      await api('PUT', '/configs', { slug: 'claude-adherence-dag', name: 'Adherence DAG', model: model() });
      const after = (await api('GET', '/configs/claude-adherence-dag')).body;
      expect(after).toMatchObject({ origin: 'claude', last_writer: 'alec' });

      const refused = await api('PUT', '/claude/configs', { title: 'Adherence DAG', model: model('Y ~ A') });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('edited');
    });

    it("cannot be aimed at Alec's DAGs", async () => {
      await api('PUT', '/configs', { name: 'My paper', model: model() });
      const { body } = await api('PUT', '/claude/configs', { title: 'my-paper', model: model('Y ~ A') });
      expect(body.slug).toBe('claude-my-paper');
      expect((await api('GET', '/configs/my-paper')).body.model.nodes).toHaveLength(3);
      // A title that already says "claude" does not double the prefix or escape it.
      expect((await api('PUT', '/claude/configs', { title: 'Claude: ../../etc', model: model() })).body.slug).toBe('claude-etc');
    });

    it("keeps Alec's new DAGs out of the claude- namespace", async () => {
      const { body } = await api('PUT', '/configs', { name: 'Claude review', model: model() });
      expect(body.slug).toBe('dag-claude-review');
    });
  });

  describe('dag-patch resolve', () => {
    const patch = (over = {}) => JSON.stringify({
      type: 'dag-patch', subject: 'dag:scratch', base_slug: null,
      ops: [{ op: 'add-node', node: { id: 'M' } }, { op: 'add-edge', edge: { from: 'A', to: 'M' } }], ...over,
    });
    const emitPatch = (over) => emitAsk(['--prompt', 'Add a mediator?', '--option', 'Accept', '--option', 'Reject',
      '--target', 'dag-generator', '--channel', 'ch_p', '--payload', patch(over)]);

    beforeEach(async () => { await api('PUT', '/current', { slug: null, name: 'Scratch', model: model() }); });

    it('accept: emits the answer on the ask channel and stamps it', async () => {
      const id = await emitPatch();
      const { status, body } = await api('POST', `/suggestions/${id}/resolve`, { outcome: 'accept', channel: 'ch_other' });
      expect(status).toBe(200);
      expect(body.outcome).toBe('accept');
      const [sig] = await signalFiles();
      expect(sig).toMatchObject({ kind: 'dag-generator-answer', in_reply_to: id, channel: 'ch_p', note: 'accept' });
      expect((await askFile(id)).answer.option_id).toBe('accept');
      expect((await api('POST', `/suggestions/${id}/resolve`, { outcome: 'accept' })).status).toBe(409);
    });

    it('refuses a superseded card but lets it be rejected', async () => {
      const old = await emitPatch();
      await new Promise((r) => setTimeout(r, 20));
      await emitPatch();
      const res = await api('POST', `/suggestions/${old}/resolve`, { outcome: 'accept' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('superseded');
      expect((await api('POST', `/suggestions/${old}/resolve`, { outcome: 'reject', note: 'no' })).status).toBe(200);
    });

    it('refuses a patch for a different DAG', async () => {
      const id = await emitPatch({ base_slug: 'my-paper', subject: 'dag:my-paper' });
      const res = await api('POST', `/suggestions/${id}/resolve`, { outcome: 'accept' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('wrong-dag');
    });

    it('refuses a retracted card and a non-patch ask', async () => {
      const id = await emitPatch();
      await run('python3', [OUTBOUND, 'retract', id], { env: env() });
      expect((await api('POST', `/suggestions/${id}/resolve`, { outcome: 'accept' })).body.error).toBe('retracted');
      const plain = await emitAsk(['--prompt', 'Q?', '--option', 'Yes', '--target', 'dag-generator']);
      expect((await api('POST', `/suggestions/${plain}/resolve`, { outcome: 'accept' })).status).toBe(400);
    });
  });
});
