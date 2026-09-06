// The distraction guard: blocks a configurable list of sites while today's
// plan is in a state the user told us should cost them their distractions —
// either a task has gone overdue, or today has no daily note at all.
//
// This is the feature ../obsidian_iphone_widget implements as a Shortcuts
// automation and ../obsidian_windows_widget implements as a global hotkey.
// Neither approach ports to a browser, but a browser has something those
// two don't: it owns the navigation itself. So instead of "intercept before
// an app opens", this intercepts the request and swaps in blocked.html.
//
// Mechanism: a single declarativeNetRequest *dynamic* rule (dynamic, not
// static, because the site list is user-editable at runtime) matching
// main_frame requests to config.blockedSites, redirecting to blocked.html.
// One rule covers every site — DNR's requestDomains condition takes a list
// and already matches subdomains, so www.youtube.com and m.youtube.com come
// along without being listed. Sub-resource requests are deliberately NOT
// matched: blocking an embedded YouTube player inside an unrelated page
// breaks that page rather than the distraction, and the point here is to
// stop a deliberate visit, not to scrub the web.
//
// FAIL-OPEN IS A DESIGN RULE, NOT AN OVERSIGHT. Every path that can't
// positively confirm "today is in a blocking state" removes the rule
// instead of leaving it in place: guard disabled, vault permission lapsed
// (which happens on browser restart — see src/vaultAccess.js), vault read
// threw, rest day, snoozed. A bug in vault reading must never be able to
// wall someone off from their browser, and a stale rule left behind by a
// crashed tick would do exactly that — dynamic DNR rules persist across
// browser restarts and extension reloads until something removes them.
//
// This file actually owns two independent guards sharing that same
// fail-open posture: the site-blocklist guard described above, and a
// stricter "deep-work" guard further down (search for "Deep-work guard")
// that blocks everything *except* an allowlist while a #tdeep-tagged task's
// time block is running. Keep the two independent rather than merging them
// — they have different activation conditions, different DNR rule shapes,
// and a bug in one must never take the other down with it.

import * as vault from "./vault.js"

// Reserved dynamic-rule IDs — one for the site-blocklist guard above, one
// for the deep-work guard below (see that section for what it does).
const RULE_ID = 1001
const GUARD_RULE_IDS = [RULE_ID]
const DEEP_WORK_RULE_ID = 1002
const DEEP_WORK_RULE_IDS = [DEEP_WORK_RULE_ID]

const STATE_KEY = "guard.state"
const DEEP_WORK_STATE_KEY = "guard.deepWork.state"
const SNOOZE_KEY = "guard.snoozeUntil"

const EMPTY_GUARD_STATE = { blocking: false, reasons: [], overdueTasks: [], noteId: null, yesterdayNoteId: null }
const EMPTY_DEEP_WORK_STATE = { active: false, task: null }

// --- Snooze ---------------------------------------------------------------
// The escape hatch. A blocker with no way out is a blocker that eventually
// gets uninstalled in a moment of frustration, taking the rest of the
// widget with it; a snooze that costs a deliberate click is enough friction
// for the job. Stored as an absolute timestamp so it survives the offscreen
// document being torn down mid-snooze.

export async function snoozeGuard(minutes) {
  const until = Date.now() + minutes * 60 * 1000
  await chrome.storage.local.set({ [SNOOZE_KEY]: until })
  return until
}

export async function getSnoozeUntil() {
  const result = await chrome.storage.local.get(SNOOZE_KEY)
  const until = Number(result[SNOOZE_KEY] || 0)
  return until > Date.now() ? until : 0
}

export async function clearSnooze() {
  await chrome.storage.local.remove(SNOOZE_KEY)
}

// --- Block state ----------------------------------------------------------
// Persisted so blocked.html can explain *why* it is showing. The redirect
// carries no context of its own (DNR redirects to a static extension path),
// so without this the block page could only say "blocked", which is the
// least useful thing it could say — the whole point is to send the user
// back to the specific thing they left undone.

export async function readGuardState() {
  const result = await chrome.storage.local.get(STATE_KEY)
  return result[STATE_KEY] || EMPTY_GUARD_STATE
}

async function writeGuardState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state })
}

// Same "state for the block page to explain itself" role as readGuardState
// above, for the deep-work guard (see that section below) — kept as a
// separate key rather than merged into the site guard's state because the
// two activate independently and blocked.js needs to tell which one sent
// the user there.
export async function readDeepWorkState() {
  const result = await chrome.storage.local.get(DEEP_WORK_STATE_KEY)
  return result[DEEP_WORK_STATE_KEY] || EMPTY_DEEP_WORK_STATE
}

async function writeDeepWorkState(state) {
  await chrome.storage.local.set({ [DEEP_WORK_STATE_KEY]: state })
}

// --- Evaluation -----------------------------------------------------------

// Decides whether today is in a blocking state, given already-read tasks.
// Split out from runGuard so the widget pages — which have just read the
// vault to render themselves — can reuse their read instead of paying for a
// second one. `noteExists` is false when today has no daily note at all
// (vault.readNote returning null); the note's actual text is never needed
// here, only its tasks, which the caller has already parsed. `yesterdayStatus`
// is the caller's already-read vault.yesterdayReviewStatus() result (or null
// if that read failed — see runGuard/syncGuardFromNote for why null means
// "skip this check" rather than "yesterday failed review").
export function evaluateGuard(config, noteExists, tasks, isRestDayToday, yesterdayStatus, now = new Date()) {
  const reasons = []
  let overdueTasks = []

  if (config.guardRespectsRestDay && isRestDayToday) {
    return { blocking: false, reasons: [], overdueTasks: [], noteId: vault.dateId(now), yesterdayNoteId: null }
  }

  if (config.blockOnMissingDailyNote && !noteExists) {
    reasons.push("no-daily-note")
  }

  if (config.blockOnOverdueTask && noteExists) {
    overdueTasks = tasks.filter((t) => vault.isTaskOverdue(t, now))
    if (overdueTasks.length > 0) reasons.push("overdue-tasks")
  }

  if (config.blockOnIncompleteReview && yesterdayStatus && (yesterdayStatus.missing || !yesterdayStatus.filled)) {
    reasons.push("incomplete-review")
  }

  return {
    blocking: reasons.length > 0,
    reasons,
    overdueTasks: overdueTasks.map((t) => ({ text: t.text, time: t.time, tags: t.tags })),
    noteId: vault.dateId(now),
    yesterdayNoteId: yesterdayStatus ? yesterdayStatus.id : null,
  }
}

// --- Rule sync ------------------------------------------------------------

// Normalizes whatever the user typed in Settings into a bare registrable
// hostname, which is the only shape DNR's requestDomains accepts: no
// scheme, no path, no port, no leading "www." (dropping it is what makes a
// pasted "www.youtube.com" behave the same as a typed "youtube.com", since
// requestDomains already covers subdomains of what it is given).
export function normalizeSite(raw) {
  let s = String(raw || "").trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme
  s = s.split("/")[0] // path
  s = s.split("?")[0]
  s = s.split("#")[0]
  s = s.split("@").pop() // userinfo, if someone pastes a full URL
  s = s.split(":")[0] // port
  s = s.replace(/^www\./, "")
  s = s.replace(/\.+$/, "") // trailing dot on a fully-qualified name
  if (!s || !/^[a-z0-9.-]+$/.test(s) || !s.includes(".")) return null
  return s
}

export function normalizeSites(list) {
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const site = normalizeSite(raw)
    if (site) seen.add(site)
  }
  return [...seen]
}

// --- Context bridge ---------------------------------------------------------
// chrome.declarativeNetRequest and chrome.tabs are NOT part of the limited
// API slice an offscreen document receives, and this module is imported by
// both the offscreen tick and by real extension pages (newtab, popup,
// options, blocked). Rather than split the module in two, the two functions
// that actually touch those APIs check here first: a context that has them
// enforces directly, and the offscreen document hands the work to the
// service worker, which does have them.
//
// This is the same defect chrome.notifications had — see background.js. Its
// symptom here was quieter and so easier to miss: the guard still worked,
// because newtab/popup/options all call these directly, so blocking only
// ever lagged until the next time the widget was opened. The 5-minute
// background tick had never once applied a rule.
export const GUARD_APPLY_MESSAGE = "obsidian-widget:guard-apply"
export const DEEP_WORK_APPLY_MESSAGE = "obsidian-widget:deep-work-apply"

function canEnforce() {
  return Boolean(
    typeof chrome !== "undefined" &&
      chrome.declarativeNetRequest &&
      typeof chrome.declarativeNetRequest.updateDynamicRules === "function" &&
      chrome.tabs &&
      typeof chrome.tabs.query === "function"
  )
}

async function delegateToWorker(type, config, state) {
  try {
    const result = await chrome.runtime.sendMessage({ type, config, state })
    return Boolean(result && result.active)
  } catch (e) {
    // Fail open, per this file's standing rule: if the worker can't be
    // reached there is no way to enforce, and silently believing we did
    // would be worse than not blocking.
    return false
  }
}

async function removeRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: GUARD_RULE_IDS })
}

async function installRule(sites) {
  // removeRuleIds runs before addRules within one call, so passing both is
  // the documented way to replace a rule atomically — there is no window
  // where the old rule is gone and the new one is not in yet.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: GUARD_RULE_IDS,
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
        condition: { requestDomains: sites, resourceTypes: ["main_frame"] },
      },
    ],
  })
}

function hostnameMatchesAny(hostname, sites) {
  return sites.some((site) => hostname === site || hostname.endsWith(`.${site}`))
}

// DNR's redirect rule only intercepts *new* navigations — a tab already
// sitting on youtube.com before the guard activated keeps loading fine
// forever, since nothing about an already-committed page re-runs the rule.
// This closes that gap by finding open tabs matching `matches(hostname)`
// directly and sending them to blocked.html too. Runs on every active tick
// (cheap: one chrome.tabs.query), so a tab opened in the moment between two
// ticks still gets caught rather than only tabs that existed at the instant
// blocking started. Shared by both guards below — the site-blocklist guard
// passes "is this hostname in blockedSites", the deep-work guard passes "is
// this hostname NOT in the allowlist".
//
// Restricted to http(s) tabs: chrome://, chrome-extension:// (which
// includes this extension's own newtab/popup/options/blocked pages),
// vivaldi://, and file:// are never candidates — the deep-work guard's
// "block everything except an allowlist" condition would otherwise happily
// try to redirect the browser's own settings pages or this widget's own New
// Tab override, which "block distracting websites" was never meant to
// cover.
async function redirectMatchingTabs(matches) {
  const blockedUrl = chrome.runtime.getURL("blocked.html")
  let tabs
  try {
    tabs = await chrome.tabs.query({})
  } catch (e) {
    return
  }
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl
    if (!url) continue
    let parsed
    try {
      parsed = new URL(url)
    } catch (e) {
      continue
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue
    const hostname = parsed.hostname.replace(/^www\./, "")
    if (!hostname) continue
    if (matches(hostname)) {
      chrome.tabs.update(tab.id, { url: blockedUrl }).catch(() => {})
    }
  }
}

// Applies a state produced by evaluateGuard: installs the block rule when
// blocking, removes it otherwise, and records the state for blocked.html.
// Safe to call on every tick — replacing the rule with an identical one is
// invisible to the user, and the writes are cheap.
export async function applyGuardState(config, state) {
  if (!canEnforce()) return delegateToWorker(GUARD_APPLY_MESSAGE, config, state)
  const sites = normalizeSites(config.blockedSites)
  const active = Boolean(state.blocking) && sites.length > 0 && !(await getSnoozeUntil())

  if (active) {
    await installRule(sites)
    await redirectMatchingTabs((hostname) => hostnameMatchesAny(hostname, sites))
  } else {
    await removeRule()
  }
  await writeGuardState({ ...state, active, sites, updatedAt: Date.now() })
  return active
}

// --- Deep-work guard --------------------------------------------------------
// A stricter sibling of the guard above, keyed off the vault's own #tdeep
// tag rather than a fixed condition list: while a #tdeep-tagged task's own
// time block is the one running right now, block every site EXCEPT
// deepWorkAllowlist instead of just blockedSites. This is the vault's own
// ADHD-toolkit if-then plan ("off-task tab during deep work → close it,
// without negotiating") implemented literally rather than left as something
// to remember to do by hand.
//
// Same fail-open posture as the site guard, plus one more: it also refuses
// to activate on an empty allowlist (see applyDeepWorkState) — an empty
// list would otherwise mean "block the entire web", which is exactly the
// kind of surprise this repo's fail-open philosophy exists to prevent.

// True while `now` falls inside a not-done #tdeep task's own time block.
// `task` is that task (for blocked.html to name), or null when nothing
// currently qualifies.
export function evaluateDeepWork(tasks, now = new Date()) {
  const task = tasks.find((t) => !t.done && t.tags.includes("tdeep") && vault.isTaskActiveNow(t, now))
  return { active: Boolean(task), task: task ? { text: task.text, time: task.time } : null }
}

async function removeExcludeRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: DEEP_WORK_RULE_IDS })
}

async function installExcludeRule(allowlist) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: DEEP_WORK_RULE_IDS,
    addRules: [
      {
        id: DEEP_WORK_RULE_ID,
        priority: 1,
        action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
        // No requestDomains here, on purpose: omitting it (unlike the site
        // guard's rule, which sets it) means "match every domain", and
        // excludedRequestDomains then subtracts the allowlist back out —
        // together that's "block everything except these".
        condition: { excludedRequestDomains: allowlist, resourceTypes: ["main_frame"] },
      },
    ],
  })
}

// Same role as applyGuardState, for the deep-work rule.
export async function applyDeepWorkState(config, state) {
  if (!canEnforce()) return delegateToWorker(DEEP_WORK_APPLY_MESSAGE, config, state)
  const allowlist = normalizeSites(config.deepWorkAllowlist)
  const active = Boolean(state.active) && allowlist.length > 0 && !(await getSnoozeUntil())

  if (active) {
    await installExcludeRule(allowlist)
    await redirectMatchingTabs((hostname) => !hostnameMatchesAny(hostname, allowlist))
  } else {
    await removeExcludeRule()
  }
  await writeDeepWorkState({ ...state, active, allowlist, updatedAt: Date.now() })
  return active
}

// For callers that already have today's parsed tasks — mirrors
// syncGuardFromNote's role for the site guard, and is always called
// alongside it (see syncGuardFromNote/runGuard below) so the two guards
// never fall out of sync with each other.
async function syncDeepWorkGuard(config, tasks) {
  if (!config.deepWorkGuardEnabled) {
    return applyDeepWorkState(config, EMPTY_DEEP_WORK_STATE)
  }
  return applyDeepWorkState(config, evaluateDeepWork(tasks))
}

// For callers that have *already* read today's note — the offscreen tick and
// the widget pages both do, to render/nag — so the guard rides along on
// their read instead of hitting the disk a second time. Handles the
// enabled check itself so callers do not each have to remember it. Also
// drives the deep-work guard off the same `tasks`, so callers only have to
// remember to call this one function to keep both in sync.
// `yesterdayStatus` is the caller's already-read vault.yesterdayReviewStatus()
// result, or null if that read isn't available/failed — see evaluateGuard.
export async function syncGuardFromNote(config, noteExists, tasks, isRestDayToday, yesterdayStatus = null) {
  const siteActive = config.distractionGuardEnabled
    ? await applyGuardState(config, evaluateGuard(config, noteExists, tasks, isRestDayToday, yesterdayStatus))
    : await applyGuardState(config, EMPTY_GUARD_STATE)
  await syncDeepWorkGuard(config, tasks)
  return siteActive
}

// Full evaluate-and-apply for callers that hold a vault handle but have not
// read today's note yet (the block page's re-check button). Returns whether
// the site-blocklist guard is now active; also syncs the deep-work guard.
//
// Note the two distinct "give up and unblock" exits below: a lapsed
// permission and an unreadable vault. Both are the fail-open rule above —
// neither is an error worth surfacing here, because the widget pages
// already show the user a "Connect vault folder" prompt for the first and
// an error line for the second. Both exits release *both* rules regardless
// of which guards are enabled — an unreadable vault must never leave either
// one stuck on, and the deep-work rule is the more dangerous of the two to
// leave stale (see its section above).
export async function runGuard(config, vaultHandle, status = "granted") {
  if (status !== "granted" || !vaultHandle) {
    await applyDeepWorkState(config, EMPTY_DEEP_WORK_STATE)
    return applyGuardState(config, EMPTY_GUARD_STATE)
  }

  let note = null
  let tasks = []
  let isRestDayToday = false
  let yesterdayStatus = null
  try {
    note = await vault.readNote(vaultHandle, config, vault.todayId())
    if (note !== null) {
      tasks = vault.parseTasks(note, config)
      isRestDayToday = vault.isRestDay(vault.parseFrontmatter(note), config)
    }
    yesterdayStatus = await vault.yesterdayReviewStatus(vaultHandle, config)
  } catch (e) {
    await applyDeepWorkState(config, EMPTY_DEEP_WORK_STATE)
    return applyGuardState(config, EMPTY_GUARD_STATE)
  }

  const siteActive = config.distractionGuardEnabled
    ? await applyGuardState(config, evaluateGuard(config, note !== null, tasks, isRestDayToday, yesterdayStatus))
    : await applyGuardState(config, EMPTY_GUARD_STATE)
  await syncDeepWorkGuard(config, tasks)
  return siteActive
}
