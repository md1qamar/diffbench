# diffbench Documentation

Welcome to the `diffbench` documentation! Use the guides below to explore the architecture, CLI options, schema DSL, statistical testing methodology, and cross-language worker integration.

![diffbench Falsifiable Optimization Gate](./images/hero-banner.jpg)

## Guides

- **[Architecture](./architecture.md)** — Module breakdown, execution pipeline, target runners, and caching behavior.
- **[CLI Reference](./cli-reference.md)** — All subcommands (`gate`, `equiv`, `bench`, `profile`, `init`), flags, exit codes, and `hypothesis.json` format.
- **[Schema DSL & Edge-Case Injection](./schema-dsl.md)** — Positional DSL syntax, JSON schemas, adversarial edge cases, delta-debugging shrinking, and static `--cases` corpora.
- **[Statistical Methodology](./statistical-methodology.md)** — Batch auto-calibration, interleaved `A/B` sampling, Welch's t-test, Mann-Whitney U, Cliff's delta, and bootstrap confidence intervals.
- **[Cross-Language Workers](./cross-language-workers.md)** — Verifying and benchmarking Python, Rust, Go, or C implementations with `cmd:` and `jsonl:`.
- **[CI & Coding Agent Workflows](./ci-and-agents.md)** — GitHub Actions summary gates, JSON artifacts, and using `SKILL.md` with coding agents.
