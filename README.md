# Obsidian Daily Widget (Vivaldi)

A Vivaldi browser extension port of [`obsidian_windows_widget`](../obsidian_windows_widget) / [`obsidian_iphone_widget`](../obsidian_iphone_widget) — shows an Obsidian daily note's "Day planner" checklist on your New Tab page and in the toolbar popup, plus the same reminder/nag system as the other two versions.

- a task list + 7-day habit-completion heatmap on New Tab and in the toolbar popup,
- the same eight local-notification nags that keep you on track through the day,
- a quick-add box to capture a task without switching to Obsidian,
- a stranded-tasks glance and a distraction guard (including a stricter deep-work mode) with the same fail-open philosophy throughout.

It reads (and, for quick-capture, writes) your Obsidian vault directly via the browser's File System Access API — there's no sync service, network call, or account involved, and no native helper app to install.

## Requirements

- Vivaldi (or any recent Chromium-based browser — Chrome, Brave, Edge — though this repo is written and tested against Vivaldi specifically).
- An Obsidian vault stored locally, with a daily-notes folder.
- Daily notes named `YYYY-MM-DD.md`, containing a "Day planner" section written as a standard Markdown task list.

## Installing (unpacked)

There's no store listing — load it as an unpacked extension:

1. Open `vivaldi://extensions`.
2. Enable **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select this folder.
4. Open a New Tab, or click the extension's toolbar icon, and click **Connect vault folder** — pick the folder that directly contains your daily-notes folder (`00_Daily` by default).

Vivaldi will **not** honor the extension's New Tab override on its own — unlike Chrome, it has no "let extensions control the New Tab page" setting, and while **New Tab Page** is set to "Vivaldi Start Page" it ignores `chrome_url_overrides.newtab` outright. To get the widget on New Tab, point Vivaldi at it explicitly:

1. **Settings → Tabs → New Tab Page**
2. Select **Specific Page**
3. Enter `chrome-extension://<extension-id>/newtab.html`, taking `<extension-id>` from the extension's entry on `vivaldi://extensions`.

The ID of an unpacked extension is derived from its folder path, so moving this folder changes it and the setting has to be updated. The toolbar popup works regardless of any of this.

## Daily note format

Identical to both other versions — only the "Day planner" section is parsed:

```md
## Day planner

- [ ] 9:00 - 10:30h Deep work on report #timp #twrk
- [x] Reply to emails #tprsn
- [ ] [[Project X]] planning #tprj
```

| Element | Syntax | Notes |
|---|---|---|
| Completion | `- [ ]` / `- [x]` / `- [X]` | drives strikethrough + task ordering (open tasks first) |
| Time range | leading `` H:MM - H:MM `` or `` H:MM - H:MMh `` | shown as a badge; also drives time-block nudges and overdue highlighting (below) |
| Tags | `#tagname` anywhere in the line | stripped from display text; first tag sets the widget's colored dot |
| Wikilinks | `[[Target]]` or `[[Target\|Alias]]` | rendered as plain text (alias, or link target's last path segment) |

`timp` (important) is the one tag with logic behind it, not just color — every reminder prioritizes `#timp` tasks.

### Overdue tasks

A task with a time range is marked overdue once that range ends and it's still unchecked. Controlled by `overdueTaskStyle` in Settings: `"red"` (default, steady highlight), `"flash"` (highlight + pulsing), or `"none"` to disable.

### Habit tracking

Any YAML frontmatter key whose value is literally `true` or `false` is a habit toggle:

```yaml
---
exercised: true
read: false
---
```

The ratio of `true` keys drives the color intensity of that day's cell in the heatmap.

### Rest days

Add `day_off: true` to a daily note's frontmatter to mark it a deliberate day off — silences that day's focus reminder, morning kickoff, evening summary, undone-tasks nag, and time-block nudges. Tomorrow's rest-day flag stops the planning nag from treating it as a missing plan. Yesterday/day-before rest days stop the streak-break alert from firing.

### Yesterday's review (Win / Reflection)

If your daily note template has inline bold fields like:

```md
**Win:** closed the thing I'd been putting off
**Reflection:** tired, but the plan held up
```

the distraction guard can require yesterday's copy of these to have text after the label before today's plan counts as "in good standing" — see `blockOnIncompleteReview` below. These are matched as a bold inline label (`**Win:**`), not a markdown heading — if your template uses `## Win` instead, this check won't find it; that's a different, unsupported shape for now.

## Quick-capture

A small "Add a task…" box above the task list on New Tab and in the popup — type and hit Enter (or click **+**) to append a new unchecked task to the end of today's Day planner section, without switching to Obsidian. Whatever you type is used verbatim as the task line, so include your own time range and tags exactly the way you'd write them by hand (e.g. `13:30 - 14:00 Call the clinic #tprsn`).

It only appends to a note that already exists and already has your `headingPattern` section — it deliberately never creates today's note or synthesizes a Day planner heading, since that would mean guessing at your real daily-note template (frontmatter habit keys, Win/Reflection fields, homepage links) instead of using it. If either is missing, it tells you so instead of writing something incomplete.

This is also why connecting your vault now asks for **read and write** access instead of read-only — the File System Access API grants one permission level per folder, not one per feature, so the connection has to cover the most demanding thing anything here does with it. If you connected before this feature existed, you'll be asked to reconnect once; it's the same "click to re-confirm" flow as a permission lapsing after a browser restart, not a fresh folder pick.

## Stranded tasks

A quiet, read-only line under the task list — "N stranded task(s) (oldest Xd)" — counting open tasks left behind in past daily notes, going back `strandedLookbackDays` (default 14). It's not a nag: hidden entirely when there's nothing to show, and it never fires a notification. Set `triageNotePath` to a vault-relative note path (e.g. wherever you sweep leftover tasks weekly) to turn the count into a link; leave it blank to just show the number.

## Notifications

Vivaldi (Manifest V3) doesn't allow a background page to just run forever the way the Windows app's process does. Instead, a `chrome.alarms` timer wakes a background check every `tickIntervalMinutes` (default **5**) — durable across the extension's background worker being suspended and restarted — and that check reads today's note and evaluates every nag below, same as the other two versions.

Every notification is clickable — it opens the relevant daily note via Obsidian's `obsidian://` URI scheme in a new tab. This requires `obsidianVaultName` in Settings to match your vault's actual name *inside the Obsidian app*.

| Nag | When |
|---|---|
| Focus reminder | Every `reminderIntervalMinutes` (tightens with more open `#timp` tasks) during `workStartHour`-`workEndHour` on `workDays` |
| Morning kickoff | Once/day, ~`morningKickoffHour`: your top pending task |
| Evening summary | Once/day, ~`eveningSummaryHour`: done/pending recap |
| Planning nag | From `planningNagHour` onward, every `planningNagIntervalMinutes`, until tomorrow's note has ≥1 task |
| Undone-tasks nag | From `undoneNagHour` onward, every `undoneNagIntervalMinutes`, until today's tasks are all checked |
| Time-block nudges | Fires when a task's time range starts, and again if it ends still unchecked |
| Weekly review | Once/week, ~`weeklyReviewHour` on `weeklyReviewDay`: trailing 7-day habit % |
| Streak-break alert | Once/day if yesterday AND the day before both hit 0% habit completion |

The harsher nags (planning, undone-tasks) use a higher notification priority to stand out — there's no custom-sound API available to an extension, so unlike the Windows version (which at least gets a system beep) these are visually louder only.

### Plan review (folded into the weekly review notification)

If `planReviewEnabled` is on and `planNotePath` points at a note with a `gantt:` list of project bars in its frontmatter (`status:`, `key:`, optionally `track: habit`) and a top-level `reviewed:` date — the shape a "long-term plan" note might use — the weekly review notification appends up to two lines: how many days it's been since `reviewed:` (once past `planReviewStaleDays`), and how many distinct project keys are `status: active` (once past `planMaxActiveProjects`). This isn't a general planning feature — it's a narrow reader for that one specific frontmatter shape, and it silently does nothing if the note is missing, unreadable, or shaped differently.

## Distraction guard

Blocks a list of sites while today's plan needs attention. This is the browser's answer to the iOS version's Shortcuts automation and the Windows version's global hotkey — neither of those ports, but a browser owns the navigation itself, so this intercepts the request instead.

**Off by default.** Loading an extension shouldn't silently start taking sites away; turn it on in **Settings → Distraction guard**.

It blocks when any condition is true:

| Condition | Setting | Meaning |
|---|---|---|
| A task is overdue | `blockOnOverdueTask` | A task's time range has ended and it's still unchecked — the same condition that drives the red highlighting and the "block ended, still open" nudge |
| Today has no daily note | `blockOnMissingDailyNote` | No `YYYY-MM-DD.md` for today exists at all |
| Yesterday's review is incomplete | `blockOnIncompleteReview` | Yesterday has no daily note at all, or its `winFieldLabel` / `reflectionFieldLabel` fields (default "Win" / "Reflection", matched as a bold inline label like `**Win:** did a thing`, not a heading) have no text after the label |

A blocked navigation lands on a page naming the specific reason, listing the overdue tasks, and offering three ways out: **Open note** (an `obsidian://` deep link to whichever note needs attention — today's, or yesterday's when the only open reason is the incomplete review — which, if that note doesn't exist, opens Obsidian right where you'd create it), **re-check** (re-reads the vault immediately rather than waiting out `tickIntervalMinutes`), and **snooze**.

Only top-level navigations are blocked, not sub-resources — an embedded YouTube player inside an unrelated page keeps working, since blocking it would break that page rather than the distraction. Tabs already open on a blocked site when the guard activates are redirected too, not just new navigations — a tab left open from before the block started doesn't get a free pass.

### When it will not block

By design, every uncertain state fails *open* — you get your sites back, never a lockout:

- the guard is disabled, or `blockedSites` is empty
- the vault is disconnected, or its permission lapsed after a browser restart
- the vault threw on read
- today is a rest day (`day_off: true`), unless you turn off `guardRespectsRestDay`
- you snoozed, and the snooze hasn't expired

This matters more than it looks: the block is a `declarativeNetRequest` dynamic rule, which **persists across browser restarts and extension reloads** until something removes it. A tick that bailed without releasing it would leave sites blocked indefinitely with no visible cause, so every early exit releases it explicitly.

### Timing

Blocking follows the same `tickIntervalMinutes` background check as the nags, so a task going overdue registers within that window. Unblocking is faster: opening New Tab or the popup re-evaluates the guard on the read it was already doing, and the block page's re-check button forces it immediately — so checking off the last overdue task doesn't leave you staring at a block page for another five minutes.

### Permissions

This is the reason the extension asks for `declarativeNetRequest` and access to all sites. DNR's *redirect* action needs host access to the request it redirects (a plain *block* action wouldn't, but it can only produce a bare `ERR_BLOCKED_BY_CLIENT`, which can't explain itself or link back to your note), and the list has to be `<all_urls>` because your site list isn't knowable ahead of time. There are no content scripts — nothing reads the content of any page you visit.

## Deep-work guard

A separate, stricter guard: while a task tagged `#tdeep` has its own time range running right now, it blocks *every* site except `deepWorkAllowlist` instead of just `blockedSites` — a "nothing but the allowed few" mode rather than "everything except the usual suspects". It turns on and off automatically with the tagged task's own time block; there's nothing to start or stop by hand.

**Off by default, and requires a non-empty allowlist to ever activate** — with `deepWorkAllowlist` empty, turning `deepWorkGuardEnabled` on does nothing, on purpose. An empty allowlist would otherwise mean "block the entire web the moment a #tdeep task starts", which is exactly the kind of surprise the fail-open design throughout this guard exists to avoid. Populate the allowlist with whatever you actually need open during focused work (docs, your own tools) before turning this on.

It shares the same snooze button, the same "redirect tabs already open, not just new navigations" behavior, and the same unconditional release on a lapsed/unreadable vault as the guard above — see `src/distractionGuard.js` for why those two guards are kept independent rather than merged into one.

## Using the extension

- **New Tab** — opens automatically to the widget (subject to the Vivaldi Start Page caveat above).
- **Toolbar popup** — click the extension icon any time for the same view in a compact window.
- **Settings (⚙ icon, or right-click the toolbar icon → Options)** — vault connect/disconnect, and every tunable below.

### If you never see a notification

Every nag is gated by an hour window, so silence is usually correct rather than broken — focus reminders are weekdays 9–18, the morning kickoff only fires 08:00–10:00, the planning and undone nags not before 22:00. On a Sunday morning, six of the eight are switched off by design.

To tell "not due yet" apart from "not working", open **Settings → Diagnostics** and click **Send test notification**. It bypasses every window and rate limit and takes the same path the real nags take:

- **Toast appears** — the plumbing is fine; you were outside the windows.
- **"Sent" but no toast** — Vivaldi or Windows is suppressing it. Check Windows Settings → System → Notifications → Vivaldi, and that Focus assist is off.
- **"Failed: …"** — a real fault; the message says what.

The same panel shows when the background check last ran, which separates "the tick never runs" from "the tick runs and decides nothing is due", plus the last notifier error if there was one.

## Configuration reference

All settings live in the extension's Settings page.

| Key | Default | Purpose |
|---|---|---|
| *(vault folder)* | *(prompted on first use)* | granted via the OS folder picker, not a typed path — see "Connect vault folder" |
| `dailyFolder` | `"00_Daily"` | subfolder containing `YYYY-MM-DD.md` notes |
| `headingPattern` | `"Day planner"` | heading text the parser looks for (case-insensitive, any `#` level) |
| `restDayFrontmatterKey` | `"day_off"` | frontmatter key marking a rest day |
| `obsidianVaultName` | `"RemoteKnowledgeBase"` | vault name as known to the Obsidian app, for tap-to-open links |
| `tagColors` / `defaultTagColor` | see Settings | per-tag dot colors (edited as JSON) |
| `overdueTaskStyle` | `"red"` | how tasks past their own time range are marked: `"none"`, `"red"`, or `"flash"` |
| `overdueColor` | `"#ff453a"` | color used for overdue tasks |
| `distractionGuardEnabled` | `false` | master toggle for the distraction guard |
| `blockedSites` | YouTube, Reddit, X/Twitter, Instagram, TikTok, Facebook, Twitch | domains to block; subdomains included automatically |
| `blockOnOverdueTask` | `true` | block while a task's time block has ended unchecked |
| `blockOnMissingDailyNote` | `true` | block while today has no daily note |
| `blockOnIncompleteReview` | `true` | block while yesterday's note is missing or its Win/Reflection fields are empty |
| `winFieldLabel` | `"Win"` | bold inline label (e.g. `**Win:**`) yesterday's Win field must have text after |
| `reflectionFieldLabel` | `"Reflection"` | bold inline label (e.g. `**Reflection:**`) yesterday's Reflection field must have text after |
| `guardRespectsRestDay` | `true` | never block on a `day_off: true` day |
| `guardSnoozeMinutes` | `5` | block page's snooze duration; `0` hides the button (shared with the deep-work guard) |
| `deepWorkGuardEnabled` | `false` | master toggle for the deep-work guard |
| `deepWorkAllowlist` | `[]` | sites still reachable during an active `#tdeep` block; empty = guard can never activate |
| `strandedLookbackDays` | `14` | how many past days the stranded-tasks glance scans |
| `triageNotePath` | `""` | vault-relative note the stranded-tasks glance links to; blank hides the link |
| `planReviewEnabled` | `false` | master toggle for the plan-review addition to the weekly review notification |
| `planNotePath` | `""` | vault-relative note with a `gantt:`/`reviewed:` frontmatter shape (see Plan review above); blank skips the check |
| `planReviewStaleDays` | `30` | flag the plan note's `reviewed:` date once it's this many days old |
| `planMaxActiveProjects` | `3` | flag once more than this many distinct project keys are `status: active` |
| `notificationsEnabled` | `true` | master toggle for all nags |
| `remindersEnabled` | `true` | focus-reminder toggle |
| `reminderIntervalMinutes` | `30` | base focus-reminder cadence |
| `workStartHour` / `workEndHour` | `9` / `18` | focus-reminder active window |
| `workDays` | `1,2,3,4,5` | focus-reminder active days (`0` = Sunday) |
| `morningKickoffHour` | `8` | morning kickoff window start |
| `eveningSummaryHour` | `19` | evening summary window start |
| `catchUpWindowHours` | `2` | tolerance window for once-per-day/week notifications |
| `planningNagHour` / `planningNagIntervalMinutes` | `22` / `10` | planning nag timing |
| `undoneNagHour` / `undoneNagIntervalMinutes` | `22` / `10` | undone-tasks nag timing |
| `timeBlockNudgesEnabled` | `true` | master toggle for time-block nudges |
| `timeBlockCatchUpMinutes` | `20` | tolerance window for time-block nudges |
| `weeklyReviewDay` / `weeklyReviewHour` | Sunday / `20` | weekly review timing |
| `tickIntervalMinutes` | `5` | how often the background check reads the vault and evaluates nags |

## Verifying changes

There's no test suite. Every `.js` file is plain ES module syntax with no browser-API calls at parse time, so a syntax check works without a browser:

```sh
node --check <file>.js
```

Actual behavior — `chrome.*` APIs, File System Access, notifications — only exists inside a real browser and needs to be verified by loading the extension unpacked (see Installing above) and reloading it from `vivaldi://extensions` after each change.

## Known limitations

- **Vault permission can lapse on browser restart.** Chromium's File System Access permission grants aren't guaranteed to survive closing and reopening the browser. If the widget shows "Connect vault folder" again after a restart, that's expected — click it, and (since the folder was already picked once) it's usually a single confirmation rather than a full re-pick.
- **Quick-capture asks for write access to your whole vault folder**, not just today's note — the File System Access API doesn't grant permission at finer than folder granularity. Nothing else in this extension writes anything; every other feature only ever reads.
- **No custom notification sound.** Unlike the Windows version's system-beep fallback for the harsher nags, there's no sound API available to an extension at all — the harsher nags rely on notification priority alone.
- **Distraction guard only covers this browser.** Unlike the iOS Shortcuts automation and the Windows global hotkey, which act at the OS level, an extension can only intercept navigations inside Vivaldi itself — another browser, or the YouTube app, is untouched by it.
- **New Tab requires manual pointing in Vivaldi.** Vivaldi ignores extension New Tab overrides and has no setting to allow them; it has to be aimed at the extension's page by hand — see "Installing" above. The toolbar popup always works regardless.
- **Background checks are timer-based, not instant on file edits.** Unlike the Windows app's file watcher (which reflects an edit in ~1s), this version only re-reads the vault every `tickIntervalMinutes` in the background, or whenever you open New Tab/the popup (which always reads fresh).
