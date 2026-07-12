# dag-generator

Create, edit, and export causal **DAGs and SWIGs** — from R-style formulas or an
interactive/visual editor. Two visual styles (informal color-coded for figures &
tutoring; manuscript TikZ matching the SSVF/HUD-VASH grammar) and export to
LaTeX, SVG, PNG, PDF, HTML, and dagitty.

Built as a Claude Code skill **and** a standalone web app, designed to plug into
[research-lounge](../research-lounge)'s analysis-room as a tab later.

## Quick start

```bash
npm install
npm test          # engine + compile pipeline (22+ tests)
npm run dev       # web app at http://127.0.0.1:4180/
```

CLI:

```bash
node src/cli/dag.mjs render --formula "A ~ L, Y ~ A + L" --style manuscript --format tex
node src/cli/dag.mjs render --formula "exposure: A
outcome: Y
confounder: L
Y ~ A + L
A ~ L" --style manuscript --format pdf -o dag.pdf
```

## How it fits together

```
formula ─┐                              ┌─ svg / html   (engine, pure JS)
dagitty ─┼─▶  canonical model  ──▶  ────┼─ tex          (canonical grammar)
tikz ────┘     (src/engine)             └─ pdf/svg/png   (LaTeX compile: src/server)
```

- **`src/engine/`** — pure, dependency-free, browser-importable: `model`,
  `formula`, `dagitty`, `tikz` (round-trippable), `layout`, `svg`, `html`, `swig`.
- **`src/server/`** — Express router + LaTeX compile pipeline
  (`latexmk` → `dvisvgm`/`pdftoppm`; degrades to `.tex`-only if TeX is absent).
- **`src/frontend/`** — vanilla-JS app; imports the engine directly in the
  browser; constrained two-way editing (grid canvas ↔ canonical TikZ ↔ formula).
- **`src/cli/dag.mjs`** — deterministic CLI used by the skill.
- **`skills/` + `commands/`** — the Claude Code skill (symlinked into `~/.claude`).
- **`tikz/dag-styles.tex`** — the named-style visual grammar (single source).

## Saving & exporting

- **Configs** — the toolbar's `configs ▾` menu saves the current DAG to a named
  registry and reopens/deletes saved ones. Configs live as JSON under
  `~/.dag-generator/configs/` (override with `DAG_GENERATOR_DATA`); the directory
  listing *is* the registry. Served by `GET/PUT/DELETE /dag/api/configs`.
- **Export destination** — `export ▾` uses the browser's native Save dialog
  (File System Access API) so you choose the folder and filename; it falls back
  to a normal download where that API isn't available.

## Two-way editing

The exported TikZ **is** the layout source of truth. Nodes snap to a grid and
only the canonical named-style grammar is accepted, so editing the `.tex` panel
and dragging on the canvas stay reliably in sync; off-grammar TikZ is flagged, not
silently dropped.

## Status

V1 (M0–M5): engine + CLI + compile + standalone app + basic SWIG + skill. See
the plan in the parent session. Fast-follows: analysis-room tab wiring,
d-separation/adjustment-set helpers, SWIG-layout polish, `\cfs` orange
superscripts, CodeMirror/KaTeX in the app.
