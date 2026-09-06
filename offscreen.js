// The offscreen document is where vault reading happens — it's the one
// context reachable from background.js's alarm tick that also has a DOM,
// which File System Access API calls need.
//
// What it is NOT is a general-purpose extension page. An offscreen document
// gets only a limited slice of the chrome.* APIs; chrome.notifications is
// not part of that slice. An earlier version of this file created
// notifications and registered chrome.notifications.onClicked here, and
// both failed — silently, because runNotifiers' catch swallowed the
// TypeError — so no nag ever fired. Anything needing an API beyond reading
// the vault now goes to the service worker by message; see sendNotification
// in src/notifications.js and the onMessage handler in background.js.
//
// vault.js / store.js / notifications.js are the same modules newtab.js and
// popup.js import — the only thing specific to this file is the tick loop.

import { loadConfig } from "./src/config.js"
import { checkVaultAccess } from "./src/vaultAccess.js"
import * as vault from "./src/vault.js"
import { runNotifiers } from "./src/notifications.js"
import { runGuard, syncGuardFromNote } from "./src/distractionGuard.js"

async function runTick() {
  const config = await loadConfig()

  const { status, handle } = await checkVaultAccess()
  if (status !== "granted") {
    // Permission lapsed (browser restart, revoked, or never granted). There
    // is no way to re-prompt from here — no window, no user gesture — so
    // this tick just does nothing until the user reconnects via newtab.html
    // or popup.html. Same "widget shows a setup hint, doesn't crash" stance
    // as the Windows app takes on an invalid vaultPath.
    //
    // The guard is the one thing that still has to run: it holds a
    // *persistent* DNR rule, so unlike a notification (which simply doesn't
    // fire) a stale block would keep blocking sites indefinitely with the
    // vault unreadable and no way for the user to clear it. runGuard's
    // fail-open path drops the rule.
    await runGuard(config, null, status)
    return
  }

  let note = null
  let tasks = []
  let isRestDayToday = false
  let yesterdayStatus = null
  try {
    note = await vault.readNote(handle, config, vault.todayId())
    if (note !== null) {
      tasks = vault.parseTasks(note, config)
      isRestDayToday = vault.isRestDay(vault.parseFrontmatter(note), config)
    }
    yesterdayStatus = await vault.yesterdayReviewStatus(handle, config)
  } catch (e) {
    // Same reasoning as above: nags can just skip a tick on stale data, but
    // the guard's rule outlives the tick, so it has to be released.
    await runGuard(config, null, "no-handle")
    return
  }

  await syncGuardFromNote(config, note !== null, tasks, isRestDayToday, yesterdayStatus)
  await runNotifiers(config, handle, tasks, isRestDayToday)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "obsidian-widget:tick") {
    runTick()
  }
})

// A tick as soon as this document spins up, rather than waiting for the
// next alarm — mirrors the Windows app's main.js firing tick() immediately
// on startup instead of waiting a full schedulerIntervalSeconds.
runTick()

// The chrome.notifications listeners that used to live here have moved to
// background.js. They never worked from this context: an offscreen document
// is given only a limited slice of the extension APIs, and
// chrome.notifications isn't in it, so registering them here threw at module
// evaluation and creating notifications threw on every tick. This file now
// only *decides* to notify; the service worker does the notifying.
