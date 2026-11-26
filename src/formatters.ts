import type {
  BenchmarkReport,
  EquivalenceReport,
  GateReport,
  ProfileReport,
} from './types.js';

export type OutputFormat = 'pretty' | 'json' | 'markdown';

function makeColors(useColor: boolean) {
  if (!useColor) {
    const id = (s: string) => s;
    return { bold: id, dim: id, green: id, red: id, yellow: id, cyan: id };
  }
  return {
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  };
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms < 0.001) return `${(ms * 1_000_000).toFixed(1)} ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(2)} us`;
  return `${ms.toFixed(3)} ms`;
}

function fmtOps(ops: number): string {
  if (!Number.isFinite(ops)) return 'inf/s';
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M ops/s`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)}k ops/s`;
  return `${ops.toFixed(1)} ops/s`;
}

export function formatEquivalenceReport(
  report: EquivalenceReport,
  format: OutputFormat,
  useColor = true
): string {
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }
  if (format === 'markdown') {
    const lines = [
      `## Differential Equivalence: ${report.passed ? 'PASS' : 'FAIL'}`,
      '',
      `- **Baseline:** \`${report.baseline}\``,
      `- **Candidate:** \`${report.candidate}\``,
      `- **Cases Tested:** ${report.totalCases} (corpus: ${report.corpusCasesTested}, edge: ${report.edgeCasesTested}, random: ${report.randomCasesTested}, seed: ${report.seed})`,
      `- **Duration:** ${report.durationMs.toFixed(1)} ms`,
    ];
    if (report.firstMismatch) {
      lines.push(
        '',
        '### Minimal Counterexample',
        `- **Reason:** ${report.firstMismatch.reason}`,
        `- **Source:** ${report.firstMismatch.source} (case #${report.firstMismatch.caseIndex}, shrink probes: ${report.firstMismatch.shrinkSteps})`,
        `- **Shrunk Args:** \`${JSON.stringify(report.firstMismatch.shrunkArgs)}\``,
        `- **Baseline:** \`${JSON.stringify(report.firstMismatch.baselineOutcome)}\``,
        `- **Candidate:** \`${JSON.stringify(report.firstMismatch.candidateOutcome)}\``
      );
    }
    return lines.join('\n');
  }

  const c = makeColors(useColor);
  const badge = report.passed ? c.green('PASS') : c.red('FAIL');
  const lines = [
    `${c.bold('diffbench equiv')}  [${badge}]`,
    `  Baseline : ${report.baseline}`,
    `  Candidate: ${report.candidate}`,
    `  Cases    : ${report.passedCases}/${report.totalCases} passed (edge=${report.edgeCasesTested}, random=${report.randomCasesTested}, corpus=${report.corpusCasesTested}, seed=${report.seed})`,
    `  Duration : ${report.durationMs.toFixed(1)} ms`,
  ];

  if (report.firstMismatch) {
    const m = report.firstMismatch;
    lines.push(
      '',
      c.red(`  Counterexample found at case #${m.caseIndex} (${m.source}, shrunk in ${m.shrinkSteps} probes):`),
      `    Reason      : ${m.reason}`,
      `    Shrunk Args : ${JSON.stringify(m.shrunkArgs)}`,
      `    Baseline Out: ${JSON.stringify(m.baselineOutcome)}`,
      `    CandidateOut: ${JSON.stringify(m.candidateOutcome)}`
    );
  }
  return lines.join('\n');
}

export function formatBenchmarkReport(
  report: BenchmarkReport,
  format: OutputFormat,
  useColor = true
): string {
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }

  const b = report.baselineStats;
  const k = report.candidateStats;
  const cmp = report.comparison;

  if (format === 'markdown') {
    return [
      '## Statistical Benchmark Report',
      '',
      `- **Baseline:** \`${report.baseline}\``,
      `- **Candidate:** \`${report.candidate}\``,
      `- **Sampling:** ${report.sampleRounds} interleaved rounds (${report.warmupRounds} warmup, batch=${report.batchSize}, seed=${report.seed})`,
      '',
      '| Metric | Baseline | Candidate |',
      '| --- | ---: | ---: |',
      `| Median (p50) | ${fmtMs(b.medianMsPerOp)} | ${fmtMs(k.medianMsPerOp)} |`,
      `| Mean +/- SD | ${fmtMs(b.meanMsPerOp)} +/- ${fmtMs(b.stdDevMsPerOp)} | ${fmtMs(k.meanMsPerOp)} +/- ${fmtMs(k.stdDevMsPerOp)} |`,
      `| p95 / p99 | ${fmtMs(b.p95MsPerOp)} / ${fmtMs(b.p99MsPerOp)} | ${fmtMs(k.p95MsPerOp)} / ${fmtMs(k.p99MsPerOp)} |`,
      `| Throughput | ${fmtOps(b.opsPerSec)} | ${fmtOps(k.opsPerSec)} |`,
      '',
      `- **Median Speedup:** **${cmp.speedupMedian.toFixed(2)}x** (${cmp.percentChangeMedian >= 0 ? '+' : ''}${cmp.percentChangeMedian.toFixed(1)}%)`,
      `- **${Math.round((1 - cmp.bootstrapCi.alpha) * 100)}% Bootstrap CI:** [${cmp.bootstrapCi.medianSpeedupLow.toFixed(2)}x, ${cmp.bootstrapCi.medianSpeedupHigh.toFixed(2)}x]`,
      `- **Welch's t-test (one-sided):** t = ${cmp.welchT.tStatistic.toFixed(3)}, df = ${cmp.welchT.degreesOfFreedom.toFixed(1)}, p = ${cmp.welchT.pValueOneSidedFaster.toExponential(3)}`,
      `- **Mann-Whitney U (one-sided):** z = ${cmp.mannWhitneyU.zScore.toFixed(3)}, p = ${cmp.mannWhitneyU.pValueOneSidedFaster.toExponential(3)}, Cliff's delta = ${cmp.mannWhitneyU.cliffsDelta.toFixed(3)}`,
    ].join('\n');
  }

  const c = makeColors(useColor);
  const speedupStr =
    cmp.speedupMedian >= 1
      ? c.green(`${cmp.speedupMedian.toFixed(2)}x faster`)
      : c.red(`${(1 / cmp.speedupMedian).toFixed(2)}x slower`);

  return [
    `${c.bold('diffbench bench')}  (${report.sampleRounds} interleaved rounds, batch=${report.batchSize}, warmup=${report.warmupRounds})`,
    `  Baseline  : ${fmtMs(b.medianMsPerOp)} median | ${fmtMs(b.p95MsPerOp)} p95 | ${fmtOps(b.opsPerSec)} (outliers=${b.iqrOutliers})`,
    `  Candidate : ${fmtMs(k.medianMsPerOp)} median | ${fmtMs(k.p95MsPerOp)} p95 | ${fmtOps(k.opsPerSec)} (outliers=${k.iqrOutliers})`,
    `  Speedup   : ${speedupStr} (${Math.round((1 - cmp.bootstrapCi.alpha) * 100)}% CI [${cmp.bootstrapCi.medianSpeedupLow.toFixed(2)}x, ${cmp.bootstrapCi.medianSpeedupHigh.toFixed(2)}x])`,
    `  Welch t   : t=${cmp.welchT.tStatistic.toFixed(3)}, df=${cmp.welchT.degreesOfFreedom.toFixed(1)}, p=${cmp.welchT.pValueOneSidedFaster.toExponential(3)}`,
    `  Mann-Whit : z=${cmp.mannWhitneyU.zScore.toFixed(3)}, p=${cmp.mannWhitneyU.pValueOneSidedFaster.toExponential(3)}, cliff=${cmp.mannWhitneyU.cliffsDelta.toFixed(3)}`,
  ].join('\n');
}

export function formatGateReport(
  report: GateReport,
  format: OutputFormat,
  useColor = true
): string {
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }
  if (format === 'markdown') {
    const lines = [
      `# diffbench Gate: ${report.verdict}`,
      '',
      `**Experiment:** ${report.name}`,
      `**Hypothesis:** ${report.hypothesis}`,
      '',
      '| Criterion | Status | Expected | Actual |',
      '| --- | --- | --- | --- |',
      ...report.criteria.map(
        (cr) =>
          `| ${cr.name} | ${cr.passed ? 'PASS' : 'FAIL'} | ${cr.expected} | ${cr.actual} |`
      ),
      '',
      formatEquivalenceReport(report.equivalence, 'markdown', false),
    ];
    if (report.benchmark) {
      lines.push('', formatBenchmarkReport(report.benchmark, 'markdown', false));
    }
    if (report.falsificationReasons.length > 0) {
      lines.push(
        '',
        '### Falsification Reasons',
        ...report.falsificationReasons.map((r) => `- ${r}`)
      );
    }
    return lines.join('\n');
  }

  const c = makeColors(useColor);
  const badge = report.passed ? c.green('CORROBORATED') : c.red('FALSIFIED');
  const lines = [
    `${c.bold('diffbench gate')} :: ${c.cyan(report.name)} [${badge}]`,
    `Hypothesis: ${report.hypothesis}`,
    '',
    c.bold('Criteria:'),
    ...report.criteria.map(
      (cr) =>
        `  ${cr.passed ? c.green('[PASS]') : c.red('[FAIL]')} ${cr.name}: ${cr.actual} (expected ${cr.expected})`
    ),
    '',
    formatEquivalenceReport(report.equivalence, 'pretty', useColor),
  ];

  if (report.benchmark) {
    lines.push('', formatBenchmarkReport(report.benchmark, 'pretty', useColor));
  }

  if (report.falsificationReasons.length > 0) {
    lines.push('', c.red('Falsification Reasons:'));
    for (const reason of report.falsificationReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  return lines.join('\n');
}

export function formatProfileReport(
  report: ProfileReport,
  format: OutputFormat,
  useColor = true
): string {
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }
  if (format === 'markdown') {
    const lines = [
      `## Hotspot Profile (${report.runtime})`,
      '',
      `- **Target:** \`${report.target}\``,
      `- **Total Profiled Time:** ${report.totalDurationMs.toFixed(1)} ms (${report.totalHits} samples)`,
      '',
      '| Rank | Function | Self % | Self ms | Total % | Location |',
      '| ---: | --- | ---: | ---: | ---: | --- |',
      ...report.hotspots.map(
        (h) =>
          `| ${h.rank} | \`${h.functionName}\` | ${h.selfPercent.toFixed(1)}% | ${h.selfTimeMs.toFixed(2)} | ${h.totalPercent.toFixed(1)}% | ${h.url}:${h.lineNumber} |`
      ),
    ];
    return lines.join('\n');
  }

  const c = makeColors(useColor);
  const lines = [
    `${c.bold('diffbench profile')} (${report.runtime}) :: ${report.target}`,
    `  Duration: ${report.totalDurationMs.toFixed(1)} ms | Samples: ${report.totalHits}`,
    '',
    '  Rank  Self %   Self ms   Total %  Function (Location)',
  ];
  for (const h of report.hotspots) {
    const rank = String(h.rank).padStart(4);
    const selfPct = `${h.selfPercent.toFixed(1)}%`.padStart(7);
    const selfMs = `${h.selfTimeMs.toFixed(2)}`.padStart(8);
    const totPct = `${h.totalPercent.toFixed(1)}%`.padStart(8);
    lines.push(`  ${rank}  ${selfPct}  ${selfMs}  ${totPct}  ${h.functionName} (${h.url}:${h.lineNumber})`);
  }
  if (report.hotspots.length === 0) {
    lines.push('  (No user-space hotspots captured; try increasing --duration-ms)');
  }
  return lines.join('\n');
}
