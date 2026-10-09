# dsh-peak-guard

> During DeepSeek's peak pricing windows, DSH is not allowed to call the model.
> The blocked call **costs nothing**, and what the user gets is an explanation plus a
> record of "what was blocked during peak hours".

English · [中文](README.md)

A **host + client** plugin for [DeepSeek Harness](https://github.com/deepseek-ai). Off-peak
(including weekends and CN public holidays) it does nothing at all. During peak windows it
short-circuits the `llm/stream` waterfall — **it never calls `next()`**, so not a single byte
reaches any model adapter — and streams back a well-formed chunk sequence of its own, which is
why the explanation appears exactly where the model's reply would have been.

---

## 1. What it looks like once installed

During peak hours (by default 09:00–12:00 and 14:00–18:00 Beijing time on weekdays) you send a
message and, where the model's answer would be, you get (polite wording is the default):

```
⛔ 高峰时段暂停模型调用（本次未产生费用）

— 现在是 DeepSeek 高峰计价时段（北京时间 09:00–12:00、14:00–18:00），高峰单价约为谷时的 2 倍；本次调用没有产生费用。
谷时 18:00 开始（还有 3 小时 12 分），届时再发即可。
需要现在继续：`/peak off 30`（放行 30 分钟） · 查看状态：`/peak status`
```

Set `tone: joke` for the original one-liner, or write anything you like in `message:`.
Set `hint: false` to keep only the first line.

Utility calls (session titles, context compaction) are **not** blocked by default — blocking them
only turns titles into that message and stops compaction from working. Set
`blockUtilityCalls: true` if you really want "not one token at peak".

### ① The shield toggle (composer, left side)

| Look | Meaning | Tooltip |
|---|---|---|
| grey shield + slash | switch is off | "Click to enable: no model calls at peak" |
| brand-coloured shield + check | on, off-peak, standing by | "Off-peak now, calls pass; next peak starts 09:00 (in 2d 11h)" |
| amber shield + amber dot | on, **currently blocking** | "Peak now, calls are blocked; off-peak starts 18:00 (in 3h 12m)" |
| small numeric badge | N blocked records | — |

The switch is **persisted** (survives a DSH restart) and is the same state as
`/peak enable|disable`. If the host half is not ready the toggle renders as a disabled grey
state — that means the plugin code changed but **DSH has not been restarted** (see §3).

### ② The blocked-request card (above the composer)

Read-only record plus two harmless actions, shown only when there is something to show:

```
⠿ 高峰期间有 2 条请求被拦下    这些请求没有发给模型，也没有产生费用          [ ˇ ] [ ✕ ]
  ● 把 README 里的截图换掉                                              09:52
  ⊘ 帮我看看这个报错                                                    09:41   ← swept aside: ring + slash
```

* **✕ dismiss** hands the *currently unhandled* records back to the host, which stamps them as
  **skipped**, and stops listing done records from then on. The card therefore empties out and
  disappears — **newly blocked requests bring it back**. To reclaim a skipped one, click its icon
  on the settings page and it becomes a normal to-do again. Same icon-button styling as the
  collapse chevron (20×20, rounded, hover fill); the cross is a 1.3px round-cap SVG stroke like
  every other card icon.
* **● → ✓ → ⊘ three states, one SVG**: click the dot to mark a record done (green check, text dims
  and gets struck through), click again to undo. Records swept aside by ✕ render as a **hollow
  ring with a slash** (amber) — "this was still unhandled when you closed the card" — and clicking
  them **restores them to a normal to-do** (one-way; there is no manual way back into skipped).
  Every transition happens inside the same stroked SVG: the ring is the same `<circle>` opening up
  (`r` 3 → 3.7, `fill-opacity` 1 → 0, `stroke-opacity` 0 → 1, 190ms), while the check and the slash
  are *drawn* with `stroke-dasharray`/`stroke-dashoffset` (240ms / 220ms,
  `cubic-bezier(.2,.8,.2,1)`). Clicks are optimistic (UI first, request second, rollback on
  failure); `prefers-reduced-motion` disables every transition.
* **What the card lists** (cardItems, a pure function): skipped records are never listed, and a done
  record is hidden only if it was **already done when you last closed the card**. Checking a record
  done therefore does *not* make it vanish on the spot — it stays until the next dismiss, so a
  mis-click is always undoable. The badge counts the records that still need attention.
* All three states are local UI state — **they change no blocking behaviour** — but they are
  **persisted** server-side (`POST /peak-guard/set` with `{check:{id,done}}`, `{restore:[id]}`,
  `{dismiss:true}`), so they survive a restart.

Geometry is copied from DSH's own composer card CSS (`--dsh-composer-card-max-width` and friends,
`--dsw-radius-lg`, `--dsw-specific-menu`, `--dsw-elevation-panel`, a `6px 12px` body), so the card
is exactly as wide as the input box and shares its horizontal centre line.

### ③ Settings → Blocked requests

A full management page registered into **DSH Settings** (`settings.section`, the same seat
`dsh-archived-chats` uses; `label` becomes the left-nav entry):

```
拦截记录  v1.0.0                              [ 全部标为已办 ]  [ 清空记录 ]
──────────────────────────────────────────────────────────────────────────
  全部 12      待办 6      已办 3      跳过 3
┌──────────────────────────────────────────────────────────────────────┐
│ 🔍 搜索请求内容或会话 id                                              │
└──────────────────────────────────────────────────────────────────────┘
⊘ 帮我看看这个报错                    09:41   a1b2c3d4        [⊘]  [🗑]   ← skipped: click to restore
● 把 README 里的截图换掉              09:52   e5f6a7b8        [✓]  [🗑]
…（no records → inbox icon + an empty state）
```

Tabs carry live counts (all / to-do / done / **skipped**), search matches the request text **and** the session
id (case-insensitive) and combines with the tab. Every row has the same three-state icon (dot ↔ check ↔ ring+slash; a skipped one restores to a to-do in one click, one-way), the
request preview, the time, the session id tail, and a delete button. "Mark all as done" is a
single request (`{checkAll:true}`); "Clear records" needs a **second click** (the button turns
into a confirm) so the destructive path is never one mis-click away. The page pulls the full list
with `?limit=200`; it only ever talks to the plugin's own two routes and reads no session data.

> 💡 **Note: after you restore a *skipped* record to a to-do in Settings, the card above the composer
> may take a moment to show it again.** The change is persisted immediately, and the settings page
> also pushes the fresh state into the in-memory store that both views share, so switching back to
> the conversation **usually shows it right away**. If the card is still stale (say you have two
> windows open), give it up to **20 seconds** — the card polls every 20 s and also refreshes the
> moment the window regains focus.

## 2. How peak/off-peak is decided

| Rule | Value |
|---|---|
| Peak windows | local (`Asia/Shanghai` by default) 09:00–12:00, 14:00–18:00, half-open `[start, end)` |
| Weekends | Saturday/Sunday are off-peak **all day** |
| Public holidays | 10 CN holiday days shipped for 2026, off-peak all day (update once a year) |

These rules match `dsh-cost-meter`'s peak/off-peak pricing **item by item** — the two are
differential-tested (`isPeak` ≡ its `isPeakHour`, `nextTransition` ≡ its `peakPhaseAt`), so the
guard and your cost meter can never disagree about what time it is.

## 3. Install

```powershell
pwsh -File install-profile.ps1            # install into the desktop profile (default)
pwsh -File install-profile.ps1 -WhatIf    # show what would change, write nothing
pwsh -File install-profile.ps1 -Uninstall # remove
```

The script backs up the profile's `package.json`, adds a `link:` dependency, appends the package
to `dsh.profile.bundles`, creates a junction under the profile's `node_modules`, then self-checks
(dependency / bundles / link / entry resolvable) and exits non-zero with restore instructions if
anything fails.

> `desktop` is an Electron-managed profile: `dsh plugin --profile desktop …` is rejected
> ("managed exclusively by the Electron application"), hence the script.

**How changes take effect — two very different paths:**

| What changed | How it applies |
|---|---|
| **profile composition** (installing, `dsh.profile.bundles`, the profile's `cordis.patch.yml`) | applies in place, hot |
| **the plugin's own code** (`lib/*.js`, `dsh.client` in `package.json`) | **you must fully quit and reopen DSH Desktop** — host modules are imported at startup and the client bundle is scanned once at startup; `dsh-hmr` only watches configuration files |

> Measured on this machine: after a code change the new HTTP routes and
> `/plugins/dsh-peak-guard/client.js` still 404 until a restart. Toggling the plugin off and on
> is **not** enough (verified twice), and touching a file's mtime does not hot-reload either.
> After a restart, `~/.dsh/plugin-data/dsh-peak-guard/last-apply.json` should say
> `stage: ready`, `routes: true`, `commands: true` — that file is the "did my code actually load"
> diagnostic.

## 4. Escape hatches

There are always three ways out, so you can never be locked out at peak:

1. **Environment** — `DSH_PEAK_GUARD=off` (also `0/false/no/disable`) silences the whole plugin.
   Read from the process environment, so it works even if the config is broken; needs a restart.
2. **Runtime** — `/peak off 30` / `/peak off forever` lets calls through, `/peak on` restores
   blocking, `/peak disable` turns the whole switch off (persisted).
3. **Config** — `allowSessions: ["session-…"]` exempts specific sessions; `peakWindows: []`
   disables blocking entirely.

## 5. Commands

```
/peak                     峰谷状态、窗口、拦截计数、话术与被拦截列表
/peak test                dry-run: see the message without sending anything
/peak force [分钟]        block even off-peak for N minutes (default 5) — for demos
/peak enable|disable      main switch (same state as the shield toggle, persisted)
/peak off [分钟|forever]  let calls through temporarily (default 30 minutes)
/peak on                  restore blocking (also clears force/off)
/peak list                print the blocked-request list
```

## 6. Configuration

Configuration lives in the profile's `cordis.patch.yml` (`id: peak-guard`); the package ships its
own commented `cordis.patch.yml` that applies with the bundle. Config changes also need a restart.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | default switch value; once you click the toggle, the toggle wins (it is persisted) |
| `timeZone` | `Asia/Shanghai` | which zone "local clock time" means |
| `peakWindows` | `["09:00-12:00","14:00-18:00"]` | half-open windows, may cross midnight; `[]` = never block |
| `weekendsOffPeak` | `true` | weekends are off-peak all day |
| `holidays` | 10 days of CN 2026 | `YYYY-MM-DD`, or ranges `A..B` |
| `tone` | `polite` | built-in wording: `polite` or `joke` |
| `message` | unset | custom wording, **overrides `tone`** |
| `hint` | `true` | append the "when does off-peak start / how to force through" lines |
| `blockUtilityCalls` | `false` | also block session titles / compaction |
| `allowSessions` | `[]` | session-id allowlist |
| `snoozeMinutes` | `30` | default `/peak off` duration |
| `blockedLimit` | `50` | how many records to keep (1–200) |
| `blockedMaxAgeMinutes` | `720` | drop records older than this (12 hours) |
| `statePath` | `<DSH_HOME>/plugin-data/dsh-peak-guard/state.json` | where the switch and the list are stored; `""` = keep nothing on disk |

Bad config never breaks DSH: wrongly-typed keys are dropped, defaults are used, and a warning is
left in the DSH log (`normalizeConfig` never throws).

## 7. Tests

```powershell
npm test    # five suites, 116 assertions
```

| Suite | Covers |
|---|---|
| `test/peak.test.mjs` | window/holiday parsing, boundaries, bad config, the three message modes, **differential tests vs `dsh-cost-meter`** |
| `test/blocked.test.mjs` | the list's pure logic: preview extraction, de-duplication, caps, expiry, sanitising, done toggling, newest-first summary |
| `test/plugin.test.mjs` | host integration on a minimal cordis double: short-circuiting (asserting `next()` is **never** called), pass-through, commands, HTTP routes, persistence, legacy state migration, management API, fail-open paths |
| `test/client.test.mjs` | client half offline: module shape, slot registration, theme-token whitelist, state→copy mapping, element trees, chevron/close/settings page, **DOM/CSS regression assertions for the icon buttons** |
| `test/patch.test.mjs` | parses `cordis.patch.yml` with DSH's own js-yaml and runs the config through normalisation |

No runtime dependencies: the suites run on Node's built-ins alone.

## 8. Implementation notes

* **The interception point is real, verified in source, not guessed.** `LlmRuntime.prepareCall()`
  returns a `PreparedLlmCall` whose `stream(options)` immediately calls
  `streamWithRegistration(options, …)`, and that is
  `ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))`. The agent loop uses that
  path (`preparedCall?.stream(request) ?? loopCtx.llm.stream(request)`), so this plugin is
  unavoidable.
* **The chunk stream is protocol-legal.** `block-start → text-delta → block-end → usage →
  finish({kind:'stop'})`; the loop pushes each chunk through `AssistantStreamAttempt.push()` →
  `AssistantStreamAccumulator` (safe-integer `time`, lossless JSON, typed `text-delta`) →
  `BlockAssembler`. With `finish.kind === 'stop'` and no `tool-call` block, the loop records an
  `assistant/message` with usage and completes the step — so the notice lands in the assistant
  bubble and **no bytes leave the machine**.
* **Never read `ctx.<service>` directly** (bitten twice: `commands`, then `sessionController`):
  cordis **throws** on an un-injected service (`cannot get property "X" without inject`), and
  `try { ctx.x } catch { ctx.get('x') }` does not save you — the catch short-circuits the
  `ctx.get` fallback too. Always `ctx.inject(['x'], (scope) => { ref = scope.x })` first, then
  fall back to the optional-access `ctx.get("x")`.
* **The switch and the phase are decoupled**: `isPeak()` is a pure time function; "should this be
  blocked" is decided in the host half. That is what lets the client render "blocking now" from
  the same numbers the host enforces.
* **The list's three invariants** (`lib/blocked.js`): **no duplicates** (same session + same text
  within 60s is one record), **bounded** (count cap plus max age; bad data is dropped), **read-only**
  (zero dependencies, zero side effects; the UI gets "newest first + total + truncated flag").
* **Two icon buttons must have identical DOM structure and their SVGs must be `display:block`.**
  A chevron used to sit inside an extra `<span>` whose style rule was deleted in a CSS rewrite;
  as an unstyled inline element it aligned to the **text baseline** and sat 1.44px too high
  (found by measuring a screenshot). Both buttons now hold the SVG directly, and a
  regression test guards the symmetry and the CSS rule.

## 9. Known limits

* The holiday table is **annual data**: update `holidays` when the State Council publishes the next
  year (and update `dsh-cost-meter`'s `DEFAULT_PEAK_HOLIDAYS` too, so the differential tests stay
  green).
* `nextTransition()` scans by hour and then by minute inside the hour; that is exact for
  hour-scale windows, but 15-minute fragment windows could theoretically miss multiple switches
  within one hour (the default config is unaffected).
* Client copy is picked from `navigator.language` between a zh/en pair — deliberately **not** DSH's
  locale service: declaring a service that may be absent leaves the fiber PENDING, and the cost
  (the whole control disappears) outweighs the benefit.
* The list only records **conversation calls that carry a `sessionId`**; utility calls are never
  blocked, and hand-made calls without a session id cannot be attributed.
* The list is **evidence of what was blocked, not a queue of work to do**. The plugin will never
  re-send anything for you — that is one of the reasons the earlier auto-replay experiment was
  removed (see [docs/DESIGN-replay-tradeoffs.md](docs/DESIGN-replay-tradeoffs.md)).

## 10. Repository layout

```
dsh-peak-guard/
├─ README.md / README.en.md   Chinese (default) / English
├─ CHANGELOG.md               release notes
├─ LICENSE                    MIT
├─ package.json               declares dsh.bundle.patch and dsh.client; zero runtime deps
├─ cordis.patch.yml           the patch row that applies when the package is in a profile
├─ install.cmd / install-profile.ps1   one-shot install into the desktop profile
├─ lib/                       index (host), peak + blocked (pure logic), store, http, client
├─ test/                      five suites, 116 assertions
├─ docs/DESIGN-replay-tradeoffs.md     the removed replay experiment, kept for the record
├─ docs/PUBLISHING.md                  how to publish / get listed in dsh-market
├─ docs/awesome-dsh-plugin-entry.yml   the list entry, ready to paste into a PR
├─ publish.cmd / publish.ps1          one-shot commit + push + tag (+ create repo / topics)
```

## 11. License

[MIT](LICENSE).
