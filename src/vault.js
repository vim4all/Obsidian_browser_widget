// Vault reading + daily-note parsing.
// Ported from ../obsidian_windows_widget/src/vault.js (itself a port of the
// iOS Scriptable script). The pure parsing functions below are copied
// verbatim — same signatures, same regexes — so this file stays easy to
// diff against its two siblings. The file-reading functions differ because
// there's no synchronous filesystem here: instead of Node's `fs` or
// Scriptable's `FileManager`, everything goes through a
// FileSystemDirectoryHandle (the File System Access API), which is
// promise-based, so every function that touches disk is async.

export function todayId(date = new Date()) {
  return dateId(date)
}

export function dateId(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// Mirrors the iOS/Windows sign convention: offsetDays in the past (0 = today,
// negative = future, so "tomorrow" is dateForOffset(-1)). Don't "fix" this to
// be more intuitive — tomorrowPlanStatus and the streak-break/weekly-review
// callers all depend on it matching the other two repos exactly.
export function dateForOffset(offsetDays) {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return d
}

export function wikiLinkToText(s) {
  return s.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, target, _full, alias) => {
    if (alias) return alias
    const parts = target.split("/")
    return parts[parts.length - 1]
  })
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function headingRegex(config) {
  return new RegExp(`^#+\\s*${escapeRegex(config.headingPattern)}`, "i")
}

export function parseTasks(markdown, config) {
  const HEADING_REGEX = headingRegex(config)
  const lines = markdown.split("\n")
  let inPlanner = false
  const tasks = []
  for (const raw of lines) {
    const line = raw.trim()
    if (HEADING_REGEX.test(line)) {
      inPlanner = true
      continue
    }
    if (inPlanner && /^#+\s/.test(line) && !HEADING_REGEX.test(line)) break
    if (!inPlanner) continue

    const m = line.match(/^- \[( |x|X)\]\s*(.*)$/)
    if (!m) continue

    const done = m[1].toLowerCase() === "x"
    let text = m[2].trim()
    if (!text) continue

    // \w+ alone stops at "/", so a project-key tag like #p/dcr would be
    // captured as bare "p" and leave a dangling "/dcr" in the display text.
    // Obsidian tags allow "/" for nesting and "-", so the tag body matches
    // both.
    const tags = [...text.matchAll(/#([\w][\w/-]*)/g)].map((mm) => mm[1])
    text = text.replace(/#[\w][\w/-]*/g, "").trim()
    text = wikiLinkToText(text)

    const timeMatch = text.match(/^(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}h?)\s*/)
    let time = null
    if (timeMatch) {
      time = timeMatch[1]
      text = text.slice(timeMatch[0].length).trim()
    }

    tasks.push({ done, time, text, tags })
  }
  return tasks
}

export function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/)
    if (m) result[m[1]] = m[2].trim()
  }
  return result
}

export function habitCompletion(frontmatter) {
  const habitKeys = Object.keys(frontmatter).filter(
    (k) => frontmatter[k] === "true" || frontmatter[k] === "false"
  )
  if (habitKeys.length === 0) return null
  const done = habitKeys.filter((k) => frontmatter[k] === "true").length
  return { done, total: habitKeys.length }
}

export function isRestDay(frontmatter, config) {
  return frontmatter[config.restDayFrontmatterKey] === "true"
}

// Same obsidian:// deep link as obsidianNoteURL below, for an arbitrary
// vault-relative path rather than one under dailyFolder — used for the
// stranded-tasks glance's link to config.triageNotePath.
export function obsidianFileURL(config, relativePath) {
  const filePath = relativePath.replace(/\.md$/i, "")
  return `obsidian://open?vault=${encodeURIComponent(config.obsidianVaultName)}&file=${encodeURIComponent(filePath)}`
}

export function obsidianNoteURL(config, id) {
  return obsidianFileURL(config, `${config.dailyFolder}/${id}`)
}

// Matches a bold inline field label line like "**Win:**" or "**Win**" —
// this vault's Win/Reflection fields are written as bold labels followed by
// free text (`**Win:** did a thing`), not markdown headings the way the Day
// planner section is. Captures any same-line trailing content in group 1.
function fieldLabelRegex(label) {
  return new RegExp(`^\\*\\*\\s*${escapeRegex(label)}\\s*:?\\s*\\*\\*\\s*:?\\s*(.*)$`, "i")
}

// Boundary lines that end a field's content run: any other bold label line
// (so Win's scan stops at Reflection's, and vice versa), a markdown
// heading, or a "---" rule — this vault puts one before "# Day planner".
const ANY_FIELD_LABEL_LINE = /^\*\*\s*[^*:]+:?\s*\*\*/
const RULE_LINE = /^-{3,}\s*$/

// Whether a "**<label>:**" field (Win/Reflection) has any actual text —
// either inline after the label on the same line, or on the line(s)
// immediately after it, up to the next field/heading/rule boundary. Used by
// the distraction guard to check yesterday's Win/Reflection fields.
export function hasFilledField(markdown, label) {
  const LABEL_REGEX = fieldLabelRegex(label)
  const lines = markdown.split("\n")
  let found = false
  for (const raw of lines) {
    const line = raw.trim()
    const m = line.match(LABEL_REGEX)
    if (m) {
      found = true
      if (m[1].trim()) return true
      continue
    }
    if (!found) continue
    if (ANY_FIELD_LABEL_LINE.test(line) || /^#+\s/.test(line) || RULE_LINE.test(line)) break
    if (line) return true
  }
  return false
}

export function parseTimeRange(timeStr) {
  const cleaned = timeStr.replace(/h\s*$/i, "").trim()
  const parts = cleaned.split("-").map((s) => s.trim())
  if (parts.length !== 2) return null
  const [startStr, endStr] = parts
  const toDate = (t) => {
    const m = t.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    const d = new Date()
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return d
  }
  const start = toDate(startStr)
  const end = toDate(endStr)
  if (!start || !end) return null
  return { start, end }
}

// A task is overdue once its own time block has ended and it's still
// unchecked — the same condition maybeSendTimeBlockNudges' "block ended,
// still open" nudge fires on, just re-derived here for display purposes.
export function isTaskOverdue(task, now = new Date()) {
  if (task.done || !task.time) return false
  const range = parseTimeRange(task.time)
  if (!range) return false
  return now > range.end
}

// True while `now` falls inside the task's own time block and it's not
// already done — used by the distraction guard's deep-work mode to tell
// whether a #tdeep-tagged task is the thing currently being worked on.
export function isTaskActiveNow(task, now = new Date()) {
  if (task.done || !task.time) return false
  const range = parseTimeRange(task.time)
  if (!range) return false
  return now >= range.start && now <= range.end
}

// Appends a new unchecked task line to markdown's Day planner section (the
// same section parseTasks reads), right after the last existing task line
// in that section — or right after the heading if the section is still
// empty. Deliberately does not create the heading/section if it's missing
// (unlike parseTasks, which just sees zero tasks in that case): a note with
// no Day planner section yet is a note the user hasn't started, and this is
// meant for quick-capture into a note that already exists, not for
// synthesizing the user's daily-note template — see captureTask() below and
// shared/widgetPage.js's #quickAdd form handler, which calls it.
export function appendTaskLine(markdown, config, taskText) {
  const HEADING_REGEX = headingRegex(config)
  const TASK_LINE = /^- \[( |x|X)\]/
  const lines = markdown.split("\n")

  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_REGEX.test(lines[i].trim())) {
      headingIndex = i
      break
    }
  }
  if (headingIndex === -1) return null

  let sectionEnd = lines.length
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#+\s/.test(lines[i].trim())) {
      sectionEnd = i
      break
    }
  }

  let insertAt = headingIndex + 1
  for (let i = headingIndex + 1; i < sectionEnd; i++) {
    if (TASK_LINE.test(lines[i].trim())) insertAt = i + 1
  }
  // No existing task line found — land after the heading's usual blank-line
  // spacer instead of butting straight up against the heading.
  if (insertAt === headingIndex + 1 && lines[insertAt] !== undefined && lines[insertAt].trim() === "") {
    insertAt++
  }

  lines.splice(insertAt, 0, `- [ ] ${taskText}`)
  return lines.join("\n")
}

// --- Async disk access, via a FileSystemDirectoryHandle for the vault root ---
// vaultHandle is a FileSystemDirectoryHandle obtained once via
// showDirectoryPicker() (see src/vaultAccess.js) and persisted in IndexedDB;
// every function below assumes its permission has already been verified as
// "granted" by the caller (vaultAccess.checkVaultAccess) — none of them
// re-check permission themselves.

export async function readNote(vaultHandle, config, id) {
  try {
    const dailyDir = await vaultHandle.getDirectoryHandle(config.dailyFolder, { create: false })
    const fileHandle = await dailyDir.getFileHandle(`${id}.md`, { create: false })
    const file = await fileHandle.getFile()
    return await file.text()
  } catch (e) {
    if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return null
    throw e
  }
}

// Overwrites an existing daily note. Never creates one (`create: false`) —
// this is only ever called right after a successful readNote() of the same
// id in captureTask() below, so a missing file here means something else
// deleted it out from under us mid-operation, which should throw rather
// than silently fabricate a note.
async function writeNote(vaultHandle, config, id, content) {
  const dailyDir = await vaultHandle.getDirectoryHandle(config.dailyFolder, { create: false })
  const fileHandle = await dailyDir.getFileHandle(`${id}.md`, { create: false })
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

// Quick-capture: appends `taskText` as a new unchecked task to today's note
// and writes it back. Deliberately does not create today's note or its Day
// planner section if either is missing — see appendTaskLine's comment —
// so the caller gets a reason to show the user instead of a silently
// synthesized note that wouldn't match their actual daily-note template.
export async function captureTask(vaultHandle, config, taskText) {
  const id = todayId()
  const content = await readNote(vaultHandle, config, id)
  if (content === null) return { ok: false, reason: "no-note", id }
  const updated = appendTaskLine(content, config, taskText)
  if (updated === null) return { ok: false, reason: "no-heading", id }
  await writeNote(vaultHandle, config, id, updated)
  return { ok: true, id }
}

// Open tasks left behind in past daily notes — the same thing this vault's
// own Sunday triage calls "stranded" (TASK_BASKET/t_UrgentTasks.md's
// "Stranded" panel). That panel scans every daily note ever written and is
// the real triage; this is a bounded, cheap approximation for a daily
// glance in the widget, not a replacement for it — see widgetData.js.
export async function countStrandedTasks(vaultHandle, config, lookbackDays) {
  let count = 0
  let oldestDays = 0
  for (let offset = 1; offset <= lookbackDays; offset++) {
    const content = await readNote(vaultHandle, config, dateId(dateForOffset(offset)))
    if (content === null) continue
    const open = parseTasks(content, config).filter((t) => !t.done).length
    if (open > 0) {
      count += open
      oldestDays = offset
    }
  }
  return { count, oldestDays }
}

// Reads an arbitrary file by vault-relative path (e.g.
// "10_SelfDev/3_Long term planning.md") — unlike readNote, which is scoped
// to config.dailyFolder. Used by planStatus() below. Same
// null-on-missing/throw-on-real-error contract as readNote.
async function readFileAtPath(vaultHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean)
  const fileName = parts.pop()
  try {
    let dir = vaultHandle
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false })
    }
    const fileHandle = await dir.getFileHandle(fileName, { create: false })
    const file = await fileHandle.getFile()
    return await file.text()
  } catch (e) {
    if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return null
    throw e
  }
}

// Special-purpose reader for one specific frontmatter shape: a `gantt:`
// list of flat maps (task/key/cat/start/end/status/track/field), the shape
// this feature's target note (config.planNotePath) writes its project bars
// in. Not a general YAML parser — it only understands "- key: value" list
// items and deeper-indented "key: value" continuation lines, which is all
// that shape needs.
function ganttBars(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return []
  const bars = []
  let current = null
  for (const line of match[1].split("\n")) {
    const itemStart = line.match(/^\s*-\s+(\w+):\s*(.*)$/)
    if (itemStart) {
      current = {}
      bars.push(current)
      current[itemStart[1]] = itemStart[2].trim()
      continue
    }
    const cont = line.match(/^\s+(\w+):\s*(.*)$/)
    if (current && cont) current[cont[1]] = cont[2].trim()
  }
  return bars
}

// Reads config.planNotePath (if set) and summarizes what the weekly review
// notifier needs from it: how stale its `reviewed:` date is, and how many
// distinct project keys are `status: active` (excluding `track: habit`
// bars, which aren't projects competing for attention — the same exclusion
// the note's own review-panel query makes). Returns null if planNotePath
// isn't configured or the note can't be read; callers treat that as "skip
// this check", not an error.
export async function planStatus(vaultHandle, config) {
  if (!config.planNotePath) return null
  const content = await readFileAtPath(vaultHandle, config.planNotePath)
  if (content === null) return null
  const frontmatter = parseFrontmatter(content)
  const reviewed = frontmatter.reviewed || null
  const reviewedDate = reviewed ? new Date(reviewed) : null
  const staleDays =
    reviewedDate && !Number.isNaN(reviewedDate.getTime())
      ? Math.floor((Date.now() - reviewedDate.getTime()) / 86400000)
      : null
  const activeKeys = new Set(
    ganttBars(content)
      .filter((b) => b.status === "active" && b.track !== "habit" && b.key)
      .map((b) => b.key)
  )
  return { reviewed, staleDays, activeCount: activeKeys.size }
}

export async function dayInfoForOffset(vaultHandle, config, offset) {
  const id = dateId(dateForOffset(offset))
  const content = await readNote(vaultHandle, config, id)
  if (content === null) return null
  const frontmatter = parseFrontmatter(content)
  return { completion: habitCompletion(frontmatter), restDay: isRestDay(frontmatter, config) }
}

export async function buildWeekHabitData(vaultHandle, config, days = 7) {
  const result = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = dateForOffset(offset)
    const id = dateId(date)
    const content = await readNote(vaultHandle, config, id)
    const completion = content === null ? null : habitCompletion(parseFrontmatter(content))
    result.push({ date, id, completion })
  }
  return result
}

// Tomorrow relative to "today" is dateForOffset(-1) — see the comment on
// dateForOffset above for why the sign looks backwards.
export async function tomorrowPlanStatus(vaultHandle, config) {
  const id = dateId(dateForOffset(-1))
  const content = await readNote(vaultHandle, config, id)
  if (content === null) return { missing: true, restDay: false, id }
  return {
    missing: parseTasks(content, config).length === 0,
    restDay: isRestDay(parseFrontmatter(content), config),
    id,
  }
}

// Yesterday relative to "today" is dateForOffset(1) — the mirror image of
// tomorrowPlanStatus's dateForOffset(-1) above, same sign convention. Used
// by the distraction guard's "yesterday's review wasn't done" check.
export async function yesterdayReviewStatus(vaultHandle, config) {
  const id = dateId(dateForOffset(1))
  const content = await readNote(vaultHandle, config, id)
  if (content === null) return { missing: true, filled: false, id }
  const filled =
    hasFilledField(content, config.winFieldLabel) && hasFilledField(content, config.reflectionFieldLabel)
  return { missing: false, filled, id }
}
