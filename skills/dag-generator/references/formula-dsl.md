# Formula DSL — grammar reference

The engine's primary input. Parsed by `src/engine/formula.mjs`. Statements are
separated by newlines or `;`.

## Structural statements

| Form | Meaning |
|---|---|
| `Y ~ A + L` | `A -> Y`, `L -> Y` (RHS is `+`-separated parents) |
| `Y ~ 1` / `Y ~ 0` | declare `Y` with no parents |
| `A -> M -> Y` | arrow-chain sugar: `A -> M`, `M -> Y` |
| `S -> abx : "Severe"` | single arrow carrying a branch label (decision trees) |
| `U1 <-> U2` | bidirected (unobserved common cause), drawn dashed |

On a line, top-level commas separate independent formulas:
`A ~ L, Y ~ A + L`.

## Role annotations

`keyword: id1, id2` — sets semantic roles (drive informal colors) and, for some,
the manuscript primitive style:

| Keyword | Effect |
|---|---|
| `exposure:` | role exposure (informal blue) |
| `outcome:` | role outcome (informal yellow) |
| `confounder:` | role confounder (informal green) |
| `mediator:` | role mediator (informal purple) |
| `collider:` | role collider (informal red) |
| `instrument:` | role instrument |
| `covariate:` | role covariate (informal green) |
| `unmeasured:` / `latent:` | style `unobs` — gray text (manuscript), gray dashed (informal) |
| `adjusted:` | style `cond` — conditioning box (rectangle) |

### Flowchart / decision-tree family

For decision-rule trees (not causal DAGs). These render the same in both styles —
their color is the point:

| Keyword | Effect |
|---|---|
| `decision:` | style `decision` — branch/test box |
| `leaf:` | style `leaf` — neutral terminal box (gray) |
| `recommend:` | style `leafPos` — positive terminal (green) |
| `avoid:` | style `leafNeg` — negative terminal (red) |

Pair with labelled arrows (`S -> abx : "Severe"`) for branch conditions. For a
custom terminal color outside the family, set a per-node override in the TikZ panel:
`\node[leaf, fill=blue!12, draw=blue!55!black](more) at (...) {...};` — the
`fill`/`draw`/`text` options are round-trippable (use comma-free xcolor expressions).

## Coordinates

The DSL carries **no coordinates** — positions come from auto-layout
(`layout.mjs`, layered left→right, snapped to grid). To fix positions, edit in the
app or the TikZ panel (`\node[rv](A) at (2,1) {...}`), which is the canonical,
round-trippable layout source.

## Example

```
exposure: A
outcome: Y
confounder: L
unmeasured: U
mediator: M
Y ~ M + L + U
M ~ A
A ~ L + U
U <-> Uc
```
