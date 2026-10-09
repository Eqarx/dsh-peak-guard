# Changelog

All notable changes to `dsh-peak-guard` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [1.0.0] — 2026-10-10

First public release.

### The core (since the very first build)

- **Intercepts `llm/stream`** (a cordis waterfall) and, during peak pricing windows,
  returns its own chunk stream **without ever calling `next()`** — so not a single byte
  reaches any model adapter, and the call costs nothing.
- Peak windows, weekends and CN public holidays mirror `dsh-meter-cost`'s model
  (`isPeak` / `nextTransition` are differential-tested against it).
- **Fail-open**: any error, unknown shape or bad config falls back to `next()`.
  A broken plugin may stop working, but it must never break DSH's model calls.
- Escape hatches: `DSH_PEAK_GUARD=off` env kill switch, `/peak off [minutes|forever]`,
  and a per-session `allowSessions` allowlist.

### Message & switches

- Interception message is **polite by default** (`⛔ 高峰时段暂停模型调用（本次未产生费用）` + pricing note +
  off-peak countdown + escape hatches); the original joke wording is one config key away (`tone: joke`),
  and `message:` overrides both.
- **Shield toggle** in the composer (`conversation.input.left`), persisted to
  `<DSH_HOME>/plugin-data/dsh-peak-guard/state.json`.
- `/peak`, `/peak status|test|force|enable|disable|off|on|list`.

### Blocked-request list

- Blocked *conversation* calls are recorded (session id, request preview, time); utility calls
  (session titles, compaction) are not, since they are never blocked.
- **Read-only card** above the composer (`conversation.input.dock`): title, note, collapse chevron,
  dismiss ✕, and per-row dot ↔ check mark with a stroke-dash "drawing" animation.
  Geometry copied from DSH's own composer card, so it is exactly as wide as the input box.
* **Dismissing the card sweeps the unhandled records aside**: ✕ hands every still-unhandled record to
  the host, which stamps it as *skipped* and records the moment; records already done **before** that
  moment stop being listed, while ones you check done afterwards stay until the next dismiss. The card
  then empties out until the next blocked request. Skipped records show up distinctly on the settings page and
  **restore to a normal to-do in one click** (one-way).
- **Settings page** (`settings.section`, nav label 「拦截记录」): tabs (all/to-do/done) with live counts,
  search over request text and session id, per-row check/delete, mark-all-as-done, and a two-step
  "clear records" confirmation. Empty state mirrors DSH's own inbox empty state.

### Removed before release

- An earlier V1/V2 "replay the blocked requests later" experiment (one-click send, auto-send at
  off-peak with a warning dialog, `sessionController` dependency, `POST /peak-guard/release`) was
  **deleted entirely**: the delivery path was fragile and the semantics contradicted the plugin's
  purpose ("don't burn money at peak" vs "send everything for you later"). Rationale kept in
  [`docs/DESIGN-replay-tradeoffs.md`](docs/DESIGN-replay-tradeoffs.md).

### Notes

- 116 assertions across five suites (`npm test`), including differential tests against `dsh-meter-cost`,
  a fake-cordis host integration suite, DOM/CSS regression assertions for the icon buttons, and a settings-page suite.
- Card-header icons use DSH's own `ICON_MEDIUM_STROKE = 1.3`; the chevron and the close cross share
  one stroke weight, and the chevron's vertical offset is a single constant (`CHEVRON_Y_SHIFT`, 0.5px steps).
