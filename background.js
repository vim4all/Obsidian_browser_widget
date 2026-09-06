// Service worker: the thinnest possible layer. Manifest V3 service workers
// have no DOM, and therefore no File System Access API — they can't read
// the vault at all. All they own is chrome.alarms (a durable timer that
// survives the worker being terminated and restarted) and the offscreen
// document's lifecycle. Every alarm tick just makes sure the offscreen
// document exists, then relays the tick to it; offscreen.js does the actual
// vault read and decides which nags are due.
//
// It also owns chrome.notifications — creating them, and handling clicks —
// because the offscreen document cannot: offscreen documents are granted
// only a limited slice of the extension APIs, and that isn't one of them.
// offscreen.js sends a NOTIFY_MESSAGE and this file makes the call.
//
// This plays the same "orchestration" role ../obsidian_windows_widget's
// src/main.js does, minus the file-watcher fast path (chokidar has no
// browser-extension equivalent — there's no way for an extension to watch
// an arbitrary local folder for changes) and minus the tray/window
// management (there's no window to manage; newtab.html and popup.html are
// plain pages the browser opens on its own).

import { loadConfig, onConfigChanged } from "./src/config.js"
import { NOTIFY_MESSAGE, consumeNotificationTarget } from "./src/notifications.js"
import {
  GUARD_APPLY_MESSAGE,
  DEEP_WORK_APPLY_MESSAGE,
  applyGuardState,
  applyDeepWorkState,
} from "./src/distractionGuard.js"

const TEST_NOTIFICATION_MESSAGE = "obsidian-widget:test-notification"

// Creating the notification lives here, not in the offscreen document that
// decides to send it. Offscreen documents get only a limited slice of the
// extension API surface and chrome.notifications is not part of it, so the
// old arrangement — offscreen.js calling chrome.notifications.create()
// directly — threw on every single nag and had the error swallowed by
// runNotifiers' catch. The service worker is the context that actually owns
// this API; offscreen.js now messages it instead (see sendNotification in
// src/notifications.js).
async function createNotification({ id, title, message, priority }) {
  return chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title,
    message,
    priority: priority || 0,
  })
}

const ALARM_NAME = "obsidian-widget-tick"
const OFFSCREEN_URL = "offscreen.html"

async function ensureOffscreenDocument() {
  const has = await chrome.offscreen.hasDocument()
  if (has) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["LOCAL_STORAGE"],
    justification:
      "Reads the FileSystemDirectoryHandle stored in IndexedDB to check today's Obsidian daily note and fire nag notifications; only a document context (not the service worker) has File System Access API support.",
  })
}

async function scheduleAlarm() {
  const config = await loadConfig()
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: config.tickIntervalMinutes })
}

async function tick() {
  await ensureOffscreenDocument()
  // Broadcasts to every extension page listening, including the offscreen
  // document — offscreen pages receive chrome.runtime messages like any
  // other extension page.
  chrome.runtime.sendMessage({ type: "obsidian-widget:tick" }).catch(() => {
    // No listener ready yet (offscreen doc just spun up) — the next tick
    // will pick it up. Never worth surfacing as an error.
  })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) tick()
})

// Both message types must answer asynchronously, hence `return true` — the
// sender (offscreen.js, or options.html's test button) waits on the result
// so a failure to create surfaces at the caller instead of vanishing.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return

  if (message.type === NOTIFY_MESSAGE) {
    createNotification(message)
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    return true
  }

  // Rule enforcement delegated from the offscreen document, which has
  // neither chrome.declarativeNetRequest nor chrome.tabs. Calling back into
  // the same functions is safe and doesn't loop: their canEnforce() check
  // passes here, so they act directly instead of delegating again.
  if (message.type === GUARD_APPLY_MESSAGE) {
    applyGuardState(message.config, message.state)
      .then((active) => sendResponse({ active }))
      .catch(() => sendResponse({ active: false }))
    return true
  }

  if (message.type === DEEP_WORK_APPLY_MESSAGE) {
    applyDeepWorkState(message.config, message.state)
      .then((active) => sendResponse({ active }))
      .catch(() => sendResponse({ active: false }))
    return true
  }

  if (message.type === TEST_NOTIFICATION_MESSAGE) {
    createNotification({
      id: `obsidian-widget-test-${Date.now()}`,
      title: "Obsidian Daily Widget",
      message: "Test notification — if you can see this, notifications work.",
      priority: 2,
    })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    return true
  }
})

// Moved here from offscreen.js along with the create() call above: an
// offscreen document can't register these either. Target URLs are persisted
// in chrome.storage by notifications.js rather than held in memory, so a
// click still resolves after the service worker has been terminated and
// restarted — which it will have been, since notifications outlive the ~30s
// idle timeout by a wide margin.
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

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm()
  ensureOffscreenDocument()
})

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarm()
  // Creating the offscreen document is enough — offscreen.js runs its own
  // tick as soon as it loads (see the bottom of that file), so calling
  // tick() here too would just fire a redundant, harmless-but-wasteful
  // second tick via the runtime message broadcast.
  ensureOffscreenDocument()
})

// Re-creates the alarm at the new period if tickIntervalMinutes changes via
// options.html — the same "hot-reload, no restart" behavior config.js's
// watchConfig gives the Windows app.
onConfigChanged(() => {
  scheduleAlarm()
})
