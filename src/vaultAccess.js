// Persists the user's chosen vault root as a FileSystemDirectoryHandle — the
// browser-native equivalent of the iOS script's Scriptable bookmark and the
// Windows app's stored vaultPath. There's no native messaging host and no
// network call: the user grants read access to one local folder, once, via
// the OS file picker, and that's the entire integration.
//
// FileSystemHandle objects are structured-cloneable, so they can be written
// straight into IndexedDB and read back later. Crucially, they can also be
// read back from a *different* extension page than the one that stored
// them: every page this extension owns (newtab.html, popup.html,
// options.html, offscreen.html) shares the same chrome-extension://<id>
// origin, which is what lets the offscreen document — used by the
// background service worker, which has no window/DOM of its own and so
// cannot show a file picker — reuse a handle the user granted from the New
// Tab page or the popup.
//
// Permission is NOT guaranteed to survive a full browser restart (Chrome's
// behavior here has shifted across versions and isn't something to depend
// on). Every caller of checkVaultAccess() must treat any non-"granted"
// result as normal, not exceptional, and fall back to a "connect your
// vault" prompt — never throw or crash the widget over it. This mirrors the
// Windows app's own stance on a bad/unset vaultPath: show a setup hint,
// don't crash.

const DB_NAME = "obsidian-widget"
const DB_VERSION = 1
const STORE_NAME = "handles"
const HANDLE_KEY = "vaultDirectoryHandle"

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore(mode, fn) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      const result = fn(store)
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function saveVaultHandle(handle) {
  await withStore("readwrite", (store) => store.put(handle, HANDLE_KEY))
}

export async function loadVaultHandle() {
  return withStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(HANDLE_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  })
}

export async function clearVaultHandle() {
  await withStore("readwrite", (store) => store.delete(HANDLE_KEY))
}

// Requires a user gesture (a click) and a visible window — call this only
// from a click handler in newtab.js / popup.js / options.js. It cannot run
// in the offscreen document or the background service worker, neither of
// which can show an OS file picker.
export async function pickVaultDirectory() {
  const handle = await window.showDirectoryPicker({ id: "obsidian-vault", mode: "read" })
  await saveVaultHandle(handle)
  return handle
}

// Returns { status, handle }, where status is one of:
//   "granted"  — handle is usable, safe to read from immediately
//   "prompt"   — a handle exists but needs requestVaultAccess() (user gesture) to re-confirm
//   "denied"   — the user explicitly denied access; needs a fresh pickVaultDirectory()
//   "no-handle" — nothing has ever been picked, or the stored handle is unusable
// Never throws — every caller uses this to decide whether to render the
// widget or a "connect vault" prompt.
export async function checkVaultAccess() {
  let handle
  try {
    handle = await loadVaultHandle()
  } catch (e) {
    return { status: "no-handle", handle: null }
  }
  if (!handle) return { status: "no-handle", handle: null }
  try {
    const permission = await handle.queryPermission({ mode: "read" })
    return { status: permission, handle }
  } catch (e) {
    return { status: "no-handle", handle: null }
  }
}

// Re-requests permission on an already-picked handle — same user-gesture
// restriction as pickVaultDirectory(), and the same caller restriction (a
// visible page, never the offscreen document or background worker).
export async function requestVaultAccess(handle) {
  return handle.requestPermission({ mode: "read" })
}
