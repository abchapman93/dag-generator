# TikZ DAG Generation Guide

## Output format

Generate a complete, compilable LaTeX file (or a `\begin{figure}...\end{figure}` block the user can paste into an existing document). Always include the necessary preamble packages.

## Required packages

```latex
\usepackage{tikz}
\usetikzlibrary{arrows.meta, positioning, decorations.pathreplacing, calc, fit}
```

## Base TikZ style definitions

Define these at the top of every DAG. Adapt colors based on whether the user wants grayscale (manuscript default) or color.

### Grayscale (manuscript default)

```latex
\tikzset{
  % Node styles
  var/.style={
    draw, rectangle, rounded corners=3pt,
    minimum width=1.8cm, minimum height=0.9cm,
    font=\small, inner sep=4pt,
    fill=white, draw=black!70, thick
  },
  treatment/.style={var, fill=black!8},
  outcome/.style={var, fill=black!8, double, double distance=1pt},
  confounder/.style={var},
  conditioned/.style={var, fill=black!12, double, double distance=1.5pt, draw=black!80},
  unmeasured/.style={var, dashed, fill=white, draw=black!50, text=black!60, font=\small\itshape},
  mediator/.style={var, fill=black!5},
  % Edge styles
  causal/.style={-{Stealth[length=5pt]}, thick, black!70},
  biasing/.style={-{Stealth[length=5pt]}, thick, red!70!black},
  blocked/.style={-{Stealth[length=5pt]}, thick, black!30, dashed},
  bidirected/.style={{Stealth[length=4pt]}-{Stealth[length=4pt]}, thick, black!40, dashed},
  % Label style
  timelabel/.style={font=\scriptsize\color{black!50}, above},
}
```

### Color version (presentations, tutoring)

```latex
\tikzset{
  treatment/.style={var, fill=blue!10, draw=blue!50!black},
  outcome/.style={var, fill=yellow!15, draw=yellow!60!black, double, double distance=1pt},
  confounder/.style={var, fill=green!10, draw=green!50!black},
  conditioned/.style={var, fill=red!10, draw=red!60!black, double, double distance=1.5pt},
  unmeasured/.style={var, dashed, fill=black!3, draw=black!40, font=\small\itshape},
  mediator/.style={var, fill=violet!10, draw=violet!50!black},
  biasing/.style={-{Stealth[length=5pt]}, thick, red!70!black},
}
```

## Node placement

Use TikZ `positioning` library for relative placement. This keeps the layout clean and adjustable.

### Single time point DAG

```latex
\begin{tikzpicture}[node distance=2.5cm and 3cm]
  \node[confounder] (L) {$L$};
  \node[treatment, below right=1.5cm and 2.5cm of L] (A) {$A$};
  \node[outcome, right=3cm of A] (Y) {$Y$};

  \draw[causal] (L) -- (A);
  \draw[causal] (L) to[bend left=20] (Y);
  \draw[causal] (A) -- (Y);
\end{tikzpicture}
```

### Longitudinal DAG (time-varying)

Arrange in a grid. Time flows left to right. Use consistent column spacing.

```latex
\begin{tikzpicture}[
  node distance=1.2cm and 2.8cm,
  every node/.style={font=\small}
]
  % Time labels
  \node[timelabel] at (0, 2.2) {$t=0$};
  \node[timelabel] at (2.8, 2.2) {$t=1$};
  \node[timelabel] at (5.6, 2.2) {$t=2$};

  % Row 1: Covariates
  \node[confounder] (L0) at (0, 1.5) {$L_0$};
  \node[confounder] (L1) at (2.8, 1.5) {$L_1$};
  \node[confounder] (L2) at (5.6, 1.5) {$L_2$};

  % Row 2: Treatment
  \node[treatment] (A0) at (0, 0) {$A_0$};
  \node[treatment] (A1) at (2.8, 0) {$A_1$};
  \node[treatment] (A2) at (5.6, 0) {$A_2$};

  % Outcome
  \node[outcome] (Y) at (8.4, 0.75) {$Y$};

  % L -> A (confounding within time)
  \draw[causal] (L0) -- (A0);
  \draw[causal] (L1) -- (A1);
  \draw[causal] (L2) -- (A2);

  % L -> next L (covariate evolution)
  \draw[causal] (L0) -- (L1);
  \draw[causal] (L1) -- (L2);

  % A -> next L (treatment affects future covariates)
  \draw[causal] (A0) to[bend left=15] (L1);
  \draw[causal] (A1) to[bend left=15] (L2);

  % L -> Y (covariates affect outcome)
  \draw[causal] (L2) to[bend left=15] (Y);

  % A -> Y (optional: direct treatment effect)
  \draw[causal] (A2) -- (Y);
\end{tikzpicture}
```

## Conditioning boxes

Indicate conditioning with the `conditioned` style (double border). Add a label below if helpful:

```latex
\node[conditioned] (C) at (4, -1.5) {$U^{d_0} = 1$};
\node[font=\scriptsize\color{red!70!black}, below=2pt of C] {(conditioned on)};
```

## Path highlighting

To highlight a specific biasing or causal path, draw it with the `biasing` style and optionally add a brace or label:

```latex
% Highlight spurious path
\draw[biasing] (L3) -- (A3);
\draw[biasing] (A3) -- (U);
\draw[biasing] (U) -- (A4);  % note: reversed, since U is a collider
\draw[biasing] (A4) -- (L4);
\draw[biasing] (L4) -- (Y);

% Add path annotation below
\node[font=\small\color{red!70!black}, align=center] at (4, -3) {
  Spurious path: $L_3 \to A_3 \to U^{d_0} \leftarrow A_4 \leftarrow L_4 \to Y$
};
```

## Ellipsis for repeated time points

When the DAG has many time points but the pattern repeats, show 2-3 explicitly and use dots:

```latex
\node[font=\large, black!40] at (4.2, 1.5) {$\cdots$};
\node[font=\large, black!40] at (4.2, 0) {$\cdots$};
```

## Unmeasured confounders

Use bidirected dashed arcs:

```latex
% Unmeasured common cause of A and Y
\draw[bidirected] (A) to[bend right=30] node[below, font=\scriptsize, black!50] {$U$} (Y);
```

Or show the unmeasured variable explicitly:

```latex
\node[unmeasured] (U) at (2, 2.5) {$U$};
\draw[causal, dashed, black!40] (U) -- (A);
\draw[causal, dashed, black!40] (U) -- (Y);
```

## Caption template

Always include a figure caption:

```latex
\caption{
  [Short description of what the DAG shows].
  [Node types]: $L_t$ = time-varying covariates; $A_t$ = treatment;
  $Y$ = outcome. [If conditioning]: The double-bordered node indicates
  conditioning on [variable]. [Key insight]: This conditioning opens
  the spurious path [path description], creating selection bias.
}
```

## Complete standalone example

```latex
\documentclass[border=10pt]{standalone}
\usepackage{tikz}
\usetikzlibrary{arrows.meta, positioning, calc}

\tikzset{
  var/.style={draw, rectangle, rounded corners=3pt, minimum width=1.6cm,
              minimum height=0.8cm, font=\small, inner sep=3pt, fill=white,
              draw=black!70, thick},
  treatment/.style={var, fill=black!8},
  outcome/.style={var, fill=black!8, double, double distance=1pt},
  confounder/.style={var},
  causal/.style={-{Stealth[length=5pt]}, thick, black!70},
}

\begin{document}
\begin{tikzpicture}[node distance=1.2cm and 2.5cm]
  % Nodes
  \node[confounder] (L) {$L$};
  \node[treatment, below right=1.2cm and 2cm of L] (A) {$A$};
  \node[outcome, right=2.5cm of A] (Y) {$Y$};
  % Edges
  \draw[causal] (L) -- (A);
  \draw[causal] (L) to[bend left=20] (Y);
  \draw[causal] (A) -- (Y);
\end{tikzpicture}
\end{document}
```

## Delivery checklist

Before delivering a TikZ DAG:
1. Verify it compiles (mentally trace through the node positions and edges)
2. Check that all referenced nodes exist and are spelled correctly
3. Ensure arrow directions match the causal story
4. Include a caption or annotation explaining the key structural feature
5. If the user's workflow is Overleaf: provide as a `\begin{figure}` block they can paste in
6. If standalone: provide as a complete `.tex` file
