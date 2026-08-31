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

import * as vault from "./vault.js"

// Reserved dynamic-rule ID. Kept in a constant (and as a single-element
// list) so a future second guard rule can be added without hunting for
// every place the ID is assumed.
const RULE_ID = 1001
const GUARD_RULE_IDS = [RULE_ID]

const STATE_KEY = "guard.state"
const SNOOZE_KEY = "guard.snoozeUntil"

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
  return result[STATE_KEY] || { blocking: false, reasons: [], overdueTasks: [], noteId: null }
}

async function writeGuardState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state })
}

// --- Evaluation -----------------------------------------------------------

// Decides whether today is in a blocking state, given already-read tasks.
// Split out from runGuard so the widget pages — which have just read the
// vault to render themselves — can reuse their read instead of paying for a
// second one. `noteExists` is false when today has no daily note at all
// (vault.readNote returning null); the note's actual text is never needed
// here, only its tasks, which the caller has already parsed.
export function evaluateGuard(config, noteExists, tasks, isRestDayToday, now = new Date()) {
  const reasons = []
  let overdueTasks = []

  if (config.guardRespectsRestDay && isRestDayToday) {
    return { blocking: false, reasons: [], overdueTasks: [], noteId: vault.dateId(now) }
  }

  if (config.blockOnMissingDailyNote && !noteExists) {
    reasons.push("no-daily-note")
  }

  if (config.blockOnOverdueTask && noteExists) {
    overdueTasks = tasks.filter((t) => vault.isTaskOverdue(t, now))
    if (overdueTasks.length > 0) reasons.push("overdue-tasks")
  }

  return {
    blocking: reasons.length > 0,
    reasons,
    overdueTasks: overdueTasks.map((t) => ({ text: t.text, time: t.time, tags: t.tags })),
    noteId: vault.dateId(now),
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

// Applies a state produced by evaluateGuard: installs the block rule when
// blocking, removes it otherwise, and records the state for blocked.html.
// Safe to call on every tick — replacing the rule with an identical one is
// invisible to the user, and the writes are cheap.
export async function applyGuardState(config, state) {
  const sites = normalizeSites(config.blockedSites)
  const active = Boolean(state.blocking) && sites.length > 0 && !(await getSnoozeUntil())

  if (active) {
    await installRule(sites)
  } else {
    await removeRule()
  }
  await writeGuardState({ ...state, active, sites, updatedAt: Date.now() })
  return active
}

// For callers that have *already* read today's note — the offscreen tick and
// the widget pages both do, to render/nag — so the guard rides along on
// their read instead of hitting the disk a second time. Handles the
// enabled check itself so callers do not each have to remember it.
export async function syncGuardFromNote(config, noteExists, tasks, isRestDayToday) {
  if (!config.distractionGuardEnabled) {
    return applyGuardState(config, { blocking: false, reasons: [], overdueTasks: [], noteId: null })
  }
  return applyGuardState(config, evaluateGuard(config, noteExists, tasks, isRestDayToday))
}

// Full evaluate-and-apply for callers that hold a vault handle but have not
// read today's note yet (the block page's re-check button). Returns whether
// the block is now active.
//
// Note the two distinct "give up and unblock" exits below: a lapsed
// permission and an unreadable vault. Both are the fail-open rule above —
// neither is an error worth surfacing here, because the widget pages
// already show the user a "Connect vault folder" prompt for the first and
// an error line for the second.
export async function runGuard(config, vaultHandle, status = "granted") {
  if (!config.distractionGuardEnabled || status !== "granted" || !vaultHandle) {
    return applyGuardState(config, { blocking: false, reasons: [], overdueTasks: [], noteId: null })
  }

  let note = null
  let tasks = []
  let isRestDayToday = false
  try {
    note = await vault.readNote(vaultHandle, config, vault.todayId())
    if (note !== null) {
      tasks = vault.parseTasks(note, config)
      isRestDayToday = vault.isRestDay(vault.parseFrontmatter(note), config)
    }
  } catch (e) {
    return applyGuardState(config, { blocking: false, reasons: [], overdueTasks: [], noteId: null })
  }

  return applyGuardState(config, evaluateGuard(config, note !== null, tasks, isRestDayToday))
}
