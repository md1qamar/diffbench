import fs from 'node:fs';
import path from 'node:path';
import { runBenchmark } from './benchmark.js';
import { runEquivalenceCheck } from './equivalence.js';
import { loadTargetRunner } from './runners.js';
import type { GateCriterion, GateReport, HypothesisSpec } from './types.js';

/**
 * Loads and validates a `hypothesis.json` specification file.
 */
export function loadHypothesisFile(filePath: string): HypothesisSpec {
  const absPath = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8')) as Partial<HypothesisSpec>;
  if (!raw.baseline || !raw.candidate) {
    throw new Error(`Invalid hypothesis file "${filePath}": missing "baseline" or "candidate".`);
  }
  return {
    name: raw.name || path.basename(filePath, path.extname(filePath)),
    hypothesis: raw.hypothesis || 'Candidate preserves equivalence and improves performance.',
    baseline: raw.baseline,
    candidate: raw.candidate,
    schema: raw.schema,
    casesFile: raw.casesFile,
    seed: raw.seed,
    iterations: raw.iterations,
    samples: raw.samples,
    warmup: raw.warmup,
    minSpeedup: raw.minSpeedup,
    maxPValue: raw.maxPValue,
    alpha: raw.alpha,
    requireCiLowerAbove: raw.requireCiLowerAbove,
    includeEdgeCases: raw.includeEdgeCases,
    equivalence: raw.equivalence,
  };
}

/**
 * Evaluates a falsifiable optimization hypothesis:
 * 1. Differential equivalence fuzzing + counterexample shrinking
 * 2. Interleaved A/B benchmarking
 * 3. Speedup threshold, Welch t-test / Mann-Whitney U significance, and bootstrap CI gating.
 */
export async function evaluateGate(
  spec: HypothesisSpec,
  options: { cwd?: string; cloneInputs?: boolean } = {}
): Promise<GateReport> {
  const cwd = options.cwd ?? process.cwd();
  const minSpeedup = spec.minSpeedup ?? 1.1;
  const maxPValue = spec.maxPValue ?? 0.05;
  const alpha = spec.alpha ?? maxPValue;
  const requireCiLowerAbove = spec.requireCiLowerAbove ?? 1.0;

  const resolvedCasesFile = spec.casesFile ? path.resolve(cwd, spec.casesFile) : undefined;

  const baseline = await loadTargetRunner(spec.baseline, cwd);
  const candidate = await loadTargetRunner(spec.candidate, cwd);

  try {
    const equivalence = await runEquivalenceCheck({
      baseline,
      candidate,
      schema: spec.schema,
      casesFile: resolvedCasesFile,
      seed: spec.seed ?? 42,
      iterations: spec.iterations ?? 200,
      includeEdgeCases: spec.includeEdgeCases ?? true,
      stopOnFirstFailure: true,
      equivalenceOptions: spec.equivalence,
    });

    const criteria: GateCriterion[] = [
      {
        name: 'Behavioral Equivalence',
        passed: equivalence.passed,
        expected: `0 mismatches across ${equivalence.totalCases} cases`,
        actual: equivalence.passed
          ? `0 mismatches (${equivalence.passedCases}/${equivalence.totalCases} passed)`
          : `${equivalence.failedCases} mismatch (${equivalence.firstMismatch?.reason ?? 'diff'})`,
      },
    ];

    const falsificationReasons: string[] = [];
    if (!equivalence.passed) {
      falsificationReasons.push(
        `Equivalence falsified: ${equivalence.firstMismatch?.reason ?? 'output mismatch'}`
      );
      return {
        verdict: 'FALSIFIED',
        passed: false,
        name: spec.name,
        hypothesis: spec.hypothesis,
        criteria,
        falsificationReasons,
        equivalence,
        benchmark: null,
        timestamp: new Date().toISOString(),
      };
    }

    const benchmark = await runBenchmark({
      baseline,
      candidate,
      schema: spec.schema,
      casesFile: resolvedCasesFile,
      seed: spec.seed ?? 42,
      warmupRounds: spec.warmup ?? 5,
      sampleRounds: spec.samples ?? 30,
      alpha,
      cloneInputs: options.cloneInputs,
    });

    const speedupMedian = benchmark.comparison.speedupMedian;
    const welchP = benchmark.comparison.welchT.pValueOneSidedFaster;
    const mwP = benchmark.comparison.mannWhitneyU.pValueOneSidedFaster;
    const ciLow = benchmark.comparison.bootstrapCi.medianSpeedupLow;

    const speedupOk = speedupMedian >= minSpeedup;
    const welchOk = welchP <= maxPValue;
    const mwOk = mwP <= maxPValue;
    const ciOk = ciLow >= requireCiLowerAbove;

    criteria.push(
      {
        name: 'Minimum Median Speedup',
        passed: speedupOk,
        expected: `>= ${minSpeedup.toFixed(2)}x`,
        actual: `${speedupMedian.toFixed(2)}x`,
      },
      {
        name: "Welch's t-test (one-sided)",
        passed: welchOk,
        expected: `p <= ${maxPValue}`,
        actual: `p = ${welchP.toExponential(3)}`,
      },
      {
        name: 'Mann-Whitney U (one-sided)',
        passed: mwOk,
        expected: `p <= ${maxPValue}`,
        actual: `p = ${mwP.toExponential(3)}`,
      },
      {
        name: `Bootstrap ${Math.round((1 - alpha) * 100)}% CI Lower Bound`,
        passed: ciOk,
        expected: `>= ${requireCiLowerAbove.toFixed(2)}x`,
        actual: `${ciLow.toFixed(2)}x (CI [${ciLow.toFixed(2)}x, ${benchmark.comparison.bootstrapCi.medianSpeedupHigh.toFixed(2)}x])`,
      }
    );

    if (!speedupOk) {
      falsificationReasons.push(
        `Observed median speedup ${speedupMedian.toFixed(2)}x is below required ${minSpeedup.toFixed(2)}x.`
      );
    }
    if (!welchOk || !mwOk) {
      falsificationReasons.push(
        `Speedup is not statistically significant at alpha=${maxPValue} (Welch p=${welchP.toExponential(2)}, MW p=${mwP.toExponential(2)}).`
      );
    }
    if (!ciOk) {
      falsificationReasons.push(
        `Bootstrap CI lower bound (${ciLow.toFixed(2)}x) falls below ${requireCiLowerAbove.toFixed(2)}x.`
      );
    }

    const passed = falsificationReasons.length === 0;
    return {
      verdict: passed ? 'CORROBORATED' : 'FALSIFIED',
      passed,
      name: spec.name,
      hypothesis: spec.hypothesis,
      criteria,
      falsificationReasons,
      equivalence,
      benchmark,
      timestamp: new Date().toISOString(),
    };
  } finally {
    await baseline.close();
    await candidate.close();
  }
}

/**
 * Scaffolds a runnable starter optimization experiment (`hypothesis.json`, `baseline.mjs`, `candidate.mjs`).
 */
export function scaffoldHypothesisWorkspace(targetDir: string): string[] {
  const absDir = path.resolve(targetDir);
  fs.mkdirSync(absDir, { recursive: true });

  const baselineFile = path.join(absDir, 'baseline.mjs');
  const candidateFile = path.join(absDir, 'candidate.mjs');
  const hypothesisFile = path.join(absDir, 'hypothesis.json');

  const baselineCode = `/**
 * Quadratic O(n^2) unique intersection baseline.
 */
export function uniqueIntersection(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const item = a[i];
    if (b.includes(item) && !out.includes(item)) {
      out.push(item);
    }
  }
  return out.sort((x, y) => x - y);
}
`;

  const candidateCode = `/**
 * Hash-set O(n + m) candidate optimization.
 */
export function uniqueIntersection(a, b) {
  const bSet = new Set(b);
  const seen = new Set();
  for (let i = 0; i < a.length; i++) {
    const item = a[i];
    if (bSet.has(item)) {
      seen.add(item);
    }
  }
  return Array.from(seen).sort((x, y) => x - y);
}
`;

  const hypothesis = {
    name: 'unique-intersection-set-port',
    hypothesis:
      'Replacing quadratic Array.includes lookups with Set membership yields >= 1.50x median speedup with zero behavioral drift.',
    baseline: './baseline.mjs#uniqueIntersection',
    candidate: './candidate.mjs#uniqueIntersection',
    schema: 'array<int(-500,500)>(200,500), array<int(-500,500)>(200,500)',
    seed: 42,
    iterations: 150,
    warmup: 5,
    samples: 30,
    minSpeedup: 1.5,
    maxPValue: 0.01,
    requireCiLowerAbove: 1.2,
  };

  fs.writeFileSync(baselineFile, baselineCode, 'utf8');
  fs.writeFileSync(candidateFile, candidateCode, 'utf8');
  fs.writeFileSync(hypothesisFile, JSON.stringify(hypothesis, null, 2) + '\n', 'utf8');

  return [baselineFile, candidateFile, hypothesisFile];
}
