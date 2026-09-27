---
name: dag-generator
description: Create, edit, and export causal DAGs and SWIGs — from R-style formulas or an interactive interview — via the dag-generator engine (deterministic CLI + web app). Renders an informal color-coded style for figures/tutoring and a manuscript TikZ style matching the SSVF/HUD-VASH grammar; exports LaTeX, SVG, PNG, PDF, HTML, and dagitty. Use whenever the user says "draw a DAG", "make a DAG", "DAG for X", "causal diagram", "SWIG", "single-world intervention graph", "show the causal structure", "visualize confounding", or wants to turn "A ~ L, Y ~ A + L" into a diagram.
---

# Causal DAG / SWIG Generator

Generate publication-quality causal DAGs and SWIGs. Unlike the old prompt-only
skill, DAGs are now **rendered by an engine**, never hand-drawn — so layout,
LaTeX, and dagitty output are correct and reproducible.

Repo: `~/Code/dag-generator`. Engine CLI: `node ~/Code/dag-generator/src/cli/dag.mjs`
(referred to below as `dag`). Web app: `~/Code/dag-generator/bin/dag-generator` (or
`npm run dev` in the repo) → `http://127.0.0.1:4180/`.

## Three ways to build a DAG

**A. Interactively with Claude (this skill).** Interview the user for structure,
express it as an R-style formula, render with the CLI, show the result, iterate.

**B. In the web app.** Open the app and let the user edit visually and in
TikZ/formula/dagitty side-by-side (constrained two-way editing; nodes snap to a
grid). Offer this when the user wants to fiddle with layout or hand-tune TikZ.

**C. Live, attached (the collab bus).** Alec edits in the app while this session
watches, points back, and suggests changes as cards he accepts or rejects. Use it
when the DAG is being worked out together rather than handed over. See
[Path C](#path-c-live-attached) below.

## Workflow (interactive path)

### 1. Understand the structure
Clarify, or infer from an ongoing methods/tutoring conversation:
- **Variables & roles** — exposure/treatment, outcome, confounder, mediator,
  collider, instrument, covariate, unmeasured/latent.
- **Temporal structure** — single time point or longitudinal.
- **Relationships** — which causes which; any unmeasured confounding.
- **Conditioning** — anything adjusted/restricted/selected on (these get boxes).
- **The point** — confounding, collider bias, mediation, selection, time-varying
  confounding, IV, etc. (see `references/` for the pattern catalog).

### 2. Express as a formula
Write the structure in the R-style DSL (this is the input the engine parses):

```
exposure: A
outcome: Y
confounder: L
unmeasured: U
Y ~ A + L + U
A ~ L + U
```

Syntax: `child ~ parent1 + parent2` (structural), `A -> M -> Y` (chain sugar),
`U1 <-> U2` (latent common cause), and role lines `exposure:`, `outcome:`,
`confounder:`, `mediator:`, `collider:`, `instrument:`, `unmeasured:`/`latent:`,
`adjusted:` (conditioning box). See `references/formula-dsl.md`.

### 3. Render with the CLI
Pick the style — **informal** for slides/tutoring, **manuscript** for papers:

```bash
# informal SVG (color-coded), straight to a file
dag render --formula "$FORMULA" --style informal --format svg -o dag.svg

# manuscript LaTeX (paper grammar: rv/cond/unobs/regime, causal/reads/cfedge)
dag render --formula "$FORMULA" --style manuscript --format tex --wrap standalone -o dag.tex

# manuscript, compiled straight to PDF / PNG / crisp SVG (needs a TeX install)
dag render --formula "$FORMULA" --style manuscript --format pdf -o dag.pdf
dag render --formula "$FORMULA" --style manuscript --format png -o dag.png
```

Formats: `json formula dagitty tex svg html png pdf`. Flags: `--style
informal|manuscript`, `--wrap picture|standalone|figure`, `--layout`/`--no-layout`,
`--compile` (LaTeX SVG/PNG). Input may also be `--dagitty`, `--tikz`, or `--in FILE`.

### 4. SWIGs
For single-world intervention graphs, build the observed-world DAG first, then
intervene on the treatment. In the app: select the treatment node → **⋔ Intervene
→ SWIG**. Programmatically: `import { intervene } from 'src/engine/swig.mjs'`. The
transform splits the treatment (orange `\splitbar`), adds a regime diamond, redraws
its effects as orange `cfedge`s, and superscripts counterfactual descendants —
reproducing the `swig-template.tex` grammar.

### 5. Deliver
- Save with a descriptive filename in the user's workspace.
- For manuscript figures, offer to drop the `.tex` into the relevant paper's
  `tex/figures/` and to `\input{dag-styles}` (the named styles live at
  `~/Code/dag-generator/tikz/dag-styles.tex`).
- Show the rendered PNG/SVG inline so the user can eyeball it, and iterate on the
  formula.

## Path C: live, attached

The app is a collab-lab surface (vendored kit: `kit/vendor/`). Its binding:

| | |
|---|---|
| handles | `@node:<id>`, `@edge:<from>-><to>` — the model's own ids |
| signal kinds | `dag-generator-point-at` / `-message` / `-ping` / `-answer` |
| ask target | `--target dag-generator` |
| context | a PNG crop of the selection (`context_path`), plus the mirror |

**Start and attach.**
1. `dag open` — starts the app if needed and opens it (add a slug to open a saved DAG).
2. Channels and the watch loop follow `/session-attach`: `channels.py list`, pick or
   create one, arm `signals.py watch --channel <id> --once` in the background, and
   re-arm with `--include-backlog` after each collect. Alec picks the same channel
   in the chip at the top of the rail's Session tab.

**Read what is on screen** without being sent anything:
`~/.claude/web-context/mirrors/dag-generator-<slug>/dag.md` (`scratch` for an
unsaved DAG) — formula, dagitty, TikZ, a node/edge table with handles, and
validation. `dag.json` is the model; `dag.svg` a render. The header's model
version tells you if it is stale. `GET /dag/api/state` says which DAG is open.
The mirror follows the most recently edited tab; keep one tab open.

**Suggest a change: `dag suggest`.** Write the DAG you think it should be; the CLI
diffs it against the DAG on screen and posts a `dag-patch` card (ops list + a
preview of the result). Accept applies it as one undo step; Reject tells you so.

```bash
dag suggest --formula "$FORMULA" --rationale "why, in one line" --channel <id>
```

- A formula or dagitty input changes **structure only** — nodes and edges. Labels,
  roles, styles and colours Alec set by hand are never touched. To change those,
  pass `--in model.json` or `--tikz` (all fields compared; `--positions` to move
  nodes too). `--dry-run` prints the payload without posting.
- New nodes are placed next to their neighbours on a free grid cell.
- One live suggestion per DAG: a newer card supersedes the older one, which can no
  longer be accepted. A card for a different DAG than the one open is refused
  until Alec opens that DAG.

**Draft a whole DAG: `dag draft`.** For a first pass, write your own DAG instead
of patching his:

```bash
dag draft --title "Adherence mediation" --formula "$FORMULA"   # → claude-adherence-mediation
dag open claude-adherence-mediation                            # or just tell Alec it's in configs
```

Drafts live in the `claude-` namespace and show a **Claude** badge in `configs ▾`.
You may overwrite your draft until Alec edits it; after that it is his, the next
`dag draft` is refused, and you change it with `dag suggest` like any of his DAGs.

**Point back.** Any ask whose payload carries `anchor` gets a **Show me** button
that selects and pulses those items on the canvas:

```bash
python3 ~/.claude/skills/session-bridge/scripts/outbound.py emit --target dag-generator \
  --channel <id> --prompt "Is this edge meant to be here?" --option Yes --option "No, remove it" \
  --payload '{"anchor": ["@edge:V0->H1", "@node:V0"]}'
```

## Philosophy gate (research-lounge-compatible)

This tool is built to plug into research-lounge's analysis-room later, so it
honors the same contract even now:
- **No autonomous authorship.** A DAG you propose is a *suggestion*. Show it and
  let the user accept / edit / reject — do not silently commit it into a manuscript.
  In the live app this is structural: nothing a session sends reaches Alec's DAG
  except through his Accept on a patch card, and drafts stay in `claude-*`.
- **The user owns layout.** Prefer handing them the app for two-way editing over
  imposing a layout.
- **No patient data.** DAGs describe structure; never embed VA/patient-level data.

## References
- `references/formula-dsl.md` — the R-style DSL grammar in full.
- `references/patterns.md` — the causal-structure pattern catalog (confounding,
  collider, mediation, M-bias, time-varying, IV, target-trial, …).
- `references/tikz-guide.md` — manuscript TikZ styling conventions.
- `references/html-guide.md` — informal HTML/SVG styling conventions & palette.
