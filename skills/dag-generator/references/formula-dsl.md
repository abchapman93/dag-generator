# Formula DSL — grammar reference

The engine's primary input. Parsed by `src/engine/formula.mjs`. Statements are
separated by newlines or `;`.

## Structural statements

| Form | Meaning |
|---|---|
| `Y ~ A + L` | `A -> Y`, `L -> Y` (RHS is `+`-separated parents) |
| `Y ~ 1` / `Y ~ 0` | declare `Y` with no parents |
| `A -> M -> Y` | arrow-chain sugar: `A -> M`, `M -> Y` |
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
