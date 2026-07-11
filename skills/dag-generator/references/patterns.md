# Causal-structure pattern catalog

Recognize which pattern the user is after, then express it as a formula. Roles in
parentheses set colors/notation.

## Single time point

**Confounding triangle**
```
exposure: A
outcome: Y
confounder: L
Y ~ A + L
A ~ L
```

**Collider bias** (conditioning on C opens a path)
```
exposure: A
outcome: Y
collider: C
adjusted: C
C ~ A + Y
```

**Mediation** (direct + indirect)
```
exposure: A
outcome: Y
mediator: M
M ~ A
Y ~ A + M
```

**M-bias / butterfly** (two latents, a collider between them)
```
unmeasured: U1, U2
collider: Z
exposure: A
outcome: Y
Z ~ U1 + U2
A ~ U1
Y ~ U2 + A
```

**Instrumental variable**
```
instrument: Z
exposure: A
outcome: Y
unmeasured: U
A ~ Z + U
Y ~ A + U
```

## Longitudinal / time-varying

**Time-varying confounding** (L confounds and is affected by prior A)
```
exposure: A0, A1
outcome: Y
confounder: L0, L1
A0 ~ L0
L1 ~ A0 + L0
A1 ~ L1 + A0
Y ~ A1 + A0 + L1 + L0
```

**Selection/censoring bias** — add a censoring node `C_t` caused by `L_t` and
`A_t`, then `adjusted: C` (conditioning on remaining uncensored).

## SWIGs

Build the observed DAG, then intervene on the treatment (app: **⋔ Intervene →
SWIG**; code: `intervene(model, 'A')`). The treatment splits into observed `A` +
regime `G^(s)`; descendants become counterfactual (`Y^s`). See
`../tikz-guide.md` and the manuscript `swig-template.tex` for the visual grammar.

## Informal color palette (legacy skill)

| Role | Fill / Border |
|---|---|
| Exposure/treatment | `#dae8fc` / `#6c8ebf` |
| Outcome | `#fff2cc` / `#d6b656` |
| Confounder / covariate | `#d5e8d4` / `#82b366` |
| Collider / selection | `#f8d7da` / `#c0392b` |
| Mediator | `#e1d5e7` / `#9673a6` |
| Unmeasured / latent | `#f0f0f0` / `#999999` (dashed) |

## Manuscript grammar (named TikZ styles)

Nodes: `rv` (bare label = random var), `cond` (rectangle = conditioning),
`unobs` (gray = unobserved), `regime` (orange diamond = SWIG decision), `fixed`
(orange = set value). Edges: `causal`, `reads` (orange dashed = regime reads a
var), `cfedge` (orange = regime → counterfactual), `bidirected` (dashed).
Source of truth: `~/Code/dag-generator/tikz/dag-styles.tex`.
