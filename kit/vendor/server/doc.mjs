// The document store: one markdown file, read whole, written atomically,
// versioned by content hash. Deliberately this small — the editor is a thin
// surface over a real file on disk; git, sidecars, and doc classes are the
// research-lounge editor's world, not this one's.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

export const versionOf = (content) => createHash('sha1').update(content).digest('hex');

export function createDoc(docPath) {
  async function read() {
    const content = await readFile(docPath, 'utf8');
    return { content, version: versionOf(content) };
  }

  // Temp-then-rename so a concurrent reader (another tab, a session Reading the
  // file) never sees a half-written doc. The tmp name is unique per WRITE:
  // overlapping saves sharing one would truncate each other's bytes, and the
  // later renames would find their file already moved and throw ENOENT.
  async function write(content) {
    const tmp = `${docPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, docPath);
    return versionOf(content);
  }

  return { path: docPath, read, write };
}

// The text analogue of dag-generator's selection crop: the selection framed by
// its surrounding paragraphs. A crop scoped to the selection alone cannot carry
// a relational complaint ("this is out of order" is invisible in a frame that
// excludes what it's out of order WITH), so ±2 paragraphs ride along, with
// markers showing exactly what was pointed at.
export function buildContext(content, start, end, { around = 2 } = {}) {
  start = Math.max(0, Math.min(start, content.length));
  end = Math.max(start, Math.min(end, content.length));

  // Paragraph boundaries: runs of blank lines. Walk boundaries out `around`
  // paragraphs on each side of the selection.
  const breaks = [0];
  const re = /\n[ \t]*\n+/g;
  for (let m; (m = re.exec(content));) breaks.push(m.index + m[0].length);
  breaks.push(content.length);

  let lo = 0, hi = breaks.length - 1;
  for (let i = 0; i < breaks.length; i++) if (breaks[i] <= start) lo = i;
  for (let i = breaks.length - 1; i >= 0; i--) if (breaks[i] >= end) hi = i;
  lo = Math.max(0, lo - around);
  hi = Math.min(breaks.length - 1, hi + around);

  const from = breaks[lo], to = breaks[hi];
  const before = content.slice(from, start);
  const selected = content.slice(start, end);
  const after = content.slice(end, to);
  return [
    `Selection @text:${start}-${end} of ${content.length} chars; shown with surrounding paragraphs.`,
    '',
    `${before}>>> selection >>>\n${selected}\n<<< end selection <<<${after}`,
  ].join('\n').trimEnd() + '\n';
}
