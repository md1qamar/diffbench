import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import inspector from 'node:inspector/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SeededRng } from './prng.js';
import { loadTargetRunner } from './runners.js';
import { generateArgs, loadCasesFile, resolveInputSchema } from './schema.js';
import type { HotspotEntry, InputSchema, ProfileReport } from './types.js';

interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface ProfileTargetParams {
  target: string;
  schema?: string | InputSchema;
  casesFile?: string;
  durationMs?: number;
  seed?: number;
  top?: number;
  includeInternals?: boolean;
  cwd?: string;
}

const SELF_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function isInternalUrl(url: string): boolean {
  if (!url) return true;
  if (url.startsWith('node:') || url.startsWith('internal/')) return true;
  if (url.startsWith('file://')) {
    try {
      const fsPath = path.resolve(fileURLToPath(url));
      const rel = path.relative(SELF_MODULE_DIR, fsPath);
      if (rel === 'profiler.js' || rel === 'profiler.ts' || rel === 'runners.js' || rel === 'runners.ts') {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }
  return false;
}

function formatUrlDisplay(url: string, cwd: string): string {
  if (!url) return '(native)';
  if (url.startsWith('file://')) {
    try {
      const fsPath = path.resolve(fileURLToPath(url));
      const rel = path.relative(cwd, fsPath);
      return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : fsPath;
    } catch {
      return url;
    }
  }
  return url;
}

function aggregateV8Profile(
  profile: CpuProfile,
  top: number,
  includeInternals: boolean,
  cwd: string
): { totalDurationMs: number; totalHits: number; hotspots: HotspotEntry[] } {
  const totalDurationMs = Math.max(0.01, (profile.endTime - profile.startTime) / 1000);
  const nodeMap = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) {
    nodeMap.set(node.id, node);
  }

  // Accumulate exact sample deltas if available; otherwise fall back to hitCount proportions.
  const selfTimeUs = new Map<number, number>();
  const totalTimeUs = new Map<number, number>();
  let totalHits = 0;

  if (
    Array.isArray(profile.samples) &&
    Array.isArray(profile.timeDeltas) &&
    profile.samples.length === profile.timeDeltas.length &&
    profile.samples.length > 0
  ) {
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      const dt = profile.timeDeltas[i];
      selfTimeUs.set(id, (selfTimeUs.get(id) ?? 0) + dt);
      totalHits++;
    }
  } else {
    for (const node of profile.nodes) {
      totalHits += node.hitCount ?? 0;
    }
    const usPerHit = totalHits > 0 ? (profile.endTime - profile.startTime) / totalHits : 0;
    for (const node of profile.nodes) {
      if ((node.hitCount ?? 0) > 0) {
        selfTimeUs.set(node.id, (node.hitCount ?? 0) * usPerHit);
      }
    }
  }

  // Bottom-up inclusive time propagation across the call tree.
  const visited = new Set<number>();
  function computeInclusive(id: number): number {
    if (visited.has(id)) return totalTimeUs.get(id) ?? 0;
    visited.add(id);
    const node = nodeMap.get(id);
    let sum = selfTimeUs.get(id) ?? 0;
    if (node?.children) {
      for (const childId of node.children) {
        sum += computeInclusive(childId);
      }
    }
    totalTimeUs.set(id, sum);
    return sum;
  }

  if (profile.nodes.length > 0) {
    computeInclusive(profile.nodes[0].id);
  }

  // Merge frames sharing the same functionName + url + lineNumber.
  const merged = new Map<
    string,
    {
      functionName: string;
      url: string;
      lineNumber: number;
      selfUs: number;
      totalUs: number;
      hits: number;
    }
  >();

  for (const node of profile.nodes) {
    const cf = node.callFrame;
    const fnName = cf.functionName || '(anonymous)';
    if (fnName === '(root)' || fnName === '(program)' || fnName === '(idle)') continue;
    if (!includeInternals && isInternalUrl(cf.url)) continue;

    const sUs = selfTimeUs.get(node.id) ?? 0;
    const tUs = totalTimeUs.get(node.id) ?? 0;
    const hits = node.hitCount ?? 0;
    if (sUs === 0 && tUs === 0 && hits === 0) continue;

    const displayUrl = formatUrlDisplay(cf.url, cwd);
    const line = (cf.lineNumber ?? 0) + 1;
    const key = `${fnName}@${displayUrl}:${line}`;
    const prev = merged.get(key);
    if (prev) {
      prev.selfUs += sUs;
      prev.totalUs = Math.max(prev.totalUs, tUs);
      prev.hits += hits;
    } else {
      merged.set(key, {
        functionName: fnName,
        url: displayUrl,
        lineNumber: line,
        selfUs: sUs,
        totalUs: tUs,
        hits,
      });
    }
  }

  const totalObservedUs = [...selfTimeUs.values()].reduce((a, b) => a + b, 0) || totalDurationMs * 1000;
  const sorted = [...merged.values()]
    .sort((a, b) => b.selfUs - a.selfUs || b.totalUs - a.totalUs)
    .slice(0, top);

  const hotspots: HotspotEntry[] = sorted.map((item, idx) => ({
    rank: idx + 1,
    functionName: item.functionName,
    url: item.url,
    lineNumber: item.lineNumber,
    selfTimeMs: item.selfUs / 1000,
    totalTimeMs: item.totalUs / 1000,
    selfPercent: (item.selfUs / totalObservedUs) * 100,
    totalPercent: Math.min(100, (item.totalUs / totalObservedUs) * 100),
    hitCount: item.hits,
  }));

  return { totalDurationMs, totalHits, hotspots };
}

function resolvePythonBin(): string {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error('Python executable (python / python3) not found on PATH.');
}

function profilePythonScript(
  target: string,
  top: number,
  includeInternals: boolean,
  cwd: string
): ProfileReport {
  const pyBin = resolvePythonBin();
  const absScript = path.resolve(cwd, target);
  const helper = [
    'import cProfile, pstats, runpy, json, sys',
    'script = sys.argv[1]',
    'top_n = int(sys.argv[2])',
    'inc_int = sys.argv[3] == "1"',
    'prof = cProfile.Profile()',
    'prof.enable()',
    'runpy.run_path(script, run_name="__main__")',
    'prof.disable()',
    'ps = pstats.Stats(prof)',
    'rows = []',
    'total_tt = sum(v[2] for v in ps.stats.values()) or 1e-9',
    'for (fn_file, lineno, fn_name), (cc, nc, tt, ct, callers) in ps.stats.items():',
    '    if not inc_int and (fn_file.startswith("<") or fn_file == "~"):',
    '        continue',
    '    rows.append({"functionName": fn_name, "url": fn_file, "lineNumber": lineno, "selfTimeMs": tt * 1000.0, "totalTimeMs": ct * 1000.0, "selfPercent": (tt / total_tt) * 100.0, "totalPercent": min(100.0, (ct / total_tt) * 100.0), "hitCount": nc})',
    'rows.sort(key=lambda r: r["selfTimeMs"], reverse=True)',
    'print(json.dumps({"totalDurationMs": total_tt * 1000.0, "totalHits": len(ps.stats), "hotspots": rows[:top_n]}))',
  ].join('\n');

  const res = spawnSync(pyBin, ['-c', helper, absScript, String(top), includeInternals ? '1' : '0'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });

  if (res.status !== 0) {
    throw new Error(`Python profiler failed: ${(res.stderr || res.stdout).trim()}`);
  }

  const lines = res.stdout.trim().split(/\r?\n/);
  const payload = JSON.parse(lines[lines.length - 1]) as {
    totalDurationMs: number;
    totalHits: number;
    hotspots: Array<Omit<HotspotEntry, 'rank'>>;
  };

  return {
    runtime: 'python-cprofile',
    target,
    totalDurationMs: payload.totalDurationMs,
    totalHits: payload.totalHits,
    hotspots: payload.hotspots.map((h, idx) => ({
      rank: idx + 1,
      ...h,
      url: formatUrlDisplay(h.url, cwd),
    })),
  };
}

/**
 * Profiles a local JS/ESM module target (`file.mjs#fn` or standalone script) using V8 Inspector,
 * or a local Python script (`script.py`) using `cProfile`, returning ranked hotspots.
 */
export async function profileTarget(params: ProfileTargetParams): Promise<ProfileReport> {
  const cwd = params.cwd ?? process.cwd();
  const top = params.top ?? 15;
  const durationMs = params.durationMs ?? 250;
  const includeInternals = params.includeInternals ?? false;

  if (params.target.endsWith('.py')) {
    return profilePythonScript(params.target, top, includeInternals, cwd);
  }

  const hasExport = params.target.includes('#') || params.target.lastIndexOf(':') > 2;
  const cases: unknown[][] = [];
  if (params.casesFile) {
    cases.push(...loadCasesFile(path.resolve(cwd, params.casesFile)));
  } else if (params.schema) {
    const parsed = resolveInputSchema(params.schema);
    const rng = new SeededRng(params.seed ?? 42);
    for (let i = 0; i < 12; i++) {
      cases.push(generateArgs(parsed, rng));
    }
  } else {
    cases.push([]);
  }

  const session = new inspector.Session();
  session.connect();

  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 100 });
    await session.post('Profiler.start');

    if (hasExport) {
      const runner = await loadTargetRunner(params.target, cwd);
      try {
        const deadline = performance.now() + durationMs;
        let iter = 0;
        if (runner.invokeSync) {
          const fn = runner.invokeSync;
          do {
            for (let b = 0; b < 16; b++) {
              fn(cases[iter % cases.length]);
              iter++;
            }
          } while (performance.now() < deadline);
        } else {
          do {
            await runner.invoke(cases[iter % cases.length]);
            iter++;
          } while (performance.now() < deadline);
        }
      } finally {
        await runner.close();
      }
    } else {
      const absPath = path.resolve(cwd, params.target);
      const stat = fs.statSync(absPath);
      const moduleUrl = pathToFileURL(absPath);
      moduleUrl.searchParams.set('v', `${stat.mtimeMs}-${stat.size}`);
      const mod = (await import(moduleUrl.href)) as Record<string, unknown>;
      if (typeof mod.default === 'function') {
        const fn = mod.default as (...args: unknown[]) => unknown;
        const deadline = performance.now() + durationMs;
        let iter = 0;
        do {
          const res = fn(...cases[iter % cases.length]);
          if (res instanceof Promise) await res;
          iter++;
        } while (performance.now() < deadline);
      }
    }

    const stopped = (await session.post('Profiler.stop')) as { profile: CpuProfile };
    const agg = aggregateV8Profile(stopped.profile, top, includeInternals, cwd);

    return {
      runtime: 'node-v8',
      target: params.target,
      totalDurationMs: agg.totalDurationMs,
      totalHits: agg.totalHits,
      hotspots: agg.hotspots,
    };
  } finally {
    try {
      await session.post('Profiler.disable');
    } catch {
      // Ignore cleanup errors
    }
    session.disconnect();
  }
}
