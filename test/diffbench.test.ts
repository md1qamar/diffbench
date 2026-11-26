import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  bootstrapSpeedupCi,
  buildEdgeCases,
  compareOutcomes,
  compareValues,
  evaluateGate,
  formatBenchmarkReport,
  formatEquivalenceReport,
  formatGateReport,
  formatProfileReport,
  generateArgs,
  loadCasesFile,
  loadHypothesisFile,
  loadTargetRunner,
  mannWhitneyUTest,
  parseCommandLine,
  profileTarget,
  resolveInputSchema,
  runBenchmark,
  runEquivalenceCheck,
  scaffoldHypothesisWorkspace,
  SeededRng,
  studentTTwoSidedPValue,
  summarizeSamples,
  welchTTest,
} from '../src/index.js';
import { runCli } from '../src/cli.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `diffbench-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SeededRng & Schema DSL', () => {
  it('generates reproducible values for identical seeds', () => {
    const schema = resolveInputSchema(
      'array<record<id:int(1,50),tag:enum<alpha,beta,gamma>>>(2,5), nullable<string(12)>'
    );
    const a = generateArgs(schema, new SeededRng(99));
    const b = generateArgs(schema, new SeededRng(99));
    assert.deepEqual(a, b);
    assert.equal(a.length, 2);
    assert.ok(Array.isArray(a[0]));
    assert.ok((a[0] as unknown[]).length >= 2 && (a[0] as unknown[]).length <= 5);
  });

  it('builds targeted boundary edge cases and respects float special flag', () => {
    const basic = resolveInputSchema('float(-10,10), string(10)');
    const edgesBasic = buildEdgeCases(basic);
    assert.ok(edgesBasic.some((c) => Object.is(c[0], -0)));
    assert.ok(!edgesBasic.some((c) => Number.isNaN(c[0])));

    const special = resolveInputSchema('float(-10,10,special)');
    const edgesSpecial = buildEdgeCases(special);
    assert.ok(edgesSpecial.some((c) => Number.isNaN(c[0])));
    assert.ok(edgesSpecial.some((c) => c[0] === Infinity));
  });

  it('parses tuple, map, and JSON schema formats and loads cases files', () => {
    const dir = makeTempDir('cases');
    const schema = resolveInputSchema('tuple<int(0,5),bool>, map<int(1,3)>(1,2)');
    assert.equal(schema.length, 2);
    assert.equal(schema[0].kind, 'tuple');
    assert.equal(schema[1].kind, 'map');

    const jsonSchema = resolveInputSchema(
      JSON.stringify({ kind: 'record', fields: { x: { kind: 'int', min: 1, max: 2 } } })
    );
    assert.equal(jsonSchema[0].kind, 'record');

    const casesPath = path.join(dir, 'cases.json');
    fs.writeFileSync(casesPath, JSON.stringify({ cases: [[1, 2], 42] }), 'utf8');
    const loaded = loadCasesFile(casesPath);
    assert.deepEqual(loaded, [[1, 2], [42]]);

    assert.throws(() => resolveInputSchema('unknownType(1,2)'), /Unknown schema type/);
  });
});

describe('Equivalence Comparison & Shrinking', () => {
  it('handles NaN, signed zero, float tolerance, key order, and special collections', () => {
    assert.equal(compareValues(NaN, NaN, { nanEqualsNan: true }), null);
    assert.match(compareValues(NaN, NaN, { nanEqualsNan: false }) || '', /NaN/);

    assert.equal(compareValues(-0, 0, { strictZero: false }), null);
    assert.match(compareValues(-0, 0, { strictZero: true }) || '', /signed zero/);

    assert.equal(compareValues(1.00001, 1.00002, { floatTol: 1e-4 }), null);
    assert.match(compareValues(1.0, 1.01, { floatTol: 1e-4 }) || '', /expected 1/);

    assert.equal(compareValues({ b: 2, a: 1 }, { a: 1, b: 2 }), null);
    assert.match(
      compareValues({ items: [{ score: 1 }] }, { items: [{ score: 2 }] }) || '',
      /\$\.items\[0\]\.score/
    );

    assert.equal(compareValues(new Set([1, 2]), new Set([2, 1])), null);
    assert.equal(compareValues(new Map([['x', 10]]), new Map([['x', 10]])), null);
    assert.equal(compareValues(new Uint8Array([1, 2]), new Uint8Array([1, 2])), null);
    assert.match(
      compareValues(new Uint8Array([1, 2]), new Uint8Array([1, 3])) || '',
      /\$\[1\]/
    );

    assert.equal(
      compareOutcomes(
        { ok: false, errorName: 'RangeError', errorMessage: 'bad A' },
        { ok: false, errorName: 'Error', errorMessage: 'bad B' },
        { errorParity: true, strictErrorMessage: false }
      ),
      null
    );
    assert.match(
      compareOutcomes(
        { ok: false, errorName: 'Error', errorMessage: 'boom' },
        { ok: true, value: 42 }
      ) || '',
      /Error parity mismatch/
    );
  });

  it('detects subtle bugs via fuzzing and shrinks failing array counterexamples', async () => {
    const dir = makeTempDir('shrink');
    const baseFile = path.join(dir, 'base.mjs');
    const candFile = path.join(dir, 'cand.mjs');

    fs.writeFileSync(
      baseFile,
      `export function sumPositive(arr) {
        let s = 0;
        for (const n of arr) if (n > 0) s += n;
        return s;
      }\n`,
      'utf8'
    );
    // Deliberate bug: drops numbers >= 50 when array has >= 1 element
    fs.writeFileSync(
      candFile,
      `export function sumPositive(arr) {
        let s = 0;
        for (const n of arr) if (n > 0 && n < 50) s += n;
        return s;
      }\n`,
      'utf8'
    );

    const baseline = await loadTargetRunner(`${baseFile}#sumPositive`);
    const candidate = await loadTargetRunner(`${candFile}#sumPositive`);
    try {
      const report = await runEquivalenceCheck({
        baseline,
        candidate,
        schema: 'array<int(-10,100)>(5,25)',
        seed: 7,
        iterations: 80,
      });

      assert.equal(report.passed, false);
      assert.ok(report.firstMismatch !== null);
      const shrunkArr = report.firstMismatch.shrunkArgs[0] as number[];
      assert.equal(shrunkArr.length, 1);
      assert.ok(shrunkArr[0] >= 50);
    } finally {
      await baseline.close();
      await candidate.close();
    }
  });

  it('supports cmd: and jsonl: subprocess runners cross-platform', async () => {
    const dir = makeTempDir('subproc');
    const cmdWorker = path.join(dir, 'cmd-worker.mjs');
    const jsonlWorker = path.join(dir, 'jsonl-worker.mjs');

    fs.writeFileSync(
      cmdWorker,
      `import fs from 'node:fs';
      const args = JSON.parse(fs.readFileSync(0, 'utf8'));
      console.log(JSON.stringify({ ok: true, value: args[0] + args[1] }));\n`,
      'utf8'
    );
    fs.writeFileSync(
      jsonlWorker,
      `import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const args = JSON.parse(line);
        process.stdout.write(JSON.stringify({ ok: true, value: args[0] + args[1] }) + '\\n');
      });\n`,
      'utf8'
    );

    assert.deepEqual(parseCommandLine('node "my script.mjs" --flag'), [
      'node',
      'my script.mjs',
      '--flag',
    ]);

    const nodeBin = JSON.stringify(process.execPath);
    const base = await loadTargetRunner(`cmd:${nodeBin} ${JSON.stringify(cmdWorker)}`);
    const cand = await loadTargetRunner(`jsonl:${nodeBin} ${JSON.stringify(jsonlWorker)}`);

    try {
      const report = await runEquivalenceCheck({
        baseline: base,
        candidate: cand,
        schema: 'int(-20,20), int(-20,20)',
        iterations: 15,
        includeEdgeCases: false,
      });
      assert.equal(report.passed, true);
      assert.equal(report.passedCases, 15);
    } finally {
      await base.close();
      await cand.close();
    }
  });
});

describe('Statistical Engine', () => {
  it('computes accurate summary metrics, Welch t-test, Mann-Whitney U, and bootstrap CI', () => {
    const baselineSamples = [10.2, 10.0, 10.4, 9.9, 10.1, 10.3, 10.0, 10.2, 10.1, 10.3];
    const candidateSamples = [2.0, 2.1, 1.9, 2.05, 2.0, 2.15, 1.95, 2.0, 2.05, 2.1];

    const summaryB = summarizeSamples(baselineSamples, 1);
    assert.ok(summaryB.medianMsPerOp > 10.0 && summaryB.medianMsPerOp < 10.3);
    assert.ok(summaryB.opsPerSec > 95 && summaryB.opsPerSec < 105);

    const welch = welchTTest(baselineSamples, candidateSamples);
    assert.ok(welch.tStatistic > 50);
    assert.ok(welch.pValueOneSidedFaster < 1e-8);

    const mw = mannWhitneyUTest(baselineSamples, candidateSamples);
    assert.equal(mw.uStatistic, 0);
    assert.equal(mw.cliffsDelta, 1);
    assert.ok(mw.pValueOneSidedFaster < 0.001);

    const ci = bootstrapSpeedupCi(baselineSamples, candidateSamples, 0.05, 500, 123);
    assert.ok(ci.medianSpeedupLow > 4.5 && ci.medianSpeedupHigh < 5.5);

    // Identical samples should not reject null hypothesis
    const sameWelch = welchTTest(baselineSamples, baselineSamples);
    assert.equal(sameWelch.pValueTwoSided, 1);
    assert.ok(studentTTwoSidedPValue(0, 10) === 1);
  });
});

describe('Benchmark, Gate, Profiler & CLI', () => {
  it('corroborates valid optimization hypothesis from scaffolded workspace', async () => {
    const dir = makeTempDir('gate-pass');
    const files = scaffoldHypothesisWorkspace(dir);
    assert.equal(files.length, 3);

    const spec = loadHypothesisFile(path.join(dir, 'hypothesis.json'));
    spec.iterations = 40;
    spec.samples = 18;
    spec.warmup = 3;

    const gateReport = await evaluateGate(spec, { cwd: dir });
    assert.equal(gateReport.verdict, 'CORROBORATED');
    assert.equal(gateReport.passed, true);
    assert.equal(gateReport.equivalence.passed, true);
    assert.ok(gateReport.benchmark !== null);
    assert.ok(gateReport.benchmark.comparison.speedupMedian >= 1.5);

    // Ensure all formatters render non-empty reports cleanly
    assert.ok(formatGateReport(gateReport, 'pretty', false).includes('CORROBORATED'));
    assert.ok(formatGateReport(gateReport, 'markdown', false).includes('# diffbench Gate'));
    assert.doesNotThrow(() => JSON.parse(formatGateReport(gateReport, 'json', false)));
  });

  it('falsifies hypotheses when speedup is insufficient or behavior drifts', async () => {
    const dir = makeTempDir('gate-fail');
    scaffoldHypothesisWorkspace(dir);

    const spec = loadHypothesisFile(path.join(dir, 'hypothesis.json'));
    spec.iterations = 20;
    spec.samples = 12;
    spec.warmup = 2;
    spec.minSpeedup = 500.0; // Unrealistic claim must be falsified

    const slowFalsified = await evaluateGate(spec, { cwd: dir });
    assert.equal(slowFalsified.verdict, 'FALSIFIED');
    assert.equal(slowFalsified.passed, false);
    assert.ok(slowFalsified.falsificationReasons.some((r) => r.includes('below required')));

    // Break candidate correctness
    fs.writeFileSync(
      path.join(dir, 'candidate.mjs'),
      `export function uniqueIntersection() { return []; }\n`,
      'utf8'
    );
    spec.minSpeedup = 1.0;
    const bugFalsified = await evaluateGate(spec, { cwd: dir });
    assert.equal(bugFalsified.verdict, 'FALSIFIED');
    assert.equal(bugFalsified.benchmark, null);
    assert.ok(bugFalsified.falsificationReasons.some((r) => r.includes('Equivalence falsified')));
  });

  it('profiles a local ESM function using V8 CPU profiler and runs CLI subcommands', async () => {
    const dir = makeTempDir('cli');
    const modPath = path.join(dir, 'hot.mjs');
    fs.writeFileSync(
      modPath,
      `export function heavyLoop(n) {
        let acc = 0;
        for (let i = 0; i < Math.max(1000, Math.abs(n) * 200); i++) {
          acc = (acc + ((i * 31) % 97)) | 0;
        }
        return acc;
      }\n`,
      'utf8'
    );

    const prof = await profileTarget({
      target: `${modPath}#heavyLoop`,
      schema: 'int(100,300)',
      durationMs: 120,
      top: 5,
    });
    assert.equal(prof.runtime, 'node-v8');
    assert.ok(prof.totalDurationMs > 0);
    assert.ok(formatProfileReport(prof, 'markdown', false).includes('Hotspot Profile'));

    const initDir = path.join(dir, 'scaffold');
    assert.equal(await runCli(['init', '--dir', initDir, '--no-color']), 0);
    assert.ok(fs.existsSync(path.join(initDir, 'hypothesis.json')));

    const gateCode = await runCli([
      'gate',
      path.join(initDir, 'hypothesis.json'),
      '--iterations',
      '25',
      '--samples',
      '14',
      '--warmup',
      '2',
      '--json',
    ]);
    assert.equal(gateCode, 0);

    const equivCode = await runCli([
      'equiv',
      '--baseline',
      `${modPath}#heavyLoop`,
      '--candidate',
      `${modPath}#heavyLoop`,
      '--schema',
      'int(1,20)',
      '--iterations',
      '10',
      '--markdown',
    ]);
    assert.equal(equivCode, 0);

    const benchRunnerBase = await loadTargetRunner(`${modPath}#heavyLoop`);
    const benchRunnerCand = await loadTargetRunner(`${modPath}#heavyLoop`);
    try {
      const bReport = await runBenchmark({
        baseline: benchRunnerBase,
        candidate: benchRunnerCand,
        schema: 'int(10,30)',
        warmupRounds: 2,
        sampleRounds: 8,
        batchSize: 5,
      });
      assert.equal(bReport.sampleRounds, 8);
      assert.ok(formatEquivalenceReport(
        {
          passed: true,
          baseline: 'a',
          candidate: 'b',
          seed: 1,
          totalCases: 1,
          edgeCasesTested: 0,
          randomCasesTested: 1,
          corpusCasesTested: 0,
          passedCases: 1,
          failedCases: 0,
          durationMs: 1,
          firstMismatch: null,
        },
        'pretty',
        false
      ).includes('PASS'));
      assert.ok(formatBenchmarkReport(bReport, 'pretty', false).includes('diffbench bench'));
    } finally {
      await benchRunnerBase.close();
      await benchRunnerCand.close();
    }

    assert.equal(await runCli(['unknown-cmd']), 2);
  });
});
