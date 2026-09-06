// Controller shared by newtab.js and popup.js — both pages are otherwise
// identical (load config, check vault access, render tasks + heatmap, wire
// up the connect/reconnect button); only their HTML's sizing and the number
// of visible tasks differ.

import { loadConfig, onConfigChanged } from "../src/config.js"
import { checkVaultAccess } from "../src/vaultAccess.js"
import { buildWidgetData } from "../src/widgetData.js"
import { render } from "./render.js"
import { syncGuardFromNote } from "../src/distractionGuard.js"
import { connectVault, reconnectVault } from "./vaultConnect.js"
import { captureTask } from "../src/vault.js"

export function initWidgetPage(els, connectButton, maxVisibleTasks) {
  let currentConfig = null

  async function refresh() {
    currentConfig = await loadConfig()
    const { status, handle } = await checkVaultAccess()
    els.quickAdd.hidden = status !== "granted"
    els.quickAddStatus.hidden = true

    if (status === "granted") {
      connectButton.hidden = true
      const data = await buildWidgetData(currentConfig, handle)
      render(els, data, maxVisibleTasks)
      // Piggybacks on the read buildWidgetData just did. The background
      // tick only runs every tickIntervalMinutes, so without this, checking
      // off the last overdue task would leave sites blocked for up to five
      // more minutes — and opening New Tab is the most likely moment for
      // the user to have just done that. Skipped when noteExists is null
      // (the read failed outright), leaving that call to the tick's own
      // fail-open path rather than guessing here.
      if (data.noteExists !== null) {
        await syncGuardFromNote(currentConfig, data.noteExists, data.tasks, data.isRestDayToday, data.yesterdayStatus)
      }
      return
    }

    connectButton.hidden = false
    connectButton.textContent = status === "prompt" ? "Reconnect vault folder" : "Connect vault folder"
    connectButton.dataset.mode = status === "prompt" ? "reconnect" : "connect"
    connectButton.dataset.pending = "false"
    render(els, { vaultConfigured: false }, maxVisibleTasks)
  }

  // Quick-capture: appends a task to today's note without leaving this page.
  // Re-checks vault access at submit time rather than trusting the last
  // render's status — per src/vaultAccess.js's own rule, permission can
  // lapse between renders and every write site has to decide fresh.
  els.quickAdd.addEventListener("submit", async (e) => {
    e.preventDefault()
    const text = els.quickAddInput.value.trim()
    if (!text) return

    els.quickAddButton.disabled = true
    els.quickAddStatus.hidden = true
    try {
      const { status, handle } = await checkVaultAccess()
      if (status !== "granted") throw new Error("Reconnect your vault to add tasks.")
      const result = await captureTask(handle, currentConfig, text)
      if (!result.ok) {
        throw new Error(
          result.reason === "no-note"
            ? "Today's note doesn't exist yet — create it in Obsidian first."
            : `Today's note has no "${currentConfig.headingPattern}" section yet.`
        )
      }
      els.quickAddInput.value = ""
      await refresh()
    } catch (err) {
      els.quickAddStatus.hidden = false
      els.quickAddStatus.textContent = err.message || String(err)
    } finally {
      els.quickAddButton.disabled = false
    }
  })

  connectButton.addEventListener("click", async () => {
    if (connectButton.dataset.pending === "true") return
    connectButton.dataset.pending = "true"
    try {
      if (connectButton.dataset.mode === "reconnect") {
        const { handle } = await checkVaultAccess()
        await reconnectVault(handle)
      } else {
        await connectVault(currentConfig)
      }
      await refresh()
    } catch (e) {
      els.placeholder.hidden = false
      els.placeholder.textContent = e.message || String(e)
      connectButton.dataset.pending = "false"
    }
  })

  onConfigChanged(() => refresh())

  refresh()
}
