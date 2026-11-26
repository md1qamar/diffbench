# CI Integration & Coding Agent Workflows

`diffbench` is designed to block regressions in CI and keep AI coding agents honest when optimizing hot code paths.

## GitHub Actions Performance & Equivalence Gate

Use `--markdown` to write a formatted summary table directly to `$GITHUB_STEP_SUMMARY` while failing the job automatically whenever `diffbench gate` returns exit code `1` (`FALSIFIED`):

```yaml
name: Optimization Gate

on: [pull_request]

jobs:
  diffbench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx diffbench gate ./perf/hypothesis.json --markdown >> "$GITHUB_STEP_SUMMARY"
```

### Machine-Readable Artifacts (`--json`)

When archiving benchmark runs or feeding results to automated review scripts, pass `--json`:

```bash
diffbench gate ./perf/hypothesis.json --json > diffbench-report.json
```

The JSON payload contains:
- `verdict`: `"CORROBORATED"` or `"FALSIFIED"`
- `criteria`: array of `{ name, passed, expected, actual }`
- `equivalence`: tested case counts and `firstMismatch.shrunkArgs` if any divergence occurred
- `benchmark`: full `baselineStats`, `candidateStats`, `welchT`, `mannWhitneyU`, `bootstrapCi`, and `heapDeltaBytes`

---

## Coding Agent Skill (`SKILL.md`)

`diffbench` ships with [`SKILL.md`](../SKILL.md) following the Agent Skills standard so **Antigravity**, **Claude Code**, **Cursor**, and **Codex** follow a disciplined optimization loop:

1. **Measure hotspots first:** run `diffbench profile <target>` rather than guessing which function is slow.
2. **State a falsifiable claim:** write `hypothesis.json` with explicit `minSpeedup`, `maxPValue`, and `requireCiLowerAbove`.
3. **Prove correctness and speedup together:** run `diffbench gate hypothesis.json --json`.
4. **Shrink and fix regressions:** if `equivalence.passed` is `false`, inspect `firstMismatch.shrunkArgs` before touching performance tuning.
5. **Reject noise:** if `verdict` is `"FALSIFIED"` (insufficient speedup, `p > maxPValue`, or CI crossing baseline), discard or refine the candidate.
