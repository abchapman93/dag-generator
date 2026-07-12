// Saved-DAG registry. Each config is a JSON file { name, updated, model } under
// the data dir (default ~/.dag-generator/configs, override DAG_GENERATOR_DATA).
// The directory listing *is* the registry — no separate index to keep in sync.

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = process.env.DAG_GENERATOR_DATA || join(homedir(), '.dag-generator', 'configs');

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'dag';
}
function safeSlug(s) {
  return String(s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 80) || 'dag';
}

export async function listConfigs() {
  await mkdir(DIR, { recursive: true });
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(join(DIR, f), 'utf8'));
      out.push({
        slug: f.replace(/\.json$/, ''),
        name: j.name || f,
        updated: j.updated || null,
        nodes: j.model?.nodes?.length || 0,
        edges: j.model?.edges?.length || 0,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return out;
}

export async function readConfig(slug) {
  const raw = await readFile(join(DIR, safeSlug(slug) + '.json'), 'utf8');
  return JSON.parse(raw);
}

export async function writeConfig({ name, model, slug }) {
  await mkdir(DIR, { recursive: true });
  const s = slug ? safeSlug(slug) : slugify(name);
  const payload = { name: name || s, updated: new Date().toISOString(), model };
  await writeFile(join(DIR, s + '.json'), JSON.stringify(payload, null, 2), 'utf8');
  return { slug: s, name: payload.name, updated: payload.updated };
}

export async function deleteConfig(slug) {
  await rm(join(DIR, safeSlug(slug) + '.json'), { force: true });
}

export function configsDir() { return DIR; }
