# makefun-site-turbo

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/teylerboal-dev/makefun-site-turbo/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/teylerboal-dev/makefun-site-turbo/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free, byte-exact high-speed drop-in replacement for `makefun-site 1.0.0`, built for [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122).

## Optimizations
- Span-based inline Markdown renderer with `Uint8Array` lookup tables (eliminates per-character regex allocations).
- Zero-split `indexOf('\n')` block lexer and front-matter parser with `charCodeAt` dispatch.
- JIT-compiled templates (`new Function`) with site-constant partial evaluation, coalesced string literals, and inlined includes.
- ASCII fast-path + memoized `slugify`, zero-allocation `wordsOf`, and fast HTML escaping.

## Run
```bash
node main.ts
```
