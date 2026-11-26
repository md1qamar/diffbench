import fs from 'node:fs';
import path from 'node:path';
import { SeededRng } from './prng.js';
import type { InputSchema, SchemaNode } from './types.js';

const STRING_EDGE_SAMPLES = [
  '',
  ' ',
  'a',
  'hello world',
  'line1\nline2\ttab',
  'café naïve 🚀',
  'a\u0301b',
  '__proto__',
  'constructor',
  '{"quoted":"value"}',
];

const ASCII_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:/';
const UNICODE_FRAGMENTS = ['a', 'Z', '0', ' ', '-', 'é', 'ñ', 'π', '🚀'];

/**
 * Splits a comma-separated DSL list at top-level depth (ignoring commas inside <...> or (...)).
 */
function splitTopLevel(input: string, delimiter = ','): string[] {
  const parts: string[] = [];
  let angleDepth = 0;
  let parenDepth = 0;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === delimiter && angleDepth === 0 && parenDepth === 0) {
      const slice = input.slice(start, i).trim();
      if (slice.length > 0) parts.push(slice);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function parseRangeArgs(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid numeric parameter "${s}" in schema DSL.`);
      }
      return n;
    });
}

function parseSingleDslNode(expr: string): SchemaNode {
  const trimmed = expr.trim();
  if (!trimmed) {
    throw new Error('Empty schema expression.');
  }

  // Match optional generic <...> and optional trailing (...)
  // Examples: int(0,100), array<int(0,10)>(0,20), record<a:int,b:string>, enum<fast,slow>
  const headMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)(.*)$/.exec(trimmed);
  if (!headMatch) {
    throw new Error(`Invalid schema token: "${trimmed}"`);
  }

  const kind = headMatch[1].toLowerCase();
  let rest = headMatch[2].trim();
  let genericBody: string | undefined;
  let parenBody: string | undefined;

  if (rest.startsWith('<')) {
    let depth = 0;
    let closeIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '<') depth++;
      else if (rest[i] === '>') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx === -1) {
      throw new Error(`Unclosed "<" in schema "${trimmed}"`);
    }
    genericBody = rest.slice(1, closeIdx).trim();
    rest = rest.slice(closeIdx + 1).trim();
  }

  if (rest.startsWith('(')) {
    if (!rest.endsWith(')')) {
      throw new Error(`Unclosed "(" in schema "${trimmed}"`);
    }
    parenBody = rest.slice(1, -1).trim();
    rest = '';
  }

  if (rest.length > 0) {
    throw new Error(`Unexpected trailing tokens "${rest}" in schema "${trimmed}"`);
  }

  switch (kind) {
    case 'int':
    case 'integer': {
      const nums = parseRangeArgs(parenBody);
      return {
        kind: 'int',
        min: nums[0] ?? -1000,
        max: nums[1] ?? 1000,
      };
    }
    case 'float':
    case 'number': {
      const rawParts = (parenBody || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const allowSpecial = rawParts.includes('special');
      const numParts = rawParts.filter((p) => p !== 'special').map(Number);
      if (numParts.some((n) => !Number.isFinite(n))) {
        throw new Error(`Invalid float bounds in "${trimmed}"`);
      }
      return {
        kind: 'float',
        min: numParts[0] ?? -1000,
        max: numParts[1] ?? 1000,
        allowSpecial,
      };
    }
    case 'bool':
    case 'boolean':
      return { kind: 'bool' };
    case 'null':
      return { kind: 'null' };
    case 'string':
    case 'str': {
      const nums = parseRangeArgs(parenBody);
      const minLen = nums.length >= 2 ? nums[0] : 0;
      const maxLen = nums.length >= 2 ? nums[1] : nums[0] ?? 48;
      return { kind: 'string', minLen: Math.max(0, minLen), maxLen: Math.max(minLen, maxLen) };
    }
    case 'array':
    case 'list': {
      if (!genericBody) {
        throw new Error(`array schema requires an element type, e.g. array<int>: "${trimmed}"`);
      }
      const nums = parseRangeArgs(parenBody);
      const minLen = nums.length >= 2 ? nums[0] : 0;
      const maxLen = nums.length >= 2 ? nums[1] : nums[0] ?? 64;
      return {
        kind: 'array',
        item: parseSingleDslNode(genericBody),
        minLen: Math.max(0, minLen),
        maxLen: Math.max(minLen, maxLen),
      };
    }
    case 'tuple': {
      if (!genericBody) {
        throw new Error(`tuple schema requires member types, e.g. tuple<int,string>: "${trimmed}"`);
      }
      const items = splitTopLevel(genericBody).map(parseSingleDslNode);
      return { kind: 'tuple', items };
    }
    case 'nullable': {
      if (!genericBody) {
        throw new Error(`nullable schema requires inner type: "${trimmed}"`);
      }
      return { kind: 'nullable', inner: parseSingleDslNode(genericBody) };
    }
    case 'enum': {
      if (!genericBody) {
        throw new Error(`enum schema requires values, e.g. enum<asc,desc>: "${trimmed}"`);
      }
      const values = splitTopLevel(genericBody).map((v) => {
        if (v === 'null') return null;
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
        return v.replace(/^['"]|['"]$/g, '');
      });
      return { kind: 'enum', values };
    }
    case 'record':
    case 'object': {
      if (!genericBody) {
        throw new Error(`record schema requires fields, e.g. record<id:int,name:string>: "${trimmed}"`);
      }
      const fields: Record<string, SchemaNode> = {};
      for (const entry of splitTopLevel(genericBody)) {
        const colonIdx = entry.indexOf(':');
        if (colonIdx <= 0) {
          throw new Error(`Invalid record field "${entry}" in "${trimmed}". Expected key:type.`);
        }
        const fieldName = entry.slice(0, colonIdx).trim();
        const fieldType = entry.slice(colonIdx + 1).trim();
        fields[fieldName] = parseSingleDslNode(fieldType);
      }
      return { kind: 'record', fields };
    }
    case 'map':
    case 'dict': {
      if (!genericBody) {
        throw new Error(`map schema requires value type, e.g. map<int>: "${trimmed}"`);
      }
      const nums = parseRangeArgs(parenBody);
      const minKeys = nums.length >= 2 ? nums[0] : 0;
      const maxKeys = nums.length >= 2 ? nums[1] : nums[0] ?? 16;
      return {
        kind: 'map',
        value: parseSingleDslNode(genericBody),
        minKeys: Math.max(0, minKeys),
        maxKeys: Math.max(minKeys, maxKeys),
      };
    }
    default:
      throw new Error(`Unknown schema type "${kind}" in "${trimmed}".`);
  }
}

/**
 * Parses a DSL string (comma-separated positional argument types) or JSON schema array/node
 * into a normalized `InputSchema` array.
 */
export function resolveInputSchema(spec: string | InputSchema | SchemaNode): InputSchema {
  if (Array.isArray(spec)) {
    return spec;
  }
  if (typeof spec === 'object' && spec !== null) {
    return [spec];
  }
  const trimmed = spec.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as InputSchema | SchemaNode;
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return splitTopLevel(trimmed).map(parseSingleDslNode);
}

/**
 * Generates a single deterministic value matching `node` using `rng`.
 */
export function generateValue(node: SchemaNode, rng: SeededRng): unknown {
  switch (node.kind) {
    case 'int':
      return rng.int(node.min ?? -1000, node.max ?? 1000);
    case 'float': {
      const val = rng.float(node.min ?? -1000, node.max ?? 1000);
      return Number(val.toPrecision(12));
    }
    case 'bool':
      return rng.bool();
    case 'null':
      return null;
    case 'string': {
      const minLen = node.minLen ?? 0;
      const maxLen = node.maxLen ?? 48;
      const len = rng.int(minLen, maxLen);
      let out = '';
      const useUnicode = rng.bool(0.15);
      for (let i = 0; i < len; i++) {
        out += useUnicode
          ? UNICODE_FRAGMENTS[Math.floor(rng.next() * UNICODE_FRAGMENTS.length)]
          : ASCII_ALPHABET[Math.floor(rng.next() * ASCII_ALPHABET.length)];
      }
      return out;
    }
    case 'enum':
      return rng.pick(node.values);
    case 'nullable':
      return rng.bool(0.2) ? null : generateValue(node.inner, rng);
    case 'array': {
      const minLen = node.minLen ?? 0;
      const maxLen = node.maxLen ?? 64;
      const len = rng.int(minLen, maxLen);
      const result: unknown[] = [];
      for (let i = 0; i < len; i++) {
        result.push(generateValue(node.item, rng));
      }
      return result;
    }
    case 'tuple':
      return node.items.map((item) => generateValue(item, rng));
    case 'record': {
      const obj: Record<string, unknown> = {};
      for (const [key, fieldNode] of Object.entries(node.fields)) {
        Object.defineProperty(obj, key, {
          value: generateValue(fieldNode, rng),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return obj;
    }
    case 'map': {
      const minKeys = node.minKeys ?? 0;
      const maxKeys = node.maxKeys ?? 16;
      const count = rng.int(minKeys, maxKeys);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const key = `k_${rng.int(0, 9999)}`;
        Object.defineProperty(obj, key, {
          value: generateValue(node.value, rng),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return obj;
    }
  }
}

/**
 * Generates deterministic positional argument arrays matching `schema`.
 */
export function generateArgs(schema: InputSchema, rng: SeededRng): unknown[] {
  return schema.map((node) => generateValue(node, rng));
}

function edgeValuesForNode(node: SchemaNode): unknown[] {
  switch (node.kind) {
    case 'int': {
      const lo = Math.ceil(node.min ?? -1000);
      const hi = Math.floor(node.max ?? 1000);
      const candidates = [lo, hi, lo + 1, hi - 1, -1, 0, 1];
      return [...new Set(candidates.filter((n) => n >= lo && n <= hi))];
    }
    case 'float': {
      const lo = node.min ?? -1000;
      const hi = node.max ?? 1000;
      const candidates = [lo, hi, -1, -0.5, 0, 0.5, 1, 1e-9, -1e-9].filter(
        (n) => n >= lo && n <= hi
      );
      if (0 >= lo && 0 <= hi) candidates.push(-0);
      if (node.allowSpecial) {
        candidates.push(NaN, Infinity, -Infinity);
      }
      return candidates;
    }
    case 'bool':
      return [false, true];
    case 'null':
      return [null];
    case 'string': {
      const minLen = node.minLen ?? 0;
      const maxLen = node.maxLen ?? 48;
      const adjusted = STRING_EDGE_SAMPLES.map((s) => {
        let val = s;
        if (val.length < minLen) val = val.padEnd(minLen, 'x');
        if (val.length > maxLen) val = val.slice(0, maxLen);
        return val;
      });
      return [...new Set(adjusted)];
    }
    case 'enum':
      return [...node.values];
    case 'nullable':
      return [null, ...edgeValuesForNode(node.inner)];
    case 'array': {
      const minLen = node.minLen ?? 0;
      const maxLen = node.maxLen ?? 64;
      const itemEdges = edgeValuesForNode(node.item);
      const first = itemEdges[0];
      const last = itemEdges[itemEdges.length - 1];
      const candidates: unknown[][] = [];
      if (minLen === 0) candidates.push([]);
      if (minLen <= 1 && maxLen >= 1) candidates.push([first], [last]);
      if (minLen <= 2 && maxLen >= 2) candidates.push([first, first], [first, last], [last, first]);
      if (minLen <= 4 && maxLen >= 4) candidates.push([first, last, first, last]);
      if (candidates.length === 0) {
        candidates.push(Array.from({ length: minLen }, () => first));
      }
      return candidates;
    }
    case 'tuple': {
      const first = node.items.map((it) => edgeValuesForNode(it)[0]);
      const last = node.items.map((it) => {
        const edges = edgeValuesForNode(it);
        return edges[edges.length - 1];
      });
      return [first, last];
    }
    case 'record': {
      const entries = Object.entries(node.fields);
      const minRec: Record<string, unknown> = {};
      const maxRec: Record<string, unknown> = {};
      for (const [k, fieldNode] of entries) {
        const edges = edgeValuesForNode(fieldNode);
        minRec[k] = edges[0];
        maxRec[k] = edges[edges.length - 1];
      }
      return [minRec, maxRec];
    }
    case 'map': {
      const minKeys = node.minKeys ?? 0;
      const maxKeys = node.maxKeys ?? 16;
      const edges = edgeValuesForNode(node.value);
      const out: Record<string, unknown>[] = [];
      if (minKeys === 0) out.push({});
      if (maxKeys >= 1) {
        const one: Record<string, unknown> = {};
        one['edge'] = edges[0];
        out.push(one);
      }
      return out;
    }
  }
}

/**
 * Constructs a targeted suite of adversarial edge-case argument vectors for `schema`.
 */
export function buildEdgeCases(schema: InputSchema): unknown[][] {
  if (schema.length === 0) return [[]];
  const perArg = schema.map(edgeValuesForNode);
  const defaults = perArg.map((list) => list[0]);
  const cases: unknown[][] = [];

  for (let argIdx = 0; argIdx < perArg.length; argIdx++) {
    for (const val of perArg[argIdx]) {
      const tuple = [...defaults];
      tuple[argIdx] = val;
      cases.push(tuple);
      if (cases.length >= 64) return cases;
    }
  }
  return cases;
}

/**
 * Loads a custom test corpus JSON file. Accepts either:
 * - an array of argument vectors (`[[arg1, arg2], ...]`)
 * - an array of single values (`[val1, val2, ...]`) when `wrapSingleArgs` is true
 * - `{ "cases": [...] }`
 */
export function loadCasesFile(filePath: string): unknown[][] {
  const absPath = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8')) as unknown;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { cases?: unknown }).cases)
      ? (raw as { cases: unknown[] }).cases
      : null;

  if (!list) {
    throw new Error(`Invalid cases file "${filePath}": expected JSON array or { "cases": [...] }.`);
  }

  return list.map((entry) => (Array.isArray(entry) ? entry : [entry]));
}
