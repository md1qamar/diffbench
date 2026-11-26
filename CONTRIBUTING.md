# Contributing to diffbench

Contributions are welcome! Please keep `diffbench` zero-dependency on external runtime packages so it works completely offline and deterministically.

## Local Development

```bash
npm install
npm run typecheck
npm test
```

## Guidelines

- Write strict TypeScript (`"strict": true`) with concise JSDoc docstrings on exported symbols.
- Keep all statistical and fuzzing behavior deterministic when `--seed` is supplied.
- Add real unit and integration tests under `test/*.test.ts` for every new feature or bug fix.
- Verify the repository passes `npm run typecheck`, `npm run build`, and `npm test` before opening a PR.
