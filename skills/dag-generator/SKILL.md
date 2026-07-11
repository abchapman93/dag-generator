---
name: dag-generator
description: Create, edit, and export causal DAGs and SWIGs — from R-style formulas or an interactive interview — via the dag-generator engine (deterministic CLI + web app). Renders an informal color-coded style for figures/tutoring and a manuscript TikZ style matching the SSVF/HUD-VASH grammar; exports LaTeX, SVG, PNG, PDF, HTML, and dagitty. Use whenever the user says "draw a DAG", "make a DAG", "DAG for X", "causal diagram", "SWIG", "single-world intervention graph", "show the causal structure", "visualize confounding", or wants to turn "A ~ L, Y ~ A + L" into a diagram.
---

# Causal DAG / SWIG Generator

Generate publication-quality causal DAGs and SWIGs. Unlike the old prompt-only
skill, DAGs are now **rendered by an engine**, never hand-drawn — so layout,
LaTeX, and dagitty output are correct and reproducible.

Repo: `~/Code/dag-generator`. Engine CLI: `node ~/Code/dag-generator/src/cli/dag.mjs`
(referred to below as `dag`). Web app: `npm run dev` in the repo → `http://127.0.0.1:4180/`.

## Two ways to build a DAG

**A. Interactively with Claude (this skill).** Interview the user for structure,
express it as an R-style formula, render with the CLI, show the result, iterate.

**B. In the web app.** Open the app and let the user edit visually and in
TikZ/formula/dagitty side-by-side (constrained two-way editing; nodes snap to a
grid). Offer this when the user wants to fiddle with layout or hand-tune TikZ.

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

## Philosophy gate (research-lounge-compatible)

This tool is built to plug into research-lounge's analysis-room later, so it
honors the same contract even now:
- **No autonomous authorship.** A DAG you propose is a *suggestion*. Show it and
  let the user accept / edit / reject — do not silently commit it into a manuscript.
- **The user owns layout.** Prefer handing them the app for two-way editing over
  imposing a layout.
- **No patient data.** DAGs describe structure; never embed VA/patient-level data.

## References
- `references/formula-dsl.md` — the R-style DSL grammar in full.
- `references/patterns.md` — the causal-structure pattern catalog (confounding,
  collider, mediation, M-bias, time-varying, IV, target-trial, …).
- `references/tikz-guide.md` — manuscript TikZ styling conventions.
- `references/html-guide.md` — informal HTML/SVG styling conventions & palette.
