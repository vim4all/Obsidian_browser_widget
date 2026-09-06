// The reminder/nag system, ported from ../obsidian_windows_widget's
// src/notifications.js (itself ported from the eight `notifiers` in the iOS
// Scriptable script). Hour windows, per-notifier rate limits, and
// catchUpWindowHours tolerance are all kept exactly as-is — this module
// lives in the offscreen document (see offscreen.js), woken by a
// chrome.alarms tick relayed from background.js, so like the Windows app
// (and unlike the throttled iOS widget refresh) an exact-hour check would
// mostly work, but the tolerance stays because the machine can still sleep
// through a tick, or the browser can be closed and reopened later.
//
// Runs entirely inside the offscreen document (see offscreen.html/js),
// which is the only context here with both DOM access (for
// chrome.notifications, which any extension page can call) and a stable
// enough lifetime to own the chrome.notifications.onClicked listener — see
// the comment at the bottom of offscreen.js for why that split exists.

import * as vault from "./vault.js"
import * as store from "./store.js"

const REMINDER_MESSAGES = [
  "Stay off the reels — future you will thank you.",
  "Quick check: is what you're doing right now moving the needle?",
  "Close the distraction. Open the task list.",
  "30 focused minutes beat 30 scrolled ones.",
  "Still here? Good. Back to the plan.",
]

const PLANNING_NAG_MESSAGES = [
  "Tomorrow doesn't plan itself. Go write it. NOW.",
  "Still no plan for tomorrow. This will keep buzzing until you fix it.",
  "You know exactly what to do. Open the vault.",
  "No tasks, no tomorrow. This is your problem right now.",
  "Every ten minutes until tomorrow has a plan. Your call how long that takes.",
]

const UNDONE_NAG_MESSAGES = [
  "The day isn't over and neither is your list.",
  "Unchecked boxes don't check themselves.",
  "This keeps buzzing every ten minutes until these are done.",
  "Still open. Still yours. Go.",
]

// notificationId -> openURL, persisted (not just in-memory) so a click still
// resolves correctly even if the offscreen document was torn down and
// recreated between the notification firing and the user clicking it.
// Self-cleans: cleared the moment a notification is clicked or dismissed.
const TARGET_PREFIX = "notifTarget."

async function rememberTarget(notificationId, url) {
  await chrome.storage.local.set({ [TARGET_PREFIX + notificationId]: url })
}

export async function consumeNotificationTarget(notificationId) {
  const key = TARGET_PREFIX + notificationId
  const result = await chrome.storage.local.get(key)
  await chrome.storage.local.remove(key)
  return result[key] || null
}

let notificationCounter = 0
function nextNotificationId(tag) {
  notificationCounter += 1
  return `${tag}-${Date.now()}-${notificationCounter}`
}

// Chrome/Vivaldi's notifications API has no per-notification custom sound —
// the same platform gap the Windows app hit with iOS's "alarm" sound, minus
// even the system-beep fallback Electron's `shell.beep()` gave it (there's
// no beep primitive available to an extension). The harsher nags rely on
// `priority: 2` alone to stand out.
async function sendNotification(title, body, options = {}) {
  const id = nextNotificationId(options.tag || "obsidian-widget")
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title,
    message: body,
    priority: options.urgent ? 2 : 0,
  })
  if (options.openURL) await rememberTarget(id, options.openURL)
}

function hashString(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

function focusReminderMessage(tasks) {
  const base = REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)]
  const pending = tasks.filter((t) => !t.done)
  if (pending.length === 0) return base
  const priority = pending.find((t) => t.tags.includes("timp")) || pending[0]
  return `${base}\nNext up: ${priority.text}`
}

// Nags harder the more important work is still open; goes quiet once
// everything's done instead of pestering for the rest of the day.
function computeReminderInterval(config, tasks) {
  const pending = tasks.filter((t) => !t.done)
  if (pending.length === 0) return Infinity
  const importantPending = pending.filter((t) => t.tags.includes("timp")).length
  if (importantPending >= 2) return Math.max(10, config.reminderIntervalMinutes / 2)
  if (importantPending === 1) return Math.max(15, (config.reminderIntervalMinutes * 2) / 3)
  return config.reminderIntervalMinutes
}

async function maybeSendFocusReminder(config, tasks, isRestDayToday) {
  if (!config.remindersEnabled || isRestDayToday) return
  const now = new Date()
  if (!config.workDays.includes(now.getDay())) return
  if (now.getHours() < config.workStartHour || now.getHours() >= config.workEndHour) return

  const interval = computeReminderInterval(config, tasks)
  if (!Number.isFinite(interval)) return

  const elapsedMin = (Date.now() - (await store.getTimestamp("lastFocusReminder"))) / 60000
  if (elapsedMin < interval) return

  await sendNotification("Stick to the plan", focusReminderMessage(tasks), {
    openURL: vault.obsidianNoteURL(config, vault.todayId()),
  })
  await store.setTimestamp("lastFocusReminder", Date.now())
}

async function maybeSendMorningKickoff(config, tasks, isRestDayToday) {
  if (isRestDayToday) return
  const now = new Date()
  if (
    now.getHours() < config.morningKickoffHour ||
    now.getHours() >= config.morningKickoffHour + config.catchUpWindowHours
  )
    return
  const today = vault.todayId()
  if (await store.dateEquals("lastMorningDate", today)) return

  const pending = tasks.filter((t) => !t.done)
  if (pending.length === 0) return
  const top = pending.find((t) => t.tags.includes("timp")) || pending[0]

  await sendNotification("First move", `Start here: ${top.text}`, {
    openURL: vault.obsidianNoteURL(config, today),
  })
  await store.setDate("lastMorningDate", today)
}

async function maybeSendEveningSummary(config, tasks, isRestDayToday) {
  if (isRestDayToday) return
  const now = new Date()
  if (
    now.getHours() < config.eveningSummaryHour ||
    now.getHours() >= config.eveningSummaryHour + config.catchUpWindowHours
  )
    return
  const today = vault.todayId()
  if (await store.dateEquals("lastEveningDate", today)) return
  if (tasks.length === 0) return

  const done = tasks.filter((t) => t.done).length
  const pending = tasks.filter((t) => !t.done)
  const pendingImportant = pending.filter((t) => t.tags.includes("timp"))

  let body = `${done}/${tasks.length} tasks done today.`
  if (pendingImportant.length > 0) {
    body += ` Still open: ${pendingImportant.map((t) => t.text).join(", ")}`
  } else if (pending.length > 0) {
    body += ` ${pending.length} minor task(s) left.`
  } else {
    body += " Everything's closed out — nice."
  }

  await sendNotification("Day wrap-up", body, { openURL: vault.obsidianNoteURL(config, today) })
  await store.setDate("lastEveningDate", today)
}

async function maybeSendPlanningNag(config, vaultHandle) {
  const now = new Date()
  if (now.getHours() < config.planningNagHour) return

  let status
  try {
    status = await vault.tomorrowPlanStatus(vaultHandle, config)
  } catch (e) {
    return // can't reach the vault right now — don't nag about something unverifiable
  }
  if (status.restDay || !status.missing) return

  const elapsedMin = (Date.now() - (await store.getTimestamp("lastPlanningNag"))) / 60000
  if (elapsedMin < config.planningNagIntervalMinutes) return

  const message = PLANNING_NAG_MESSAGES[Math.floor(Math.random() * PLANNING_NAG_MESSAGES.length)]
  await sendNotification("⚠️ No plan for tomorrow", message, {
    urgent: true,
    openURL: vault.obsidianNoteURL(config, status.id),
  })
  await store.setTimestamp("lastPlanningNag", Date.now())
}

async function maybeSendUndoneTasksNag(config, tasks, isRestDayToday) {
  if (isRestDayToday) return
  const now = new Date()
  if (now.getHours() < config.undoneNagHour) return

  const pending = tasks.filter((t) => !t.done)
  if (pending.length === 0) return

  const elapsedMin = (Date.now() - (await store.getTimestamp("lastUndoneNag"))) / 60000
  if (elapsedMin < config.undoneNagIntervalMinutes) return

  const base = UNDONE_NAG_MESSAGES[Math.floor(Math.random() * UNDONE_NAG_MESSAGES.length)]
  const listed = pending.slice(0, 3).map((t) => t.text)
  const more = pending.length > listed.length ? ` (+${pending.length - listed.length} more)` : ""
  const title = `⚠️ ${pending.length} task${pending.length === 1 ? "" : "s"} still undone`

  await sendNotification(title, `${base}\n${listed.join(", ")}${more}`, {
    urgent: true,
    openURL: vault.obsidianNoteURL(config, vault.todayId()),
  })
  await store.setTimestamp("lastUndoneNag", Date.now())
}

// Fires when a task's own scheduled time range starts, and again if it ends
// with the task still unchecked. Dedup key is a hash of time+text so it
// resets naturally when tomorrow's note reuses the same time slot with
// different (or no) text.
async function maybeSendTimeBlockNudges(config, tasks, isRestDayToday) {
  if (!config.timeBlockNudgesEnabled || isRestDayToday) return
  const now = new Date()
  const today = vault.todayId()
  const catchUpMs = config.timeBlockCatchUpMinutes * 60000
  const noteURL = vault.obsidianNoteURL(config, today)

  for (const task of tasks) {
    if (!task.time) continue
    const range = vault.parseTimeRange(task.time)
    if (!range) continue

    const id = hashString(`${task.time}|${task.text}`)
    const startKey = `blockStart.${id}`
    const endKey = `blockEnd.${id}`

    const startDue = now >= range.start && now.getTime() < range.start.getTime() + catchUpMs
    if (startDue && !(await store.dateEquals(startKey, today))) {
      await sendNotification("Block starting", task.text, { openURL: noteURL })
      await store.setDate(startKey, today)
    }

    if (!task.done) {
      const endDue = now >= range.end && now.getTime() < range.end.getTime() + catchUpMs
      if (endDue && !(await store.dateEquals(endKey, today))) {
        await sendNotification("Block ended, still open", task.text, { openURL: noteURL })
        await store.setDate(endKey, today)
      }
    }
  }
}

async function maybeSendWeeklyReview(config, vaultHandle) {
  const now = new Date()
  if (now.getDay() !== config.weeklyReviewDay) return
  if (
    now.getHours() < config.weeklyReviewHour ||
    now.getHours() >= config.weeklyReviewHour + config.catchUpWindowHours
  )
    return
  const today = vault.todayId()
  if (await store.dateEquals("lastWeeklyReview", today)) return

  let weekData
  try {
    weekData = await vault.buildWeekHabitData(vaultHandle, config)
  } catch (e) {
    return // vault not reachable right now
  }

  const withData = weekData.filter((d) => d.completion && d.completion.total > 0)
  if (withData.length === 0) return

  const totalDone = withData.reduce((sum, d) => sum + d.completion.done, 0)
  const totalPossible = withData.reduce((sum, d) => sum + d.completion.total, 0)
  const pct = Math.round((totalDone / totalPossible) * 100)
  const zeroDays = withData.filter((d) => d.completion.done === 0).length

  let body = `Habits this week: ${pct}% (${totalDone}/${totalPossible}).`
  body += zeroDays > 0 ? ` ${zeroDays} day(s) at zero.` : " No zero days — keep it up."

  // Folded into this same notification rather than a new one, deliberately:
  // the vault's own weekly ritual already reviews the plan note right after
  // the daily/weekly reports (see 3_Long term planning.md's review panel),
  // so this just surfaces the two numbers that panel already computes,
  // instead of adding a ninth independently-timed nag with its own rate
  // limit to reason about.
  if (config.planReviewEnabled) {
    try {
      const plan = await vault.planStatus(vaultHandle, config)
      if (plan) {
        if (plan.staleDays !== null && plan.staleDays >= config.planReviewStaleDays) {
          body += `\nPlan last reviewed ${plan.staleDays}d ago.`
        }
        if (plan.activeCount > config.planMaxActiveProjects) {
          body += `\n${plan.activeCount} active projects (max ${config.planMaxActiveProjects}).`
        }
      }
    } catch (e) {
      // Plan note unreadable/misshapen — the habit half of this
      // notification still matters, so it still goes out without it.
    }
  }

  await sendNotification("Weekly review", body, { openURL: vault.obsidianNoteURL(config, today) })
  await store.setDate("lastWeeklyReview", today)
}

async function maybeSendStreakBreakAlert(config, vaultHandle) {
  const today = vault.todayId()
  if (await store.dateEquals("lastStreakBreakAlert", today)) return

  let yesterday, dayBefore
  try {
    yesterday = await vault.dayInfoForOffset(vaultHandle, config, 1)
    dayBefore = await vault.dayInfoForOffset(vaultHandle, config, 2)
  } catch (e) {
    return // vault not reachable right now
  }

  // A deliberate rest day is never evidence of a broken streak.
  if ((yesterday && yesterday.restDay) || (dayBefore && dayBefore.restDay)) return

  const brokenBothDays =
    yesterday &&
    dayBefore &&
    yesterday.completion &&
    dayBefore.completion &&
    yesterday.completion.total > 0 &&
    yesterday.completion.done === 0 &&
    dayBefore.completion.total > 0 &&
    dayBefore.completion.done === 0
  if (!brokenBothDays) return

  await sendNotification("Streak broken", "Habits hit zero two days running. Don't make it three.", {
    openURL: vault.obsidianNoteURL(config, today),
  })
  await store.setDate("lastStreakBreakAlert", today)
}

// Each notifier gets its own try/catch — a throw from one must never skip
// the rest for that tick (the same bug class the iOS script's comment
// warns about, and the Windows app preserves the fix for).
export async function runNotifiers(config, vaultHandle, tasks, isRestDayToday) {
  if (!config.notificationsEnabled) return
  const notifiers = [
    () => maybeSendFocusReminder(config, tasks, isRestDayToday),
    () => maybeSendMorningKickoff(config, tasks, isRestDayToday),
    () => maybeSendEveningSummary(config, tasks, isRestDayToday),
    () => maybeSendPlanningNag(config, vaultHandle),
    () => maybeSendUndoneTasksNag(config, tasks, isRestDayToday),
    () => maybeSendTimeBlockNudges(config, tasks, isRestDayToday),
    () => maybeSendWeeklyReview(config, vaultHandle),
    () => maybeSendStreakBreakAlert(config, vaultHandle),
  ]
  for (const notify of notifiers) {
    try {
      await notify()
    } catch (e) {
      // Never let one notifier's failure block the widget or its siblings.
    }
  }
}
