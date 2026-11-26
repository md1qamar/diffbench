# Cross-Language Workers (`cmd:` and `jsonl:`)

Beyond JavaScript/TypeScript ESM modules, `diffbench` lets you verify and benchmark implementations written in **Python, Rust, Go, C, or any compiled CLI** against a reference baseline.

## Protocol Overview

Both `cmd:` and `jsonl:` targets use a simple JSON contract:

- **Input (`stdin`):** a JSON array representing the positional argument tuple `[arg1, arg2, ...]`.
- **Success (`stdout`):** `{"ok": true, "value": <returnValue>}` (or any raw JSON value/string).
- **Error (`stdout`):** `{"ok": false, "errorName": "ValueError", "error": "negative input"}` (or non-zero exit code for `cmd:`).

Error parity works seamlessly across languages: if both the baseline JS module and the candidate Python/Rust worker signal an error for the same bad input, `errorParity: true` treats them as equivalent unless `--strict-error-message` semantics are configured.

---

## Mode 1: Persistent NDJSON Worker (`jsonl:`) — Recommended

`jsonl:` spawns the worker **once** and streams one JSON line per invocation over `stdin`/`stdout`. This eliminates process-startup overhead so you can fuzz hundreds of cases and benchmark dozens of rounds in milliseconds.

### Python `jsonl:` Worker Example (`worker.py`)

```python
import json
import sys

def fast_sum_positive(nums):
    return sum(x for x in nums if x > 0)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        args = json.loads(line)
        result = fast_sum_positive(*args)
        sys.stdout.write(json.dumps({"ok": True, "value": result}) + "\n")
    except Exception as exc:
        sys.stdout.write(json.dumps({
            "ok": False,
            "errorName": type(exc).__name__,
            "error": str(exc),
        }) + "\n")
    sys.stdout.flush()
```

Run equivalence + benchmark against a JS baseline:

```bash
diffbench gate \
  --baseline ./baseline.mjs#sumPositive \
  --candidate "jsonl:python worker.py" \
  --schema "array<int(-100,100)>(100,400)" \
  --iterations 200 \
  --samples 30
```

---

## Mode 2: One-Shot Command (`cmd:`)

Use `cmd:` when wrapping an existing CLI or quick script that reads a single JSON payload from `stdin`, prints one JSON result, and exits:

```bash
diffbench equiv \
  --baseline ./baseline.mjs#parseRecord \
  --candidate "cmd:./target/release/parse_cli" \
  --schema "string(64)" \
  --iterations 50
```

> **Tip:** `cmd:` spawns a fresh process per case and automatically sets `batchSize = 1` during benchmarks. Use `jsonl:` whenever you want to measure algorithm speed without OS process-launch latency.
