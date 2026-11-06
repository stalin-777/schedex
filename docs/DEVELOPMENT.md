# Development

[Back to README](../README.md) · [Manual publication](PUBLISHING.md)

## Commands

Use Node.js `^22.22.2 || ^24.15.0 || >=26` with npm. Integration testing also needs VS Code and the official Codex extension (`openai.chatgpt`).

| Task | Make | npm |
| --- | --- | --- |
| Install dependencies | `make install` | `npm ci` |
| Lint | `make lint` | `npm run lint` |
| Check syntax, localization, assets | `make check` | `npm run check` |
| Run tests | `make test` | `npm test` |
| Package | `make vsix` | `npm run vsix` |
| All checks and package | `make verify` | Run the four checks above in order |

Press **F5 → Run Schedex** to open an Extension Development Host. Install Codex there; breakpoints in `src/` work without packaging.

CI runs checks and packaging on Windows, macOS, and Linux. The Linux job uploads the universal **schedex-vsix** artifact; retention follows repository settings. Published packages can be kept in [GitHub Releases](PUBLISHING.md#github-releases).

The scoped minimatch 10 override addresses [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Remove it when ESLint and `vsce` accept a patched version directly.

## Code map

| Area | Modules |
| --- | --- |
| Forms and commands | `scheduler.js`, `schedulerView.js`, `manage.js`, `media/` components |
| Storage and execution | `jobStore.js`, `jobLocks.js`, `jobTimers.js`, `jobs.js` |
| Codex protocol | `runtime.js`, `appServerClient.js`, `directDelivery.js`, `threads.js` |
| Availability and models | `availability.js`, `availabilityPolicy.js`, `accountIdentity.js`, `models.js` |
| Prompt protection | `threadRevision.js`, `promptTemplates.js` |
| History | `historyMonitor.js`, `taskProgress.js` |
| Resource bounds | `limits.js`, `boundedLines.js` |

## Delivery invariants

- **Existing threads:** use `thread/queue/add` over stdio, preserving Codex's model settings. Persist the client message ID before submission and the returned queue receipt afterward. Never resume the thread or fall back to CLI prompt arguments.
- **New threads:** keep `thread/start` and the first `turn/start` on one connection; a provisional rollout may not exist yet. Wait for `turn/completed` and process exit. Only unaccepted provisional threads may be recreated.
- **Ownership:** direct runs need an exclusive writer; shared `turn/start` could steer another turn. A per-thread file lock serializes Schedex submissions across windows. Pending Codex queue input defers direct resume. The UI cannot attach as a second writer during a new-thread run.
- **Model overrides:** validate the runtime catalog and settings API, pass model/effort in turn and collaboration settings, then restore future-turn settings after acceptance. Effort labels use advertised values, including `low` and `xhigh`.
- **Accounts:** bind the ChatGPT fingerprint on every save. Missing legacy bindings or changed accounts pause execution; manual checks preserve the binding and budget. Recheck identity after protected-history reads on the submitting client.
- **Uncertain acceptance:** persist submission intent before writing input. Lost acknowledgements require review, never automatic redelivery. Account checks and queue handoff are separate RPCs; accepted input cannot be recalled.

## Storage and scheduling

The shared JSON file in `globalStorageUri` is authoritative; `globalState` is a migration source. Mutations reread under the cross-window lock and replace the file atomically with mode `0600`. Watchers reconcile local timers with external edits and removals. A due task is rechecked under the storage lock before claiming it.

`sendMode` is `time` or `available` (legacy default: `time`). Keep the requested `sendAt`; retries use `nextAttemptAt`, availability checks use `nextCheckAt` and `expiresAt`. Read-only interrupted checks can recover; persisted submission intent requires review.

Availability requires `ordinaryUsageAllowed === true` and no applicable exhausted or blocked quota, including general and matching model buckets. An elapsed reset estimate alone never proves readiness. Resolve default models with the saved `cwd`, matching thread creation.

The shared availability cache expires after two minutes when ready or near any reported reset, otherwise after 15 minutes. Save/manual-check timestamps reject older snapshots; acceptance invalidates them. A dispatch lock covers checking and submission. Temporary errors back off until the deadline; only submissions consume the five-attempt budget.

## Prompt protection

`stalePolicy` is `send`, `skip`, or `confirm`; new threads always use `send`. Protected saves hash the newest turn's user/assistant messages via `thread/turns/list`. Ignore tool logs and metadata. Only an unsupported-method response permits the legacy full-history fallback; incomplete history fails closed.

Recheck before recording submission intent. Changed history skips or creates a persistent confirmation with a unique `confirmationId`. Decisions update conditionally under the store lock, preserving deadline and budget; stale replies cannot approve edited tasks. Approval accepts only the observed revision, so later messages require another decision.

Custom templates store text and policy in `prompt-templates.v1.json`, using the same locking and atomic-write rules.

## History and resource bounds

Archive direct successes as `completed`, queue receipts as `queued`, removals as `cancelled`. Archived records are never scheduled. `getSnapshot` reads once for UI state; active and history cards use pages of 25.

History passes check up to 100 oldest-check records with one read-only client and a bounded shared page cache. Persist results once, rereading under the store lock and ignoring deleted rows. Automatic checks run every 30 seconds for up to 8 days; manual refresh also checks older and terminal records.

Match exact turn IDs or queue/client-message IDs, never prompt text. Search at most 10 pages of 50 entries. Missing matches preserve confirmed terminal results; otherwise completion remains unknown. An `interrupted` snapshot without a timestamp or error stays unconfirmed. Never invent finish times or resend history entries.

`schedex.historyRetentionDays` is application-scoped and opt-in (0 disables cleanup). On startup, setting changes, and daily, prune only old archived terminal records. Keep active, queued, running, and unconfirmed work.

Limits: prompts 64 KiB UTF-8; 100 custom templates; each store and history page cache 16 MiB; RPC lines 16 MiB; retained stderr 8 KiB; `wslpath` output 1 MiB. Oversized writes leave the previous file intact. Oversized stored prompts pause before sending; partial RPC lines are bounded before decoding.

## Release checks and assets

Automated protocol tests use simulated servers. Before release, manually exercise existing/new conversations, both send modes, model overrides, account switching, approvals, and status recovery after restarting VS Code. Confirm later messages retain the prior model settings.

The extension icon is `media/schedex-logo.png`. Buttons use `media/schedex-calendar-send.woff`; edit `scripts/assets/schedex-calendar-send.svg` and regenerate with `python scripts/build-icon-font.py` and FontTools. Normal builds use the committed WOFF and need no Python.
