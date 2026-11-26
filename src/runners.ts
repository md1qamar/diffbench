import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { ExecutionOutcome, TargetRunner } from './types.js';

/**
 * Splits a shell-style command line respecting single and double quotes.
 */
export function parseCommandLine(cmdLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      // Preserve Windows backslash path separators unless escaping a quote or backslash.
      const next = cmdLine[i + 1];
      if (next === '"' || next === "'" || next === '\\') {
        escaped = true;
        continue;
      }
      current += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

function normalizeError(err: unknown): ExecutionOutcome {
  if (err instanceof Error) {
    return {
      ok: false,
      errorName: err.name || 'Error',
      errorMessage: err.message || String(err),
    };
  }
  return {
    ok: false,
    errorName: 'ThrownValue',
    errorMessage: String(err),
  };
}

function parseModuleTargetSpec(spec: string): { filePath: string; exportName: string } {
  // Windows paths have drive letter colons like C:\foo\bar.js#fn; find the last # or : after index 2.
  const hashIdx = spec.lastIndexOf('#');
  if (hashIdx > 0) {
    return {
      filePath: spec.slice(0, hashIdx),
      exportName: spec.slice(hashIdx + 1) || 'default',
    };
  }
  const colonIdx = spec.lastIndexOf(':');
  if (colonIdx > 2) {
    return {
      filePath: spec.slice(0, colonIdx),
      exportName: spec.slice(colonIdx + 1) || 'default',
    };
  }
  return { filePath: spec, exportName: 'default' };
}

function parseWorkerLine(line: string): ExecutionOutcome {
  const trimmed = line.trim();
  if (!trimmed) {
    return { ok: false, errorName: 'EmptyOutput', errorMessage: 'Worker emitted empty output.' };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof parsed.ok === 'boolean'
    ) {
      if (parsed.ok) {
        return { ok: true, value: parsed.value };
      }
      return {
        ok: false,
        errorName: typeof parsed.errorName === 'string' ? parsed.errorName : 'WorkerError',
        errorMessage: typeof parsed.error === 'string' ? parsed.error : String(parsed.errorMessage ?? 'Error'),
      };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: true, value: trimmed };
  }
}

async function createModuleRunner(spec: string, cwd: string): Promise<TargetRunner> {
  const { filePath, exportName } = parseModuleTargetSpec(spec);
  const absPath = path.resolve(cwd, filePath);
  const stat = fs.statSync(absPath);
  const moduleUrl = pathToFileURL(absPath);
  moduleUrl.searchParams.set('v', `${stat.mtimeMs}-${stat.size}`);
  const mod = (await import(moduleUrl.href)) as Record<string, unknown>;
  const candidateFn =
    mod[exportName] ??
    (exportName === 'default' && typeof mod.default === 'object' && mod.default !== null
      ? (mod.default as Record<string, unknown>).default
      : undefined);

  if (typeof candidateFn !== 'function') {
    const available = Object.keys(mod).join(', ') || '(none)';
    throw new Error(
      `Export "${exportName}" is not a function in "${absPath}". Available exports: ${available}`
    );
  }

  const fn = candidateFn as (...args: unknown[]) => unknown;
  const isAsync = fn.constructor.name === 'AsyncFunction';

  return {
    spec,
    kind: 'module',
    isAsync,
    invokeSync: isAsync
      ? undefined
      : (args: unknown[]): ExecutionOutcome => {
          try {
            const value = fn(...args);
            return { ok: true, value };
          } catch (err) {
            return normalizeError(err);
          }
        },
    async invoke(args: unknown[]): Promise<ExecutionOutcome> {
      try {
        const result = fn(...args);
        const value = result instanceof Promise ? await result : result;
        return { ok: true, value };
      } catch (err) {
        return normalizeError(err);
      }
    },
    async close() {},
  };
}

function createCmdRunner(spec: string, commandLine: string, cwd: string): TargetRunner {
  const parts = parseCommandLine(commandLine);
  if (parts.length === 0) {
    throw new Error(`Invalid cmd target: "${spec}"`);
  }
  const [bin, ...baseArgs] = parts;

  return {
    spec,
    kind: 'cmd',
    isAsync: true,
    async invoke(args: unknown[]): Promise<ExecutionOutcome> {
      const res = spawnSync(bin, baseArgs, {
        cwd,
        input: JSON.stringify(args),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });

      if (res.error) {
        return { ok: false, errorName: 'SpawnError', errorMessage: res.error.message };
      }
      if (res.status !== 0) {
        return {
          ok: false,
          errorName: `ExitCode${res.status}`,
          errorMessage: (res.stderr || res.stdout || `Exited with ${res.status}`).trim(),
        };
      }
      return parseWorkerLine(res.stdout || '');
    },
    async close() {},
  };
}

function createJsonlWorkerRunner(spec: string, commandLine: string, cwd: string): TargetRunner {
  const parts = parseCommandLine(commandLine);
  if (parts.length === 0) {
    throw new Error(`Invalid jsonl worker target: "${spec}"`);
  }
  const [bin, ...baseArgs] = parts;

  const child = spawn(bin, baseArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending: Array<{
    resolve: (outcome: ExecutionOutcome) => void;
    reject: (err: Error) => void;
  }> = [];
  let stderrTail = '';
  let closed = false;

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  rl.on('line', (line: string) => {
    const next = pending.shift();
    if (next) {
      next.resolve(parseWorkerLine(line));
    }
  });

  child.on('exit', (code) => {
    closed = true;
    while (pending.length > 0) {
      const next = pending.shift();
      next?.reject(
        new Error(
          `Worker "${commandLine}" exited early with code ${code}: ${stderrTail.trim()}`
        )
      );
    }
  });

  child.on('error', (err) => {
    closed = true;
    while (pending.length > 0) {
      const next = pending.shift();
      next?.reject(err);
    }
  });

  return {
    spec,
    kind: 'jsonl',
    isAsync: true,
    invoke(args: unknown[]): Promise<ExecutionOutcome> {
      if (closed || !child.stdin.writable) {
        return Promise.resolve({
          ok: false,
          errorName: 'WorkerClosed',
          errorMessage: `Worker process is closed (${stderrTail.trim()})`,
        });
      }
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write(JSON.stringify(args) + '\n');
      });
    },
    async close() {
      if (!closed) {
        closed = true;
        rl.close();
        child.stdin.end();
        child.kill();
      }
    },
  };
}

/**
 * Loads a target runner from a target specification:
 * - `path/to/file.js#fnName` (or `:fnName` / default export)
 * - `cmd:<executable and args>` (one-shot JSON stdin/stdout per call)
 * - `jsonl:<executable and args>` (persistent NDJSON stdio worker)
 */
export async function loadTargetRunner(spec: string, cwd = process.cwd()): Promise<TargetRunner> {
  if (spec.startsWith('cmd:')) {
    return createCmdRunner(spec, spec.slice(4).trim(), cwd);
  }
  if (spec.startsWith('jsonl:')) {
    return createJsonlWorkerRunner(spec, spec.slice(6).trim(), cwd);
  }
  return createModuleRunner(spec, cwd);
}
