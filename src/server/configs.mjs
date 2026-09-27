// Saved-DAG registry. Each config is a JSON file under the data dir (default
// ~/.dag-generator/configs, override DAG_GENERATOR_DATA):
//
//   { name, updated, model, origin?, last_writer? }
//
// The directory listing *is* the registry — no separate index to keep in sync.
//
// Two authors, one registry. Alec's DAGs are written by the page. A session may
// write only its OWN drafts, in the reserved `claude-` slug namespace, and only
// until Alec edits one: from then on it is his (`last_writer: 'alec'`), and a
// session changes it the way it changes any of his DAGs — with a patch card he
// accepts. The same provenance rule as the whiteboard's claude- boards.

import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CLAUDE_PREFIX = 'claude-';

export function defaultConfigsDir() {
  return process.env.DAG_GENERATOR_DATA || join(homedir(), '.dag-generator', 'configs');
}

export function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'dag';
}
function safeSlug(s) {
  return String(s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 80) || 'dag';
}
export const isClaudeSlug = (s) => String(s || '').startsWith(CLAUDE_PREFIX);

// The only way a draft slug is made: minted from a title, never taken from a
// request, so no argument can point this at one of Alec's DAGs.
export function claudeSlugFor(title) {
  const base = slugify(title).replace(/^(claude-)+/, '') || 'dag';
  return `${CLAUDE_PREFIX}${base}`;
}

export function createConfigs({ dir = defaultConfigsDir() } = {}) {
  const pathOf = (slug) => join(dir, safeSlug(slug) + '.json');

  async function put(slug, payload) {
    await mkdir(dir, { recursive: true });
    const path = pathOf(slug);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, path);
  }

  async function list() {
    await mkdir(dir, { recursive: true });
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const j = JSON.parse(await readFile(join(dir, f), 'utf8'));
        out.push({
          slug: f.replace(/\.json$/, ''),
          name: j.name || f,
          updated: j.updated || null,
          nodes: j.model?.nodes?.length || 0,
          edges: j.model?.edges?.length || 0,
          origin: j.origin || null,
          last_writer: j.last_writer || null,
        });
      } catch { /* skip unreadable */ }
    }
    out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    return out;
  }

  async function read(slug) {
    return JSON.parse(await readFile(pathOf(slug), 'utf8'));
  }
  const tryRead = (slug) => read(slug).catch(() => null);

  // Alec's write, from the page. Editing a Claude draft keeps its origin and
  // takes ownership of it. A NEW DAG never lands in the claude- namespace, even
  // if he names it "Claude something".
  async function write({ name, model, slug }) {
    let s = slug ? safeSlug(slug) : slugify(name);
    if (!slug && isClaudeSlug(s)) s = `dag-${s}`;
    const prev = await tryRead(s);
    const payload = { name: name || s, updated: new Date().toISOString(), model, last_writer: 'alec' };
    if (prev?.origin) payload.origin = prev.origin;
    await put(s, payload);
    return { slug: s, name: payload.name, updated: payload.updated };
  }

  // A session's write. Refused once Alec has edited the draft.
  async function writeClaudeDraft({ title, model }) {
    const s = claudeSlugFor(title);
    if (!isClaudeSlug(s)) throw Object.assign(new Error('refusing to write outside the claude namespace'), { code: 'NAMESPACE' });
    const prev = await tryRead(s);
    if (prev && prev.last_writer === 'alec') {
      throw Object.assign(new Error(`Alec has edited ${s}; send a patch card instead`), { code: 'EDITED', slug: s });
    }
    const payload = { name: String(title || s), updated: new Date().toISOString(), model, origin: 'claude', last_writer: 'claude' };
    await put(s, payload);
    return { slug: s, name: payload.name, updated: payload.updated, replaced: Boolean(prev) };
  }

  async function remove(slug) {
    await rm(pathOf(slug), { force: true });
  }

  return { dir, pathOf, list, read, write, writeClaudeDraft, remove };
}
