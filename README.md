# timer-events

A countdown timer node for [Node-RED](https://nodered.org/) with a
purpose-built four-output event model. Every command — successful,
redundant, or blocked — is observable as a structured event, so flows can
react to exactly what happened without guesswork.

Derived from `stoptimer-varidelay-plus`.

## Why this node

Most timer nodes tell you when the timer fires. This one tells you
everything: when it started, restarted, stopped, expired, paused, resumed,
was locked, was blocked, or had its time adjusted — each as a tagged event
with a consistent message envelope describing the timer's full state at
that moment.

## Outputs

| # | Output | Fires on |
|---|--------|----------|
| 1 | **Start**  | A true stopped/expired → running transition. Nothing else. |
| 2 | **Stop**   | A genuine stop command or natural expiry. Nothing else. |
| 3 | **Query**  | An incoming `query` message, or a Heartbeat tick. |
| 4 | **Events** | Every event, including copies of Start/Stop and every ignored/blocked command. |

Outputs 1 and 2 never carry a blocked or redundant message — anything that
didn't truly happen appears only on output 4, tagged `msg.ignored: true`.

## Features at a glance

- **Variable delay** — override duration per message via `msg.delay` / `msg.units`
- **Control commands** — `stop`, `pause`, `resume`, `query`, `lock`, `unlock`,
  `disable`, `enable`, `adjusttime`, `settime`, `setduration` (all case-insensitive)
- **Event envelope** — every output message carries `timerEvent`, `timerState`,
  `remainingTime`, `elapsedTime`, `timerDuration`, `ignored`, `source`, and more
- **Ignored-message threshold actions** — automatically stop, pause, restart,
  add time, or emit a warning when enough messages are ignored during a run
- **Heartbeat** — periodic status snapshots on the Query output for
  monitoring long-running timers
- **Cooldown** — refuse new starts for a fixed period after a natural expiry
- **Persistence** — resume running, paused, or cooling-down timers across
  deploys and Node-RED restarts

## Install

From your Node-RED user directory (typically `~/.node-red`):

```bash
npm install <your-package-name>
```

Or via the Node-RED palette manager. The node appears in the **function**
category as **Timer with Events**.

## Documentation

Full documentation — configuration reference, event taxonomy, command
details, persistence behavior, example flows, and troubleshooting — lives
in the [project wiki](../../wiki). The node's built-in help panel in the
Node-RED editor also covers everyday usage.

## Sponsorship

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buymeacoffee)](https://buymeacoffee.com/BMC-USERNAME)

## License

Licensed under the [Apache License 2.0](LICENSE).

Modifications copyright (C) 2025 mchristegh.
Derived from stoptimer-varidelay-plus — modifications copyright (C) 2020
hamsando; original copyright jbardi.
