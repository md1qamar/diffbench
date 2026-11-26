import { SeededRng } from './prng.js';
import type { SampleSummary, StatisticalComparison } from './types.js';

/**
 * Computes log-gamma via Lanczos approximation for accurate incomplete beta / t-distribution CDF.
 */
function logGamma(z: number): number {
  const coeffs = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const shifted = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < coeffs.length; i++) {
    x += coeffs[i] / (shifted + i + 1);
  }
  const t = shifted + coeffs.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b) using continued fractions.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value from Student's t distribution with `df` degrees of freedom.
 */
export function studentTTwoSidedPValue(tAbs: number, df: number): number {
  if (!Number.isFinite(tAbs)) return 0;
  if (df <= 0 || !Number.isFinite(df)) return 1;
  if (tAbs === 0) return 1;
  const x = df / (df + tAbs * tAbs);
  return Math.min(1, Math.max(0, regularizedIncompleteBeta(x, df / 2, 0.5)));
}

/**
 * Standard normal complementary CDF approximation (Abramowitz & Stegun 7.1.26).
 */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Computes quantile `q` in [0, 1] using linear interpolation on a sorted array.
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const weight = pos - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

/**
 * Summarizes per-operation latency samples (in milliseconds).
 */
export function summarizeSamples(samplesMsPerOp: readonly number[], batchSize: number): SampleSummary {
  if (samplesMsPerOp.length === 0) {
    throw new Error('Cannot summarize empty sample array.');
  }
  const n = samplesMsPerOp.length;
  const sorted = [...samplesMsPerOp].sort((a, b) => a - b);
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
  const median = quantile(sorted, 0.5);
  const variance =
    n > 1 ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = quantile(absDevs, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const fenceLo = q1 - 1.5 * iqr;
  const fenceHi = q3 + 1.5 * iqr;
  const iqrOutliers = sorted.filter((v) => v < fenceLo || v > fenceHi).length;

  return {
    n,
    batchSize,
    meanMsPerOp: mean,
    medianMsPerOp: median,
    stdDevMsPerOp: stdDev,
    madMsPerOp: mad,
    minMsPerOp: sorted[0],
    maxMsPerOp: sorted[n - 1],
    p50MsPerOp: median,
    p95MsPerOp: quantile(sorted, 0.95),
    p99MsPerOp: quantile(sorted, 0.99),
    iqrOutliers,
    opsPerSec: median > 0 ? 1000 / median : Infinity,
    samplesMsPerOp: [...samplesMsPerOp],
  };
}

/**
 * Computes Welch's two-sample t-test (H1: baseline mean > candidate mean, i.e., candidate is faster).
 */
export function welchTTest(baseline: readonly number[], candidate: readonly number[]) {
  const n1 = baseline.length;
  const n2 = candidate.length;
  const m1 = baseline.reduce((a, b) => a + b, 0) / n1;
  const m2 = candidate.reduce((a, b) => a + b, 0) / n2;
  const v1 = n1 > 1 ? baseline.reduce((a, b) => a + (b - m1) ** 2, 0) / (n1 - 1) : 0;
  const v2 = n2 > 1 ? candidate.reduce((a, b) => a + (b - m2) ** 2, 0) / (n2 - 1) : 0;

  const s1 = v1 / n1;
  const s2 = v2 / n2;
  const se = Math.sqrt(s1 + s2);

  if (se === 0) {
    if (m1 === m2) {
      return { tStatistic: 0, degreesOfFreedom: n1 + n2 - 2, pValueTwoSided: 1, pValueOneSidedFaster: 0.5 };
    }
    const dir = m1 > m2 ? Infinity : -Infinity;
    return {
      tStatistic: dir,
      degreesOfFreedom: n1 + n2 - 2,
      pValueTwoSided: 0,
      pValueOneSidedFaster: m1 > m2 ? 0 : 1,
    };
  }

  const t = (m1 - m2) / se;
  const denom = (s1 * s1) / Math.max(1, n1 - 1) + (s2 * s2) / Math.max(1, n2 - 1);
  const df = denom > 0 ? ((s1 + s2) ** 2) / denom : n1 + n2 - 2;
  const pTwo = studentTTwoSidedPValue(Math.abs(t), df);
  const pOneFaster = t >= 0 ? pTwo / 2 : 1 - pTwo / 2;

  return {
    tStatistic: t,
    degreesOfFreedom: df,
    pValueTwoSided: pTwo,
    pValueOneSidedFaster: pOneFaster,
  };
}

/**
 * Computes the non-parametric Mann-Whitney U test with tie correction and Cliff's delta.
 */
export function mannWhitneyUTest(baseline: readonly number[], candidate: readonly number[]) {
  const n1 = baseline.length;
  const n2 = candidate.length;
  const combined: Array<{ value: number; group: 0 | 1 }> = [
    ...baseline.map((value) => ({ value, group: 0 as const })),
    ...candidate.map((value) => ({ value, group: 1 as const })),
  ];
  combined.sort((a, b) => a.value - b.value);

  let r1 = 0;
  let tieCorrection = 0;
  let i = 0;
  while (i < combined.length) {
    let j = i + 1;
    while (j < combined.length && combined[j].value === combined[i].value) {
      j++;
    }
    const count = j - i;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (combined[k].group === 0) r1 += avgRank;
    }
    if (count > 1) {
      tieCorrection += count ** 3 - count;
    }
    i = j;
  }

  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const uStatistic = Math.min(u1, u2);
  const N = n1 + n2;
  const mu = (n1 * n2) / 2;
  const variance =
    N > 1
      ? ((n1 * n2) / 12) * (N + 1 - tieCorrection / (N * (N - 1)))
      : 0;
  const sigma = Math.sqrt(Math.max(0, variance));

  // Positive z means baseline values rank higher (slower) than candidate values.
  const zScore = sigma > 0 ? (u1 - mu) / sigma : 0;
  const pTwo = sigma > 0 ? Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(zScore))))) : 1;
  const pOneFaster = sigma > 0 ? Math.min(1, Math.max(0, 1 - normalCdf(zScore))) : 0.5;
  const cliffsDelta = (u1 - u2) / (n1 * n2);

  return {
    uStatistic,
    zScore,
    pValueTwoSided: pTwo,
    pValueOneSidedFaster: pOneFaster,
    cliffsDelta,
  };
}

/**
 * Computes seeded percentile bootstrap confidence intervals for speedup ratios.
 */
export function bootstrapSpeedupCi(
  baseline: readonly number[],
  candidate: readonly number[],
  alpha = 0.05,
  resamples = 2000,
  seed = 1337
) {
  const rng = new SeededRng(seed);
  const n1 = baseline.length;
  const n2 = candidate.length;
  const medianRatios: number[] = [];
  const meanRatios: number[] = [];

  const bScratch = new Array<number>(n1);
  const cScratch = new Array<number>(n2);

  for (let r = 0; r < resamples; r++) {
    let bSum = 0;
    for (let i = 0; i < n1; i++) {
      const v = baseline[Math.floor(rng.next() * n1)];
      bScratch[i] = v;
      bSum += v;
    }
    let cSum = 0;
    for (let i = 0; i < n2; i++) {
      const v = candidate[Math.floor(rng.next() * n2)];
      cScratch[i] = v;
      cSum += v;
    }

    bScratch.sort((a, b) => a - b);
    cScratch.sort((a, b) => a - b);

    const bMed = quantile(bScratch, 0.5);
    const cMed = quantile(cScratch, 0.5);
    medianRatios.push(cMed > 0 ? bMed / cMed : 1);
    meanRatios.push(cSum > 0 ? (bSum / n1) / (cSum / n2) : 1);
  }

  medianRatios.sort((a, b) => a - b);
  meanRatios.sort((a, b) => a - b);

  return {
    alpha,
    resamples,
    medianSpeedupLow: quantile(medianRatios, alpha / 2),
    medianSpeedupHigh: quantile(medianRatios, 1 - alpha / 2),
    meanSpeedupLow: quantile(meanRatios, alpha / 2),
    meanSpeedupHigh: quantile(meanRatios, 1 - alpha / 2),
  };
}

/**
 * Runs full comparative inferential statistics between baseline and candidate summaries.
 */
export function compareBenchmarks(
  baseline: SampleSummary,
  candidate: SampleSummary,
  alpha = 0.05,
  seed = 1337
): StatisticalComparison {
  const speedupMean =
    candidate.meanMsPerOp > 0 ? baseline.meanMsPerOp / candidate.meanMsPerOp : Infinity;
  const speedupMedian =
    candidate.medianMsPerOp > 0 ? baseline.medianMsPerOp / candidate.medianMsPerOp : Infinity;
  const percentChangeMedian =
    baseline.medianMsPerOp > 0
      ? ((baseline.medianMsPerOp - candidate.medianMsPerOp) / baseline.medianMsPerOp) * 100
      : 0;

  return {
    speedupMean,
    speedupMedian,
    percentChangeMedian,
    welchT: welchTTest(baseline.samplesMsPerOp, candidate.samplesMsPerOp),
    mannWhitneyU: mannWhitneyUTest(baseline.samplesMsPerOp, candidate.samplesMsPerOp),
    bootstrapCi: bootstrapSpeedupCi(
      baseline.samplesMsPerOp,
      candidate.samplesMsPerOp,
      alpha,
      2000,
      seed
    ),
  };
}
