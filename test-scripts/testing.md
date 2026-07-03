# Testing

How to set up and run the automated test suites for `timer-events`, and
how to read the results. These are functional tests that exercise the
node's runtime logic against a stubbed Node-RED environment — they need
only Node.js, no Node-RED installation.

## Setup

### Prerequisites

- **Node.js** — any reasonably current version (the suites use only
  built-in modules: `fs`, `path`, `os`; nothing is installed via npm).
- No running Node-RED instance is required or used.

### Directory layout

Place all of the following in **one directory** (any location):

```
timer-events.js              the node under test
cycle.js                     required by timer-events.js at load time
test-harness.js              the nine test suites
test-threshold-scope.js
test-restore.js
test-validation.js
test-redundant-stop.js
test-elapsed.js
test-paused-restore.js
test-status-flicker.js
test-fractional-label.js
```

Each suite resolves `timer-events.js` **relative to its own location**
(`__dirname`), so the directory can live anywhere — but the node file
and `cycle.js` must sit beside the tests. If `cycle.js` is missing,
every suite fails immediately at load with a
`Cannot find module './cycle.js'` error.

## Running the tests

### One suite

```bash
node test-harness.js
```

### All nine suites

```bash
for t in test-harness test-threshold-scope test-restore test-validation \
         test-redundant-stop test-elapsed test-paused-restore \
         test-status-flicker test-fractional-label; do
  echo "---- $t ----"
  node $t.js
done
```

(Windows PowerShell equivalent: run each `node test-<name>.js` in
sequence, or loop over `Get-ChildItem test-*.js`.)

Each suite exits with code `0` on full success and `1` if any check
failed, so they compose cleanly into CI or a script that stops on first
failure.

## What to expect during a run

- **Real time passes.** These tests use actual `setTimeout` timers and
  wall-clock sleeps — a check like "pause at 3 seconds, resume, confirm
  expiry ~7 seconds later" genuinely waits those seconds and measures.
  Individual suites take from a few seconds up to ~30 seconds; the full
  battery takes **roughly 2–3 minutes**. Silence between output lines is
  normal — a timer is running.
- **Output format:** one line per check, streamed as each completes:

  ```
  PASS  T1a pause freezes at ~7000ms (was: full 10000ms)
  FAIL  T2 query at t+4s reports ~6000ms (was: 10000ms)  [10000]
  ```

  A `FAIL` line ends with the actual observed value in brackets. Each
  suite ends with a summary line (`ALL ... TESTS PASSED` or
  `N FAILURE(S)`).
- **Filesystem activity:** suites that exercise persistence create their
  own throwaway directories under the system temp location (via
  `mkdtemp`, prefix `timerevents-…`) and write timer state files there.
  They **never touch** your real Node-RED `userDir` or any existing
  timer state. The OS cleans the temp directories up eventually; they're
  small either way.
- **No network, no external processes.**

## What to expect after a run

A healthy full battery is **103 passing checks, 0 failures**:

| Suite | Checks | Covers |
|---|---|---|
| `test-harness` | 15 | Wall-clock-accurate remaining time: pause/resume precision, live queries, adjustments, persistence targets, cooldown time, expiry timing |
| `test-threshold-scope` | 11 | Threshold actions fire only for active runs; never from idle/disabled/cooldown; legitimate lock-gate and paused-gate firings still work |
| `test-restore` | 10 | Running restore as a continuation: original duration, ignored count, elapsed-including-downtime survive; fresh config wins over persisted |
| `test-validation` | 14 | Strict numeric validation of `msg.delay`, `adjusttime`, `settime`, `setduration`; documented fallbacks and clean rejections |
| `test-redundant-stop` | 16 | Stop-while-idle is ignored with zero state change; `_timerpass` arming semantics; genuine stops from running/paused/cooldown |
| `test-elapsed` | 17 | State-aware `elapsedTime`: frozen while paused, 0 while idle, cooldown-relative, final-value snapshots on stopped/expired events |
| `test-paused-restore` | 7 | Paused timers restore frozen (downtime excluded); independent frozen elapsed; legacy state-file fallback |
| `test-status-flicker` | 4 | No blank status flashes; every command path repaints its own label |
| `test-fractional-label` | 9 | Status labels always whole seconds; message envelopes still exact ms; timing precision unaffected |

## Interpreting failures

- **A single timing-flavored failure that passes on rerun** — checks
  compare measured durations against expected values within tolerances
  (typically 300–700 ms). On a heavily loaded machine, a sleep can
  overrun a tolerance. Rerun the suite; a consistent pass on retry means
  the machine, not the code. A failure that **reproduces consistently**
  is real — the bracketed value on the FAIL line tells you what was
  observed vs. the expectation in the label text.
- **Every suite fails instantly at load** — `cycle.js` or
  `timer-events.js` isn't beside the test files (see layout above).
- **Persistence suites fail, others pass** — check that the system temp
  directory is writable, and note these tests run against whatever
  `cycle.js` sits in the directory; the suites were developed against a
  minimal identity stub, and the full Crockford `cycle.js` is expected
  to behave identically here (no test message contains circular
  references).

## What these tests do not cover

The stubbed environment verifies the node's logic, not its integration:

- Behavior inside a **real Node-RED runtime** (true
  `RED.util.cloneMessage` semantics, flow deployment, subflow/`_alias`
  state-file naming).
- The **editor side** — the HTML edit dialog, field visibility logic,
  and canvas label are only syntax-checkable outside a browser.
- The **built-in help text** rendering.

A short manual pass in a live Node-RED instance — edit dialog behavior,
one deploy/restart cycle with a running and a paused timer, and one full
cooldown cycle — remains the recommended complement before trusting a
changed build in production flows.
