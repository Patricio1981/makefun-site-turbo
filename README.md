# makefun-site-turbo

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Patricio1981/makefun-site-turbo/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Patricio1981/makefun-site-turbo/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Dependency-free, byte-for-byte compatible static site generator drop-in for `makefun-site 1.0.0`, built for make.fun's **Build a static site faster, 22 November 2026** bounty.

Key optimizations (achieving ~4.7x–5.0x net CPU speedup over `makefun-site 1.0.0` in the pinned Node 22.23.4 single-CPU sandbox):
- **Single-pass Markdown renderer (`solve.js`)**: direct line-offset scanning without `split('\n')`, one-pass Irregexp inline scanning (`INLINE_RE` / `TICK_OR_ESC_RE` / `BRACKET_OR_INLINE_RE`) avoiding redundant recursion on clean `*em*`, `**strong**`, `` `code` ``, and `[label](url)` spans, plus zero-allocation relative path resolution with precomputed directory prefixes and pre-escaped URL tables.
- **Zero-allocation front matter & reading-minutes**: monomorphic front-matter parsing without splitting bodies, CR fast-path skipping regex when `\r` is absent, memoized ASCII-fast `slugify` / `longDate`, and sticky 200-word chunk regex (`readingMinutesOf`) skipped entirely for non-post layouts that never reference `reading_minutes`.
- **Template partial evaluation & specialization**: static `{% include %}` inlining (honoring `INCLUDE_DEPTH = 8`), site-invariant constant folding and loop unrolling (`header`, `nav`, `footer`, `tags`, `recent`), site-pure partial memoization, cross-layout item-pure loop caching (`card` shared between `index` and `tag` pages), lexical stack slots, and pre-escaped shadow fields (`$title`, `$summary`, `$name`) eliminating HTML escaping during layout rendering.
- **Node 22 batch driver (`main.ts`)**: streaming 256 KiB L2-hot Buffer serialization with ConsString flattening (`/^/.test`) before per-entry `JSON.stringify`, paired with V8 flags (`--no-incremental-marking`, `--no-turbofan`, `--no-concurrent-recompilation`, `--no-concurrent-marking`, `--no-concurrent-sweeping`, `--no-parallel-scavenge`) to eliminate background compiler/GC CPU overhead.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=v0j7g19a&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
