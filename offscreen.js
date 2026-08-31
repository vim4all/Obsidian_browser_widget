// The offscreen document is where the actual vault-reading + nag-firing
// work happens — it's the one context reachable from background.js's alarm
// tick that also has a DOM, which File System Access API calls need. It's
// also, deliberately, where chrome.notifications.onClicked is handled: MV3
// service workers get terminated after ~30s idle and only wake back up for
// events they registered a listener for at the top level, which works fine
// for chrome.alarms.onAlarm, but chrome.offscreen documents are simpler to
// reason about here since they aren't torn down on the same idle timer —
// keeping the click handler in the same place that creates the
// notifications (both here) avoids having to hand off "which context owns
// this notification's target URL" across the background/offscreen split.
//
// vault.js / store.js / notifications.js are the same modules newtab.js and
// popup.js import — the only thing specific to this file is the tick loop
// and the notification-click plumbing.

import { loadConfig } from "./src/config.js"
import { checkVaultAccess } from "./src/vaultAccess.js"
import * as vault from "./src/vault.js"
import { runNotifiers, consumeNotificationTarget } from "./src/notifications.js"
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
  try {
    note = await vault.readNote(handle, config, vault.todayId())
    if (note !== null) {
      tasks = vault.parseTasks(note, config)
      isRestDayToday = vault.isRestDay(vault.parseFrontmatter(note), config)
    }
  } catch (e) {
    // Same reasoning as above: nags can just skip a tick on stale data, but
    // the guard's rule outlives the tick, so it has to be released.
    await runGuard(config, null, "no-handle")
    return
  }

  await syncGuardFromNote(config, note !== null, tasks, isRestDayToday)
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

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const url = await consumeNotificationTarget(notificationId)
  if (url) chrome.tabs.create({ url })
  chrome.notifications.clear(notificationId)
})

// A notification dismissed without being clicked still leaves its target
// URL in storage; clean it up either way so it doesn't accumulate.
chrome.notifications.onClosed.addListener((notificationId) => {
  consumeNotificationTarget(notificationId)
})
