import { describe, it, expect, afterEach } from 'vitest';
import { detectTools, compile } from '../src/server/compile.mjs';
import { layout } from '../src/engine/layout.mjs';
import * as formula from '../src/engine/formula.mjs';

const model = () => layout(formula.parse('exposure: A\noutcome: Y\nconfounder: L\nY ~ A + L\nA ~ L').model);

describe('compile pipeline', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it('detectTools returns a boolean capability map', async () => {
    const t = await detectTools();
    expect(typeof t.canCompile).toBe('boolean');
    expect(typeof t.latexmk).toBe('boolean');
  });

  it('degrades cleanly to a NO_LATEX error when the toolchain is absent', async () => {
    process.env.PATH = ''; // hide latexmk/which
    await expect(compile(model(), 'pdf')).rejects.toMatchObject({ code: 'NO_LATEX' });
  });

  it('compiles to PDF / SVG / PNG when TeX is present', async () => {
    const t = await detectTools();
    if (!t.canCompile) { console.warn('skipping: no LaTeX toolchain'); return; }
    const pdf = await compile(model(), 'pdf');
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    if (t.dvisvgm) {
      const svg = await compile(model(), 'svg');
      expect(svg.toString()).toContain('<svg');
    }
    if (t.pdftoppm) {
      const png = await compile(model(), 'png');
      expect(png.slice(1, 4).toString()).toBe('PNG');
    }
  }, 60000);
});
