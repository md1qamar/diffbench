# CLI Reference

```text
diffbench <command> [options]
```

## Subcommands

### `diffbench gate [hypothesis.json]`
Runs the full falsifiable optimization gate: differential equivalence + counterexample shrinking + interleaved A/B benchmark + statistical acceptance checks.

- If `[hypothesis.json]` is omitted and `--baseline` / `--candidate` are not passed, `diffbench` looks for `./hypothesis.json`.
- Any CLI flag (`--min-speedup`, `--iterations`, `--samples`, `--seed`, etc.) overrides the value loaded from `hypothesis.json`.
- **Exit codes:** `0` (`CORROBORATED`), `1` (`FALSIFIED`), `2` (invalid arguments).

### `diffbench equiv`
Runs differential equivalence fuzzing and delta-debugging counterexample shrinking without benchmarking.

```bash
diffbench equiv \
  --baseline ./baseline.mjs#fn \
  --candidate ./candidate.mjs#fn \
  --schema "array<int(-10,100)>(5,20)" \
  --iterations 200
```

- **Requires:** `--baseline`, `--candidate`, and either `--schema` or `--cases`.
- **Exit codes:** `0` (all cases matched), `1` (mismatch detected), `2` (invalid arguments).

### `diffbench bench`
Runs an interleaved randomized A/B micro/macro benchmark and outputs descriptive + inferential statistics.

```bash
diffbench bench \
  --baseline ./baseline.mjs#fn \
  --candidate ./candidate.mjs#fn \
  --schema "array<int(-500,500)>(200,500)" \
  --samples 40 --warmup 5
```

### `diffbench profile <target>`
Identifies hot functions before you optimize.

- For JS/ESM exports (`./mod.mjs#fn`) or default-exported modules (`./mod.mjs`), samples using Node's V8 CPU profiler (`node:inspector/promises`) at `100 us` intervals.
- For Python scripts (`./script.py`), runs `cProfile` locally and ranks functions by self time.

### `diffbench init [--dir <path>]`
Scaffolds a runnable starter workspace containing `baseline.mjs`, `candidate.mjs`, and `hypothesis.json` (defaults to `.`).

---

## Target Syntax

| Target Form | Example | Description |
| --- | --- | --- |
| ESM Export | `./src/hash.mjs#fastHash` | Imports module and invokes named export (or `default` if `#fn` omitted; `:fn` also supported). |
| One-shot CLI | `"cmd:python worker.py"` | Spawns executable per input vector; writes JSON array on `stdin`, reads JSON result on `stdout`. |
| Streaming NDJSON | `"jsonl:./target/release/worker"` | Keeps worker process alive; exchanges one JSON line per invocation over `stdin`/`stdout`. |

---

## Flags Reference

| Flag | Default | Applies To | Description |
| --- | --- | --- | --- |
| `--baseline <target>` | — | `gate`, `equiv`, `bench` | Baseline implementation target. |
| `--candidate <target>` | — | `gate`, `equiv`, `bench` | Candidate optimized/ported target. |
| `--schema <dsl \| json>` | — | All except `init` | Positional Schema DSL or JSON schema array. |
| `--cases <file.json>` | — | All except `init` | Static test corpus file (`[[...], ...]` or `{"cases": [...]}`). |
| `--seed <n>` | `42` | All except `init` | Deterministic PRNG seed for fuzzing, A/B ordering, and bootstrap CI. |
| `--iterations <n>` | `200` | `gate`, `equiv` | Number of random fuzz iterations (in addition to edge cases and `--cases`). |
| `--samples <n>` | `30` | `gate`, `bench` | Number of paired interleaved A/B timing rounds. |
| `--warmup <n>` | `5` | `gate`, `bench` | Unrecorded warmup rounds run before sampling. |
| `--batch <n>` | Auto | `bench` | Explicit invocations per sample round (overrides auto-calibration). |
| `--min-speedup <x>` | `1.10` | `gate` | Minimum required median speedup (`baselineMedian / candidateMedian`). |
| `--max-p-value <p>` | `0.05` | `gate`, `bench` | Significance threshold `alpha` for Welch's t-test, Mann-Whitney U, and CI (`1 - alpha`). |
| `--ci-lower <x>` | `1.00` | `gate` | Minimum acceptable lower bound of the bootstrap speedup CI. |
| `--float-tol <eps>` | `0` | `gate`, `equiv` | Absolute epsilon tolerance when comparing finite floating-point numbers. |
| `--strict-zero` | `false` | `gate`, `equiv` | Require `-0` and `+0` to match via `Object.is`. |
| `--nan-unequal` | `false` | `gate`, `equiv` | Treat `NaN` vs `NaN` as a mismatch instead of equal. |
| `--no-edge-cases` | `false` | `gate`, `equiv` | Skip adversarial boundary input injection. |
| `--clone-inputs` | `false` | `gate`, `bench` | Pre-clone inputs before each timed call (use for in-place mutating functions). |
| `--duration-ms <n>` | `250` | `profile` | Target sampling window in milliseconds for V8 CPU profiling. |
| `--top <n>` | `15` | `profile` | Maximum number of ranked hotspot rows to display. |
| `--include-internals` | `false` | `profile` | Include Node/Python stdlib & `diffbench` harness frames. |
| `--json` | `false` | All | Emit machine-readable JSON output. |
| `--markdown` | `false` | All | Emit GitHub-flavored Markdown tables and summaries. |
| `--no-color` | `false` | All | Disable ANSI terminal escapes (also honors `NO_COLOR`). |
| `-h`, `--help` | — | All | Print CLI help. |
| `-v`, `--version` | — | All | Print version (`0.1.0`). |

---

## `hypothesis.json` Format

```json
{
  "name": "unique-intersection-set-port",
  "hypothesis": "Replacing quadratic Array.includes lookups with Set membership yields >= 1.50x median speedup with zero behavioral drift.",
  "baseline": "./baseline.mjs#uniqueIntersection",
  "candidate": "./candidate.mjs#uniqueIntersection",
  "schema": "array<int(-500,500)>(200,500), array<int(-500,500)>(200,500)",
  "seed": 42,
  "iterations": 150,
  "warmup": 5,
  "samples": 30,
  "minSpeedup": 1.5,
  "maxPValue": 0.01,
  "requireCiLowerAbove": 1.2,
  "includeEdgeCases": true,
  "equivalence": {
    "floatTol": 0,
    "strictZero": false,
    "nanEqualsNan": true,
    "errorParity": true,
    "strictErrorMessage": false
  }
}
```
