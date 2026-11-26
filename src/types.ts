/**
 * Supported schema nodes for deterministic property-based input generation and shrinking.
 */
export type SchemaNode =
  | { kind: 'int'; min?: number; max?: number }
  | { kind: 'float'; min?: number; max?: number; allowSpecial?: boolean }
  | { kind: 'bool' }
  | { kind: 'null' }
  | { kind: 'string'; minLen?: number; maxLen?: number }
  | { kind: 'enum'; values: Array<string | number | boolean | null> }
  | { kind: 'array'; item: SchemaNode; minLen?: number; maxLen?: number }
  | { kind: 'tuple'; items: SchemaNode[] }
  | { kind: 'nullable'; inner: SchemaNode }
  | { kind: 'record'; fields: Record<string, SchemaNode> }
  | { kind: 'map'; value: SchemaNode; minKeys?: number; maxKeys?: number };

/**
 * Top-level input specification: either an array of positional argument schemas or a single schema.
 */
export type InputSchema = SchemaNode[];

/**
 * Comparison options used during differential equivalence checking.
 */
export interface EquivalenceOptions {
  /** Absolute tolerance for comparing finite floating-point numbers. Default: 0 (exact). */
  floatTol?: number;
  /** Distinguish -0 from +0 via Object.is. Default: false. */
  strictZero?: boolean;
  /** Treat NaN === NaN as equal. Default: true. */
  nanEqualsNan?: boolean;
  /** Require both implementations to throw/fail together when errors occur. Default: true. */
  errorParity?: boolean;
  /** Require identical error messages when both throw (otherwise error parity alone suffices). Default: false. */
  strictErrorMessage?: boolean;
}

/**
 * Normalized outcome from executing one target on one argument vector.
 */
export interface ExecutionOutcome {
  ok: boolean;
  value?: unknown;
  errorName?: string;
  errorMessage?: string;
}

/**
 * Target execution adapter supporting JS/ESM module exports, per-call executables, and NDJSON workers.
 */
export interface TargetRunner {
  spec: string;
  kind: 'module' | 'cmd' | 'jsonl';
  isAsync: boolean;
  invoke(args: unknown[]): Promise<ExecutionOutcome>;
  invokeSync?(args: unknown[]): ExecutionOutcome;
  close(): Promise<void>;
}

/**
 * Details of a single behavioral discrepancy between baseline and candidate targets.
 */
export interface EquivalenceMismatch {
  caseIndex: number;
  source: 'corpus' | 'edge-case' | 'random';
  originalArgs: unknown[];
  shrunkArgs: unknown[];
  shrinkSteps: number;
  reason: string;
  baselineOutcome: ExecutionOutcome;
  candidateOutcome: ExecutionOutcome;
}

/**
 * Result of running differential equivalence testing.
 */
export interface EquivalenceReport {
  passed: boolean;
  baseline: string;
  candidate: string;
  seed: number;
  totalCases: number;
  edgeCasesTested: number;
  randomCasesTested: number;
  corpusCasesTested: number;
  passedCases: number;
  failedCases: number;
  durationMs: number;
  firstMismatch: EquivalenceMismatch | null;
}

/**
 * Descriptive statistics for a single target's timing samples (in milliseconds per batch or operation).
 */
export interface SampleSummary {
  n: number;
  batchSize: number;
  meanMsPerOp: number;
  medianMsPerOp: number;
  stdDevMsPerOp: number;
  madMsPerOp: number;
  minMsPerOp: number;
  maxMsPerOp: number;
  p50MsPerOp: number;
  p95MsPerOp: number;
  p99MsPerOp: number;
  iqrOutliers: number;
  opsPerSec: number;
  samplesMsPerOp: number[];
}

/**
 * Inferential statistics comparing candidate performance against baseline performance.
 */
export interface StatisticalComparison {
  speedupMean: number;
  speedupMedian: number;
  percentChangeMedian: number;
  welchT: {
    tStatistic: number;
    degreesOfFreedom: number;
    pValueTwoSided: number;
    pValueOneSidedFaster: number;
  };
  mannWhitneyU: {
    uStatistic: number;
    zScore: number;
    pValueTwoSided: number;
    pValueOneSidedFaster: number;
    cliffsDelta: number;
  };
  bootstrapCi: {
    alpha: number;
    resamples: number;
    medianSpeedupLow: number;
    medianSpeedupHigh: number;
    meanSpeedupLow: number;
    meanSpeedupHigh: number;
  };
}

/**
 * Result of running an interleaved A/B benchmark.
 */
export interface BenchmarkReport {
  baseline: string;
  candidate: string;
  seed: number;
  warmupRounds: number;
  sampleRounds: number;
  batchSize: number;
  caseCount: number;
  baselineStats: SampleSummary;
  candidateStats: SampleSummary;
  comparison: StatisticalComparison;
  heapDeltaBytes: {
    baseline: number;
    candidate: number;
  };
  durationMs: number;
}

/**
 * Declarative falsifiable optimization hypothesis definition (hypothesis.json).
 */
export interface HypothesisSpec {
  name: string;
  hypothesis: string;
  baseline: string;
  candidate: string;
  schema?: string | InputSchema;
  casesFile?: string;
  seed?: number;
  iterations?: number;
  samples?: number;
  warmup?: number;
  minSpeedup?: number;
  maxPValue?: number;
  alpha?: number;
  requireCiLowerAbove?: number;
  includeEdgeCases?: boolean;
  equivalence?: EquivalenceOptions;
}

/**
 * Individual criterion check inside the falsifiable gate.
 */
export interface GateCriterion {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

/**
 * Final decision report from `diffbench gate`.
 */
export interface GateReport {
  verdict: 'CORROBORATED' | 'FALSIFIED';
  passed: boolean;
  name: string;
  hypothesis: string;
  criteria: GateCriterion[];
  falsificationReasons: string[];
  equivalence: EquivalenceReport;
  benchmark: BenchmarkReport | null;
  timestamp: string;
}

/**
 * Single ranked hotspot function returned by `diffbench profile`.
 */
export interface HotspotEntry {
  rank: number;
  functionName: string;
  url: string;
  lineNumber: number;
  selfTimeMs: number;
  totalTimeMs: number;
  selfPercent: number;
  totalPercent: number;
  hitCount: number;
}

/**
 * Result of profiling a JS/ESM or Python target locally.
 */
export interface ProfileReport {
  runtime: 'node-v8' | 'python-cprofile';
  target: string;
  totalDurationMs: number;
  totalHits: number;
  hotspots: HotspotEntry[];
}
