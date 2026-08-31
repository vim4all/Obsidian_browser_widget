// Config: replaces the `const` blocks at the top of the iOS script and the
// userData/config.json file the Windows app uses, with an object persisted
// via chrome.storage.local (the closest browser-extension equivalent of "a
// small file that survives updates and can be watched for external edits").
// Edited via options.html; chrome.storage.onChanged plays the same role
// config.js's watchConfig (Windows) / fs.watch played there — no restart
// required to pick up a change.
//
// There is no vaultPath here, unlike the Windows app's config: the vault is
// referenced by a FileSystemDirectoryHandle (see src/vaultAccess.js), which
// isn't a plain string and is persisted separately in IndexedDB rather than
// alongside these settings.

export const DEFAULTS = {
  dailyFolder: "00_Daily",
  headingPattern: "Day planner", // matched as `^#+\s*<pattern>`, case-insensitive
  restDayFrontmatterKey: "day_off",
  obsidianVaultName: "RemoteKnowledgeBase", // must match the vault's name inside Obsidian

  tagColors: {
    tstrt: "#af52de",
    twrk: "#0a84ff",
    tprj: "#ff9f0a",
    timp: "#ff453a",
    tprsn: "#30d158",
  },
  defaultTagColor: "#8e8e93",

  // --- Overdue tasks ---
  // A task counts as overdue once its own time range has ended and it's
  // still unchecked (same condition the time-block "ended, still open"
  // nudge fires on). Style: "none" | "red" | "flash".
  overdueTaskStyle: "red",
  overdueColor: "#ff453a",

  // --- Notifications master switch ---
  notificationsEnabled: true,

  // --- Focus reminders ---
  remindersEnabled: true,
  reminderIntervalMinutes: 30,
  workStartHour: 9,
  workEndHour: 18,
  workDays: [1, 2, 3, 4, 5], // 0 = Sunday

  // --- Morning kickoff / evening summary ---
  morningKickoffHour: 8,
  eveningSummaryHour: 19,
  catchUpWindowHours: 2,

  // --- Planning / undone nags ---
  planningNagHour: 22,
  planningNagIntervalMinutes: 10,
  undoneNagHour: 22,
  undoneNagIntervalMinutes: 10,

  // --- Time-block nudges ---
  timeBlockNudgesEnabled: true,
  timeBlockCatchUpMinutes: 20,

  // --- Weekly review ---
  weeklyReviewDay: 0, // Sunday
  weeklyReviewHour: 20,

  // --- Distraction guard ---
  // Blocks blockedSites while today is in a state worth interrupting. This
  // is the browser's answer to the iOS Shortcuts automation and the Windows
  // global hotkey; see src/distractionGuard.js for the mechanism and for
  // why every uncertain path fails open.
  //
  // Default OFF, unlike every other feature here. Loading an extension
  // should never silently start taking sites away — this one only starts
  // once the user has picked it in Settings.
  distractionGuardEnabled: false,
  blockedSites: [
    "youtube.com",
    "reddit.com",
    "x.com",
    "twitter.com",
    "instagram.com",
    "tiktok.com",
    "facebook.com",
    "twitch.tv",
  ],
  blockOnOverdueTask: true, // a task whose time block ended, still unchecked
  blockOnMissingDailyNote: true, // today has no YYYY-MM-DD.md at all
  guardRespectsRestDay: true, // day_off: true silences the guard like every other nag
  guardSnoozeMinutes: 5, // 0 disables the snooze button on the block page

  // --- Misc ---
  // chrome.alarms has a practical minimum period of ~1 minute; this plays
  // the role of the Windows app's schedulerIntervalSeconds. Kept coarser
  // than that 30s default since alarms are the one thing here that costs a
  // background wakeup even when nothing changed.
  tickIntervalMinutes: 5,
}

const STORAGE_KEY = "config"

function deepMerge(base, override) {
  const result = { ...base }
  for (const key of Object.keys(base)) {
    if (
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key]) &&
      typeof override[key] === "object" &&
      override[key] !== null
    ) {
      result[key] = { ...base[key], ...override[key] }
    } else if (Object.prototype.hasOwnProperty.call(override, key)) {
      result[key] = override[key]
    }
  }
  return result
}

export async function loadConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return deepMerge(DEFAULTS, stored[STORAGE_KEY] || {})
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config })
}

// Fires on any change to the stored config, from any extension page —
// options.html saving a new value, or this same function being called from
// a different tab. Callback receives the freshly-merged config, same shape
// loadConfig() returns.
export function onConfigChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      callback(deepMerge(DEFAULTS, changes[STORAGE_KEY].newValue || {}))
    }
  })
}
