#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from './benchmark.js';
import { runEquivalenceCheck } from './equivalence.js';
import {
  formatBenchmarkReport,
  formatEquivalenceReport,
  formatGateReport,
  formatProfileReport,
  type OutputFormat,
} from './formatters.js';
import {
  evaluateGate,
  loadHypothesisFile,
  scaffoldHypothesisWorkspace,
} from './hypothesis.js';
import { profileTarget } from './profiler.js';
import { loadTargetRunner } from './runners.js';
import type { EquivalenceOptions, HypothesisSpec } from './types.js';

const VERSION = '0.1.0';

const HELP_TEXT = `diffbench v${VERSION} — Falsifiable optimization gate for developers and coding agents

Usage:
  diffbench gate [hypothesis.json] [options]   Verify equivalence + statistical speedup
  diffbench equiv [options]                    Differential fuzzing + counterexample shrinking
  diffbench bench [options]                    Interleaved A/B statistical micro-benchmark
  diffbench profile <target> [options]         Rank hot functions (V8 CPU profiler / Python cProfile)
  diffbench init [--dir <path>]                Scaffold starter hypothesis.json + baseline/candidate

Targets:
  path/to/mod.mjs#exportName                   ESM/JS module function export (default if omitted)
  "cmd:python baseline.py"                     One-shot executable (JSON args on stdin -> JSON stdout)
  "jsonl:./fast_worker"                        Persistent NDJSON stdio worker (high-throughput)

Schema DSL (--schema):
  int(min,max), float(min,max), bool, string(maxLen), enum<a,b>, nullable<T>,
  array<T>(minLen,maxLen), tuple<T1,T2>, record<k1:T1,k2:T2>, map<T>(min,max)

Common Options:
  --baseline <target>        Baseline implementation target
  --candidate <target>       Optimized/ported candidate target
  --schema <dsl|json>        Input schema DSL (comma-separated positional args)
  --cases <file.json>        Static corpus JSON file of input vectors
  --seed <n>                 Deterministic PRNG seed (default: 42)
  --iterations <n>           Random equivalence fuzz iterations (default: 200)
  --samples <n>              Interleaved A/B benchmark rounds (default: 30)
  --warmup <n>               Warmup rounds before timing (default: 5)
  --batch <n>                Explicit ops per sample round (default: auto-calibrated)
  --min-speedup <x>          Minimum required median speedup for gate (default: 1.10)
  --max-p-value <p>          Significance threshold alpha (default: 0.05)
  --ci-lower <x>             Minimum bootstrap CI lower bound (default: 1.00)
  --float-tol <eps>          Absolute float comparison tolerance (default: 0)
  --strict-zero              Distinguish -0 from +0
  --nan-unequal              Treat NaN != NaN
  --no-edge-cases            Skip adversarial edge-case inputs
  --clone-inputs             Clone inputs per benchmark call (for in-place mutators)
  --json                     Emit machine-readable JSON output
  --markdown                 Emit GitHub-flavored Markdown report
  --no-color                 Disable ANSI terminal colors
  -h, --help                 Show this help message
  -v, --version              Show version
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'markdown',
  'no-color',
  'no-edge-cases',
  'clone-inputs',
  'strict-zero',
  'nan-unequal',
  'include-internals',
  'help',
  'h',
  'version',
  'v',
]);

export function parseCliArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx);
        const val = token.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = token.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags[key] = argv[++i];
        } else {
          flags[key] = true;
        }
      }
    } else if (token === '-h') {
      flags.help = true;
    } else if (token === '-v') {
      flags.version = true;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : undefined;
}

function getNumberFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const val = flags[key];
  if (typeof val !== 'string') return undefined;
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid numeric value for --${key}: "${val}"`);
  }
  return num;
}

function resolveOutputFormat(flags: Record<string, string | boolean>): OutputFormat {
  if (flags.json) return 'json';
  if (flags.markdown) return 'markdown';
  return 'pretty';
}

function buildEquivalenceOptions(flags: Record<string, string | boolean>): EquivalenceOptions {
  return {
    floatTol: getNumberFlag(flags, 'float-tol'),
    strictZero: Boolean(flags['strict-zero']),
    nanEqualsNan: flags['nan-unequal'] ? false : undefined,
  };
}

export async function runCli(argv: string[]): Promise<number> {
  const { positional, flags } = parseCliArgs(argv);

  if (flags.version) {
    console.log(VERSION);
    return 0;
  }

  const command = positional[0];
  if (!command || flags.help || command === 'help') {
    console.log(HELP_TEXT);
    return 0;
  }

  const format = resolveOutputFormat(flags);
  const useColor = !flags['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY !== false;

  switch (command) {
    case 'init': {
      const dir = getStringFlag(flags, 'dir') || positional[1] || '.';
      const created = scaffoldHypothesisWorkspace(dir);
      if (format === 'json') {
        console.log(JSON.stringify({ dir: path.resolve(dir), created }, null, 2));
      } else {
        console.log(`Scaffolded diffbench workspace in ${path.resolve(dir)}:`);
        for (const f of created) {
          console.log(`  - ${path.relative(process.cwd(), f) || f}`);
        }
        console.log('\nNext step: diffbench gate ' + path.join(dir, 'hypothesis.json'));
      }
      return 0;
    }

    case 'equiv': {
      const baselineSpec = getStringFlag(flags, 'baseline');
      const candidateSpec = getStringFlag(flags, 'candidate');
      if (!baselineSpec || !candidateSpec) {
        console.error('Error: `diffbench equiv` requires --baseline and --candidate.');
        return 2;
      }
      const schema = getStringFlag(flags, 'schema');
      const casesFile = getStringFlag(flags, 'cases');
      if (!schema && !casesFile) {
        console.error('Error: `diffbench equiv` requires --schema or --cases.');
        return 2;
      }

      const baseline = await loadTargetRunner(baselineSpec);
      const candidate = await loadTargetRunner(candidateSpec);
      try {
        const report = await runEquivalenceCheck({
          baseline,
          candidate,
          schema,
          casesFile,
          seed: getNumberFlag(flags, 'seed'),
          iterations: getNumberFlag(flags, 'iterations'),
          includeEdgeCases: !flags['no-edge-cases'],
          equivalenceOptions: buildEquivalenceOptions(flags),
        });
        console.log(formatEquivalenceReport(report, format, useColor));
        return report.passed ? 0 : 1;
      } finally {
        await baseline.close();
        await candidate.close();
      }
    }

    case 'bench': {
      const baselineSpec = getStringFlag(flags, 'baseline');
      const candidateSpec = getStringFlag(flags, 'candidate');
      if (!baselineSpec || !candidateSpec) {
        console.error('Error: `diffbench bench` requires --baseline and --candidate.');
        return 2;
      }
      const baseline = await loadTargetRunner(baselineSpec);
      const candidate = await loadTargetRunner(candidateSpec);
      try {
        const report = await runBenchmark({
          baseline,
          candidate,
          schema: getStringFlag(flags, 'schema'),
          casesFile: getStringFlag(flags, 'cases'),
          seed: getNumberFlag(flags, 'seed'),
          warmupRounds: getNumberFlag(flags, 'warmup'),
          sampleRounds: getNumberFlag(flags, 'samples'),
          batchSize: getNumberFlag(flags, 'batch'),
          alpha: getNumberFlag(flags, 'max-p-value'),
          cloneInputs: Boolean(flags['clone-inputs']),
        });
        console.log(formatBenchmarkReport(report, format, useColor));
        return 0;
      } finally {
        await baseline.close();
        await candidate.close();
      }
    }

    case 'gate': {
      const maybeFile = positional[1];
      const hasExplicitTargets = Boolean(
        getStringFlag(flags, 'baseline') && getStringFlag(flags, 'candidate')
      );
      let spec: HypothesisSpec;
      let baseCwd = process.cwd();

      if (maybeFile) {
        const resolved = path.resolve(maybeFile);
        baseCwd = path.dirname(resolved);
        spec = loadHypothesisFile(resolved);
      } else if (!hasExplicitTargets && fs.existsSync(path.resolve('hypothesis.json'))) {
        const resolved = path.resolve('hypothesis.json');
        baseCwd = path.dirname(resolved);
        spec = loadHypothesisFile(resolved);
      } else if (hasExplicitTargets) {
        spec = {
          name: getStringFlag(flags, 'name') || 'cli-hypothesis',
          hypothesis:
            getStringFlag(flags, 'hypothesis') ||
            'Candidate preserves behavioral equivalence and achieves required speedup.',
          baseline: getStringFlag(flags, 'baseline')!,
          candidate: getStringFlag(flags, 'candidate')!,
        };
      } else {
        console.error(
          'Error: provide a hypothesis.json file or --baseline and --candidate flags.'
        );
        return 2;
      }

      // Apply CLI flag overrides on top of hypothesis.json
      if (getStringFlag(flags, 'baseline')) spec.baseline = getStringFlag(flags, 'baseline')!;
      if (getStringFlag(flags, 'candidate')) spec.candidate = getStringFlag(flags, 'candidate')!;
      if (getStringFlag(flags, 'schema')) spec.schema = getStringFlag(flags, 'schema')!;
      if (getStringFlag(flags, 'cases')) spec.casesFile = getStringFlag(flags, 'cases')!;
      if (getNumberFlag(flags, 'seed') !== undefined) spec.seed = getNumberFlag(flags, 'seed');
      if (getNumberFlag(flags, 'iterations') !== undefined)
        spec.iterations = getNumberFlag(flags, 'iterations');
      if (getNumberFlag(flags, 'samples') !== undefined) spec.samples = getNumberFlag(flags, 'samples');
      if (getNumberFlag(flags, 'warmup') !== undefined) spec.warmup = getNumberFlag(flags, 'warmup');
      if (getNumberFlag(flags, 'min-speedup') !== undefined)
        spec.minSpeedup = getNumberFlag(flags, 'min-speedup');
      if (getNumberFlag(flags, 'max-p-value') !== undefined)
        spec.maxPValue = getNumberFlag(flags, 'max-p-value');
      if (getNumberFlag(flags, 'ci-lower') !== undefined)
        spec.requireCiLowerAbove = getNumberFlag(flags, 'ci-lower');
      if (flags['no-edge-cases']) spec.includeEdgeCases = false;

      const eqOverrides = buildEquivalenceOptions(flags);
      spec.equivalence = {
        ...spec.equivalence,
        ...(eqOverrides.floatTol !== undefined ? { floatTol: eqOverrides.floatTol } : {}),
        ...(eqOverrides.strictZero ? { strictZero: true } : {}),
        ...(eqOverrides.nanEqualsNan === false ? { nanEqualsNan: false } : {}),
      };

      if (!spec.schema && !spec.casesFile) {
        console.error('Error: gate requires a "schema" or "casesFile" (--schema / --cases).');
        return 2;
      }

      const report = await evaluateGate(spec, {
        cwd: baseCwd,
        cloneInputs: Boolean(flags['clone-inputs']),
      });
      console.log(formatGateReport(report, format, useColor));
      return report.passed ? 0 : 1;
    }

    case 'profile': {
      const target = positional[1] || getStringFlag(flags, 'target');
      if (!target) {
        console.error('Error: `diffbench profile` requires a target script or module#fn.');
        return 2;
      }
      const report = await profileTarget({
        target,
        schema: getStringFlag(flags, 'schema'),
        casesFile: getStringFlag(flags, 'cases'),
        durationMs: getNumberFlag(flags, 'duration-ms'),
        seed: getNumberFlag(flags, 'seed'),
        top: getNumberFlag(flags, 'top'),
        includeInternals: Boolean(flags['include-internals']),
      });
      console.log(formatProfileReport(report, format, useColor));
      return 0;
    }

    default:
      console.error(`Unknown subcommand "${command}". Run \`diffbench --help\` for usage.`);
      return 2;
  }
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('diffbench error:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
