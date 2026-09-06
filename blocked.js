// The page a blocked navigation lands on. Deliberately not a dead end: its
// whole job is to name the specific thing that caused the block and put the
// fix one click away, so the path of least resistance leads back to the
// daily note rather than to disabling the guard.
//
// The redirect itself carries no context (DNR redirects to a static
// extension path), so everything shown here comes from the guard state the
// last tick wrote to chrome.storage — see src/distractionGuard.js.

import { loadConfig } from "./src/config.js"
import { checkVaultAccess } from "./src/vaultAccess.js"
import { readGuardState, readDeepWorkState, snoozeGuard, getSnoozeUntil, runGuard } from "./src/distractionGuard.js"
import { renderTaskRow } from "./shared/render.js"
import * as vault from "./src/vault.js"

const titleEl = document.getElementById("title")
const reasonEl = document.getElementById("reason")
const tasksEl = document.getElementById("tasks")
const tasksLabelEl = document.getElementById("tasksLabel")
const openNoteButton = document.getElementById("openNoteButton")
const recheckButton = document.getElementById("recheckButton")
const snoozeButton = document.getElementById("snoozeButton")
const snoozeNoteEl = document.getElementById("snoozeNote")

const REASON_TEXT = {
  "no-daily-note": "There is no daily note for today yet. Write today's plan first.",
  "overdue-tasks": "You have tasks whose time block has already ended, still unchecked.",
  "incomplete-review": "Yesterday's note is missing, or its Win/Reflection fields are still empty.",
}

function describe(reasons) {
  const parts = reasons.map((r) => REASON_TEXT[r]).filter(Boolean)
  if (parts.length === 0) return "This site is blocked by your Day planner guard."
  return parts.join(" ")
}

async function paint() {
  const config = await loadConfig()
  const state = await readGuardState()
  const deepWork = await readDeepWorkState()

  document.documentElement.style.setProperty("--overdue-color", config.overdueColor)

  if (!state.active && !deepWork.active) {
    // Both guards cleared between the redirect and this page painting —
    // most likely the user fixed the note in another window. Say so rather
    // than showing a block reason that no longer holds.
    titleEl.textContent = "You're clear"
    reasonEl.textContent = "The block just lifted. Reload the page you were trying to open."
    tasksLabelEl.hidden = true
    tasksEl.innerHTML = ""
    snoozeButton.hidden = true
    return
  }

  tasksEl.innerHTML = ""
  if (deepWork.active) {
    // The deep-work guard's allowlist is what's blocking here, not the site
    // guard's reason list — name the task instead so it's clear this isn't
    // the same block as the one below.
    titleEl.textContent = "Deep work."
    reasonEl.textContent = deepWork.task
      ? `You're in a #tdeep block right now — "${deepWork.task.text}". Only allowlisted sites are open until it ends.`
      : "A #tdeep block is running right now. Only allowlisted sites are open until it ends."
    tasksLabelEl.hidden = true
  } else {
    titleEl.textContent = "Not yet."
    reasonEl.textContent = describe(state.reasons || [])

    const overdue = state.overdueTasks || []
    tasksLabelEl.hidden = overdue.length === 0
    for (const task of overdue) {
      tasksEl.appendChild(
        renderTaskRow(
          { ...task, done: false, overdue: true },
          config.tagColors,
          config.defaultTagColor,
          // Always "red" here regardless of config.overdueTaskStyle: this
          // page exists *because* these tasks are overdue, so honoring a
          // "none" setting would strip the one bit of information it is for.
          "red"
        )
      )
    }
  }

  const snoozeUntil = await getSnoozeUntil()
  if (snoozeUntil) {
    snoozeButton.hidden = true
    snoozeNoteEl.hidden = false
    snoozeNoteEl.textContent = `Snoozed until ${new Date(snoozeUntil).toLocaleTimeString()}.`
  } else if (config.guardSnoozeMinutes > 0) {
    snoozeButton.hidden = false
    snoozeButton.textContent = `Snooze ${config.guardSnoozeMinutes} min`
    snoozeNoteEl.hidden = true
  } else {
    snoozeButton.hidden = true
    snoozeNoteEl.hidden = true
  }
}

openNoteButton.addEventListener("click", async () => {
  const config = await loadConfig()
  const state = await readGuardState()
  const reasons = state.reasons || []
  // Only reason is yesterday's review being incomplete → that's the note to
  // fix, not today's. Any other reason (or a mix) is about today's plan, so
  // today's note stays the default target.
  const onlyIncompleteReview = reasons.length === 1 && reasons[0] === "incomplete-review"
  const id = (onlyIncompleteReview ? state.yesterdayNoteId : state.noteId) || vault.todayId()
  // Same obsidian:// deep link the notifications use. If the target note
  // does not exist yet this opens Obsidian at a missing file, which is
  // exactly the prompt to create it.
  chrome.tabs.create({ url: vault.obsidianNoteURL(config, id) })
})

// Re-reads the vault right now instead of waiting out the rest of the
// tickIntervalMinutes window. Without this, checking off the last overdue
// task could leave the user staring at a block page for another five
// minutes, which is the fastest way to make someone resent the feature.
recheckButton.addEventListener("click", async () => {
  recheckButton.disabled = true
  recheckButton.textContent = "Checking…"
  try {
    const config = await loadConfig()
    const { status, handle } = await checkVaultAccess()
    await runGuard(config, handle, status)
  } catch (e) {
    // Fail open, same as the guard itself: never leave the user stuck here
    // because a re-check threw.
  }
  recheckButton.disabled = false
  recheckButton.textContent = "I fixed it — re-check"
  await paint()
})

snoozeButton.addEventListener("click", async () => {
  const config = await loadConfig()
  await snoozeGuard(config.guardSnoozeMinutes)
  const { status, handle } = await checkVaultAccess()
  await runGuard(config, handle, status)
  await paint()
})

paint()
