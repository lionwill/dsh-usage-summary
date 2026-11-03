# dsh-usage-summary

[简体中文](README.md) | English

A compact **usage summary** widget for DeepSeek Harness Web: a capsule in the status bar below the input box (`conversation.composer.dock`, `order: -10`), placed **left of** the "N turns M steps · tok/s" stats capsule; clicking it pops up a detail panel **upwards**.

The panel content **switches automatically with the channel the current session is using**:

## Two modes

| Current session channel | Capsule | Panel title | Panel content |
| --- | --- | --- | --- |
| DeepSeek official (`deepseek-official` / `deepseek-account`) | `● DS ¥128.40` | **DeepSeek Official Balance** | Official data only: this session's official tokens (cache-miss input / cache-hit / output), time-of-day estimated cost, account balance. No Go plan shown |
| OpenCode Go (anything else) | `● Go 5h 12% · wk 8% · mo 46%` | **OpenCode Go Usage Summary** | A new "this session" row at the top (**Go channel only**: total tokens and call count), followed by the usual three plan windows (5 hours / week / month) progress bars and reset times |

```text
# DeepSeek official channel
● DeepSeek Official Balance  [account]  deepseek-flash · 5 calls        ↻  ×
Input (cache miss)                                          12.3K
Cache hit                                                   48.0K
Output                                                       1.2K
Cost (estimated)                                          ¥0.0181
Balance                                                  ¥128.40

# OpenCode Go channel
● OpenCode Go Usage Summary                                   ↻  ×
This session                                21.4K tok · 9 calls
5 hours  ████░░░░░░░░░░░░  12%      resets 16:30
This week ███░░░░░░░░░░░░░   8%      resets 11-08
This month █████████░░░░░░░  46%      resets 11-07
```

Existing behavior: colors are green <60% / yellow 60–85% / red ≥85%; clicking the capsule toggles the panel, clicking outside or `Esc` closes it; auto refresh every 60 seconds; `↻` forces a refresh; on fetch failure an error and a retry are shown.

## Color thresholds (editable in the panel)

Progress bars/percentages/capsule dot use three color bands: **green < orange start ≤ orange < red start ≤ red**. The default thresholds are **60 / 85** (click **⚙** in the panel header after opening it to change them):

```text
● OpenCode Go Usage Summary        ↻ ⚙ ×
  ⬛ 0–60%   ⬛ 60–85%   ⬛ 85–100%
  Orange threshold (%)              [ 60 ]
  Red threshold (%)                 [ 85 ]
  [Restore defaults] [Cancel] [Save]
  Affects only this browser's display and is saved in localStorage.
```

- The two split points define three ranges; input must satisfy `1 ≤ orange start < red start ≤ 100`, otherwise saving is rejected with a hint.
- After saving it takes effect **immediately** (capsule percentage text, progress-bar fill and dot color update together) and is written to `localStorage` (key `dsh-usage-summary:thresholds`); it survives a page refresh and needs no restart.
- The capsule dot uses the **highest** percentage among the three windows, so "this month reaches 60%" turns the whole dot.
- In DeepSeek official mode the colors are decided by **amount** (balance < ¥10 orange, < ¥1 red) and are unaffected by this setting.

## Historical sessions and background indexing

The host keeps in memory only sessions "opened in the current process", so historical sessions need another source. The plugin reads persisted logs through `ctx.sessionPersistence` and runs one silent full index in the background:

- **Scan at startup**: `sessionPersistence.list()` enumerates all stored sessions, ordered by **most recent activity descending** (log-file mtime, falling back to the header's createdAt), folded one by one by a background queue; only one at a time, pausing 120ms between sessions by default, so it never competes with the host for resources.
- **On-demand priority**: when the panel is open and the session has not been indexed yet, "this session" shows **calculating…**; while the panel is open the client fast-polls every 2 seconds and switches to the number as soon as indexing completes.
- **Refresh = high priority**: clicking `↻` in the panel **moves the current session to the front of the queue** and waits for the result (`indexTimeoutMs`, 8s by default); usually it returns in tens of milliseconds without waiting for the whole queue.
- **Index once**: the index lives in memory and is rebuilt after a restart; every 5 minutes it re-checks stored logs by `revision` and only re-folds the ones that changed. Sessions already open always take the synchronous path (the in-memory log is the most recent, no need to wait for the index).
- The index runs silently: no logs, no notifications, no session occupancy.

## Data sources

| Endpoint | Purpose |
| --- | --- |
| `GET /usage-summary/v1/plan` | OpenCode Go plan usage (the host polls upstream `https://opencode.ai/inference/go/v1/usage`, 60s cache) |
| `GET /usage-summary/v1/session?session=<id>` | Current-session summary: routing decision + official/Go local stats + balance; unindexed historical sessions return `pending:true`, `&refresh=1` triggers a high-priority fold |

- **Usage stats are purely local**: the host folds persisted session logs (`request/header` decides routing, `assistant/message`'s `source.provider` + `usage` do the bookkeeping), with zero extra inference calls. Token counts are the exact values reported by the provider.
- **Balance**: the source matching the auth method is preferred — API-key routing uses the official `/user/balance`, account routing uses the DSH account service's platform wallet (`deepseekAccount.getBalance`); on failure it automatically falls back to the other source (60s cache; balance < ¥1 shown in red).
- **Amounts are estimates**: billed per call by time of day using the official CNY price table (2026-10-17).

### DeepSeek official pricing (CNY / 1M tokens)

| Model | Cache hit (peak/off-peak) | Cache miss (peak/off-peak) | Output (peak/off-peak) |
| --- | --- | --- | --- |
| `deepseek-flash` | ¥0.04 / ¥0.02 | ¥2 / ¥1 | ¥8 / ¥4 |
| `deepseek-v4-pro` | ¥0.30 / ¥0.15 | ¥9 / ¥4.5 | ¥27 / ¥13.5 |

Peak = **Beijing time**, Monday–Friday 09:00–12:00 and 14:00–18:00; statutory holidays are not modelled → amounts are estimates.

## Adding new channels later?

**Yes, but not automatically.** The "channel" in the settings page is just DSH's provider routing; for the plugin to handle a channel it needs two more things:

1. **How to count usage** — any channel can use the current mechanism: accumulate tokens from session logs by provider id (just list the ids in the config);
2. **Whether there is a balance/plan source** — if it has an official API, add a fetch adapter (like DeepSeek's `/user/balance` or OpenCode Go's `/usage`); otherwise it can only show local tokens and estimated cost.

So the extension path is: change provider sets such as `goProviders` / `deepseekProviders` to the channel ids you want to track, and add a fetch adapter plus cache for the balance part. Currently the plugin ships with two channel groups: Go and DeepSeek official.

## Installation

```sh
dsh plugin --profile web add link:/absolute/path/without/spaces/dsh-usage-summary
```

Installing from a tarball works too (`dsh-usage-summary-0.5.0.tgz` is packed following npm conventions):

```sh
dsh plugin --profile web add /absolute/path/dsh-usage-summary-0.5.0.tgz
```

First install / **upgrading the host half requires restarting `dsh web`**; changing only `lib/client.js` needs just a page refresh.

> The plugin ships no secrets: both the OpenCode Go key and the DeepSeek key are resolved by the host credentials service (defaults reference `OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY`, configurable).

## Configuration (optional; written to the profile's `cordis.patch.yml`, overridden per id)

```yaml
- id: usage-summary
  config:
    # OpenCode Go (plan)
    apiBase: https://opencode.ai/inference/go/v1
    apiKeyEnv: OPENCODE_GO_API_KEY
    apiPath: /usage-summary/v1
    refreshMs: 60000
    timeoutMs: 15000
    goProviders: [opencode-go]            # providers counted in "this session" usage
    # DeepSeek official
    deepseekApiBase: https://api.deepseek.com
    deepseekKeyEnv: DEEPSEEK_API_KEY
    deepseekProviders: [deepseek-official, deepseek-account]
    deepseekAccountVersion: 1.0.0         # x-client-version for platform-wallet requests (defaults to the host version)
    balanceRefreshMs: 60000
    # Historical-session background indexing
    indexDelayMs: 120            # pause between sessions
    indexRescanMs: 300000        # interval for re-checking stored logs' revision (5 minutes)
    indexTimeoutMs: 8000         # longest wait for a high-priority fold on refresh
    # Color thresholds are set in the panel's ⚙ (localStorage), not in server config
    deepseekPrices:
      deepseek-flash:
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
      deepseek-v4-pro:
        peak: { cacheHit: 0.30, cacheMiss: 9, output: 27 }
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
```

## How it works

- **Host half**: `inject: [webServer, credentials, sessions]`.
  - `/plan`: caches and de-duplicates upstream requests according to `refreshMs`;
  - `/session`: `ctx.sessions.get(id)` gets the session → folds the persisted event log (a single pass computes both the official and the Go ledger) → decides `mode` from the latest `request/header`: the official channel returns `{ mode:'deepseek', auth, deepseek:{...}, go }`, otherwise it returns `{ mode:'go', go:{calls,tokens} }`. Results are micro-cached for 2s keyed by the session-log cursor.
  - Keys are always resolved through `ctx.credentials.resolve(ref)`; never written to disk or to logs.
- **Client half**: registers into `conversation.composer.dock` (`order: -10`) and takes `sessionId` from the slot's standard session props; `/plan` and `/session` are each polled every 60s; both capsule and panel render by `mode`. The panel uses `createPortal` + `position: fixed` anchored above the capsule.

## Known limitations

- Session logs are read with `Session.snapshotEvents()` (deprecated but still usable); when it is removed in the future the official section will show a fetch failure, while the Go plan part is unaffected.
- Amounts are estimates (holidays not modelled; Search/Fetch per-call fees not counted).
- Only `assistant/message` events that successfully report usage are counted; failed attempts are not.
- The `deepseek-account` balance requires the account plugin to be mounted and logged in; otherwise it falls back to the API-key balance, and if both fail it shows "fetch failed".
- Historical sessions depend on the `sessionPersistence` service; without it those sessions can only show "fetch failed".
- The first startup reads the historical logs once in the background (silently, rate-limited); with many sessions it can take a few seconds to index everything.

## Uninstall

```sh
dsh plugin --profile web remove dsh-usage-summary
```
