# Knowledge graphs

[graphify](https://github.com/safishamsi/graphify) graphs of this repository, for agents and people who need to see how the code, specs, and docs connect. The graphs live only on the machine that built them: everything here except this README and the three build scripts is ignored by git.

## Owns

| Graph | Path | Contents | Use it for |
| --- | --- | --- | --- |
| Product (default) | `graphify-out/graph.json` | All code outside `.claude/`, plus specs, ADRs, scope, reviews, positioning, and READMEs | Questions that cross docs and code: which spec or ADR governs a module, what a feature touches end to end |
| Code | `graphify-out/code/graph.json` | Every code file, structure only (imports, calls, classes, SQL tables) | Refactors, call chains, impact of a change (`graphify affected`), import cycles |
| All | `graphify-out/all/graph.json` | Product plus the vendored `.claude/` skills, agents, and commands | Questions about the agent tooling itself |

Each folder also holds `GRAPH_REPORT.md` (hubs, communities with cohesion scores, surprising links, suggested questions), `graph.html` (open it in a browser), and `labels.json` (community names).

## Never touches

The build reads the repo and writes only inside `graphify-out/`. The code pass is a local parse that sends nothing anywhere. The doc pass sends the Markdown files to Claude through a Claude Code session, the same as an agent reading them. graphify skips files it flags as secrets (the Shopify fixture tokens and the dev license key).

## How to query

Start from a concrete name with `--seed`. A plain question matches on its words, so "how does the write back hold reach the order page" starts from every `Page()` and `.write()` and returns noise.

```bash
graphify query "write back hold" --seed WriteBackProjection --budget 2500
```

```bash
graphify affected "WriteBackProjection" --graph graphify-out/code/graph.json
```

```bash
graphify explain "ChannelsService" --graph graphify-out/code/graph.json
```

`affected` walks backwards from a node to everything that imports or calls it, which is the impact list for a change. NestJS services reach their users by constructor injection, so who uses a service shows up as `imports` edges, not `calls`. `graphify path "A" "B"` gives the shortest link between two nodes. Answers cite `source_file` and `source_location`; check the file before acting on an answer. For a single lookup ("where is X defined"), grep is faster.

## How to rebuild

graphify is a Python package (`pip install "graphifyy[sql]"`; the interpreter path is saved in `graphify-out/.graphify_python`). Run `/graphify` in Claude Code for the full pipeline, or rebuild by hand from the repo root:

1. Detect files: the Step 2 snippet of the graphify skill, which writes `graphify-out/.graphify_detect.json`.
2. Code pass (free, cached per file): `python graphify-out/ast-extract.py`.
3. Doc pass: the skill's Part B, with one reader agent per chunk writing `graphify-out/.graphify_chunk_NN.json`. Re-read only the docs that changed. A later chunk that re-reads a file replaces that file's earlier nodes.
4. Check coverage: `python graphify-out/coverage-check.py` lists any file a reader agent read short.
5. Build: `python graphify-out/build-graphs.py build`, then `python graphify-out/build-graphs.py label` for the reports and `graph.html`.

The graphs go stale with every merge. Rebuild after a milestone lands, not after every commit.

## Decisions

- **Three graphs from one extraction.** The 2026-11-11 build covered 1,962 files (about 2.1 million words, over graphify's single graph guidance), so the owner asked for three scoped views rather than one. They share one code pass and one doc pass, so a rebuild costs the same as a single graph.
- **Community names are generated.** Each graph has 300 to 500 communities, so each is named after its dominant folder and most connected node (for example `api/orders · OrdersService`), not by hand.
- **Not committed.** The graphs are tens of megabytes and specific to the checkout; committing them would conflict on every merge.
