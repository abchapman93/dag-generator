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
npm test          # engine, server, compile pipeline + the kit drift check
npm run dev       # web app at http://127.0.0.1:4180/
npm run sync-kit  # re-vendor the collab kit after it changes upstream
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
- **`src/server/`** — `app.mjs` (factory) + `router.mjs` (`/dag/api/*`): LaTeX
  compile (`latexmk` → `dvisvgm`/`pdftoppm`; degrades to `.tex`-only if TeX is
  absent), the saved-DAG registry, the bus mirror, and the collab bus routes.
- **`kit/`** — the collab-lab kit, vendored (`kit/vendor/`, never edited here;
  `npm run sync-kit` re-copies it and `kit/kit-drift.test.mjs` fails on drift).
- **`src/frontend/`** — vanilla-JS app; imports the engine directly in the
  browser; constrained two-way editing (grid canvas ↔ canonical TikZ ↔ formula).
- **`src/cli/dag.mjs`** — deterministic CLI used by the skill.
- **`skills/` + `commands/`** — the Claude Code skill (symlinked into `~/.claude`).
- **`tikz/dag-styles.tex`** — the named-style visual grammar (single source).

## Saving & exporting

- **Configs** — the toolbar's `configs ▾` menu saves the current DAG to a named
  registry, reopens/deletes saved ones, and starts a blank DAG (`＋ New`, or
  ⌘/Ctrl-N). Once a config is open, edits **auto-save** back to it (debounced; a
  `•` on the name chip shows a pending save). Configs live as JSON under
  `~/.dag-generator/configs/` (override with `DAG_GENERATOR_DATA`); the directory
  listing *is* the registry. Served by `GET/PUT/DELETE /dag/api/configs`.
- **Export destination** — `export ▾` uses the browser's native Save dialog
  (File System Access API) so you choose the folder and filename; it falls back
  to a normal download where that API isn't available.
- **Keyboard** — ⌘/Ctrl-Z undo, ⌘/Ctrl-⇧-Z (or ⌘/Ctrl-Y) redo, ⌘/Ctrl-N new
  blank DAG, Delete/Backspace removes the selection. History is per-DAG and
  coalesces rapid bursts (e.g. a drag) into one step; text-field edits keep native
  undo. (Note: some browsers reserve ⌘N for "new window".)

## Working with a Claude session (collab-lab surface)

The app is a surface on the collab-lab bus (`~/.claude/web-context/`), built on
the vendored kit:

- **⌖ point at** (or `p`) sends the selection to the session as `@node:`/`@edge:`
  handles plus a PNG crop; `▾` adds a note or a quick reply; nothing selected sends
  a message or a ping. The **channel chip** at the right of the toolbar scopes all
  of it to one session.
- **Cards** from the session appear in the rail (which widens while one is open):
  questions, **patch cards** (a suggested change — ops, a preview, Accept/Reject;
  Accept is one undo step), and **Show me** buttons where the session points at
  nodes or edges. ✕ dismisses a card without telling the session anything.
- **Claude drafts** show a *Claude* badge in `configs ▾`; editing one makes it yours.
- The open DAG is mirrored to `~/.claude/web-context/mirrors/dag-generator-<slug>/`
  for sessions to read.

Session side: `dag open`, `dag draft`, `dag suggest` (see `dag help` and the
skill's Path C).

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
