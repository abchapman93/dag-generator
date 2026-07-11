---
description: Create, edit, and export a causal DAG or SWIG (informal or manuscript style) via the dag-generator engine.
---

Invoke the `dag-generator` skill to build a causal DAG or SWIG.

Arguments (all optional): `$ARGUMENTS` may contain a formula (e.g.
`A ~ L, Y ~ A + L`), a description of the causal structure, and/or a target style
(`informal` or `manuscript`).

Follow the skill:
1. If a formula/structure was given, use it; otherwise interview for the causal
   structure (variables + roles, temporal structure, conditioning, the point).
2. Express it in the R-style formula DSL.
3. Render with the CLI (`node ~/Code/dag-generator/src/cli/dag.mjs render …`) in the
   requested style, or open the web app (`npm run dev` in `~/Code/dag-generator`)
   for two-way visual/TikZ editing.
4. Show the result and iterate. Treat any generated DAG as a suggestion the user
   accepts/edits/rejects — never auto-commit it into a manuscript.
