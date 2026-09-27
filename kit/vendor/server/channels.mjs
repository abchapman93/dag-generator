// Channel registry — the unit a session attaches to and a surface's picker
// selects. A channel is a named, scoped feed on the shared bus: signals and
// asks stamped with its id are visible only to readers attached to it, which
// is what lets two Claude Code sessions listen concurrently and gives a fresh
// attach a clean backlog by construction.
//
// This is a filesystem contract, not an API: one JSON file per channel in
// ~/.claude/web-context/channels/, schema of record with channels.py
// (~/.claude/skills/session-bridge/scripts/) — the interop test in ../test
// runs the real Python against this implementation.
//
// The registry file is deliberately small — no stored last_activity, because
// storing it would make every signal writer also a registry writer (two files
// per emit, contention, drift). listChannels computes it on demand by
// scanning signals/, which prune keeps small.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A channel_id indexes a filename, so refuse anything that isn't one — it
// arrives over HTTP and `../../x` must not walk out of the store.
const SAFE_ID = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith('.');

const oneLine = (s, limit = 300) => (String(s || '').split(/\s+/).filter(Boolean).join(' ').slice(0, limit)) || null;

function newChannelId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${t}-${randomBytes(2).toString('hex')}`;
}

// The tmp name is unique per WRITE, not per process: two archives of one
// channel can land at once, and with a shared tmp name the second rename finds
// its file already moved and throws ENOENT.
async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }   // mid-write, malformed, or gone — skip it
}

export function createChannels({ webContext } = {}) {
  const base = webContext || process.env.COLLAB_WEBCTX || join(homedir(), '.claude', 'web-context');
  const dir = join(base, 'channels');
  const signalDir = join(base, 'signals');
  const outboundDir = join(base, 'outbound');

  async function readChannelFile(path) {
    const channel = await readJson(path);
    return (channel && typeof channel === 'object' && channel.channel_id) ? channel : null;
  }

  // One pass over signals/: newest created_at and pending (unconsumed) count
  // per channel, plus the same pair for unchanneled traffic (key null).
  async function scanActivity() {
    const stats = new Map();
    let names;
    try { names = await readdir(signalDir); }
    catch { return stats; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const signal = await readJson(join(signalDir, name));
      if (!signal || typeof signal !== 'object') continue;
      const key = signal.channel || null;
      const entry = stats.get(key) || { last_activity: null, pending: 0 };
      const created = signal.created_at || '';
      if (created > (entry.last_activity || '')) entry.last_activity = created;
      if (!signal.consumed_at) entry.pending += 1;
      stats.set(key, entry);
    }
    return stats;
  }

  // Newest first, with computed last_activity + pending per channel. The
  // shape matches `channels.py list` exactly, so an app can hand it straight
  // to its /api/channels route: unchanneled traffic is invisible to a scoped
  // watch, so its pending count is reported here rather than silently
  // vanishing.
  async function listChannels({ includeArchived = false } = {}) {
    let names;
    try { names = await readdir(dir); }
    catch { names = []; }   // no registry yet — no channels, not an error
    const stats = await scanActivity();
    const channels = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const channel = await readChannelFile(join(dir, name));
      if (!channel) continue;
      if (!includeArchived && channel.archived_at) continue;
      const entry = stats.get(channel.channel_id) || {};
      channels.push({ ...channel, last_activity: entry.last_activity ?? null, pending: entry.pending ?? 0 });
    }
    channels.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const unchanneled = stats.get(null) || {};
    return { channels, unchanneled_pending: unchanneled.pending ?? 0 };
  }

  async function getChannel(channelId) {
    if (!SAFE_ID(channelId)) return null;
    return readChannelFile(join(dir, `${channelId}.json`));
  }

  // name is the human label; the id is the identity. Names are not
  // unique-enforced — two writers with no locking shouldn't fight over it.
  async function createChannel({ name, note = null, by = null } = {}) {
    const label = oneLine(name, 80);
    if (!label) throw new Error('name is required');
    const channel = {
      channel_id: newChannelId(),
      name: label,
      created_at: new Date().toISOString(),
      created_by: oneLine(by, 60),
      note: oneLine(note),
      archived_at: null,
    };
    await mkdir(dir, { recursive: true });
    await writeAtomic(join(dir, `${channel.channel_id}.json`), JSON.stringify(channel, null, 2) + '\n');
    return channel;
  }

  // Stamp archived_at; idempotent. Pickers hide archived channels, the store
  // keeps them — archive is the reversible verb, delete is the sharp one.
  async function archiveChannel(channelId) {
    if (!SAFE_ID(channelId)) return null;
    const path = join(dir, `${channelId}.json`);
    const channel = await readChannelFile(path);
    if (!channel) return null;
    if (channel.archived_at) return channel;
    channel.archived_at = new Date().toISOString();
    await writeAtomic(path, JSON.stringify(channel, null, 2) + '\n');
    return channel;
  }

  // Unlink the registry file AND purge the channel's signals, asks, and the
  // context files those referenced. Deletion is a plain unlink with nothing
  // behind it — no picker routes this; it exists for symmetry with
  // channels.py, whose CLI is the sanctioned way to mean it.
  async function deleteChannel(channelId) {
    if (!SAFE_ID(channelId)) return null;
    const path = join(dir, `${channelId}.json`);
    if (!await readChannelFile(path)) return null;
    const removed = { signals: 0, asks: 0, context: 0 };
    for (const [storeDir, countKey] of [[signalDir, 'signals'], [outboundDir, 'asks']]) {
      let names;
      try { names = await readdir(storeDir); }
      catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const itemPath = join(storeDir, name);
        const item = await readJson(itemPath);
        if (!item || typeof item !== 'object' || item.channel !== channelId) continue;
        // Both side files: the excerpt (context_path) and the full message body
        // (note_path). Separate fields because they hold different things —
        // document text vs the person's own words — and a purge that knew only
        // the first would leave the second orphaned in context/ forever.
        for (const field of ['context_path', 'note_path']) {
          if (!item[field]) continue;
          try { await unlink(item[field]); removed.context += 1; } catch {}
        }
        try { await unlink(itemPath); removed[countKey] += 1; } catch {}
      }
    }
    try { await unlink(path); } catch { return null; }
    return removed;
  }

  return { listChannels, getChannel, createChannel, archiveChannel, deleteChannel };
}
