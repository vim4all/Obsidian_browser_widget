// Task list + heatmap rendering, adapted from
// ../obsidian_windows_widget/renderer/renderer.js. No IPC here (there's no
// separate main/renderer process split in a browser extension) and no
// ResizeObserver-driven window resizing (browser pages just take whatever
// size their host gives them — a popup's fixed box, or the full New Tab
// page) — otherwise this is the same DOM-building logic, exported as a
// plain function so both newtab.js and popup.js can call it.

const GREEN_LEVELS = ["#9be9a8", "#40c463", "#30a14e", "#216e39"]

// els: { placeholder, tasks, more, heatmap } — the four elements every host
// page's HTML must provide (see newtab.html / popup.html).
// maxVisibleTasks: popup.html passes a smaller number than newtab.html since
// the popup has a hard height ceiling browsers impose.
export function render(els, data, maxVisibleTasks) {
  els.tasks.innerHTML = ""
  els.more.hidden = true
  els.placeholder.hidden = true

  if (data.vaultConfigured === false) {
    els.placeholder.hidden = false
    els.placeholder.textContent = "Connect your Obsidian vault to get started."
  } else if (data.error) {
    els.placeholder.hidden = false
    els.placeholder.textContent = data.error
  } else if (!data.tasks || data.tasks.length === 0) {
    els.placeholder.hidden = false
    els.placeholder.textContent = "No tasks in Day planner."
  } else {
    const ordered = [...data.tasks].sort((a, b) => Number(a.done) - Number(b.done))
    const visible = ordered.slice(0, maxVisibleTasks)
    for (const task of visible) {
      els.tasks.appendChild(renderTaskRow(task, data.tagColors, data.defaultTagColor, data.overdueTaskStyle))
    }
    if (ordered.length > maxVisibleTasks) {
      els.more.hidden = false
      els.more.textContent = `+${ordered.length - maxVisibleTasks} more`
    }
  }

  renderHeatmap(els.heatmap, data.week || [])
}

// Exported for blocked.js, which lists the overdue tasks that triggered the
// distraction guard and wants them to look exactly like they do in the
// widget — same dot, same time badge, same overdue coloring.
export function renderTaskRow(task, tagColors, defaultTagColor, overdueTaskStyle) {
  const row = document.createElement("div")
  let className = "task-row" + (task.done ? " done" : "")
  if (task.overdue && overdueTaskStyle && overdueTaskStyle !== "none") {
    className += " overdue"
    if (overdueTaskStyle === "flash") className += " overdue-flash"
  }
  row.className = className

  const dot = document.createElement("div")
  dot.className = "task-dot"
  dot.textContent = task.done ? "✓" : ""
  row.appendChild(dot)

  if (task.time) {
    const time = document.createElement("span")
    time.className = "task-time"
    time.textContent = task.time
    row.appendChild(time)
  }

  const text = document.createElement("span")
  text.className = "task-text"
  text.textContent = task.text
  row.appendChild(text)

  if (task.tags && task.tags.length > 0) {
    const tag = document.createElement("span")
    tag.className = "tag-dot"
    tag.style.background = (tagColors && tagColors[task.tags[0]]) || defaultTagColor
    row.appendChild(tag)
  }

  return row
}

// Deliberately just the colored squares — no "Last 7 Days" title, no
// weekday-letter labels underneath, matching both sibling apps. Both were
// cut there for taking up vertical space the color alone doesn't need.
function renderHeatmap(heatmapEl, week) {
  heatmapEl.innerHTML = ""
  heatmapEl.hidden = week.length === 0
  for (const day of week) {
    const square = document.createElement("div")
    square.className = "heatmap-square"
    square.style.background = levelColor(day)
    heatmapEl.appendChild(square)
  }
}

function levelColor(day) {
  if (!day.completion || day.completion.total === 0) return "var(--divider)"
  const ratio = day.completion.done / day.completion.total
  if (ratio === 0) return "#8e8e93"
  const idx = Math.min(GREEN_LEVELS.length - 1, Math.ceil(ratio * GREEN_LEVELS.length) - 1)
  return GREEN_LEVELS[idx]
}
