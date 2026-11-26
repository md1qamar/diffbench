---
name: diffbench
description: Falsifiable optimization workflow for coding agents. Use when optimizing hot functions, porting algorithms across languages, or verifying performance changes with differential equivalence fuzzing, counterexample shrinking, and statistical benchmarking.
---

# Falsifiable Optimization Workflow (`diffbench`)

Never claim a code optimization or cross-language port is faster or behavior-preserving without running a falsifiable gate first.

## Workflow

1. **Discover the real hotspot before touching code**
   Run the local profiler to locate where execution time is actually spent:
   ```bash
   npx diffbench profile ./src/worker.mjs#processBatch --schema "array<int(-100,100)>(200,500)"
   ```
   Or for Python scripts:
   ```bash
   npx diffbench profile ./pipeline.py
   ```

2. **Formulate a falsifiable hypothesis**
   Define `hypothesis.json` (or scaffold one with `npx diffbench init`) with explicit acceptance bounds:
   - `baseline` and `candidate` targets (`file.mjs#fn`, `cmd:...`, or `jsonl:...`)
   - Input `schema` DSL or static `casesFile`
   - Equivalence guarantees (`floatTol`, `strictZero`, `errorParity`)
   - Statistical requirements (`minSpeedup`, `maxPValue`, `requireCiLowerAbove`)

3. **Run the falsifiable gate**
   ```bash
   npx diffbench gate hypothesis.json --json
   ```
   - If `equiv` finds a divergence, inspect `firstMismatch.shrunkArgs` (minimal counterexample from delta debugging) and fix the bug before benchmarking.
   - If `verdict` is `FALSIFIED` due to `minSpeedup`, `Welch's t-test`, `Mann-Whitney U`, or bootstrap CI lower bound crossing baseline, reject or refine the optimization rather than shipping noise.
   - Only accept and commit the optimization when `verdict === "CORROBORATED"` (exit code `0`).

4. **Cross-language verification (Node <-> Python / Rust / Go / C)**
   Expose a persistent NDJSON stdio worker (`jsonl:<command>`) or one-shot stdin/stdout command (`cmd:<command>`) that reads JSON argument arrays and prints `{"ok": true, "value": ...}` or `{"ok": false, "error": "..."}`, then pass it as `--candidate`.
