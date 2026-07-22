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
