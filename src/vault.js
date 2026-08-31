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

    const tags = [...text.matchAll(/#(\w+)/g)].map((mm) => mm[1])
    text = text.replace(/#\w+/g, "").trim()
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

export function obsidianNoteURL(config, id) {
  const filePath = `${config.dailyFolder}/${id}`
  return `obsidian://open?vault=${encodeURIComponent(config.obsidianVaultName)}&file=${encodeURIComponent(filePath)}`
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
