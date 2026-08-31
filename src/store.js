// Persistent key/value store for nag rate-limiting — the same role the iOS
// script's Keychain helpers and the Windows app's state.json play. Backed by
// chrome.storage.local, prefixed so these keys don't collide with the
// "config" key src/config.js owns. Unlike the Windows app's in-memory cache
// (safe there because it's a single long-lived process), every call here
// hits chrome.storage directly — this module can be imported from the
// background service worker AND the offscreen document, which are separate
// JS instances that don't share memory, so a cache would just go stale.

const PREFIX = "store."

async function get(key) {
  const k = PREFIX + key
  const result = await chrome.storage.local.get(k)
  return result[k]
}

async function set(key, value) {
  await chrome.storage.local.set({ [PREFIX + key]: value })
}

export async function getTimestamp(key) {
  const v = await get(key)
  return v ? Number(v) : 0
}

export async function setTimestamp(key, ts) {
  await set(key, String(ts))
}

export async function dateEquals(key, id) {
  return (await get(key)) === id
}

export async function setDate(key, id) {
  await set(key, id)
}
