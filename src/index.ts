export { runBenchmark, getBenchmarkSink } from './benchmark.js';
export {
  compareOutcomes,
  compareValues,
  runEquivalenceCheck,
  shrinkCounterexample,
} from './equivalence.js';
export {
  formatBenchmarkReport,
  formatEquivalenceReport,
  formatGateReport,
  formatProfileReport,
} from './formatters.js';
export type { OutputFormat } from './formatters.js';
export {
  evaluateGate,
  loadHypothesisFile,
  scaffoldHypothesisWorkspace,
} from './hypothesis.js';
export { SeededRng } from './prng.js';
export { profileTarget } from './profiler.js';
export { loadTargetRunner, parseCommandLine } from './runners.js';
export {
  buildEdgeCases,
  generateArgs,
  generateValue,
  loadCasesFile,
  resolveInputSchema,
} from './schema.js';
export {
  bootstrapSpeedupCi,
  compareBenchmarks,
  mannWhitneyUTest,
  quantile,
  studentTTwoSidedPValue,
  summarizeSamples,
  welchTTest,
} from './stats.js';
export * from './types.js';
