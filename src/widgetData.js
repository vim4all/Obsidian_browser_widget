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

  return {
    vaultConfigured: true,
    error,
    noteExists,
    tasks,
    isRestDayToday,
    week,
    tagColors: config.tagColors,
    defaultTagColor: config.defaultTagColor,
    overdueTaskStyle: config.overdueTaskStyle,
    overdueColor: config.overdueColor,
  }
}
