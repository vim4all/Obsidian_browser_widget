# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Vivaldi (Chromium, Manifest V3) browser extension that is a from-scratch port of [`../obsidian_windows_widget`](../obsidian_windows_widget) (itself a port of [`../obsidian_iphone_widget/ObsidianDailyWidget.js`](../obsidian_iphone_widget/ObsidianDailyWidget.js), a Scriptable/iOS widget script). It reads today's Obsidian daily note's "Day planner" checklist and renders it — task list, overdue highlighting, 7-day habit-completion heatmap — on the New Tab page and in the toolbar popup, plus the same eight local-notification nags the other two versions have.

All three repos are meant to be read side by side when porting new behavior: the iOS script is the source of truth for *what* each feature does; the Windows repo is the desktop-native *how*; this repo is the browser-native *how*. Prefer 1:1 behavioral parity over "improving" the logic — deviations exist only where a platform gave a capability this one doesn't have, or vice versa. See "Conventions to preserve" below for the specific deviations that are intentional.

**The single biggest platform difference from both siblings: there is no filesystem API here.** A browser extension can't open an arbitrary local folder the way Scriptable's `FileManager` or Node's `fs` can. Vault access instead goes through the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) (`showDirectoryPicker()`), which requires a one-time user gesture to grant, returns a `FileSystemDirectoryHandle` that gets persisted in IndexedDB, and whose permission is **not guaranteed to survive a browser restart**. Every read path in this repo is written to degrade to a "reconnect your vault" prompt rather than crash when that permission has lapsed — see `src/vaultAccess.js`.

## Commands

There is no build step, bundler, or lint/test config — this is a plain unpacked MV3 extension, loaded directly from this directory.

```sh
node --check <file>.js         # syntax-check any individual file (all use ES module import/export)
npm run icons                   # regenerate icons/*.png from scripts/generate-icons.js (only if the icon design changes)
```

Every `.js` file in this repo (`src/`, `shared/`, `background.js`, `offscreen.js`, `newtab.js`, `popup.js`, `options.js`) is plain ES module syntax with **zero browser-extension-API calls at parse time** — `node --check` catches syntax errors, but actual behavior (`chrome.*` APIs, File System Access, IndexedDB) only exists in a real browser and needs to be verified by loading the extension.

### Loading it in Vivaldi for manual testing

1. `vivaldi://extensions` → enable **Developer mode** (top right) → **Load unpacked** → select this directory.
2. Open a New Tab, or click the toolbar icon, and use **Connect vault folder** to grant access to your Obsidian vault's root (the folder that directly contains `00_Daily`).
3. After editing any file, go back to `vivaldi://extensions` and click the extension's reload icon — there's no hot-reload.
4. `chrome://serviceworker-internals` (or `vivaldi://serviceworker-internals`) is useful for inspecting whether `background.js` is alive/terminated; `vivaldi://extensions` → the extension's "service worker" / "Inspect views" links open DevTools for the background worker, the offscreen document, and any open newtab/popup/options page.

## Architecture

### Why five separate pages instead of one

Unlike the Windows app's single main+renderer process, this repo has to split across contexts because of what each one is and isn't allowed to do:

| Context | Has a DOM? | Can show a file picker? | Lifetime |
|---|---|---|---|
| `background.js` (service worker) | No | No | Terminated after ~30s idle; woken by events (`chrome.alarms`, messages) |
| `offscreen.js` (offscreen document) | Yes | No (no visible window) | Alive until explicitly closed — see below |
| `newtab.js` / `popup.js` / `options.js` / `blocked.js` | Yes | Yes (has a user gesture from a click) | Normal page lifetime |

This is why vault *reading* happens in `offscreen.js` (it has a DOM, which File System Access API operations on an *already-granted* handle need) while vault *connecting* only happens in `newtab.js` / `popup.js` / `options.js` (only those have the user gesture a picker requires). `background.js` itself never touches the vault at all — it only owns the alarm and the offscreen document's lifecycle.

### `src/vault.js` — daily note parsing

Direct port of the Windows app's `src/vault.js` (which itself ports the iOS script's `parseTasks`/`parseFrontmatter`/`wikiLinkToText`/`habitCompletion`/`isRestDay`/`buildWeekHabitData`/`obsidianNoteURL`). The pure parsing functions (`parseTasks`, `parseFrontmatter`, `habitCompletion`, `isRestDay`, `parseTimeRange`, `isTaskOverdue`, `wikiLinkToText`) are copied verbatim, same signatures — keep it that way so this file stays easy to diff against its two siblings. The disk-touching functions (`readNote`, `dayInfoForOffset`, `buildWeekHabitData`, `tomorrowPlanStatus`) are `async` and take a `FileSystemDirectoryHandle` as their first argument instead of reading a `config.vaultPath` string, since that's what the File System Access API works with. `dateForOffset(offsetDays)` keeps the same sign convention as both siblings: positive offset = past, so "tomorrow" is `dateForOffset(-1)` — don't "fix" this, `tomorrowPlanStatus` and the streak-break/weekly-review callers depend on it matching exactly.

Every function here assumes the caller has already verified permission is `"granted"` via `vaultAccess.checkVaultAccess()` — none of them re-check permission themselves, and none of them can (`queryPermission`/`requestPermission` live on `vaultAccess.js`, not here).

Beyond the ported-verbatim core, this file also has a few things with no sibling equivalent, all added for this specific vault's own productivity system (`10_SelfDev` in the user's vault — see `Task system.md`/`Как користуватись системою.md` there for the source of truth on what these mirror): `hasFilledField()` + `yesterdayReviewStatus()` check the vault's `**Win:**`/`**Reflection:**` inline bold fields (not headings — this vault doesn't use the iOS/Windows README's heading-based template for those); `isTaskActiveNow()` + the distraction guard's deep-work mode key off the vault's `#tdeep` tag; `countStrandedTasks()` mirrors what this vault's own `TASK_BASKET/t_UrgentTasks.md` Dataview query calls "stranded" tasks, bounded to `config.strandedLookbackDays` rather than scanning every note ever written; `planStatus()`/`ganttBars()` are a special-purpose (not general-YAML) reader for one specific frontmatter shape — the `gantt:` list of flat maps this vault's `3_Long term planning.md` uses — gated behind `config.planNotePath` being set, and meant to stay silently skipped (not thrown) for any vault that isn't shaped this way. `appendTaskLine()`/`captureTask()` are the write side (see vaultAccess.js below) — quick-capture from the widget UI (`shared/widgetPage.js`'s `#quickAdd` form). `captureTask()` deliberately never creates today's note or its Day planner section if either is missing, to avoid synthesizing a note that wouldn't match the user's actual daily-note template (frontmatter habit keys, Win/Reflection fields, homepage links) — that's a materially bigger feature (a real templating system) than quick-capture is meant to be.

### `src/vaultAccess.js` — the File System Access API layer

This is the one module with no equivalent in either sibling repo, because neither sibling needed one — Scriptable had a persistent bookmark, Node just had a path string. Here:

- Permission is requested as `"readwrite"`, not `"read"` — quick-capture (`vault.captureTask()`, wired up in `shared/widgetPage.js`) writes to today's note. The File System Access API grants one permission level per handle, not one per operation, so the connection has to be provisioned for the most demanding thing anything in the extension does with it; every other read path just uses more access than it strictly needs. A user who granted `"read"` before this existed sees `checkVaultAccess()` return `"prompt"` once and has to reconnect — same UI path as a permission lapsing after a browser restart, not a new code path.
- `pickVaultDirectory()` calls `window.showDirectoryPicker()` — **requires a user gesture and a visible window**, so it can only be called from `newtab.js` / `popup.js` / `options.js`, never from `offscreen.js` or `background.js`.
- The returned `FileSystemDirectoryHandle` is structured-cloneable, so it's persisted directly into IndexedDB (`saveVaultHandle`/`loadVaultHandle`). Because every page this extension owns shares the same `chrome-extension://<id>` origin, a handle picked from `newtab.html` can be read back from `offscreen.html` — that's the entire mechanism that lets the background tick (which has no window) reuse a vault connection the user granted from a page that did.
- `checkVaultAccess()` returns `{ status, handle }` where `status` is `"granted" | "prompt" | "denied" | "no-handle"`, and **never throws** — every caller (offscreen tick, newtab/popup/options render) treats anything other than `"granted"` as the normal "not connected right now" case, not an exception. This mirrors the Windows app's stance on an invalid `vaultPath`: show a setup hint, don't crash.
- Permission surviving a browser restart is explicitly **not** relied upon anywhere in this codebase, because Chromium's behavior here isn't something to build a hard assumption on. If you're tempted to add code that assumes a granted handle stays granted forever, don't — always re-check via `checkVaultAccess()` at the point of use rather than caching a "granted" result across page loads or offscreen-document lifetimes.

### `src/config.js` — the `const` blocks, made runtime-editable

Same role as the Windows app's `src/config.js` (which itself replaced the iOS script's top-of-file `const` blocks), but persisted via `chrome.storage.local` under a single `"config"` key instead of a JSON file on disk — there's no filesystem to write one to. `chrome.storage.onChanged` (`onConfigChanged`) plays the same "hot-reload, no restart needed" role `fs.watch` played for the Windows app's `config.json`. There is **no `vaultPath` key here** — the vault reference is a `FileSystemDirectoryHandle`, not a string, and lives in IndexedDB via `vaultAccess.js` instead, since `chrome.storage` can't hold a handle.

### `src/store.js` — nag rate-limit state

Same shape as the Windows app's `store.js` (`getTimestamp`/`setTimestamp`/`dateEquals`/`setDate`), but every call hits `chrome.storage.local` directly rather than keeping an in-memory cache the way the Windows version does — that cache pattern only works for a single long-lived process, and `background.js` and `offscreen.js` are separate JS instances (plus `background.js` gets torn down and restarted) that don't share memory, so a cache here would just go stale or vanish.

### `src/notifications.js` — the eight nags

Ported with the exact same hour windows, per-notifier rate limits, and `catchUpWindowHours` tolerance as both siblings — **this still matters here**: even though the background tick isn't subject to iOS's widget-refresh throttling the way the original script was, the browser can still be closed for hours and reopened, so the tolerance window stays. `runNotifiers()` preserves the same one-try/catch-per-notifier structure as both siblings — a throw from any single notifier must never skip the rest for that tick.

This module decides *what* to notify and owns the notification-click target map (`consumeNotificationTarget`), but it does **not** call `chrome.notifications.create()` — `sendNotification()` posts a `NOTIFY_MESSAGE` to the service worker, which makes the call. See "The offscreen API ceiling" below.

`maybeSendWeeklyReview()` also folds in a plan-review check (`vault.planStatus()`, gated on `config.planReviewEnabled`) when it fires — deliberately appended to this existing notification rather than added as a ninth independently-timed one, since the vault's own weekly ritual already reviews the plan note in the same sitting as the weekly/daily reports this notification already summarizes.

Two deliberate deviations from both siblings, both platform-forced:
- **No custom or louder notification sound at all**, not even Windows' `shell.beep()` fallback for the harsher nags — `chrome.notifications` has no sound API an extension can hook into. The harsher nags (planning, undone-tasks) rely on `priority: 2` alone to stand out.
- **No distraction-guard feature.** Both siblings have one (iOS: a Shortcuts "App is Opened" automation; Windows: a global hotkey). Neither has a browser equivalent — extensions can't intercept "a tab is about to navigate to a specific site" the way those two intercept "an app is about to open" (a `webNavigation`-based version *could* exist, but that's a materially different feature — page-load interception vs. app-open interception — and is out of scope here, same as the Windows README treats "auto app-launch interception" as explicitly out of scope for that platform).

### `background.js` — the thinnest layer in this repo, on purpose

Owns exactly two things: the `chrome.alarms` tick (a durable timer that survives the service worker being terminated and restarted — unlike a plain `setInterval`, which the Windows app can use because it's a real persistent process and this isn't) and the offscreen document's lifecycle (`chrome.offscreen.createDocument`/`hasDocument`). It never touches the vault, `src/vault.js`, or `src/notifications.js` directly — every alarm tick just makes sure the offscreen document exists, then broadcasts a `{ type: "obsidian-widget:tick" }` runtime message that `offscreen.js` picks up. Keep it this way: if you're adding logic that reads the vault or decides whether to nag, it belongs in `offscreen.js`, not here — this file has no DOM and cannot get one.

### `offscreen.js` — where the actual tick logic runs

Loads config, calls `vaultAccess.checkVaultAccess()`, and if (and only if) that comes back `"granted"`, reads today's note and calls `notifications.runNotifiers()`. If it's not `"granted"`, the tick is a silent no-op — there is no way to re-prompt for permission from here (no window, no user gesture), so it just waits for the user to reconnect from a visible page.

### The offscreen API ceiling — read this before moving anything into `offscreen.js`

**An offscreen document does not get the full `chrome.*` surface.** It has a DOM (which is the entire reason it exists — File System Access needs one) but only a limited slice of the extension APIs. `chrome.storage` and `chrome.runtime` work. `chrome.notifications`, `chrome.tabs`, and `chrome.declarativeNetRequest` **do not**.

This repo shipped that mistake twice, and both times it failed silently:

1. `offscreen.js` called `chrome.notifications.create()` and registered `chrome.notifications.onClicked`. Every nag threw `TypeError` into `runNotifiers`' catch — which was empty — so **no notification ever fired**, with no error anywhere.
2. `distractionGuard.js`'s `applyGuardState`/`applyDeepWorkState` call `chrome.declarativeNetRequest` and `chrome.tabs`. Reached from the offscreen tick they threw too; the guard only appeared to work because `newtab.js`/`popup.js`/`options.js`/`blocked.js` call the same functions from real extension pages, which do have those APIs. The 5-minute background tick had never applied a rule.

The fix in both cases is the same shape: the offscreen document *decides*, the service worker *acts*. `sendNotification()` posts `NOTIFY_MESSAGE`; `applyGuardState`/`applyDeepWorkState` check `canEnforce()` and post `GUARD_APPLY_MESSAGE`/`DEEP_WORK_APPLY_MESSAGE` when the APIs are missing. `background.js` handles all four and calls the real APIs. Calling back into the same guard functions from the worker does not loop — `canEnforce()` is true there, so they act directly.

**When adding anything to the tick path, assume the API is unavailable in `offscreen.js` until proven otherwise, and never leave a bare `catch {}` around it.** The empty catch is what turned a total outage into an invisible one; `runNotifiers` now logs and records to `diag.lastNotifierError`, which `options.html` displays.

`chrome.notifications.onClicked`/`onClosed` live in `background.js`. Target URLs are persisted to `chrome.storage.local` via `rememberTarget`/`consumeNotificationTarget` rather than held in memory, so a click still resolves after the service worker has been terminated and restarted — which it will have been, since a notification sits on screen far longer than the ~30s idle timeout. `rememberTarget` is awaited *before* the create message is sent, since a notification can be clicked the instant it appears.

The offscreen document is deliberately **not closed** after each tick — `chrome.offscreen` documents aren't subject to the service worker's ~30s idle-kill, so once created it's left running to avoid re-creating a document every ~`tickIntervalMinutes`. It only goes away when Vivaldi itself closes (browser restart), at which point `background.js`'s `onStartup` listener recreates it.

### `src/distractionGuard.js` — the site blocker

The feature the other two repos implement outside the app entirely (iOS: a Shortcuts automation; Windows: a global hotkey). Neither approach ports, but a browser owns the navigation itself, so this version intercepts the request instead: a single `declarativeNetRequest` **dynamic** rule (dynamic, not static, because `config.blockedSites` is user-editable at runtime) matching `main_frame` requests against `requestDomains`, redirecting to `blocked.html`. One rule covers every site — `requestDomains` takes a list and already matches subdomains, so `youtube.com` covers `m.youtube.com` without listing it.

**`main_frame` only, deliberately.** Matching sub-resources would break unrelated pages that embed a YouTube player rather than blocking the distraction; the target is a deliberate visit.

**Fail-open is a design rule, not an oversight.** Every path that can't positively confirm a blocking state *removes* the rule rather than leaving it: guard disabled, vault permission lapsed, vault read threw, rest day, snoozed. This matters more here than anywhere else in the repo because a DNR dynamic rule is **persistent** — unlike a notification, which simply doesn't fire when a tick bails, a stale rule keeps blocking across browser restarts and extension reloads until something explicitly removes it. That's why `offscreen.js`'s tick calls `runGuard(config, null, status)` on both of its early-return paths instead of just returning.

`evaluateGuard()` is pure (no `chrome.*`, no disk) and takes `noteExists` rather than the note text, so it's directly unit-testable in Node and so callers can reuse a read they've already done. Two wrappers sit on top: `syncGuardFromNote()` for callers that already read today's note (the offscreen tick, and `shared/widgetPage.js` — which is why checking off the last overdue task and opening New Tab clears the block immediately instead of waiting out `tickIntervalMinutes`), and `runGuard()` for callers holding only a handle (`blocked.js`'s re-check button, `options.js` on save).

The manifest needs `host_permissions: ["<all_urls>"]` for this: DNR's `redirect` action requires host access to the request being redirected (a plain `block` action wouldn't, but it can only produce `ERR_BLOCKED_BY_CLIENT`, which can't explain itself or link back to the note). It has to be `<all_urls>` because the site list isn't knowable at manifest time. Nothing reads page content — there are no content scripts.

**Deep-work guard** is a second, independent guard in this same file, using a second DNR rule (`DEEP_WORK_RULE_ID`) and its own storage key (`readDeepWorkState`/`applyDeepWorkState`). It activates while `evaluateDeepWork()` finds a not-done task tagged `#tdeep` whose own time block contains "now" (via `vault.isTaskActiveNow()`), and blocks *every* site except `config.deepWorkAllowlist` — the DNR condition omits `requestDomains` (meaning "match anything") and sets `excludedRequestDomains` to the allowlist instead, the inverse of the site guard's rule. It refuses to activate on an empty allowlist, same reasoning as the site guard refusing to activate on an empty `blockedSites`. Both guards share the same snooze (`getSnoozeUntil()`) and the same tab-redirect mechanism (`redirectMatchingTabs()`, parameterized by a hostname predicate) — the site guard passes "hostname is in the list", the deep-work guard passes "hostname is *not* in the list". `redirectMatchingTabs()` is restricted to `http:`/`https:` tabs specifically so the deep-work guard's "block everything" condition can never try to redirect this extension's own pages (chrome-extension://) or the browser's internal pages (chrome://, vivaldi://) — those were never what "block distracting websites" meant. `syncGuardFromNote()` and `runGuard()` both drive this guard alongside the site guard automatically (via `syncDeepWorkGuard()`), including on every fail-open exit — an unreadable vault must release *both* rules, and the deep-work rule is the more dangerous of the two to leave stale since it blocks nearly the whole web, not just a fixed list.

### `src/widgetData.js` + `shared/render.js` — shared between newtab.js and popup.js

`widgetData.js` plays the same role as the Windows app's `main.js` `buildRenderData()` — assembles `{ tasks, week, error, ... }` from the vault. `shared/render.js` is the Windows app's `renderer.js` DOM-building logic with the IPC and `ResizeObserver` plumbing stripped out (there's no separate main/renderer process here, and browser pages just take whatever size their host — the New Tab tab, or the popup's fixed box — gives them). `shared/widgetPage.js` is the controller both `newtab.js` and `popup.js` call into (load config → check vault access → render, plus the connect/reconnect button), so the only things specific to `newtab.js`/`popup.js` are which DOM elements exist in their HTML and `MAX_VISIBLE_TASKS` (popup has a hard height ceiling; New Tab doesn't).

`widgetData.js` also computes `stranded` (`vault.countStrandedTasks()`) and `triageURL` (built from `config.triageNotePath` via `vault.obsidianFileURL()`, the non-daily-note-scoped sibling of `obsidianNoteURL()`), each in their own try/catch so a failure there can't cost the user today's task list — `render()` renders that as a quiet, un-nagging line, hidden entirely when there's nothing stranded. `shared/widgetPage.js` additionally owns the `#quickAdd` form's submit handler, which calls `vault.captureTask()` directly (re-checking `checkVaultAccess()` at submit time, never trusting the page's last render) and then calls the same `refresh()` the page already uses, rather than hand-rolling a partial re-render.

### `options.js` — the settings surface

The Windows app's tray "Edit config..." opens the raw `config.json` in the OS's default text editor. There's no equivalent here — an extension can't shell out to an external editor — so `options.html` is a real form instead, with one field per `DEFAULTS` key in `src/config.js` except the two in `TEXT_BLOB_KEYS`: `tagColors` (edited as a JSON blob, `tagColorsJson` — not worth a full color-picker UI for something edited rarely) and `blockedSites` (edited as newline-separated text, `blockedSitesText`, which is far easier to paste into than a JSON array; normalized through `normalizeSites()` on save, then the form is repopulated so the user sees the normalized form rather than wondering why their pasted URL looks different from what actually blocks). When adding a new config key to `DEFAULTS`, also add a form field for it in `options.html` + wire it into `SIMPLE_KEYS`'s handling in `options.js`, or it'll silently be unreachable from the settings UI (it'll still work via whatever wrote it directly to `chrome.storage.local`, just not editable here).

## Conventions to preserve when editing

- Every disk-touching function takes the `FileSystemDirectoryHandle` as an explicit parameter (see `src/vault.js`) — never cache "the vault handle" as a module-level variable anywhere, since permission can lapse between calls and every call site needs to be the one deciding what to do about that (usually: nothing, and let the UI's next `checkVaultAccess()` show the reconnect prompt).
- `vaultAccess.pickVaultDirectory()` / `requestVaultAccess()` must only ever be called from a click handler in a visible page (`newtab.js`, `popup.js`, `options.js`) — never add a call to either from `offscreen.js` or `background.js`; it will throw (no user gesture available) or simply isn't available (no window to show a picker in).
- Keep `runNotifiers()`'s per-notifier `try/catch` structure — see the `src/notifications.js` section above and both sibling repos' identical convention.
- `store.js` keys stay short/flat (`"lastFocusReminder"`, `"blockStart.<hash>"`) — no per-platform namespace prefix needed, since `chrome.storage.local` here is entirely private to this extension already (unlike the iOS version's shared-Keychain-namespace concern).
- When porting a new feature from either sibling script, port the *behavior* (hour windows, rate limits, rest-day interactions) exactly, and only diverge where a platform capability genuinely differs — and document the divergence inline the way the deviations above are documented, so future edits don't "fix" an intentional difference back into a bug.
- `icons/*.png` are generated, not hand-drawn — see `scripts/generate-icons.js`. Don't edit the PNGs directly; change the SDF math in the script and re-run `npm run icons` instead, or the source of truth and the shipped asset will drift apart.
