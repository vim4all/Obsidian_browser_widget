// Shared "connect/reconnect the vault" flow for newtab.js and popup.js —
// both need the exact same button behavior, so it lives here once rather
// than being copy-pasted.

import { pickVaultDirectory, requestVaultAccess, clearVaultHandle } from "../src/vaultAccess.js"

// Opens the OS folder picker, then validates the chosen folder actually
// contains config.dailyFolder — same check ../obsidian_windows_widget's
// config.ensureVaultConfigured() does, just async and against a
// FileSystemDirectoryHandle instead of a path string. Throws with a
// human-readable message on cancel or a bad folder; callers should catch
// and display e.message.
export async function connectVault(config) {
  let handle
  try {
    handle = await pickVaultDirectory()
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Folder selection cancelled.")
    throw e
  }
  try {
    await handle.getDirectoryHandle(config.dailyFolder, { create: false })
  } catch (e) {
    await clearVaultHandle()
    throw new Error(`That folder doesn't contain "${config.dailyFolder}". Pick your vault's root folder.`)
  }
  return handle
}

// Re-confirms permission on an already-picked handle (the "prompt"/"denied"
// case from vaultAccess.checkVaultAccess) — needed after a browser restart
// if Chrome didn't persist the earlier grant.
export async function reconnectVault(handle) {
  const permission = await requestVaultAccess(handle)
  if (permission !== "granted") throw new Error("Vault access was not granted.")
  return handle
}
