import { SeededRng } from './prng.js';
import { buildEdgeCases, generateArgs, loadCasesFile, resolveInputSchema } from './schema.js';
import type {
  EquivalenceMismatch,
  EquivalenceOptions,
  EquivalenceReport,
  ExecutionOutcome,
  InputSchema,
  TargetRunner,
} from './types.js';

const DEFAULT_OPTIONS: Required<EquivalenceOptions> = {
  floatTol: 0,
  strictZero: false,
  nanEqualsNan: true,
  errorParity: true,
  strictErrorMessage: false,
};

/**
 * Deeply compares two JS values and returns a concise path-annotated mismatch reason, or `null` if equal.
 */
export function compareValues(
  expected: unknown,
  actual: unknown,
  opts: EquivalenceOptions = {},
  jsonPath = '$'
): string | null {
  const o = { ...DEFAULT_OPTIONS, ...opts };

  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isNaN(expected) && Number.isNaN(actual)) {
      return o.nanEqualsNan ? null : `${jsonPath}: expected NaN !== NaN (nanEqualsNan=false)`;
    }
    if (Number.isNaN(expected) || Number.isNaN(actual)) {
      return `${jsonPath}: expected ${String(expected)}, got ${String(actual)}`;
    }
    if (expected === 0 && actual === 0) {
      if (o.strictZero && !Object.is(expected, actual)) {
        const expLabel = Object.is(expected, -0) ? '-0' : '0';
        const actLabel = Object.is(actual, -0) ? '-0' : '0';
        return `${jsonPath}: signed zero mismatch (expected ${expLabel}, got ${actLabel})`;
      }
      return null;
    }
    if (expected === actual) return null;
    if (
      o.floatTol > 0 &&
      Number.isFinite(expected) &&
      Number.isFinite(actual) &&
      Math.abs(expected - actual) <= o.floatTol
    ) {
      return null;
    }
    return `${jsonPath}: expected ${String(expected)}, got ${String(actual)}`;
  }

  if (Object.is(expected, actual)) return null;

  if (expected === null || actual === null || typeof expected !== typeof actual) {
    return `${jsonPath}: expected ${describeShort(expected)}, got ${describeShort(actual)}`;
  }

  if (typeof expected !== 'object') {
    return `${jsonPath}: expected ${describeShort(expected)}, got ${describeShort(actual)}`;
  }

  if (expected instanceof Date && actual instanceof Date) {
    return expected.getTime() === actual.getTime()
      ? null
      : `${jsonPath}: expected Date(${expected.toISOString()}), got Date(${actual.toISOString()})`;
  }

  if (expected instanceof RegExp && actual instanceof RegExp) {
    return expected.source === actual.source && expected.flags === actual.flags
      ? null
      : `${jsonPath}: expected ${expected.toString()}, got ${actual.toString()}`;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${jsonPath}: expected ${Array.isArray(expected) ? 'Array' : 'Object'}, got ${Array.isArray(actual) ? 'Array' : 'Object'}`;
    }
    if (expected.length !== actual.length) {
      return `${jsonPath}.length: expected ${expected.length}, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = compareValues(expected[i], actual[i], o, `${jsonPath}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (ArrayBuffer.isView(expected) && ArrayBuffer.isView(actual)) {
    if (expected.constructor !== actual.constructor) {
      return `${jsonPath}: expected ${expected.constructor.name}, got ${actual.constructor.name}`;
    }
    const a = expected as unknown as ArrayLike<number | bigint>;
    const b = actual as unknown as ArrayLike<number | bigint>;
    if (a.length !== b.length) {
      return `${jsonPath}.length: expected ${a.length}, got ${b.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const diff = compareValues(a[i], b[i], o, `${jsonPath}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (expected instanceof Set && actual instanceof Set) {
    if (expected.size !== actual.size) {
      return `${jsonPath}.size: expected ${expected.size}, got ${actual.size}`;
    }
    const expArr = [...expected];
    const actArr = [...actual];
    for (let i = 0; i < expArr.length; i++) {
      const found = actArr.some((item) => compareValues(expArr[i], item, o) === null);
      if (!found) {
        return `${jsonPath}: missing Set element ${describeShort(expArr[i])}`;
      }
    }
    return null;
  }

  if (expected instanceof Map && actual instanceof Map) {
    if (expected.size !== actual.size) {
      return `${jsonPath}.size: expected ${expected.size}, got ${actual.size}`;
    }
    for (const [key, val] of expected.entries()) {
      if (!actual.has(key)) {
        return `${jsonPath}: missing Map key ${describeShort(key)}`;
      }
      const diff = compareValues(val, actual.get(key), o, `${jsonPath}.get(${describeShort(key)})`);
      if (diff) return diff;
    }
    return null;
  }

  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;
  const expKeys = Object.keys(expObj).sort();
  const actKeys = Object.keys(actObj).sort();

  if (expKeys.length !== actKeys.length) {
    const missing = expKeys.filter((k) => !Object.hasOwn(actObj, k));
    const extra = actKeys.filter((k) => !Object.hasOwn(expObj, k));
    return `${jsonPath}: key mismatch (missing: [${missing.join(', ')}], extra: [${extra.join(', ')}])`;
  }

  for (let i = 0; i < expKeys.length; i++) {
    const k = expKeys[i];
    if (k !== actKeys[i]) {
      return `${jsonPath}: expected key "${k}", got "${actKeys[i]}"`;
    }
    const diff = compareValues(expObj[k], actObj[k], o, `${jsonPath}.${k}`);
    if (diff) return diff;
  }

  return null;
}

function describeShort(val: unknown): string {
  if (val === undefined) return 'undefined';
  if (typeof val === 'bigint') return `${val}n`;
  if (typeof val === 'string') {
    return val.length > 40 ? JSON.stringify(val.slice(0, 37) + '...') : JSON.stringify(val);
  }
  try {
    const s = JSON.stringify(val);
    if (s === undefined) return String(val);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  } catch {
    return String(val);
  }
}

/**
 * Compares two `ExecutionOutcome` objects according to `EquivalenceOptions`.
 */
export function compareOutcomes(
  baseline: ExecutionOutcome,
  candidate: ExecutionOutcome,
  opts: EquivalenceOptions = {}
): string | null {
  const o = { ...DEFAULT_OPTIONS, ...opts };

  if (baseline.ok && candidate.ok) {
    return compareValues(baseline.value, candidate.value, o);
  }

  if (!baseline.ok && !candidate.ok) {
    if (!o.errorParity) return null;
    if (o.strictErrorMessage && baseline.errorMessage !== candidate.errorMessage) {
      return `Error message mismatch: expected "${baseline.errorMessage}", got "${candidate.errorMessage}"`;
    }
    return null;
  }

  if (!baseline.ok && candidate.ok) {
    return `Error parity mismatch: baseline threw ${baseline.errorName}("${baseline.errorMessage}"), candidate returned ${describeShort(candidate.value)}`;
  }

  return `Error parity mismatch: baseline returned ${describeShort(baseline.value)}, candidate threw ${candidate.errorName}("${candidate.errorMessage}")`;
}

function cloneJsonSafe(val: unknown): unknown {
  try {
    return structuredClone(val);
  } catch {
    return val;
  }
}

function generateShrinkCandidates(val: unknown): unknown[] {
  const candidates: unknown[] = [];

  if (typeof val === 'number' && Number.isFinite(val) && val !== 0) {
    candidates.push(0);
    if (val < 0) candidates.push(-val);
    const halved = Number.isInteger(val) ? Math.trunc(val / 2) : val / 2;
    if (halved !== val && halved !== 0) candidates.push(halved);
    const towardZero = Number.isInteger(val) ? (val > 0 ? val - 1 : val + 1) : Math.trunc(val);
    if (towardZero !== val) candidates.push(towardZero);
    return candidates;
  }

  if (typeof val === 'string' && val.length > 0) {
    candidates.push('');
    if (val.length > 1) {
      const mid = Math.floor(val.length / 2);
      candidates.push(val.slice(0, mid), val.slice(mid));
      candidates.push(val.slice(0, -1), val.slice(1));
    }
    return candidates;
  }

  if (Array.isArray(val) && val.length > 0) {
    candidates.push([]);
    if (val.length > 1) {
      const mid = Math.floor(val.length / 2);
      candidates.push(val.slice(0, mid), val.slice(mid));
      for (let i = 0; i < Math.min(val.length, 8); i++) {
        candidates.push([...val.slice(0, i), ...val.slice(i + 1)]);
      }
    }
    // Also shrink individual elements
    for (let i = 0; i < Math.min(val.length, 6); i++) {
      for (const smallerItem of generateShrinkCandidates(val[i])) {
        const copy = [...val];
        copy[i] = smallerItem;
        candidates.push(copy);
      }
    }
    return candidates;
  }

  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const k of keys.slice(0, 6)) {
      const without: Record<string, unknown> = { ...obj };
      delete without[k];
      candidates.push(without);
      for (const smallerVal of generateShrinkCandidates(obj[k])) {
        candidates.push({ ...obj, [k]: smallerVal });
      }
    }
    return candidates;
  }

  return candidates;
}

/**
 * Delta-debugging shrinker: reduces a failing argument vector to a minimal failing counterexample.
 */
export async function shrinkCounterexample(
  baseline: TargetRunner,
  candidate: TargetRunner,
  failingArgs: unknown[],
  opts: EquivalenceOptions = {},
  maxProbes = 150
): Promise<{ shrunkArgs: unknown[]; shrinkSteps: number }> {
  let current = failingArgs.map(cloneJsonSafe);
  let probes = 0;
  let improved = true;

  while (improved && probes < maxProbes) {
    improved = false;
    for (let argIdx = 0; argIdx < current.length && probes < maxProbes; argIdx++) {
      const variants = generateShrinkCandidates(current[argIdx]);
      for (const variant of variants) {
        if (probes >= maxProbes) break;
        probes++;
        const testArgs = current.map((a, idx) => (idx === argIdx ? variant : cloneJsonSafe(a)));
        const bOut = await baseline.invoke(testArgs);
        const cOut = await candidate.invoke(testArgs);
        if (compareOutcomes(bOut, cOut, opts) !== null) {
          current = testArgs;
          improved = true;
          break;
        }
      }
    }
  }

  return { shrunkArgs: current, shrinkSteps: probes };
}

export interface RunEquivalenceParams {
  baseline: TargetRunner;
  candidate: TargetRunner;
  schema?: string | InputSchema;
  casesFile?: string;
  seed?: number;
  iterations?: number;
  includeEdgeCases?: boolean;
  stopOnFirstFailure?: boolean;
  equivalenceOptions?: EquivalenceOptions;
}

/**
 * Runs differential equivalence testing across corpus, edge-case, and seeded random inputs.
 */
export async function runEquivalenceCheck(
  params: RunEquivalenceParams
): Promise<EquivalenceReport> {
  const start = performance.now();
  const seed = params.seed ?? 42;
  const iterations = params.iterations ?? 200;
  const includeEdgeCases = params.includeEdgeCases ?? true;
  const stopOnFirstFailure = params.stopOnFirstFailure ?? true;
  const opts = params.equivalenceOptions ?? {};

  const testCases: Array<{ source: 'corpus' | 'edge-case' | 'random'; args: unknown[] }> = [];

  if (params.casesFile) {
    for (const args of loadCasesFile(params.casesFile)) {
      testCases.push({ source: 'corpus', args });
    }
  }

  let parsedSchema: InputSchema | null = null;
  if (params.schema) {
    parsedSchema = resolveInputSchema(params.schema);
    if (includeEdgeCases) {
      for (const args of buildEdgeCases(parsedSchema)) {
        testCases.push({ source: 'edge-case', args });
      }
    }
    const rng = new SeededRng(seed);
    for (let i = 0; i < iterations; i++) {
      testCases.push({ source: 'random', args: generateArgs(parsedSchema, rng) });
    }
  } else if (testCases.length === 0) {
    throw new Error('Equivalence check requires either --schema or --cases.');
  }

  let passedCases = 0;
  let failedCases = 0;
  let edgeCasesTested = 0;
  let randomCasesTested = 0;
  let corpusCasesTested = 0;
  let firstMismatch: EquivalenceMismatch | null = null;

  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    if (tc.source === 'corpus') corpusCasesTested++;
    else if (tc.source === 'edge-case') edgeCasesTested++;
    else randomCasesTested++;

    const argsForBase = tc.args.map(cloneJsonSafe);
    const argsForCand = tc.args.map(cloneJsonSafe);

    const [bOut, cOut] = await Promise.all([
      params.baseline.invoke(argsForBase),
      params.candidate.invoke(argsForCand),
    ]);

    const reason = compareOutcomes(bOut, cOut, opts);
    if (reason === null) {
      passedCases++;
    } else {
      failedCases++;
      if (!firstMismatch) {
        const { shrunkArgs, shrinkSteps } = await shrinkCounterexample(
          params.baseline,
          params.candidate,
          tc.args,
          opts
        );
        const [shrunkBase, shrunkCand] = await Promise.all([
          params.baseline.invoke(shrunkArgs.map(cloneJsonSafe)),
          params.candidate.invoke(shrunkArgs.map(cloneJsonSafe)),
        ]);
        const shrunkReason = compareOutcomes(shrunkBase, shrunkCand, opts) ?? reason;

        firstMismatch = {
          caseIndex: idx,
          source: tc.source,
          originalArgs: tc.args,
          shrunkArgs,
          shrinkSteps,
          reason: shrunkReason,
          baselineOutcome: shrunkBase,
          candidateOutcome: shrunkCand,
        };
      }
      if (stopOnFirstFailure) break;
    }
  }

  return {
    passed: failedCases === 0,
    baseline: params.baseline.spec,
    candidate: params.candidate.spec,
    seed,
    totalCases: passedCases + failedCases,
    edgeCasesTested,
    randomCasesTested,
    corpusCasesTested,
    passedCases,
    failedCases,
    durationMs: performance.now() - start,
    firstMismatch,
  };
}
