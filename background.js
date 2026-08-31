// Service worker: the thinnest possible layer. Manifest V3 service workers
// have no DOM, and therefore no File System Access API — they can't read
// the vault at all. All they own is chrome.alarms (a durable timer that
// survives the worker being terminated and restarted) and the offscreen
// document's lifecycle. Every alarm tick just makes sure the offscreen
// document exists, then relays the tick to it; offscreen.js does the actual
// vault read + notifier logic (see the comment there for why it also owns
// chrome.notifications instead of this file).
//
// This plays the same "orchestration" role ../obsidian_windows_widget's
// src/main.js does, minus the file-watcher fast path (chokidar has no
// browser-extension equivalent — there's no way for an extension to watch
// an arbitrary local folder for changes) and minus the tray/window
// management (there's no window to manage; newtab.html and popup.html are
// plain pages the browser opens on its own).

import { loadConfig, onConfigChanged } from "./src/config.js"

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
