# Backlog

Lightweight, demand-pulled. Not a sprint plan — just things worth doing when they
come up again.

## Configs: support external/linked config files

**Added 2026-07-22**, from hpd-ssvf-hudvash Paper 1 DAG-editing session.

Today `src/server/configs.mjs` only reads/writes flat JSON files under one data
dir (default `~/.dag-generator/configs`, override via `DAG_GENERATOR_DATA`).
Every config from every project lands in the same flat registry — there's no way
to point a single saved config at a path inside a project repo, so a paper's DAG
can't be git-tracked alongside the paper without leaving the app's registry.

**Wanted:** some way to save (or link) a config so its JSON lives inside a
project directory and is picked up by `listConfigs()`/`readConfig()` as if it
were local. Options to weigh when this gets picked up:
- A `path` field in a lightweight pointer file (`{ "path": "/abs/or/relative" }`)
  that `readConfig`/`writeConfig` follow instead of reading `slug.json` directly.
- Multiple registry roots (`DAG_GENERATOR_DATA` becomes a search path, or the
  app accepts a per-request project dir) instead of one fixed `DIR`.
- Just document the symlink workaround (`ln -s /path/in/project/x.json
  ~/.dag-generator/configs/x.json`) if a code change isn't worth it — `readFile`/
  `writeFile` already follow symlinks transparently, so this works today with no
  server change, at the cost of the registry entry silently vanishing if the
  symlink or its target ever moves.

Not urgent — the symlink workaround is a fine stopgap when a specific paper's DAG
needs to be git-tracked in its own repo.

## Node label placement / box sizing (label-above, auto-width, or width override)

**Added 2026-07-24**, from the collab-lab A2 pneumonia ATS methods-tree dogfood
(`~/Code/collab-lab/friction/2026-07-24-a2-ats-methods-tree.md`). Spec only —
**not implemented**; Alec is deciding whether the feature is wanted at all.

**The trigger.** Decision-tree nodes with prose labels ("Comorbidities",
"No comorbidity", "Antibiotics") overflow their boxes. Alec wants the figure to
match the pneumonia *results* tree
(`~/Code/pneumonia-aim3-dtr/output/figures/integrated/tree_contour_integrated_moderate_90day.pdf`),
where category labels sit **above** each panel, not inside it.

**Root cause.** In the SVG/canvas renderer, box dimensions are FIXED CONSTANTS per
style (`svg.mjs` `FLOW.decision = { rx: 34, ry: 22 }` → every box 68×44px), never
derived from the label and with no per-node geometry override (only `fill`/`stroke`/
`text` *colours* round-trip). Note: this is an **SVG/canvas-only** artifact — the
LaTeX styles use `minimum size=7mm` + `inner sep`, so a *compiled* `.tex` box already
auto-grows to fit its text. Only the fast renderer clips.

Three candidate directions (not mutually exclusive):

### A. Auto-size SVG/canvas boxes to label width (correctness fix)
Measure the label and set `rx` from it (like LaTeX already does), instead of a fixed
constant. Boxes grow to fit their text; overflow disappears; the SVG renderer matches
the LaTeX compile.
- **Touches:** `svg.mjs visual()`/`renderNode` width calc, `canvas.mjs nodeVisual`;
  no model/grammar change, no round-trip risk (geometry stays derived, not stored).
- **Text measurement:** no DOM in the engine → approximate width from character count
  × font-metric factor at font-size 19 (good enough for Latin labels), or expose a
  measured width from the canvas and keep the engine's estimate for headless SVG.
- **Pro:** smallest change, fixes the actual bug, keeps labels *inside* boxes.
- **Con:** does NOT match the results-figure "label above panel" look — if that
  specific style is the goal, this alone isn't it. It also **dissolves the stated
  motivation for direction C** (see #2 finding in the friction log).

### B. Per-node width override (`node.w`)
Add a stored geometry field, plumbed like `fill`/`stroke`: model field + `svg`/`canvas`
honour it + TikZ round-trips it as `minimum width=<n>mm` (a REAL TikZ key, unlike C's).
- **Touches:** `model.mjs` (normalize/validate), `svg.mjs`, `canvas.mjs`, `tikz.mjs`
  emit+parse, +test. Grid-snap question: is width on the grid or free px/mm?
- **Pro:** manual control; real TikZ key so manuscript-compile fidelity is intact.
- **Con:** manual per-node fiddling; doesn't auto-solve overflow; still labels-inside.

### C. Node label placement (`node.labelPos: 'above' | 'center'`) — the results-fig match
Mirror how EDGES already carry `labelPos`. `above` draws the label above the box top
edge; the box itself can be empty (matches results fig: empty/colored panel, label
above). This is the direction Alec asked about in #2.
- **Model:** add `node.labelPos` (default absent = center), preserved verbatim like
  `edge.labelPos`. `model.mjs normalizeNode`/`validate`.
- **svg.mjs `renderNode`:** if `labelPos === 'above'`, place text at
  `(p.x, p.y - v.ry - GAP)`, `text-anchor=middle`, baseline bottom; draw the box
  regardless. (Font-style already conditional via `UPRIGHT_STYLES`.)
- **canvas.mjs `nodeSVG`:** identical, for parity (same duplication noted in the
  friction log — a shared node-render helper would pay off here).
- **TikZ round-trip:** emit `labelpos=above` in the node option list (slots in beside
  `fill`/`draw`/`text` in `tikz.mjs emit`); `parse` recognises `labelpos=<v>` in the
  option loop → `node.labelPos`. Round-trips within OUR grammar.
- **Manuscript-compile caveat:** `labelpos` is NOT a native TikZ key, so a compiled
  `.tex` would ignore it (label renders centered, not above) OR error. Mitigations:
  (i) add a no-op `labelpos/.code={}` to `STYLE_BLOCK` so compile doesn't error but
  doesn't move the label either (SVG-faithful, LaTeX-approx), or (ii) emit the *real*
  TikZ form `label={above:{<text>}}` with an empty node body `{}` and teach `parse`
  to read it back — higher parser cost (nested braces) but true LaTeX fidelity.
  Decision needed if the deliverable is ever LaTeX-compiled vs engine-SVG/PNG.
- **Pro:** the only direction that matches the results-figure style; sidesteps
  text-fitting entirely (label lives outside the box).
- **Con:** biggest change (4 files + round-trip + test); manuscript-compile fidelity
  question above.

**Open decision (Alec):** is the goal (a) just stop the clipping — then **A** is
cheapest and most correct; (b) manual sizing control — **B**; or (c) truly match the
results figure's label-above-panel style — **C** (optionally atop A/B). C's stated
"sidestep fitting text" rationale weakens if A lands first.

**Also held (same session):** a shared **legend / column-header** concept at the top
of the figure (green=Antibiotics / red=No antibiotics key; and the Severity | Virus |
Comorbidities | Decision column headers). The engine has NO out-of-graph annotation
primitive today — legends/headers can only be faked as floating labelled nodes.
Deferred by Alec 2026-07-24; revisit with A/B/C.

## Auto-layout hides edges behind collinear chains

**Added 2026-09-27**, from the collab-kit migration (a `dag draft` of
`Y ~ A + M + L, M ~ A + L, A ~ L` laid out as one row `L A M Y`, so `L → Y`,
`A → Y` and `L → M` ran straight through the nodes between them). The same
complaint is why collab-lab's whiteboard does its own layout
(`apps/whiteboard/shared/dag-layout.mjs`). `layout.mjs` layers by depth and snaps
to the grid but never checks whether an edge passes through a node. Candidate
fix: after layering, bend (or nudge a row for) any straight edge whose segment
hits another node's cell — the same `onSegment` test `patch.mjs` now uses to
place new nodes.
