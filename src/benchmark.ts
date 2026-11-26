import { SeededRng } from './prng.js';
import { generateArgs, loadCasesFile, resolveInputSchema } from './schema.js';
import { compareBenchmarks, summarizeSamples } from './stats.js';
import type { BenchmarkReport, InputSchema, TargetRunner } from './types.js';

// Global blackhole sink prevents V8 dead-code elimination of pure target calls.
let benchmarkSink: unknown = null;

export function getBenchmarkSink(): unknown {
  return benchmarkSink;
}

export interface RunBenchmarkParams {
  baseline: TargetRunner;
  candidate: TargetRunner;
  schema?: string | InputSchema;
  casesFile?: string;
  seed?: number;
  warmupRounds?: number;
  sampleRounds?: number;
  batchSize?: number;
  alpha?: number;
  cloneInputs?: boolean;
}

function buildBenchmarkCases(
  schemaSpec: string | InputSchema | undefined,
  casesFile: string | undefined,
  seed: number
): unknown[][] {
  if (casesFile) {
    const loaded = loadCasesFile(casesFile);
    if (loaded.length === 0) {
      throw new Error(`Cases file "${casesFile}" contains 0 cases.`);
    }
    return loaded;
  }
  if (schemaSpec) {
    const schema = resolveInputSchema(schemaSpec);
    const rng = new SeededRng(seed ^ 0x517cc1b7);
    const cases: unknown[][] = [];
    for (let i = 0; i < 16; i++) {
      cases.push(generateArgs(schema, rng));
    }
    return cases;
  }
  return [[]];
}

async function calibrateBatchSize(
  baseline: TargetRunner,
  candidate: TargetRunner,
  cases: unknown[][],
  explicitBatchSize?: number
): Promise<number> {
  if (explicitBatchSize && explicitBatchSize >= 1) {
    return Math.floor(explicitBatchSize);
  }
  // External process runners should default to 1 op per sample unless explicitly overridden.
  if (baseline.kind !== 'module' || candidate.kind !== 'module') {
    return 1;
  }

  // Run one warm probe on both targets and scale batch size toward ~4 ms per sample round.
  const probeArgs = cases[0];
  await baseline.invoke(probeArgs);
  await candidate.invoke(probeArgs);

  let probeBatch = 1;
  let elapsedMs = 0;
  while (probeBatch <= 4096) {
    const t0 = process.hrtime.bigint();
    if (baseline.invokeSync && candidate.invokeSync) {
      for (let i = 0; i < probeBatch; i++) {
        const args = cases[i % cases.length];
        benchmarkSink = baseline.invokeSync(args);
        benchmarkSink = candidate.invokeSync(args);
      }
    } else {
      for (let i = 0; i < probeBatch; i++) {
        const args = cases[i % cases.length];
        benchmarkSink = await baseline.invoke(args);
        benchmarkSink = await candidate.invoke(args);
      }
    }
    elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (elapsedMs >= 2.0) break;
    probeBatch *= 4;
  }

  if (elapsedMs <= 0) return 512;
  const perOpPairMs = elapsedMs / probeBatch;
  const targetMsPerTargetRound = 4.0;
  // Since the probe ran both baseline and candidate, scale by 2 * targetMs / perOpPairMs.
  const estimated = Math.round((targetMsPerTargetRound * 2) / perOpPairMs);
  return Math.max(1, Math.min(20_000, estimated));
}

async function runBatchRound(
  runner: TargetRunner,
  cases: unknown[][],
  batchSize: number,
  cloneInputs: boolean
): Promise<number> {
  const preparedCases = cloneInputs
    ? Array.from({ length: batchSize }, (_, i) => structuredClone(cases[i % cases.length]))
    : cases;

  if (runner.invokeSync) {
    const fn = runner.invokeSync;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < batchSize; i++) {
      const args = cloneInputs ? preparedCases[i] : preparedCases[i % preparedCases.length];
      benchmarkSink = fn(args);
    }
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0) / 1e6;
  }

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < batchSize; i++) {
    const args = cloneInputs ? preparedCases[i] : preparedCases[i % preparedCases.length];
    benchmarkSink = await runner.invoke(args);
  }
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

/**
 * Runs an interleaved randomized A/B micro/macro benchmark and returns full statistical results.
 */
export async function runBenchmark(params: RunBenchmarkParams): Promise<BenchmarkReport> {
  const start = performance.now();
  const seed = params.seed ?? 42;
  const warmupRounds = params.warmupRounds ?? 5;
  const sampleRounds = params.sampleRounds ?? 30;
  const alpha = params.alpha ?? 0.05;
  const cloneInputs = params.cloneInputs ?? false;

  const cases = buildBenchmarkCases(params.schema, params.casesFile, seed);
  const batchSize = await calibrateBatchSize(
    params.baseline,
    params.candidate,
    cases,
    params.batchSize
  );

  // Warmup phase (stabilizes JIT tiers and caches)
  for (let w = 0; w < warmupRounds; w++) {
    await runBatchRound(params.baseline, cases, batchSize, cloneInputs);
    await runBatchRound(params.candidate, cases, batchSize, cloneInputs);
  }

  const baselineSamples: number[] = [];
  const candidateSamples: number[] = [];
  const rng = new SeededRng(seed ^ 0x27d4eb2d);

  const heapBaseBefore = process.memoryUsage().heapUsed;
  let heapBaseDelta = 0;
  let heapCandDelta = 0;

  for (let r = 0; r < sampleRounds; r++) {
    const runBaselineFirst = rng.bool();
    if (runBaselineFirst) {
      const h0 = process.memoryUsage().heapUsed;
      const bMs = await runBatchRound(params.baseline, cases, batchSize, cloneInputs);
      const h1 = process.memoryUsage().heapUsed;
      const cMs = await runBatchRound(params.candidate, cases, batchSize, cloneInputs);
      const h2 = process.memoryUsage().heapUsed;
      baselineSamples.push(bMs / batchSize);
      candidateSamples.push(cMs / batchSize);
      heapBaseDelta += h1 - h0;
      heapCandDelta += h2 - h1;
    } else {
      const h0 = process.memoryUsage().heapUsed;
      const cMs = await runBatchRound(params.candidate, cases, batchSize, cloneInputs);
      const h1 = process.memoryUsage().heapUsed;
      const bMs = await runBatchRound(params.baseline, cases, batchSize, cloneInputs);
      const h2 = process.memoryUsage().heapUsed;
      candidateSamples.push(cMs / batchSize);
      baselineSamples.push(bMs / batchSize);
      heapCandDelta += h1 - h0;
      heapBaseDelta += h2 - h1;
    }
  }

  // Prevent compiler warning if heapBaseBefore unused while keeping clean baseline reference
  void heapBaseBefore;

  const baselineStats = summarizeSamples(baselineSamples, batchSize);
  const candidateStats = summarizeSamples(candidateSamples, batchSize);
  const comparison = compareBenchmarks(baselineStats, candidateStats, alpha, seed);

  return {
    baseline: params.baseline.spec,
    candidate: params.candidate.spec,
    seed,
    warmupRounds,
    sampleRounds,
    batchSize,
    caseCount: cases.length,
    baselineStats,
    candidateStats,
    comparison,
    heapDeltaBytes: {
      baseline: Math.round(heapBaseDelta / Math.max(1, sampleRounds)),
      candidate: Math.round(heapCandDelta / Math.max(1, sampleRounds)),
    },
    durationMs: performance.now() - start,
  };
}
