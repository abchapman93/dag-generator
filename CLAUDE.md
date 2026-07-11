# dag-generator — Claude Code instructions

Solo-dev project (Alec). A causal DAG/SWIG engine + web app + Claude skill. See
[README.md](README.md) for the architecture map.

## Run it

```bash
npm run dev    # web app at http://127.0.0.1:4180/
npm test       # vitest: engine round-trips + LaTeX compile pipeline
```

## Architecture invariants (don't break these)

- **`src/engine/` stays pure** — no DOM, no Express, no node-only APIs. It is
  imported directly in the browser (`/engine/*.mjs`) AND by the CLI/server. Only
  `src/server/compile.mjs` may use `child_process`/`fs`.
- **The canonical TikZ grammar is the round-trip contract.** `tikz.emit` and
  `tikz.parse` must stay inverses over the documented grammar (one `\node`/`\draw`
  per line, absolute grid coords, explicit bends). Anything off-grammar is FLAGGED
  by the parser, never silently dropped — that's what makes two-way editing safe.
- **`node.style` (rv/cond/unobs/regime/fixed) is authoritative** for rendering &
  round-trip; `node.role` is optional semantic metadata for informal colors.
- **Grid-snapped layout.** Node coordinates are integers; the layout engine and
  the canvas both snap to the grid.

## Research-lounge compatibility

The app is a self-managing module: `mount({ stage, ... })` runs standalone and,
later, as an analysis-room `dag` tab (add `<button data-view="dag">`, a `<script>`,
and a `VIEWS.dag` entry — no shell changes). Honor the philosophy gate: generated
DAGs are suggestions (accept/edit/reject), never auto-committed; no patient data.

## Skill

`skills/dag-generator/` and `commands/dag-generator.md` are symlinked into
`~/.claude`. Edits here are live for Claude Code. The skill drives DAG creation via
the CLI (deterministic), never by hand-drawing SVG/TikZ.

## Conventions

- Vanilla JS, ESM, no build step, no frontend npm deps (mirror research-lounge).
- Add a test for every engine change (`test/*.test.mjs`).
- Verify app changes in the browser before calling them done.
