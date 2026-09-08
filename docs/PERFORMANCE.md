# Performance audit

Milestone M0 establishes reproducible measurements and regression budgets for
the plugin's build, tests, suggestion hot path, memory, and published package.

## Run locally

Install the locked dependencies, then run the budget gate:

```bash
npm ci
npm run performance:check
```

Use `npm run performance` to print the same measurements without failing when
a budget is exceeded. Both performance commands rebuild the plugin and run its
unit tests before measuring the built artifact. Code Foundry runs
`performance:check` in its dedicated performance job on pull requests.

The harness prints JSON containing the observed metrics, configured budgets,
and pass/fail status. Budgets live in `performance-budgets.json` and cover:

- TypeScript build and unit-test wall-clock time.
- p95 latency for the production history-matching function over 5,000 entries.
- Retained heap added by importing the built plugin and by 10,000 history scans.
- Packed size, unpacked size, file count, and direct runtime dependency count
  from `npm pack --dry-run`.

The plugin-import measurement is a conservative standalone-process value: it
includes peer modules loaded from the development install. Pi already has those
peers in memory when it loads the extension, so the incremental heap in a live
Pi process is expected to be lower.

## M0 reference result

A reference run on 2026-09-07 using macOS arm64 and Node.js 22.23.1 produced:

| Metric                        | Result       | Budget       |
| ----------------------------- | ------------ | ------------ |
| Build                         | 1,167 ms     | 10,000 ms    |
| Unit tests                    | 228 ms       | 10,000 ms    |
| History lookup p95            | 0.266 ms     | 2 ms         |
| Standalone plugin import heap | 37,095,200 B | 67,108,864 B |
| Retained history-scan heap    | 4,888 B      | 8,388,608 B  |
| Packed package                | 24,223 B     | 51,200 B     |
| Unpacked package              | 99,637 B     | 163,840 B    |
| Published files               | 11           | 12           |
| Direct runtime dependencies   | 0            | 0            |

Run the gate on an otherwise idle machine. Wall-clock and garbage-collection
measurements vary across hosts, so the budgets intentionally allow normal CI
variance while catching order-of-magnitude regressions. Tighten a budget only
after comparing several local and CI runs; do not raise one without documenting
the measured regression and its rationale.

## CI command

The repository's reusable Code Foundry workflow runs behavior tests and
performance budgets as separate jobs:

```bash
npm test
npm run performance:check
```

The first command builds the extension and runs behavior tests. A budget breach
in the second command exits non-zero and fails `Validation / Test / Performance`.
