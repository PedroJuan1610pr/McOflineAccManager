const mineflayer = require('mineflayer')
const readline = require('readline')
const https = require('https')
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const dns = require('dns')
const net = require('net')
const express = require('express')
const { WebSocketServer } = require('ws')
const gemsHistoryStore = require('./history')

// The system's DNS resolver has repeatedly caused problems (EAI_AGAIN when
// resolving the server host, both here and when connecting to the
// Minecraft server). We force Node to use public DNS instead of the
// machine/ISP's default resolver.
dns.setServers(['1.1.1.1', '8.8.8.8'])
const webConfig = require('./webconfig')

// Shared keep-alive agent for requests to the gems API: reuses the
// TCP/TLS connection between requests so DNS doesn't need to be resolved
// again on every call. Under bursts of concurrent requests (several bots
// requesting gems at once), doing a DNS resolution per request can
// overload the system resolver and cause EAI_AGAIN errors even when DNS
// is otherwise working fine.
const gemsApiAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })

// Loads (or reloads) config.js, clearing the require cache first so
// changes can be picked up on the fly without restarting the process (if
// we didn't, Node would always return the already-cached version).
// config.js unifies accounts, hotkeys, triggers, and macros in a single
// file (previously split across separate hotkeys.js/triggers.js/
// macros.js files).
function loadConfigModule() {
  try {
    const fullPath = require.resolve('./config')
    delete require.cache[fullPath]
    return require(fullPath)
  } catch (err) {
    output(`⚠ Error loading config.js: ${err.message}`)
    return { accounts: [], hotkeys: [], triggers: [], macros: {} }
  }
}

let fullConfig = loadConfigModule()
const accounts = fullConfig.accounts || []
let hotkeysConfig = fullConfig.hotkeys || []
let triggersConfig = fullConfig.triggers || []
let macrosConfig = fullConfig.macros || {}

// ─── Safety net: don't let an internal library error take down the whole process ──
process.on('uncaughtException', (err) => {
  if (isKnownNoisyError(err)) return
  console.error(`[uncaughtException] ${err.message}`)
})
process.on('unhandledRejection', (err) => {
  if (isKnownNoisyError(err)) return
  console.error(`[unhandledRejection] ${err?.message || err}`)
})

// Known bug: some servers send a custom scoreboard/tablist (e.g. "wtab_sb")
// that the mineflayer library doesn't recognize. It's harmless, just noise.
function isKnownNoisyError(err) {
  const msg = err?.message || String(err || '')
  return msg.includes('unknown objective')
}

// ─── Root-cause fix for the scoreboard.js bug ("unknown objective") ────────
// mineflayer's internal plugin (lib/plugins/scoreboard.js) registers a
// listener on bot._client for the 'scoreboard_score' and
// 'scoreboard_objective' packets that throws if the server sends an update
// for an objective the bot doesn't have registered (some servers send
// custom tablists/scoreboards, e.g. "wtab_sb", that trigger this). That
// throw happens inside the protocol client's own listener, in the middle
// of several internal stream layers, and sometimes escapes the
// process.on('uncaughtException') handler below before reaching it,
// crashing the whole process with the full stack trace.
//
// The reliable way to neutralize it is at the source: we temporarily
// remove the listeners mineflayer registered for those two packets, and
// re-add them wrapped in a try/catch that only swallows the known "unknown
// objective" error (any other error is re-thrown as-is, so we don't hide
// unrelated bugs). This has to be done right after creating the bot,
// before any packet arrives (createBot registers those listeners
// synchronously).
function patchNoisyScoreboardListeners(bot, id) {
  const packetNames = ['scoreboard_score', 'scoreboard_objective']
  for (const packetName of packetNames) {
    const originalListeners = bot._client.listeners(packetName)
    if (!originalListeners.length) continue
    bot._client.removeAllListeners(packetName)
    for (const fn of originalListeners) {
      bot._client.on(packetName, (...args) => {
        try {
          fn(...args)
        } catch (err) {
          if (isKnownNoisyError(err)) return // known, harmless bug: ignored
          log(id, `[Internal scoreboard error] ${err.message}`)
        }
      })
    }
  }
}

// The library itself does console.error(err) internally when it catches
// that bug; we filter it here so it doesn't clutter the terminal.
const originalConsoleError = console.error
console.error = (...args) => {
  const first = args[0]
  if (isKnownNoisyError(first) || (typeof first === 'string' && first.includes('unknown objective'))) return
  originalConsoleError(...args)
}

// ─── Discord (disconnect notifications) ─────────────────────────────────────
// Set these to your own webhook URL and user ID to get a Discord ping when
// an account disconnects. Left empty by default (no notification is sent).
const DISCORD_WEBHOOK_URL = ''
const DISCORD_USER_ID = ''

function sendDiscordWebhook(id, reason) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK_URL) return resolve()
    const data = JSON.stringify({
      content: `<@${DISCORD_USER_ID}> ⚠️ Account **${id}** has disconnected.\n**Reason:** ${reason}`,
      allowed_mentions: { users: [DISCORD_USER_ID] },
    })
    const req = https.request(
      DISCORD_WEBHOOK_URL,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { res.on('data', () => {}); res.on('end', resolve) }
    )
    req.on('error', () => resolve())
    req.write(data)
    req.end()
  })
}

// ─── State ────────────────────────────────────────────────────────────────
const sessions = new Map() // id -> { cfg, bot, autoClick }
let activeId = accounts[0]?.id || null

// ─── Chat log to file ───────────────────────────────────────────────────────
// Since every account receives the same server chat (it's a broadcast),
// we only need to save it once: we use the first account in config.js as
// the "source" for the log so lines aren't duplicated.
const PRIMARY_ACCOUNT_ID = accounts[0]?.id || null
const CHATLOG_DIR = path.join(__dirname, 'chatlog')
let chatLogStream = null

function pad2(n) {
  return String(n).padStart(2, '0')
}

function initChatLog() {
  try {
    if (!fs.existsSync(CHATLOG_DIR)) fs.mkdirSync(CHATLOG_DIR, { recursive: true })
    const now = new Date()
    // File name format: day-month-year-start time.txt (with dashes instead
    // of slashes/colons because those characters aren't valid in file
    // names on Windows).
    const fileName =
      `${pad2(now.getDate())}-${pad2(now.getMonth() + 1)}-${now.getFullYear()}` +
      `-${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.txt`
    const filePath = path.join(CHATLOG_DIR, fileName)
    chatLogStream = fs.createWriteStream(filePath, { flags: 'a' })
    chatLogStream.on('error', (err) => output(`[chatlog] Error writing the log: ${err.message}`))
    output(`[chatlog] Saving chat to chatlog/${fileName}`)
  } catch (err) {
    output(`[chatlog] Could not create the log: ${err.message}`)
  }
}

function writeChatLog(text) {
  if (!chatLogStream) return
  const now = new Date()
  const ts = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  chatLogStream.write(`[${ts}] ${text}\n`)
}

// ─── Web panel: connected WebSocket clients and broadcast helpers ─────────
const wsClients = new Set()
function broadcast(obj) {
  const data = JSON.stringify(obj)
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(data)
  }
}
function accountsSnapshot() {
  return accounts.map((cfg) => {
    const s = sessions.get(cfg.id)
    return {
      id: cfg.id,
      username: cfg.username,
      connected: !!s?.bot,
      muted: !!s?.muted,
      active: cfg.id === activeId,
      multi: typeof cfg.multi === 'number' ? cfg.multi : 1,
    }
  })
}
function broadcastStatus() {
  broadcast({ type: 'status', accounts: accountsSnapshot() })
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const isTTY = !!process.stdout.isTTY

// 'chat'  → the bottom line is the normal command prompt (managed by readline)
// 'menu'  → the bottom line is the interactive account menu (managed by hand,
//           with total priority over the keyboard: readline is disconnected while it's open)
let mode = 'chat'
let menuState = null
let lastMenuLineCount = 0

function prompt() {
  if (mode === 'menu') return // the menu paints its own reserved line while it's open
  rl.setPrompt(`[${activeId || '-'}] > `)
  rl.prompt()
}

// ─── "Safe" output: never cuts off what the user is typing ───────────────
// All chat/log printing goes through here. In 'chat' mode we use readline's
// internal redraw (clears the command line, prints the message above, and
// repaints exactly what had been typed). In 'menu' mode we do the same by
// hand, because the menu block spans several lines and readline knows
// nothing about it.
function output(text) {
  if (!isTTY) { process.stdout.write(text + '\n'); return }
  if (mode === 'menu') {
    process.stdout.write(eraseLines(lastMenuLineCount))
    process.stdout.write(text + '\n')
    drawMenuBlock()
    return
  }
  readline.cursorTo(process.stdout, 0)
  readline.clearLine(process.stdout, 0)
  process.stdout.write(text + '\n')
  rl._refreshLine()
}

function eraseLines(count) {
  let s = ''
  for (let i = 0; i < count; i++) s += '\x1b[1A\x1b[2K'
  return s
}

// ─── Interactive account menu (shortcut: Ctrl+T, arrows + Enter) ──────────
function buildMenuLines() {
  const lines = ['┌─── Switch account  (↑/↓ move · Enter select · Esc cancel) ───']
  accounts.forEach((cfg, i) => {
    const s = sessions.get(cfg.id)
    const state = s?.bot ? 'connected' : 'disconnected'
    const activeMark = cfg.id === activeId ? '●' : ' '
    const row = `${activeMark} ${cfg.id.padEnd(10)} ${cfg.username.padEnd(20)} [${state}]`
    lines.push(i === menuState.selected ? `➤ \x1b[7m${row}\x1b[0m` : `  ${row}`)
  })
  lines.push('└──────────────────────────────────────────────────────────────────────')
  return lines
}

function drawMenuBlock() {
  const lines = buildMenuLines()
  process.stdout.write(lines.join('\n') + '\n')
  lastMenuLineCount = lines.length
}

function redrawMenu() {
  process.stdout.write(eraseLines(lastMenuLineCount))
  drawMenuBlock()
}

function openMenu() {
  if (mode === 'menu') return
  mode = 'menu'
  const startIdx = Math.max(0, accounts.findIndex(a => a.id === activeId))
  menuState = { selected: startIdx }

  // The menu has absolute priority: while it's open, no key reaches
  // chat/readline. We keep ALL keypress listeners that were registered
  // (readline + our own Ctrl+T shortcut) and restore them when it closes.
  const previousListeners = process.stdin.listeners('keypress').slice()
  previousListeners.forEach((fn) => process.stdin.removeListener('keypress', fn))

  readline.cursorTo(process.stdout, 0)
  readline.clearLine(process.stdout, 0)
  drawMenuBlock()

  const menuKeyHandler = (str, key) => {
    if (!key) return
    if (key.ctrl && key.name === 'c') { rl.close(); process.exit(0) }
    if (key.name === 'up') { menuState.selected = (menuState.selected - 1 + accounts.length) % accounts.length; redrawMenu() }
    else if (key.name === 'down') { menuState.selected = (menuState.selected + 1) % accounts.length; redrawMenu() }
    else if (key.name === 'return' || key.name === 'enter') {
      const chosen = accounts[menuState.selected]
      closeMenu(previousListeners, menuKeyHandler)
      selectAccount(chosen)
    } else if (key.name === 'escape') {
      closeMenu(previousListeners, menuKeyHandler)
      output('Account switch cancelled.')
    }
    // any other key is ignored: chat input can't "sneak in" while the menu is open
  }
  process.stdin.on('keypress', menuKeyHandler)
}

function closeMenu(previousListeners, menuKeyHandler) {
  process.stdin.removeListener('keypress', menuKeyHandler)
  previousListeners.forEach((fn) => process.stdin.on('keypress', fn))
  process.stdout.write(eraseLines(lastMenuLineCount))
  lastMenuLineCount = 0
  mode = 'chat'
  menuState = null
  prompt()
}

function selectAccount(cfg) {
  activeId = cfg.id
  output(`► Active account: ${activeId} (${cfg.username})`)
  broadcastStatus()
  if (!sessions.get(cfg.id)?.bot) {
    output('Not connected, connecting...')
    attemptConnect(cfg)
  }
}

// ─── Configurable hotkeys ("hotkeys" section of config.js) ───────────────
// Normalizes a combo like "Ctrl+Shift+G" / "ctrl + g" into a canonical,
// comparable form: modifiers sorted alphabetically + key name.
function normalizeCombo(str) {
  return String(str || '')
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join('+')
}

// Converts readline/Node's keypress event to the same canonical format.
function keyEventToCombo(key) {
  const parts = []
  if (key.ctrl) parts.push('ctrl')
  if (key.meta) parts.push('alt') // Node reports Alt as "meta"
  if (key.shift) parts.push('shift')
  const name = key.name || key.sequence
  if (!name) return null
  parts.push(String(name).toLowerCase())
  return parts.sort().join('+')
}

const hotkeyMap = new Map()
function loadHotkeys() {
  hotkeyMap.clear()
  for (const hk of hotkeysConfig) {
    if (!hk || !hk.combo || !hk.target || !hk.command) {
      output(`⚠ Invalid hotkey in config.js (missing fields): ${JSON.stringify(hk)}`)
      continue
    }
    const combo = normalizeCombo(hk.combo)
    if (!combo.includes('ctrl') && !combo.includes('alt') && !/^f\d{1,2}$/.test(combo)) {
      output(`⚠ Hotkey "${hk.combo}" doesn't include ctrl/alt and isn't a function key (f1-f12): it will also be typed into the prompt when pressed.`)
    }
    if (hotkeyMap.has(combo)) {
      output(`⚠ Duplicate hotkey, ignoring the repeat: ${hk.combo}`)
      continue
    }
    hotkeyMap.set(combo, hk)
  }
}
loadHotkeys()

// Hot-reloads the "hotkeys" section of config.js (without restarting the
// process): re-reads the file from disk (bypassing the require cache) and
// rebuilds the map.
function reloadHotkeys() {
  fullConfig = loadConfigModule()
  hotkeysConfig = fullConfig.hotkeys || []
  loadHotkeys()
  output(`↻ config.js reloaded (${hotkeyMap.size} hotkey(s)).`)
}

function listHotkeys() {
  if (!hotkeyMap.size) { output('No hotkeys configured (the "hotkeys" section of config.js is empty).'); return }
  const lines = [...hotkeyMap.values()].map(
    (hk) => `  ${hk.combo.padEnd(16)} → [${hk.target}] ${hk.command}`
  )
  output('Configured hotkeys:\n' + lines.join('\n'))
}

// Runs a command on the target(s) of a hotkey ('all' | 'active' | account id).
async function runOnTarget(target, command) {
  if (target === 'all') {
    for (const s of sessions.values()) {
      if (s.bot) await runCommand(s, command)
    }
    return
  }
  if (target === 'active') {
    const s = sessions.get(activeId)
    if (s?.bot) await runCommand(s, command)
    else output('[Hotkey] No active account connected.')
    return
  }
  const s = sessions.get(target)
  if (s?.bot) await runCommand(s, command)
  else output(`[Hotkey] Account ${target} not connected.`)
}

// ─── Hot-reload when saving config.js ──────────────────────────────────────
// Watches the file and, when it changes on disk, reloads it automatically
// without having to restart the process or type any command. Debounced
// because many editors generate several "change" events per save (they
// write to a temp file and then rename it).
function watchConfigReload(filename, reloadFn) {
  let timer = null
  try {
    fs.watch(path.join(__dirname, filename), { persistent: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(reloadFn, 200)
    })
  } catch {
    // The file doesn't exist yet (it's optional): there's nothing to watch
    // until it's created; a manual /reload or restart is needed until then.
  }
}

// Returns true if the key matched a hotkey (and the action has already been fired).
async function handleHotkeyPress(key) {
  const combo = keyEventToCombo(key)
  if (!combo) return false
  const hk = hotkeyMap.get(combo)
  if (!hk) return false
  output(`[Hotkey ${hk.combo}] → ${hk.command}  (${hk.target})`)
  await runOnTarget(hk.target, hk.command)
  return true
}

// ─── Configurable chat triggers ("triggers" section of config.js) ─────
// Same as hotkeys, but they fire when a message matching certain text is
// READ from the server's chat, instead of when a key combo is pressed.
// "match" accepts plain text (matches if the message CONTAINS it,
// case-insensitive) or a regex written as '/pattern/flags'.
function compileTriggerMatch(match) {
  const str = String(match || '')
  const m = str.match(/^\/(.*)\/([a-z]*)$/i)
  if (m) {
    try { return new RegExp(m[1], m[2]) } catch { return null }
  }
  return str // plain text
}

const triggerList = []
function loadTriggers() {
  triggerList.length = 0
  triggersConfig.forEach((tr) => {
    if (!tr || !tr.match || !tr.target || !tr.command) {
      output(`⚠ Invalid trigger in config.js (missing fields): ${JSON.stringify(tr)}`)
      return
    }
    const compiled = compileTriggerMatch(tr.match)
    if (compiled === null) {
      output(`⚠ Trigger with invalid regex in config.js: ${tr.match}`)
      return
    }
    triggerList.push({ ...tr, _compiled: compiled, _lastFired: new Map() })
  })
}
loadTriggers()

// Hot-reloads the "triggers" section of config.js (without restarting the process).
function reloadTriggers() {
  fullConfig = loadConfigModule()
  triggersConfig = fullConfig.triggers || []
  loadTriggers()
  output(`↻ config.js reloaded (${triggerList.length} trigger(s)).`)
}

function listTriggers() {
  if (!triggerList.length) { output('No chat triggers configured (the "triggers" section of config.js is empty).'); return }
  const lines = triggerList.map(
    (tr) => `  ${String(tr.match).padEnd(28)} → [${tr.target}] ${tr.command}`
  )
  output('Configured chat triggers:\n' + lines.join('\n'))
}

function textMatchesTrigger(text, tr) {
  if (tr._compiled instanceof RegExp) return tr._compiled.test(text)
  return text.toLowerCase().includes(tr._compiled.toLowerCase())
}

// Called with the chat text already stripped of color codes, and the
// config (cfg) of the account that received it, so 'self' can be resolved.
async function handleChatTriggers(cfg, text) {
  const now = Date.now()
  for (const tr of triggerList) {
    if (!textMatchesTrigger(text, tr)) continue
    const cooldown = tr.cooldown ?? 3000
    const last = tr._lastFired.get(cfg.id) || 0
    if (now - last < cooldown) continue
    tr._lastFired.set(cfg.id, now)
    const target = tr.target === 'self' ? cfg.id : tr.target
    log(cfg.id, `[Trigger "${tr.match}"] → ${tr.command}  (${target})`)
    await runOnTarget(target, tr.command)
  }
}

// ─── Configurable shop macros ("macros" section of config.js) ───────────
// Each macro defines a command like "/name <number> [delayMs]" that:
//   1. Sends a chat command that opens a window (e.g. "/gemas")
//   2. Waits for the server to open that window
//   3. Performs <number> clicks on a fixed slot, with a delay between each
// Format of the "macros" section of config.js:
//   macros: {
//     helmet: { openCommand: '/gemas', slot: 11 },
//   }
const DEFAULT_MACRO_DELAY_MS = 350
const DEFAULT_MACRO_WINDOW_TIMEOUT_MS = 8000

const macroMap = new Map()
function loadMacros() {
  macroMap.clear()
  for (const [name, def] of Object.entries(macrosConfig || {})) {
    if (!def || !def.openCommand || typeof def.slot !== 'number') {
      output(`⚠ Invalid macro in config.js (missing "openCommand"/"slot" fields): ${name}`)
      continue
    }
    macroMap.set(name.toLowerCase(), {
      name,
      openCommand: def.openCommand,
      slot: def.slot,
      button: def.button === 'right' ? 'right' : 'left',
      delayMs: typeof def.delayMs === 'number' ? def.delayMs : DEFAULT_MACRO_DELAY_MS,
      windowTimeoutMs: typeof def.windowTimeoutMs === 'number' ? def.windowTimeoutMs : DEFAULT_MACRO_WINDOW_TIMEOUT_MS,
      closeAfter: def.closeAfter !== false, // defaults to true: closes the menu when done
    })
  }
}
loadMacros()

// Hot-reloads the "macros" section of config.js (without restarting the process).
function reloadMacros() {
  fullConfig = loadConfigModule()
  macrosConfig = fullConfig.macros || {}
  loadMacros()
  output(`↻ config.js reloaded (${macroMap.size} macro(s)).`)
}

function listMacros() {
  if (!macroMap.size) { output('No shop macros configured (the "macros" section of config.js is empty).'); return }
  const lines = [...macroMap.values()].map(
    (m) => `  /${m.name.padEnd(12)} <number> [delayMs]  → ${m.openCommand}  slot ${m.slot} (click ${m.button}, default delay ${m.delayMs}ms, ${m.closeAfter ? 'closes when done' : 'does not close when done'})`
  )
  output('Configured shop macros:\n' + lines.join('\n'))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Waits for the bot to receive the next 'windowOpen' event (e.g. the shop
// opening after sending "/gemas"). If the server doesn't open anything in
// time, it rejects with a timeout so the macro doesn't hang forever.
function waitForWindowOpen(bot, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false
    const onOpen = (window) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(window)
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      bot.removeListener('windowOpen', onOpen)
      reject(new Error('timeout waiting for the window to open'))
    }, timeoutMs)
    bot.once('windowOpen', onOpen)
  })
}

// Runs a full shop macro: opens the window, waits for it to load, and
// performs the requested clicks on the configured slot with a delay
// between each one.
async function runBuyMacro(session, macro, times, delayMs) {
  const { bot, cfg } = session

  // If a window was already open from before, close it: otherwise the next
  // 'windowOpen' might not arrive (some servers don't reopen if one is
  // already open) and we'd confuse the slots of an old window with the shop's.
  if (bot.currentWindow) {
    try { bot.closeWindow(bot.currentWindow) } catch { /* not critical */ }
  }

  log(cfg.id, `[${macro.name}] Sending "${macro.openCommand}"...`)
  bot.chat(macro.openCommand)

  let window
  try {
    window = await waitForWindowOpen(bot, macro.windowTimeoutMs)
  } catch (err) {
    log(cfg.id, `[${macro.name}] No window opened (${err.message}). Macro cancelled.`)
    return
  }

  log(cfg.id, `[${macro.name}] Window opened (${window.title || window.type || 'shop'}). Doing ${times} click(s) on slot ${macro.slot}, delay ${delayMs}ms...`)

  const mouseButton = macro.button === 'right' ? 1 : 0
  let done = 0
  for (let i = 0; i < times; i++) {
    if (!bot.currentWindow) {
      log(cfg.id, `[${macro.name}] The window closed before finishing (${done}/${times} clicks done)`)
      return
    }
    try {
      await bot.clickWindow(macro.slot, mouseButton, 0)
      done++
    } catch (err) {
      log(cfg.id, `[${macro.name}] Error on click ${i + 1}/${times}: ${err.message}`)
    }
    if (i < times - 1) await sleep(delayMs)
  }
  log(cfg.id, `[${macro.name}] Done: ${done}/${times} clicks completed.`)

  // ─── Final window close ────────────────────────────────────────────
  // Many servers leave the shop menu open after buying; we close it the
  // same way the "/close" command would (sends the close_window packet to
  // the server), unless the macro disables this with closeAfter: false in
  // the "macros" section of config.js.
  if (macro.closeAfter !== false) {
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow)
        log(cfg.id, `[${macro.name}] Window closed.`)
      } catch (err) {
        log(cfg.id, `[${macro.name}] Error closing the window: ${err.message}`)
      }
    }
  }
}

// readline already enables keypress + raw mode internally for the TTY, so
// this doesn't interfere with normal line editing (arrows, history, etc).
readline.emitKeypressEvents(process.stdin, rl)
if (isTTY) process.stdin.setRawMode(true)
process.stdin.on('keypress', (str, key) => {
  if (!key) return
  if (key.ctrl && key.name === 'c') { rl.close(); process.exit(0) }
  if (key.ctrl && key.name === 't' && mode !== 'menu') { openMenu(); return }
  if (mode === 'menu') return // the menu has total priority, already handled in openMenu()
  handleHotkeyPress(key) // runs async in the background; doesn't block line editing
})

function stripFormatting(input) {
  if (input == null) return ''
  const text = typeof input === 'string' ? input
    : typeof input.toString === 'function' ? input.toString()
    : JSON.stringify(input)
  return text.replace(/§#[0-9a-fA-F]{6}/g, '').replace(/§[0-9a-fk-or]/gi, '')
}

// ─── External API: gem lookup ────────────────────────────────────────────
// Uses fetchJsonRetry (same helper as fetchClanTopData) to retry with
// backoff on 429/5xx instead of failing on the first try, and logs the
// real failure reason so we can tell "API down" apart from "rate limit"
// or "stats.gems field missing from the response".
async function fetchGemsForUsername(username, logId) {
  const url = `https://api.yourserver.net/api/v1/players/${encodeURIComponent(username)}`
  try {
    const json = await fetchJsonRetry(url)
    const gems = json?.stats?.gems
    if (typeof gems !== 'number') {
      if (logId) log(logId, `[gems] response without stats.gems for ${username}: ${JSON.stringify(json).slice(0, 200)}`)
      return null
    }
    return gems
  } catch (err) {
    if (logId) log(logId, `[gems] failed querying ${username}: ${err.status ? `HTTP ${err.status}` : err.message}`)
    return null
  }
}

// Generic GET against the server's public API: resolves with the parsed
// JSON, or rejects with an Error carrying `.status` (HTTP code) when
// available, so we can tell "not found" (4xx) apart from "rate limit /
// down" (429, 5xx).
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent: gemsApiAgent }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) }
          catch (err) { reject(err) }
        } else {
          const err = new Error(`HTTP ${res.statusCode}`)
          err.status = res.statusCode
          reject(err)
        }
      })
    }).on('error', reject)
  })
}

// Same as fetchJson but with retries + exponential backoff for 429
// (rate limit) and occasional 5xx errors from the API.
async function fetchJsonRetry(url, tries = 3, baseDelayMs = 600) {
  let lastErr
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fetchJson(url)
    } catch (err) {
      lastErr = err
      const retryable = err.status === 429 || (err.status && err.status >= 500) || !err.status
      if (!retryable || attempt === tries - 1) throw err
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt) + Math.random() * 200))
    }
  }
  throw lastErr
}

// ─── Clan gem leaderboard (used by the web panel) ───────────────────────────
// Runs on the backend (with no CORS restrictions) to prevent the browser
// from blocking direct requests to the server's API.
async function fetchClanTopData(slug, knownGems) {
  const clan = await fetchJsonRetry(`https://api.yourserver.net/api/v1/clans/${encodeURIComponent(slug)}`)
  const members = Array.isArray(clan.members) ? clan.members : []
  const results = []

  // Map of already-known gem counts (own accounts, already shown in the
  // panel) so we don't re-request them from the API and waste rate-limit
  // budget on redundant queries.
  const knownMap = new Map()
  if (Array.isArray(knownGems)) {
    for (const k of knownGems) {
      if (k && k.name && typeof k.gems === 'number') knownMap.set(String(k.name).toLowerCase(), k.gems)
    }
  }

  const toFetch = members.filter((m) => !knownMap.has(String(m.name).toLowerCase()))
  for (const m of members) {
    const cachedGems = knownMap.get(String(m.name).toLowerCase())
    if (cachedGems !== undefined) {
      results.push({ name: m.name, online: !!m.online, gems: cachedGems })
    }
  }

  const CONCURRENCY = 3
  const STAGGER_MS = 150
  let idx = 0

  await new Promise((resolve) => {
    if (!toFetch.length) { resolve(); return }
    let done = 0
    function launchNext() {
      if (idx >= toFetch.length) return
      const m = toFetch[idx++]
      fetchJsonRetry(`https://api.yourserver.net/api/v1/players/${encodeURIComponent(m.name)}`)
        .then((data) => {
          results.push({ name: m.name, online: !!m.online, gems: typeof data?.stats?.gems === 'number' ? data.stats.gems : null })
        })
        .catch(() => {
          results.push({ name: m.name, online: !!m.online, gems: null })
        })
        .finally(() => {
          done++
          if (done === toFetch.length) resolve()
          else launchNext()
        })
    }
    for (let k = 0; k < CONCURRENCY; k++) setTimeout(launchNext, k * STAGGER_MS)
  })

  results.sort((a, b) => (b.gems ?? -1) - (a.gems ?? -1))
  const known = results.filter((r) => r.gems != null).length
  const total = results.reduce((sum, r) => sum + (r.gems || 0), 0)
  return { slug, clanName: clan.name || slug, members: results, total, known, count: members.length }
}

function log(id, msg) {
  output(`[${id}] ${msg}`)
  broadcast({ type: 'log', id, msg })
}

// ─── Generated-gems history (/paygemas) — persisted to disk ─────────
// Loading/saving to disk lives in history.js (public/gems-history.json).
// Here we just wrap those calls to notify connected clients over
// WebSocket when there's a new entry or the history gets cleared.
function addGemsHistoryEntry(entry) {
  gemsHistoryStore.add(entry)
  broadcast({ type: 'gems_history_add', entry })
}

function clearGemsHistory() {
  gemsHistoryStore.clear()
  broadcast({ type: 'gems_history', history: gemsHistoryStore.getAll() })
}

function formatWindow(window) {
  const lines = []
  window.slots.forEach((item, i) => {
    if (item) lines.push(`  [${i}] ${item.displayName} x${item.count}`)
  })
  return lines.length ? lines.join('\n') : '  (empty)'
}

function printWindow(id, window) {
  output(`[${id}] Window: ${window.title || window.type || 'inventory'} (${window.slots.length} slots)\n${formatWindow(window)}`)
}

// ─── Per-session auto-click ───────────────────────────────────────────────────
function makeAutoClick(session) {
  return {
    interval: null,
    active: false,
    button: 'right',
    ms: 100,
    start(button = 'right', ms = 100) {
      this.stop()
      this.button = button
      this.ms = ms
      this.active = true
      this.interval = setInterval(() => {
        const bot = session.bot
        if (!bot) return
        if (button === 'right') bot.activateItem()
        else bot.swingArm()
      }, ms)
      log(session.cfg.id, `[AutoClick] ▶ ${button} every ${ms}ms`)
    },
    stop() {
      if (this.interval) clearInterval(this.interval)
      this.interval = null
      this.active = false
    },
    toggle(button, ms) {
      if (this.active) { this.stop(); log(session.cfg.id, '[AutoClick] ■ Disabled') }
      else this.start(button, ms)
    },
  }
}

// ─── Reconnection synchronization across accounts ──────────────────────────────
// Requested rules:
//  1. When an account disconnects, wait 15s and retry connecting.
//  2. If that attempt fails, wait 1 minute and try again (and so on for
//     every subsequent failure, every 1 minute).
//  3. If any attempt fails because the SERVER is down (not the account:
//     a network error while connecting, not a kick/failed login), stop
//     retrying per account and switch to checking every 1 minute whether
//     the server responds again.
//  4. Once the server is operational again, wait 30s and start
//     reconnecting the accounts.
//  5. All accounts (startup, automatic reconnection, manual /connect, and
//     the web panel) share the same "turn" per server so two connections
//     aren't fired less than 15s apart, because the server rejects
//     connections that arrive too close together.
const RECONNECT_FIRST_DELAY_MS = 15000    // wait after disconnect before the 1st retry
const RECONNECT_RETRY_DELAY_MS = 60000    // wait between retries if the previous one failed
const SERVER_DOWN_CHECK_INTERVAL_MS = 60000 // check frequency while the server is down
const SERVER_UP_RESUME_DELAY_MS = 30000   // wait after detecting the server is back
const MIN_CONNECT_GAP_MS = 15000          // minimum gap between attempts to the same server

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function serverKey(cfg) { return `${cfg.host}:${cfg.port}` }

// key (host:port) → { queueTail, lastAttemptAt, down, checking }
const serverGates = new Map()
function getServerGate(cfg) {
  const key = serverKey(cfg)
  let gate = serverGates.get(key)
  if (!gate) {
    gate = { key, queueTail: Promise.resolve(), lastAttemptAt: 0, down: false, checking: false }
    serverGates.set(key, gate)
  }
  return gate
}

// Reserves a turn to try connecting to `cfg`'s server, waiting as needed
// so at least MIN_CONNECT_GAP_MS has passed since the last attempt to
// THAT SAME server (counting any account's attempt). Chained on a shared
// promise (`queueTail`) so two accounts requesting a turn "at the same
// time" don't compute the same gap and end up connecting together.
function reserveConnectSlot(cfg) {
  const gate = getServerGate(cfg)
  const turn = gate.queueTail.then(async () => {
    const wait = Math.max(0, gate.lastAttemptAt + MIN_CONNECT_GAP_MS - Date.now())
    if (wait > 0) await sleep(wait)
    gate.lastAttemptAt = Date.now()
  })
  gate.queueTail = turn.catch(() => {})
  return turn
}

// Distinguishes an "account" failure (wrong login, kick, version
// mismatch, etc., where we did manage to talk to the server) from a
// "server" failure (nobody's listening / not responding / network cut).
function isServerDownError(err) {
  if (!err) return false
  const code = err.code || ''
  const knownCodes = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET']
  if (knownCodes.includes(code)) return true
  return new RegExp(knownCodes.join('|') + '|timed out', 'i').test(String(err.message || ''))
}

// Low-level (pure TCP) check for whether the server is responding, without
// going through mineflayer's full handshake/login.
function checkServerReachable(cfg) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port, timeout: 5000 })
    const finish = (ok) => { socket.destroy(); resolve(ok) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// Marks the server as down (if it wasn't already) and starts the periodic
// check every minute until it responds again.
function markServerDown(cfg) {
  const gate = getServerGate(cfg)
  if (gate.down) return
  gate.down = true
  log(cfg.id, `Server ${gate.key} appears to be down. Checking every ${SERVER_DOWN_CHECK_INTERVAL_MS / 1000}s until it's back...`)
  if (gate.checking) return
  gate.checking = true

  const tick = async () => {
    if (!gate.down) { gate.checking = false; return }
    const ok = await checkServerReachable(cfg)
    if (!ok) { setTimeout(tick, SERVER_DOWN_CHECK_INTERVAL_MS); return }

    log(cfg.id, `Server ${gate.key} is responding again. Waiting ${SERVER_UP_RESUME_DELAY_MS / 1000}s before reconnecting accounts...`)
    await sleep(SERVER_UP_RESUME_DELAY_MS)
    gate.down = false
    gate.checking = false
    resumeAccountsForServer(gate.key)
  }
  setTimeout(tick, SERVER_DOWN_CHECK_INTERVAL_MS)
}

// Reconnects (respecting each one's 15s turn) every account on a given
// server that's disconnected and pending automatic reconnection, once
// it's confirmed the server is operational again.
function resumeAccountsForServer(key) {
  for (const session of sessions.values()) {
    if (serverKey(session.cfg) !== key) continue
    if (session.bot) continue
    if (session.manualDisconnect) continue
    if (session.cfg.autoRelog === false) continue
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
    session.reconnectTimer = null
    attemptConnect(session.cfg)
  }
}

// Single entry point for connecting an account: startup, automatic
// reconnection, manual `/connect`, and the web panel all go through here,
// so they all respect the same minimum gap between connections to the server.
function attemptConnect(cfg) {
  const gate = getServerGate(cfg)
  if (gate.down) return // the periodic check in markServerDown takes care of resuming
  reserveConnectSlot(cfg).then(() => connect(cfg))
}

// ─── Create/connect an account ───────────────────────────────────────────────
function connect(cfg) {
  let session = sessions.get(cfg.id)
  if (session?.bot) session.bot.end()
  if (session?.reconnectTimer) clearTimeout(session.reconnectTimer)

  if (!session) {
    session = { cfg, bot: null, autoClick: null, manualDisconnect: false, retries: 0, reconnectTimer: null, muted: !!cfg.mute }
    session.autoClick = makeAutoClick(session)
    sessions.set(cfg.id, session)
  } else {
    session.manualDisconnect = false
    session.reconnectTimer = null
  }

  session.spawnedThisAttempt = false
  session.lastError = null

  const bot = mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    version: cfg.version,
    auth: cfg.auth,
  })
  session.bot = bot
  patchNoisyScoreboardListeners(bot, cfg.id)

  // mineflayer can emit 'spawn' more than once within the SAME connection
  // (some servers send several position/teleport packets in a row right
  // after joining — warps, internal respawns, etc. — and each one fires a
  // 'spawn'). This flag lives in connect()'s closure, so it resets itself
  // on every new real connection, and prevents /login and spawnCommand
  // from being resent multiple times in the same session.
  let firstSpawnHandled = false

  bot.on('spawn', () => {
    session.retries = 0
    session.spawnedThisAttempt = true
    broadcastStatus()
    prompt()

    if (firstSpawnHandled) return
    firstSpawnHandled = true

    log(cfg.id, `Connected to ${cfg.host}:${cfg.port}`)
    if (cfg.password) bot.chat(`/login ${cfg.password}`)

    // ─── spawnCommand (config.js): command(s) the account runs on its own
    // right after joining. Accepts a single string or an array of strings
    // (sent in order). If the account does /login (has a "password"), we
    // wait a bit to give the server time to process the login before
    // sending more commands; if there's no login, it's sent right away.
    if (cfg.spawnCommand) {
      const spawnCommands = Array.isArray(cfg.spawnCommand) ? cfg.spawnCommand : [cfg.spawnCommand]
      const spawnDelay = cfg.password ? 1200 : 0
      setTimeout(() => {
        ;(async () => {
          for (const cmd of spawnCommands) {
            if (!cmd) continue
            try {
              await runCommand(session, cmd)
              log(cfg.id, `[SpawnCommand] ${cmd}`)
            } catch (err) {
              log(cfg.id, `[SpawnCommand error] ${err.message}`)
            }
          }
        })()

      }, spawnDelay)
    }
  })

  const seen = new Set()
  bot.on('message', (jsonMsg, position) => {
    if (position === 'game_info') return
    let text = stripFormatting(
      typeof jsonMsg.toMotd === 'function' ? jsonMsg.toMotd() : jsonMsg
    ).trim()
    if (!text) return

    // ─── Auto-register: if the server mentions "register", we send /register <pass> <pass> ──
    // Runs before the "muted" check so it always works, with a cooldown so
    // we don't spam the command if the server prints several lines in a
    // row containing that word.
    if (cfg.password && /register/i.test(text)) {
      const now = Date.now()
      if (now - (session.lastAutoRegister || 0) > 5000) {
        session.lastAutoRegister = now
        bot.chat(`/register ${cfg.password} ${cfg.password}`)
        log(cfg.id, `[AutoRegister] Sent: /register ${cfg.password} ${cfg.password}`)
      }
    }

    // ─── Chat triggers: like auto-register, these work even while "muted" ──
    handleChatTriggers(cfg, text).catch((err) => log(cfg.id, `[Trigger error] ${err.message}`))

    if (seen.has(text)) { seen.delete(text); return }
    seen.add(text)
    setImmediate(() => seen.delete(text))

    // ─── Log to file: only the "primary" account, even if it's muted in
    // the console/panel (the file wants to save ALL of the chat, not just
    // what's shown). ──
    if (cfg.id === PRIMARY_ACCOUNT_ID) writeChatLog(text)

    if (session.muted) return
    log(cfg.id, text)
  })

  bot.on('windowOpen', (window) => {
    if (session.muted) return
    printWindow(cfg.id, window)
  })

  bot.on('death', () => { session.autoClick.stop(); bot.respawn() })
  bot.on('kicked', (reason) => log(cfg.id, `Kicked: ${stripFormatting(reason)}`))
  bot.on('error', (err) => {
    session.lastError = err
    if (!isKnownNoisyError(err)) log(cfg.id, `[Error] ${err.message}`)
  })
  bot.on('end', async (reason) => {
    log(cfg.id, `Disconnected: ${reason}`)
    session.autoClick.stop()
    session.bot = null
    broadcastStatus()
    await sendDiscordWebhook(cfg.id, reason)
    log(cfg.id, 'Notification sent to Discord.')

    if (session.manualDisconnect) return
    if (cfg.autoRelog === false) {
      log(cfg.id, 'autoRelog disabled in config.js: it will not reconnect on its own.')
      return
    }

    // Connection failure (never managed to spawn) due to a typical
    // "server isn't up" network error: stop retrying per account and
    // switch to checking every minute until it's back.
    if (!session.spawnedThisAttempt && isServerDownError(session.lastError)) {
      markServerDown(cfg)
      return
    }

    session.retries += 1
    const delay = session.retries <= 1 ? RECONNECT_FIRST_DELAY_MS : RECONNECT_RETRY_DELAY_MS
    log(cfg.id, `Retrying connection in ${delay / 1000}s (attempt ${session.retries})...`)
    session.reconnectTimer = setTimeout(() => attemptConnect(cfg), delay)
  })

  return session
}

// ─── Persisting "multi" to config.js ───────────────────────────────────────
// Rewrites ONLY the "multi" field of the given account's block inside
// config.js, leaving the rest of the file (formatting, comments, other
// accounts) untouched. Uses brace matching instead of a regex over the
// whole file so it doesn't accidentally touch another account's "multi".
const CONFIG_PATH = path.join(__dirname, 'config.js')
function persistMultiToConfig(id, value) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')

    const idMatch = new RegExp(`id:\\s*['"]${id}['"]`).exec(raw)
    if (!idMatch) { log(id, '[Notice] Not saved to config.js: id not found in the file.'); return }

    // Backs up to the '{' that opens this account's object.
    const start = raw.lastIndexOf('{', idMatch.index)
    if (start === -1) { log(id, '[Notice] Not saved to config.js: could not locate the start of the object.'); return }

    // Advances to the '}' that closes that same object, counting nesting.
    let depth = 0, end = -1
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++
      else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) { log(id, '[Notice] Not saved to config.js: could not locate the end of the object.'); return }

    const block = raw.slice(start, end + 1)
    const newBlock = /multi\s*:\s*[\d.]+/.test(block)
      ? block.replace(/multi\s*:\s*[\d.]+/, `multi: ${value}`)
      : block.replace(/\}\s*$/, `  multi: ${value},\n}`) // if the account didn't have "multi", add it

    fs.writeFileSync(CONFIG_PATH, raw.slice(0, start) + newBlock + raw.slice(end + 1), 'utf8')
    log(id, 'Saved to config.js.')
  } catch (err) {
    log(id, `[Notice] Could not save multi to config.js: ${err.message}`)
  }
}

// ─── Run a command on a specific bot ──────────────────────────────────────
async function runCommand(session, trimmed) {
  const { bot, autoClick, cfg } = session
  if (!bot) { log(cfg.id, 'Not connected. Use /connect ' + cfg.id); return }

  // ─── Dynamic shop macros (e.g. "/helmet 5" defined in config.js) ────
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/)
    const macro = macroMap.get(parts[0].toLowerCase())
    if (macro) {
      const times = parseInt(parts[1], 10)
      if (isNaN(times) || times <= 0) { log(cfg.id, `Usage: /${macro.name} <number of clicks> [delayMs]`); return }
      const delayMs = parts[2] != null && !isNaN(parseInt(parts[2], 10)) ? parseInt(parts[2], 10) : macro.delayMs
      await runBuyMacro(session, macro, times, delayMs)
      return
    }
  }

  if (trimmed === '/stats') {
    log(cfg.id, `❤ ${bot.health?.toFixed(1) ?? '?'}  🍗 ${bot.food ?? '?'}`)
    return
  }
  if (trimmed === '/pos') {
    const p = bot.entity.position
    log(cfg.id, `x:${p.x.toFixed(2)} y:${p.y.toFixed(2)} z:${p.z.toFixed(2)}`)
    return
  }
  if (trimmed.startsWith('/use')) {
    const parts = trimmed.split(/\s+/)
    if (parts[1] != null) {
      const slot = parseInt(parts[1], 10)
      if (!isNaN(slot) && slot >= 0 && slot <= 8) bot.setQuickBarSlot(slot)
    }
    bot.activateItem()
    log(cfg.id, 'Right click')
    return
  }
  if (trimmed.startsWith('/equip')) {
    const slot = parseInt(trimmed.split(/\s+/)[1], 10)
    if (isNaN(slot) || slot < 0 || slot > 8) { log(cfg.id, 'Usage: /equip <slot 0-8>'); return }
    bot.setQuickBarSlot(slot)
    const item = bot.inventory.slots[36 + slot]
    log(cfg.id, `Hand: ${item ? item.displayName : 'Empty'}`)
    return
  }
  if (trimmed.startsWith('/click')) {
    const parts = trimmed.split(/\s+/)
    const slot = parseInt(parts[1], 10)
    if (isNaN(slot) || !bot.currentWindow) { log(cfg.id, 'No window open or invalid slot'); return }
    const action = parts[2] || 'left'
    let mouseButton = 0, mode = 0
    if (action === 'right') mouseButton = 1
    if (action === 'shift') mode = 1
    if (action === 'drop') mode = 4
    try { await bot.clickWindow(slot, mouseButton, mode); log(cfg.id, `Click ${action} slot ${slot}`) }
    catch (err) { log(cfg.id, `Error: ${err.message}`) }
    return
  }
  if (trimmed === '/inv') {
    if (bot.currentWindow) printWindow(cfg.id, bot.currentWindow)
    else printWindow(cfg.id, bot.inventory)
    return
  }
  if (trimmed === '/close') {
    if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); log(cfg.id, 'Window closed') }
    else log(cfg.id, 'No window open')
    return
  }
  if (trimmed.startsWith('/autoclick')) {
    const parts = trimmed.split(/\s+/)
    let button = autoClick.button, ms = autoClick.ms
    if (parts[1] === 'left' || parts[1] === 'right') button = parts[1]
    if (parts[2] && !isNaN(parseInt(parts[2], 10))) ms = parseInt(parts[2], 10)
    autoClick.toggle(button, ms)
    return
  }
  if (trimmed.startsWith('/look ')) {
    const [, yawS, pitchS] = trimmed.split(/\s+/)
    const yaw = parseFloat(yawS), pitch = parseFloat(pitchS)
    if (isNaN(yaw) || isNaN(pitch)) { log(cfg.id, 'Usage: /look <yaw> <pitch>'); return }
    const toRad = d => (d * Math.PI) / 180
    bot.entity.yaw = toRad(yaw)
    bot.entity.pitch = toRad(pitch)
    bot._client.write('position_look', {
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
      yaw, pitch, flags: 0x00, teleportId: 0,
    })
    log(cfg.id, `Looking yaw:${yaw}° pitch:${pitch}°`)
    return
  }
  if (trimmed.startsWith('/lookat')) {
    const [, xs, ys, zs] = trimmed.split(/\s+/)
    const x = parseFloat(xs), y = parseFloat(ys), z = parseFloat(zs)
    if ([x, y, z].some(isNaN)) { log(cfg.id, 'Usage: /lookat <x> <y> <z>'); return }
    await bot.lookAt({ x, y, z }, true)
    log(cfg.id, `Looking at (${x}, ${y}, ${z})`)
    return
  }
  if (trimmed === '/drop') {
    const item = bot.heldItem
    if (!item) { log(cfg.id, 'Nothing in hand'); return }
    try { await bot.tossStack(item); log(cfg.id, `Dropped: ${item.displayName} x${item.count}`) }
    catch (err) { log(cfg.id, `Error: ${err.message}`) }
    return
  }
  if (trimmed === '/dropall') {
    const items = bot.inventory.items()
    if (!items.length) { log(cfg.id, 'Inventory empty'); return }
    log(cfg.id, `Dropping ${items.length} stacks...`)
    for (const item of items) {
      try { await bot.tossStack(item) }
      catch (err) { log(cfg.id, `Error dropping ${item.displayName}: ${err.message}`) }
    }
    log(cfg.id, 'Inventory emptied')
    return
  }
  if (trimmed === '/dropallgui') {
    const win = bot.currentWindow
    if (!win) { log(cfg.id, 'No window open. Use /dropall for the inventory.'); return }
    // win.slots includes both the container's slots (chest, ender chest,
    // etc.) and the player's inventory slots, so a single sweep empties both.
    const slotsWithItems = []
    win.slots.forEach((item, i) => { if (item) slotsWithItems.push(i) })
    if (!slotsWithItems.length) { log(cfg.id, 'Window and inventory are already empty'); return }
    log(cfg.id, `Dropping ${slotsWithItems.length} stacks (window + inventory)...`)
    for (const slot of slotsWithItems) {
      try { await bot.clickWindow(slot, 1, 4) } // mode 4 = drop, button 1 = whole stack
      catch (err) { log(cfg.id, `Error dropping slot ${slot}: ${err.message}`) }
    }
    log(cfg.id, 'Window and inventory emptied')
    return
  }

  if (trimmed.startsWith('/multi')) {
    const parts = trimmed.split(/\s+/)
    if (parts[1] == null) {
      log(cfg.id, `Current multi: x${typeof cfg.multi === 'number' ? cfg.multi : 1}`)
      return
    }
    const value = parseFloat(parts[1])
    if (isNaN(value)) { log(cfg.id, 'Usage: /multi [number]'); return }
    cfg.multi = value
    log(cfg.id, `Multi updated to x${value}`)
    persistMultiToConfig(cfg.id, value)
    broadcastStatus()
    return
  }

  if (trimmed.startsWith('/paygemas') || trimmed.startsWith('paygemas')) {
    const parts = trimmed.split(/\s+/)
    const targetName = parts[1]
    if (!targetName) { log(cfg.id, 'Usage: /paygemas <name>'); return }
    log(cfg.id, `Checking ${cfg.username}'s gems...`)
    const gems = await fetchGemsForUsername(cfg.username, cfg.id)
    if (gems == null) { log(cfg.id, `Could not get the gem count for ${cfg.username} (API down or error)`); return }
    if (gems <= 0) { log(cfg.id, `${cfg.username} has no gems (0), nothing sent`); return }
    const cmd = `/gemas pagar ${targetName} ${gems}`
    bot.chat(cmd)
    log(cfg.id, `Sent: ${cmd}`)
    addGemsHistoryEntry({ ts: Date.now(), botId: cfg.id, target: targetName, gems })
    return
  }

  // Anything else → chat
  bot.chat(trimmed)
}

// ─── Multi-account management commands ────────────────────────────────────────
function listAccounts() {
  const lines = accounts.map((cfg) => {
    const s = sessions.get(cfg.id)
    const state = s?.bot ? 'connected' : 'disconnected'
    const mark = cfg.id === activeId ? '►' : ' '
    return `${mark} ${cfg.id.padEnd(12)} ${cfg.username.padEnd(20)} [${state}]`
  })
  output(lines.join('\n'))
}

rl.on('line', async (line) => {
  const trimmed = line.trim()

  if (!trimmed) { prompt(); return }

  if (trimmed === '/help') {
    output(`
Ctrl+T                   → Opens the interactive menu to switch accounts
/hotkeys                 → Lists the hotkeys configured in config.js
/triggers                → Lists the chat triggers configured in config.js
/macros                  → Lists the shop macros configured in config.js
/reload                  → Manually reloads hotkeys/triggers/macros from config.js (also reloads on save)
/reloadhotkeys           → Reloads only the "hotkeys" section of config.js
/reloadtriggers          → Reloads only the "triggers" section of config.js
/reloadmacros            → Reloads only the "macros" section of config.js
/accounts                → Lists accounts and their status
/switch <id>             → Switches the active account
/connect <id>            → Connects/reconnects an account
/disconnect [id]         → Disconnects an account (defaults to the active one)
/mute                    → Stops showing the active account's chat/system messages
/unmute                  → Shows the active account's chat again
/all <command or text>   → Runs the command/message on ALL connected accounts
/q                       → Quit and disconnect everything

Per-account commands (active account or via /all):
  /stats /pos /inv /use [slot] /equip <slot> /click <slot> [left|right|shift|drop]
  /close /autoclick [left|right] [ms] /look <yaw> <pitch> /lookat <x> <y> <z>
  /drop  /dropall  /dropallgui
  /multi [number]          → Without a number: shows the account's current multi
                              With a number: changes the account's multi (shown in the web panel)
  /paygemas <name>         → Sends "/gemas pagar <name> <gems>" with the bot's current gems
                              (use /all paygemas <name> to empty ALL bots to that person)
  /<macro> <number> [ms]   → Shop macros defined in config.js (e.g. "/helmet 5")
                              Sends the open command, waits for the window, and does
                              <number> clicks on the configured slot, with [ms] delay between each
  (any other text is sent as chat)
`)
    prompt(); return
  }

  if (trimmed === '/accounts') { listAccounts(); prompt(); return }

  if (trimmed === '/hotkeys') { listHotkeys(); prompt(); return }

  if (trimmed === '/triggers') { listTriggers(); prompt(); return }

  if (trimmed === '/reloadhotkeys') { reloadHotkeys(); prompt(); return }

  if (trimmed === '/reloadtriggers') { reloadTriggers(); prompt(); return }

  if (trimmed === '/macros') { listMacros(); prompt(); return }

  if (trimmed === '/reloadmacros') { reloadMacros(); prompt(); return }

  if (trimmed === '/reload') { reloadAllFromConfig(); prompt(); return }

  if (trimmed.startsWith('/switch')) {
    const id = trimmed.split(/\s+/)[1]
    if (!accounts.find(a => a.id === id)) output('Account not found in config.js')
    else { activeId = id; broadcastStatus() }
    prompt(); return
  }

  if (trimmed.startsWith('/connect')) {
    const id = trimmed.split(/\s+/)[1] || activeId
    const cfg = accounts.find(a => a.id === id)
    if (!cfg) output('Account not found in config.js')
    else attemptConnect(cfg)
    prompt(); return
  }

  if (trimmed.startsWith('/disconnect')) {
    const id = trimmed.split(/\s+/)[1] || activeId
    const s = sessions.get(id)
    if (s) {
      s.manualDisconnect = true
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      if (s.bot) s.bot.end('Manual disconnect')
      else output('That account is not connected')
    } else output('That account is not connected')
    prompt(); return
  }

  if (trimmed === '/mute') {
    const s = sessions.get(activeId)
    if (s) { s.muted = true; output(`[${activeId}] Chat muted`); broadcastStatus() }
    prompt(); return
  }

  if (trimmed === '/unmute') {
    const s = sessions.get(activeId)
    if (s) { s.muted = false; output(`[${activeId}] Chat unmuted`); broadcastStatus() }
    prompt(); return
  }

  if (trimmed === '/q' || trimmed === '/quit') {
    for (const s of sessions.values()) {
      s.manualDisconnect = true
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      s.autoClick.stop()
      s.bot?.end('Manual shutdown')
    }
    rl.close()
    process.exit(0)
  }

  if (trimmed.startsWith('/all ')) {
    const cmd = trimmed.slice(5)
    for (const s of sessions.values()) {
      if (s.bot) await runCommand(s, cmd)
    }
    prompt(); return
  }

  // Normal command → goes to the active account
  const active = sessions.get(activeId)
  if (!active) { output('No active account connected. Use /connect ' + activeId); prompt(); return }
  await runCommand(active, trimmed)
  prompt()
})

// ─── Web panel ───────────────────────────────────────────────────────────
function getLanUrls(port) {
  const urls = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}`)
    }
  }
  return urls
}

function startWebServer() {
  const app = express()
  app.use(express.static(path.join(__dirname, 'public')))

  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    wsClients.add(ws)
    ws.send(JSON.stringify({ type: 'snapshot', accounts: accountsSnapshot() }))
    ws.send(JSON.stringify({ type: 'gems_history', history: gemsHistoryStore.getAll() }))

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      handleWebMessage(msg)
    })

    ws.on('close', () => wsClients.delete(ws))
  })

  server.listen(webConfig.port, '0.0.0.0', () => {
    output(`Web panel listening on port ${webConfig.port}. Access it from other devices on your network at:`)
    const urls = getLanUrls(webConfig.port)
    if (urls.length) urls.forEach((u) => output(`  ${u}`))
    else output(`  http://localhost:${webConfig.port} (no local network IP detected)`)
  })
}

async function handleWebMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return

  if (msg.type === 'connect') {
    const cfg = accounts.find((a) => a.id === msg.id)
    if (cfg) attemptConnect(cfg)
    return
  }

  if (msg.type === 'disconnect') {
    const s = sessions.get(msg.id)
    if (s?.bot) {
      s.manualDisconnect = true
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      s.bot.end('Manual disconnect (web panel)')
    }
    return
  }

  if (msg.type === 'mute' || msg.type === 'unmute') {
    const s = sessions.get(msg.id)
    if (s) { s.muted = msg.type === 'mute'; broadcastStatus() }
    return
  }

  if (msg.type === 'command') {
    const text = String(msg.text || '').trim()
    if (!text) return
    if (msg.all) {
      for (const s of sessions.values()) {
        if (s.bot) await runCommand(s, text)
      }
    } else {
      const s = sessions.get(msg.id)
      if (s) await runCommand(s, text)
    }
    return
  }

  if (msg.type === 'gems_history_clear') {
    clearGemsHistory()
    return
  }

  if (msg.type === 'clantop_request') {
    const slug = String(msg.slug || 'gems').trim().toLowerCase()
    try {
      const data = await fetchClanTopData(slug, msg.known)
      broadcast({ type: 'clantop_result', ...data })
    } catch (err) {
      broadcast({ type: 'clantop_result', slug, error: err.message || 'Could not load the clan', members: [], total: 0, known: 0, count: 0 })
    }
    return
  }
}


const seenIds = new Set()
const dupIds = new Set()
for (const cfg of accounts) {
  if (seenIds.has(cfg.id)) dupIds.add(cfg.id)
  seenIds.add(cfg.id)
}
if (dupIds.size) {
  output(`⚠ WARNING: duplicate id(s) in config.js: ${[...dupIds].join(', ')}. Each account needs a unique id or they'll overwrite each other.`)
}

// reserveConnectSlot itself already takes care of spacing each attempt at
// least MIN_CONNECT_GAP_MS apart from the previous one per server, so
// there's no need to stagger by hand here: every turn is requested right
// away, and they get resolved in order while respecting the minimum gap.
// Reloads the "hotkeys"/"triggers"/"macros" sections of config.js all at
// once (used by the single-file watcher below and by /reload).
function reloadAllFromConfig() {
  fullConfig = loadConfigModule()
  hotkeysConfig = fullConfig.hotkeys || []
  triggersConfig = fullConfig.triggers || []
  macrosConfig = fullConfig.macros || {}
  loadHotkeys()
  loadTriggers()
  loadMacros()
  output(`↻ config.js reloaded (${hotkeyMap.size} hotkey(s), ${triggerList.length} trigger(s), ${macroMap.size} macro(s)).`)
}

initChatLog()
accounts.forEach((cfg) => attemptConnect(cfg))
startWebServer()
// Note: "accounts" (the accounts themselves) are NOT hot-reloaded when
// config.js is saved — only hotkeys/triggers/macros. Changing accounts
// requires restarting the process, just like before when they lived in
// their own file.
watchConfigReload('config.js', reloadAllFromConfig)
prompt()
