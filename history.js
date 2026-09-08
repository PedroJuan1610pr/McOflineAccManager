// ─── history.js ───────────────────────────────────────────────────────────
// Persistence of the generated-gems history (/paygemas command).
//
// This history used to live only in the browser's localStorage: it was
// lost when switching devices, when clearing browser data, or it simply
// didn't exist until the browser processed the log lines.
//
// This module saves each payment to a JSON file inside public/
// (gems-history.json), so that:
//   - The web panel gets the same history back regardless of where you
//     open it from (it doesn't depend on the browser/device).
//   - It survives process restarts (node multibot.js).
//
// It knows nothing about WebSockets or Express: it only loads/saves data
// to disk. multibot.js is the one that uses it and takes care of notifying
// connected clients (broadcast) when there's a new entry or the history
// gets cleared.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs')
const path = require('path')

// Saved INSIDE public/ as requested, so it's the same file already served
// by express.static(). Note: this also means it's directly downloadable
// from the panel (e.g. http://<host>:<port>/gems-history.json), just like
// the rest of public/'s content — there's nothing sensitive in it (only
// bot name, recipient name, and gem amount), but it's worth keeping in
// mind if the panel is exposed outside the LAN.
const HISTORY_PATH = path.join(__dirname, 'public', 'gems-history.json')

// Maximum number of stored entries so the file doesn't grow without bound.
const MAX_ENTRIES = 3000

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Doesn't exist yet (first run) or is corrupted/unreadable: start
    // from scratch instead of crashing the process.
    return []
  }
}

// In-memory state, loaded once when the process starts.
let history = loadFromDisk()

function saveToDisk() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history))
  } catch (err) {
    console.error(`⚠ Could not save ${HISTORY_PATH}: ${err.message}`)
  }
}

// Returns the full history (array of { ts, botId, target, gems }).
function getAll() {
  return history
}

// Adds a new entry, trims to the max, and persists to disk.
// Returns the entry itself (for convenience, so it can be used in the broadcast).
function add(entry) {
  history.push(entry)
  if (history.length > MAX_ENTRIES) history = history.slice(-MAX_ENTRIES)
  saveToDisk()
  return entry
}

// Clears the history (the panel's "Clear history" button) and persists it.
function clear() {
  history = []
  saveToDisk()
}

module.exports = { getAll, add, clear, HISTORY_PATH }
