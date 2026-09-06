import { loadConfig, saveConfig, DEFAULTS } from "./src/config.js"
import { checkVaultAccess, clearVaultHandle } from "./src/vaultAccess.js"
import { connectVault, reconnectVault } from "./shared/vaultConnect.js"
import { runGuard, normalizeSites } from "./src/distractionGuard.js"

const form = document.getElementById("configForm")
const saveStatus = document.getElementById("saveStatus")
const vaultStatusEl = document.getElementById("vaultStatus")
const vaultMessageEl = document.getElementById("vaultMessage")
const connectButton = document.getElementById("connectButton")
const disconnectButton = document.getElementById("disconnectButton")

// Every DEFAULTS key maps 1:1 to a form field name except three edited as
// free text: tagColors (a JSON blob — a per-tag color picker isn't worth
// the UI for something edited maybe once) and blockedSites/deepWorkAllowlist
// (newline-separated lists, far easier to paste into than a JSON array).
const TEXT_BLOB_KEYS = ["tagColors", "blockedSites", "deepWorkAllowlist"]
const SIMPLE_KEYS = Object.keys(DEFAULTS).filter((k) => !TEXT_BLOB_KEYS.includes(k))

function populateForm(config) {
  for (const key of SIMPLE_KEYS) {
    const el = form.elements[key]
    if (!el) continue
    if (key === "workDays") {
      el.value = config.workDays.join(",")
    } else if (el.type === "checkbox") {
      el.checked = Boolean(config[key])
    } else {
      el.value = config[key]
    }
  }
  form.elements.tagColorsJson.value = JSON.stringify(config.tagColors, null, 2)
  form.elements.blockedSitesText.value = (config.blockedSites || []).join("\n")
  form.elements.deepWorkAllowlistText.value = (config.deepWorkAllowlist || []).join("\n")
}

function readForm(currentConfig) {
  const config = { ...currentConfig }
  for (const key of SIMPLE_KEYS) {
    const el = form.elements[key]
    if (!el) continue
    if (key === "workDays") {
      config.workDays = el.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    } else if (el.type === "checkbox") {
      config[key] = el.checked
    } else if (el.type === "number") {
      config[key] = Number(el.value)
    } else {
      config[key] = el.value
    }
  }
  config.tagColors = JSON.parse(form.elements.tagColorsJson.value)
  // Normalized on the way in rather than on the way out, so what gets saved
  // is exactly what the guard will match on — a pasted "https://www.reddit.com/"
  // becomes "reddit.com" and the user sees that when the form repopulates,
  // instead of wondering why their entry looks different from what blocks.
  config.blockedSites = normalizeSites(form.elements.blockedSitesText.value.split("\n"))
  config.deepWorkAllowlist = normalizeSites(form.elements.deepWorkAllowlistText.value.split("\n"))
  return config
}

async function refreshVaultStatus() {
  const { status, handle } = await checkVaultAccess()
  connectButton.textContent = status === "prompt" ? "Reconnect vault folder" : "Connect / change vault folder"
  connectButton.dataset.mode = status === "prompt" ? "reconnect" : "connect"
  disconnectButton.hidden = status === "no-handle"

  if (status === "granted") {
    vaultStatusEl.textContent = `Connected: "${handle.name}"`
  } else if (status === "prompt" || status === "denied") {
    vaultStatusEl.textContent = `Vault folder "${handle.name}" needs to be reconnected.`
  } else {
    vaultStatusEl.textContent = "Not connected."
  }
}

async function init() {
  const config = await loadConfig()
  populateForm(config)
  await refreshVaultStatus()
}

connectButton.addEventListener("click", async () => {
  vaultMessageEl.hidden = true
  try {
    const config = await loadConfig()
    if (connectButton.dataset.mode === "reconnect") {
      const { handle } = await checkVaultAccess()
      await reconnectVault(handle)
    } else {
      await connectVault(config)
    }
    await refreshVaultStatus()
  } catch (e) {
    vaultMessageEl.hidden = false
    vaultMessageEl.textContent = e.message || String(e)
  }
})

disconnectButton.addEventListener("click", async () => {
  await clearVaultHandle()
  await refreshVaultStatus()
})

form.addEventListener("submit", async (e) => {
  e.preventDefault()
  saveStatus.textContent = ""
  try {
    const current = await loadConfig()
    const next = readForm(current)
    await saveConfig(next)
    // Apply the guard immediately instead of waiting for the next tick.
    // Turning it off is the case that matters: leaving sites blocked for
    // another tickIntervalMinutes after the user has explicitly disabled
    // the feature would read as the toggle being broken.
    const { status, handle } = await checkVaultAccess()
    await runGuard(next, handle, status)
    populateForm(next) // reflect normalized blockedSites back to the user
    saveStatus.textContent = "Saved."
    setTimeout(() => {
      saveStatus.textContent = ""
    }, 2000)
  } catch (e) {
    saveStatus.textContent = `Error: ${e.message || e}`
  }
})

init()
