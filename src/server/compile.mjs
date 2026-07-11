// Manuscript-style compile pipeline: model -> standalone .tex -> latexmk -> PDF,
// then PDF -> SVG (dvisvgm) / PNG (pdftoppm). Degrades gracefully: if the TeX
// toolchain is absent, callers fall back to engine-native .tex/.svg/.html.
//
// All work happens in an ephemeral temp dir that is cleaned up afterwards.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit as emitTikz } from '../engine/tikz.mjs';

const run = promisify(execFile);

async function has(bin) {
  try { await run('which', [bin]); return true; } catch { return false; }
}

// Which compile tools are available on this machine.
export async function detectTools() {
  const [latexmk, dvisvgm, pdftoppm, rsvg] = await Promise.all(
    ['latexmk', 'dvisvgm', 'pdftoppm', 'rsvg-convert'].map(has)
  );
  return { latexmk, dvisvgm, pdftoppm, rsvg, canCompile: latexmk };
}

// Compile a model to a Buffer in the requested format ('pdf' | 'svg' | 'png').
// Throws a clear error if the required tool is missing.
export async function compile(model, format = 'pdf', opts = {}) {
  const tools = await detectTools();
  if (!tools.latexmk) {
    const err = new Error('LaTeX toolchain not found (latexmk). Manuscript PDF/SVG/PNG export requires a TeX install; use tex/svg/html engine formats instead.');
    err.code = 'NO_LATEX';
    throw err;
  }
  const dir = await mkdtemp(join(tmpdir(), 'dag-'));
  try {
    const tex = emitTikz(model, { wrap: 'standalone' });
    const texPath = join(dir, 'fig.tex');
    await writeFile(texPath, tex, 'utf8');

    const latexmk = async (engineFlag) => {
      await run('latexmk', [engineFlag, '-interaction=nonstopmode', '-halt-on-error', `-outdir=${dir}`, texPath], { cwd: dir })
        .catch(async (e) => {
          const log = await readFile(join(dir, 'fig.log'), 'utf8').catch(() => '');
          const tail = log.split('\n').filter((l) => /^!|Error|Undefined/.test(l)).slice(0, 6).join('\n');
          throw new Error(`latexmk failed:\n${tail || (e.stderr || e.message)}`);
        });
    };

    // SVG: compile to DVI and let dvisvgm read it natively (no poppler needed —
    // this build of dvisvgm cannot parse PDF). Crisp vector output.
    if (format === 'svg') {
      if (!tools.dvisvgm) throw new Error('dvisvgm not found (needed for compiled SVG).');
      await latexmk('-dvi');
      const dviPath = join(dir, 'fig.dvi');
      await access(dviPath);
      const svgPath = join(dir, 'fig.svg');
      await run('dvisvgm', ['--no-fonts=0', '--exact', dviPath, '-o', svgPath], { cwd: dir });
      return await readFile(svgPath);
    }

    // PDF / PNG: compile to PDF.
    await latexmk('-pdf');
    const pdfPath = join(dir, 'fig.pdf');
    await access(pdfPath);

    if (format === 'pdf') return await readFile(pdfPath);

    if (format === 'png') {
      if (!tools.pdftoppm) throw new Error('pdftoppm not found (needed for PNG).');
      const dpi = opts.dpi || 300;
      await run('pdftoppm', ['-png', '-r', String(dpi), '-singlefile', pdfPath, join(dir, 'fig')], { cwd: dir });
      return await readFile(join(dir, 'fig.png'));
    }

    throw new Error(`unknown compile format '${format}'`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Rasterize an engine SVG string to PNG without LaTeX (uses rsvg-convert).
export async function svgToPng(svgString, opts = {}) {
  if (!(await has('rsvg-convert'))) throw new Error('rsvg-convert not found (needed for engine-SVG PNG).');
  const dir = await mkdtemp(join(tmpdir(), 'dag-'));
  try {
    const svgPath = join(dir, 'fig.svg'), pngPath = join(dir, 'fig.png');
    await writeFile(svgPath, svgString, 'utf8');
    const args = ['-f', 'png'];
    if (opts.zoom) args.push('-z', String(opts.zoom));
    args.push('-o', pngPath, svgPath);
    await run('rsvg-convert', args);
    return await readFile(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
