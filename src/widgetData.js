// Assembles the data the widget UI renders — the same role
// ../obsidian_windows_widget/src/main.js's buildRenderData() plays there.
// Shared between newtab.js and popup.js (both need the identical task
// list + heatmap), so the rendering logic in shared/render.js only has to
// be written once.

import * as vault from "./vault.js"

export async function buildWidgetData(config, vaultHandle) {
  if (!vaultHandle) {
    return { vaultConfigured: false, tasks: [], week: [] }
  }

  let tasks = []
  let isRestDayToday = false
  let error = null
  // Distinct from `error`: "the note is missing" is a specific, actionable
  // state the distraction guard keys on, whereas `error` is a display
  // string that also covers unreadable-vault failures. Null means the read
  // never got far enough to tell.
  let noteExists = null

  try {
    const note = await vault.readNote(vaultHandle, config, vault.todayId())
    noteExists = note !== null
    if (note === null) {
      error = "No daily note for today."
    } else {
      tasks = vault.parseTasks(note, config).map((t) => ({ ...t, overdue: vault.isTaskOverdue(t) }))
      isRestDayToday = vault.isRestDay(vault.parseFrontmatter(note), config)
    }
  } catch (e) {
    error = String((e && e.message) || e)
  }

  let week = []
  try {
    week = (await vault.buildWeekHabitData(vaultHandle, config)).map((d) => ({ completion: d.completion }))
  } catch (e) {
    week = []
  }

  // Read alongside (not gated on) today's note above: the distraction guard
  // needs it regardless of whether today's read succeeded, and null here
  // means "skip that check" (fail open), not "yesterday failed review".
  let yesterdayStatus = null
  try {
    yesterdayStatus = await vault.yesterdayReviewStatus(vaultHandle, config)
  } catch (e) {
    yesterdayStatus = null
  }

  // A read-only glance at past days' leftover open tasks — not a nag, just
  // a number next to the list (see shared/render.js). Own try/catch, same
  // reasoning as week/yesterdayStatus above: a failure here shouldn't cost
  // the user today's task list.
  let stranded = null
  try {
    stranded = await vault.countStrandedTasks(vaultHandle, config, config.strandedLookbackDays)
  } catch (e) {
    stranded = null
  }

  return {
    vaultConfigured: true,
    error,
    noteExists,
    tasks,
    isRestDayToday,
    yesterdayStatus,
    stranded,
    triageURL: config.triageNotePath ? vault.obsidianFileURL(config, config.triageNotePath) : null,
    week,
    tagColors: config.tagColors,
    defaultTagColor: config.defaultTagColor,
    overdueTaskStyle: config.overdueTaskStyle,
    overdueColor: config.overdueColor,
  }
}
