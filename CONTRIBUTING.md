## Contributing

### Tests

- **`pnpm test:quick`** — Recommended while iterating: skips `__tests__/integration/`, `__tests__/performance/`, and `package-contract.test.ts` (the latter runs a full `pnpm build` and tarball checks).
- **`pnpm test:run`** — Full suite with Jest’s default **parallel** workers (typically under ~1–2 minutes locally; the old `--runInBand` default was often 6+ minutes).
- **`pnpm test:ci`** — Same as `test:run` but **`--runInBand`** if you need strictly serial execution to debug ordering flakes.
- **`pnpm test`** / **`pnpm test:coverage`** — Coverage run for releases.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/<YourFeature>`)
3. Commit your changes (`git commit -am 'Add a new feature'`)
4. Push to the branch (`git push origin feature/<YourFeature>`)
5. Create a new pull request on the development branch
