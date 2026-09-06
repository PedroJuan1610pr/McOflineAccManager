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

// El resolver DNS del sistema ha dado problemas de forma recurrente
// (EAI_AGAIN al resolver widowmc.net, tanto aquí como en la conexión al
// servidor de Minecraft). Forzamos a Node a usar DNS públicos en vez del
// resolver por defecto de la máquina/ISP.
dns.setServers(['1.1.1.1', '8.8.8.8'])
const webConfig = require('./webconfig')

// Agente keep-alive compartido para las peticiones a api.widowmc.net: reutiliza
// la conexión TCP/TLS entre peticiones para no tener que resolver DNS de nuevo
// en cada llamada. Bajo ráfagas de peticiones concurrentes (varios bots pidiendo
// gemas a la vez), hacer una resolución DNS por petición puede saturar el
// resolver del sistema y provocar errores EAI_AGAIN aunque el DNS funcione bien
// en general.
const widowmcAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })

// Carga (o recarga) config.js, limpiando antes la cache de require para poder
// leer cambios en caliente sin reiniciar el proceso (si no, Node devolvería
// siempre la versión ya cacheada). config.js unifica en un solo fichero las
// cuentas, hotkeys, triggers y macros (antes repartidos en hotkeys.js/
// triggers.js/macros.js separados).
function loadConfigModule() {
  try {
    const fullPath = require.resolve('./config')
    delete require.cache[fullPath]
    return require(fullPath)
  } catch (err) {
    output(`⚠ Error cargando config.js: ${err.message}`)
    return { accounts: [], hotkeys: [], triggers: [], macros: {} }
  }
}

let fullConfig = loadConfigModule()
const accounts = fullConfig.accounts || []
let hotkeysConfig = fullConfig.hotkeys || []
let triggersConfig = fullConfig.triggers || []
let macrosConfig = fullConfig.macros || {}

// ─── Blindaje: que un error interno de una librería no tire abajo TODO el proceso ──
process.on('uncaughtException', (err) => {
  if (isKnownNoisyError(err)) return
  console.error(`[uncaughtException] ${err.message}`)
})
process.on('unhandledRejection', (err) => {
  if (isKnownNoisyError(err)) return
  console.error(`[unhandledRejection] ${err?.message || err}`)
})

// Bug conocido: algunos servidores mandan un scoreboard/tablist personalizado
// (ej. "wtab_sb") que la librería mineflayer no reconoce. Es inofensivo, solo ruido.
function isKnownNoisyError(err) {
  const msg = err?.message || String(err || '')
  return msg.includes('unknown objective')
}

// ─── Blindaje de raíz para el bug de scoreboard.js ("unknown objective") ────
// El plugin interno de mineflayer (lib/plugins/scoreboard.js) registra un
// listener sobre bot._client para los paquetes 'scoreboard_score' y
// 'scoreboard_objective' que hace throw() si el servidor manda una
// actualización para un objective que el bot no tiene registrado (algunos
// servidores mandan tablists/scoreboards personalizados, ej. "wtab_sb", que
// disparan esto). Ese throw ocurre dentro del propio listener del cliente de
// protocolo, en medio de varias capas de streams internas, y a veces escapa
// del process.on('uncaughtException') de más abajo antes de llegar a él,
// tirando el proceso entero con el stack completo.
//
// La forma fiable de neutralizarlo es en el origen: quitamos temporalmente
// los listeners que puso mineflayer para esos dos paquetes, y los volvemos a
// poner envueltos en un try/catch que solo traga el error "unknown
// objective" conocido (cualquier otro error se relanza tal cual, para no
// esconder bugs distintos). Esto hay que hacerlo justo tras crear el bot,
// antes de que llegue ningún paquete (createBot registra esos listeners de
// forma síncrona).
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
          if (isKnownNoisyError(err)) return // bug conocido, inofensivo: se ignora
          log(id, `[Error interno scoreboard] ${err.message}`)
        }
      })
    }
  }
}

// La propia librería hace console.error(err) internamente al capturar ese bug;
// lo filtramos aquí para que no ensucie la terminal.
const originalConsoleError = console.error
console.error = (...args) => {
  const first = args[0]
  if (isKnownNoisyError(first) || (typeof first === 'string' && first.includes('unknown objective'))) return
  originalConsoleError(...args)
}

// ─── Discord (aviso de desconexión) ─────────────────────────────────────────
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1521603965668556830/lRVJFViabQyYgxqJh1_eeWgE3TW7-vhyssbzIswGzDkCmDsPyRILSQ8UYai6xBccG5Cf'
const DISCORD_USER_ID = '722575528980119574'

function sendDiscordWebhook(id, reason) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK_URL) return resolve()
    const data = JSON.stringify({
      content: `<@${DISCORD_USER_ID}> ⚠️ La cuenta **${id}** se ha desconectado.\n**Motivo:** ${reason}`,
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

// ─── Estado ────────────────────────────────────────────────────────────────
const sessions = new Map() // id -> { cfg, bot, autoClick }
let activeId = accounts[0]?.id || null

// ─── Log de chat a fichero ───────────────────────────────────────────────────
// Como todas las cuentas reciben el mismo chat del server (es un broadcast),
// solo hace falta guardarlo una vez: usamos la primera cuenta de config.js
// como "fuente" del log para no duplicar líneas.
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
    // Formato de fichero: dia-mes-año-hora de inicio.txt (con guiones en vez de
    // barras/dos puntos porque esos caracteres no son válidos en nombres de
    // fichero en Windows).
    const fileName =
      `${pad2(now.getDate())}-${pad2(now.getMonth() + 1)}-${now.getFullYear()}` +
      `-${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.txt`
    const filePath = path.join(CHATLOG_DIR, fileName)
    chatLogStream = fs.createWriteStream(filePath, { flags: 'a' })
    chatLogStream.on('error', (err) => output(`[chatlog] Error escribiendo el log: ${err.message}`))
    output(`[chatlog] Guardando chat en chatlog/${fileName}`)
  } catch (err) {
    output(`[chatlog] No se pudo crear el log: ${err.message}`)
  }
}

function writeChatLog(text) {
  if (!chatLogStream) return
  const now = new Date()
  const ts = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  chatLogStream.write(`[${ts}] ${text}\n`)
}

// ─── Panel web: clientes WebSocket conectados y helpers de difusión ────────
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

// 'chat'  → la línea de abajo es el prompt normal de comandos (gestionado por readline)
// 'menu'  → la línea de abajo es el menú interactivo de cuentas (gestionado a mano, con
//           prioridad total sobre el teclado: readline se desconecta mientras está abierto)
let mode = 'chat'
let menuState = null
let lastMenuLineCount = 0

function prompt() {
  if (mode === 'menu') return // la línea reservada la pinta el menú mientras esté abierto
  rl.setPrompt(`[${activeId || '-'}] > `)
  rl.prompt()
}

// ─── Salida "segura": nunca corta lo que el usuario está escribiendo ───────
// Toda impresión de chat/logs pasa por aquí. En 'chat' usamos el redibujado
// interno de readline (borra la línea de comandos, imprime el mensaje arriba,
// y vuelve a pintar exactamente lo que había escrito). En 'menu' hacemos lo
// mismo pero a mano, porque el bloque del menú ocupa varias líneas y readline
// no sabe nada de él.
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

// ─── Menú interactivo de cuentas (atajo: Ctrl+T, flechas + Enter) ──────────
function buildMenuLines() {
  const lines = ['┌─── Cambiar de cuenta  (↑/↓ mover · Enter seleccionar · Esc cancelar) ───']
  accounts.forEach((cfg, i) => {
    const s = sessions.get(cfg.id)
    const state = s?.bot ? 'conectado' : 'desconectado'
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

  // El menú tiene prioridad absoluta: mientras esté abierto, ninguna tecla
  // llega al chat/readline. Nos quedamos con TODOS los listeners de keypress
  // que hubiera puestos (readline + nuestro propio atajo Ctrl+T) y los
  // restauramos al cerrar.
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
      output('Cambio de cuenta cancelado.')
    }
    // cualquier otra tecla se ignora: el chat no puede "colarse" mientras el menú está abierto
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
  output(`► Cuenta activa: ${activeId} (${cfg.username})`)
  broadcastStatus()
  if (!sessions.get(cfg.id)?.bot) {
    output('No está conectada, conectando...')
    attemptConnect(cfg)
  }
}

// ─── Hotkeys configurables (sección "hotkeys" de config.js) ───────────────
// Normaliza un combo tipo "Ctrl+Shift+G" / "ctrl + g" a una forma canónica
// comparable: modificadores ordenados alfabéticamente + nombre de tecla.
function normalizeCombo(str) {
  return String(str || '')
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join('+')
}

// Convierte el evento keypress de readline/Node al mismo formato canónico.
function keyEventToCombo(key) {
  const parts = []
  if (key.ctrl) parts.push('ctrl')
  if (key.meta) parts.push('alt') // Node reporta Alt como "meta"
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
      output(`⚠ Hotkey inválida en config.js (faltan campos): ${JSON.stringify(hk)}`)
      continue
    }
    const combo = normalizeCombo(hk.combo)
    if (!combo.includes('ctrl') && !combo.includes('alt') && !/^f\d{1,2}$/.test(combo)) {
      output(`⚠ Hotkey "${hk.combo}" no lleva ctrl/alt ni es una tecla de función (f1-f12): también se escribirá en el prompt al pulsarla.`)
    }
    if (hotkeyMap.has(combo)) {
      output(`⚠ Hotkey duplicada, se ignora la repetida: ${hk.combo}`)
      continue
    }
    hotkeyMap.set(combo, hk)
  }
}
loadHotkeys()

// Recarga la sección "hotkeys" de config.js en caliente (sin reiniciar el
// proceso): vuelve a leer el fichero del disco (saltándose la cache de
// require) y reconstruye el mapa.
function reloadHotkeys() {
  fullConfig = loadConfigModule()
  hotkeysConfig = fullConfig.hotkeys || []
  loadHotkeys()
  output(`↻ config.js recargado (${hotkeyMap.size} hotkey(s)).`)
}

function listHotkeys() {
  if (!hotkeyMap.size) { output('No hay hotkeys configuradas (sección "hotkeys" de config.js vacía).'); return }
  const lines = [...hotkeyMap.values()].map(
    (hk) => `  ${hk.combo.padEnd(16)} → [${hk.target}] ${hk.command}`
  )
  output('Hotkeys configuradas:\n' + lines.join('\n'))
}

// Ejecuta un comando sobre el/los destino(s) de una hotkey ('all' | 'active' | id de cuenta).
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
    else output('[Hotkey] No hay cuenta activa conectada.')
    return
  }
  const s = sessions.get(target)
  if (s?.bot) await runCommand(s, command)
  else output(`[Hotkey] Cuenta ${target} no conectada.`)
}

// ─── Recarga en caliente al guardar config.js ──────────────────────────────
// Vigila el fichero y, cuando cambia en disco, lo recarga automáticamente sin
// tener que reiniciar el proceso ni escribir ningún comando. Con debounce
// porque muchos editores generan varios eventos de "cambio" por cada guardado
// (escriben a un fichero temporal y luego renombran).
function watchConfigReload(filename, reloadFn) {
  let timer = null
  try {
    fs.watch(path.join(__dirname, filename), { persistent: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(reloadFn, 200)
    })
  } catch {
    // El fichero no existe todavía (es opcional): no hay nada que vigilar
    // hasta que se cree; en ese caso hará falta un /reload manual o reiniciar.
  }
}

// Devuelve true si la tecla coincidía con una hotkey (y ya se ha lanzado la acción).
async function handleHotkeyPress(key) {
  const combo = keyEventToCombo(key)
  if (!combo) return false
  const hk = hotkeyMap.get(combo)
  if (!hk) return false
  output(`[Hotkey ${hk.combo}] → ${hk.command}  (${hk.target})`)
  await runOnTarget(hk.target, hk.command)
  return true
}

// ─── Triggers de chat configurables (sección "triggers" de config.js) ─────
// Igual que las hotkeys, pero se disparan al LEER en el chat del servidor un
// mensaje que coincide con cierto texto, en vez de al pulsar una combinación.
// "match" admite texto plano (coincide si el mensaje lo CONTIENE, sin mayúsculas/
// minúsculas) o una regex escrita como '/patron/flags'.
function compileTriggerMatch(match) {
  const str = String(match || '')
  const m = str.match(/^\/(.*)\/([a-z]*)$/i)
  if (m) {
    try { return new RegExp(m[1], m[2]) } catch { return null }
  }
  return str // texto plano
}

const triggerList = []
function loadTriggers() {
  triggerList.length = 0
  triggersConfig.forEach((tr) => {
    if (!tr || !tr.match || !tr.target || !tr.command) {
      output(`⚠ Trigger inválido en config.js (faltan campos): ${JSON.stringify(tr)}`)
      return
    }
    const compiled = compileTriggerMatch(tr.match)
    if (compiled === null) {
      output(`⚠ Trigger con regex inválida en config.js: ${tr.match}`)
      return
    }
    triggerList.push({ ...tr, _compiled: compiled, _lastFired: new Map() })
  })
}
loadTriggers()

// Recarga la sección "triggers" de config.js en caliente (sin reiniciar el proceso).
function reloadTriggers() {
  fullConfig = loadConfigModule()
  triggersConfig = fullConfig.triggers || []
  loadTriggers()
  output(`↻ config.js recargado (${triggerList.length} trigger(s)).`)
}

function listTriggers() {
  if (!triggerList.length) { output('No hay triggers de chat configurados (sección "triggers" de config.js vacía).'); return }
  const lines = triggerList.map(
    (tr) => `  ${String(tr.match).padEnd(28)} → [${tr.target}] ${tr.command}`
  )
  output('Triggers de chat configurados:\n' + lines.join('\n'))
}

function textMatchesTrigger(text, tr) {
  if (tr._compiled instanceof RegExp) return tr._compiled.test(text)
  return text.toLowerCase().includes(tr._compiled.toLowerCase())
}

// Se llama con el texto de chat ya limpio de colores y con la config (cfg) de
// la cuenta que lo recibió, para poder resolver target: 'self'.
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

// ─── Macros de tienda configurables (sección "macros" de config.js) ───────
// Cada macro define un comando tipo "/nombre <numero> [delayMs]" que:
//   1. Manda un comando de chat que abre una ventana (ej. "/gemas")
//   2. Espera a que el servidor abra esa ventana
//   3. Hace <numero> clicks en un slot fijo, con un delay entre cada click
// Formato de la sección "macros" de config.js:
//   macros: {
//     casco: { openCommand: '/gemas', slot: 11 },
//   }
const DEFAULT_MACRO_DELAY_MS = 350
const DEFAULT_MACRO_WINDOW_TIMEOUT_MS = 8000

const macroMap = new Map()
function loadMacros() {
  macroMap.clear()
  for (const [name, def] of Object.entries(macrosConfig || {})) {
    if (!def || !def.openCommand || typeof def.slot !== 'number') {
      output(`⚠ Macro inválido en config.js (faltan campos "openCommand"/"slot"): ${name}`)
      continue
    }
    macroMap.set(name.toLowerCase(), {
      name,
      openCommand: def.openCommand,
      slot: def.slot,
      button: def.button === 'right' ? 'right' : 'left',
      delayMs: typeof def.delayMs === 'number' ? def.delayMs : DEFAULT_MACRO_DELAY_MS,
      windowTimeoutMs: typeof def.windowTimeoutMs === 'number' ? def.windowTimeoutMs : DEFAULT_MACRO_WINDOW_TIMEOUT_MS,
      closeAfter: def.closeAfter !== false, // por defecto true: cierra el menú al terminar
    })
  }
}
loadMacros()

// Recarga la sección "macros" de config.js en caliente (sin reiniciar el proceso).
function reloadMacros() {
  fullConfig = loadConfigModule()
  macrosConfig = fullConfig.macros || {}
  loadMacros()
  output(`↻ config.js recargado (${macroMap.size} macro(s)).`)
}

function listMacros() {
  if (!macroMap.size) { output('No hay macros de tienda configurados (sección "macros" de config.js vacía).'); return }
  const lines = [...macroMap.values()].map(
    (m) => `  /${m.name.padEnd(12)} <numero> [delayMs]  → ${m.openCommand}  slot ${m.slot} (click ${m.button}, delay por defecto ${m.delayMs}ms, ${m.closeAfter ? 'cierra al terminar' : 'no cierra al terminar'})`
  )
  output('Macros de tienda configurados:\n' + lines.join('\n'))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Espera a que el bot reciba el próximo evento 'windowOpen' (ej. la tienda
// abriéndose tras mandar "/gemas"). Si el servidor no abre nada a tiempo,
// rechaza con un timeout para no dejar el macro colgado para siempre.
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
      reject(new Error('timeout esperando a que se abriera la ventana'))
    }, timeoutMs)
    bot.once('windowOpen', onOpen)
  })
}

// Ejecuta un macro de tienda completo: abre la ventana, espera a que cargue,
// y hace los clicks pedidos en el slot configurado con delay entre cada uno.
async function runBuyMacro(session, macro, times, delayMs) {
  const { bot, cfg } = session

  // Si ya había una ventana abierta de antes, la cerramos: si no, el próximo
  // 'windowOpen' podría no llegar (algunos servidores no reabren si ya está
  // abierta) y confundiríamos los slots de una ventana vieja con los de la tienda.
  if (bot.currentWindow) {
    try { bot.closeWindow(bot.currentWindow) } catch { /* no crítico */ }
  }

  log(cfg.id, `[${macro.name}] Enviando "${macro.openCommand}"...`)
  bot.chat(macro.openCommand)

  let window
  try {
    window = await waitForWindowOpen(bot, macro.windowTimeoutMs)
  } catch (err) {
    log(cfg.id, `[${macro.name}] No se abrió ninguna ventana (${err.message}). Macro cancelado.`)
    return
  }

  log(cfg.id, `[${macro.name}] Ventana abierta (${window.title || window.type || 'tienda'}). Haciendo ${times} click(s) en slot ${macro.slot}, delay ${delayMs}ms...`)

  const mouseButton = macro.button === 'right' ? 1 : 0
  let done = 0
  for (let i = 0; i < times; i++) {
    if (!bot.currentWindow) {
      log(cfg.id, `[${macro.name}] La ventana se cerró antes de terminar (${done}/${times} clicks hechos)`)
      return
    }
    try {
      await bot.clickWindow(macro.slot, mouseButton, 0)
      done++
    } catch (err) {
      log(cfg.id, `[${macro.name}] Error en click ${i + 1}/${times}: ${err.message}`)
    }
    if (i < times - 1) await sleep(delayMs)
  }
  log(cfg.id, `[${macro.name}] Terminado: ${done}/${times} clicks hechos.`)

  // ─── Cierre final del menú ────────────────────────────────────────────
  // Muchos servidores dejan el menú de la tienda abierto tras comprar; lo
  // cerramos igual que haría el comando "/close" (manda el packet
  // close_window al servidor), salvo que el macro lo desactive con
  // closeAfter: false en la sección "macros" de config.js.
  if (macro.closeAfter !== false) {
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow)
        log(cfg.id, `[${macro.name}] Ventana cerrada.`)
      } catch (err) {
        log(cfg.id, `[${macro.name}] Error cerrando la ventana: ${err.message}`)
      }
    }
  }
}

// readline ya activa keypress + raw mode internamente para el TTY, así que
// esto no interfiere con la edición normal de línea (flechas, historial, etc).
readline.emitKeypressEvents(process.stdin, rl)
if (isTTY) process.stdin.setRawMode(true)
process.stdin.on('keypress', (str, key) => {
  if (!key) return
  if (key.ctrl && key.name === 'c') { rl.close(); process.exit(0) }
  if (key.ctrl && key.name === 't' && mode !== 'menu') { openMenu(); return }
  if (mode === 'menu') return // el menú tiene prioridad total, ya gestionado en openMenu()
  handleHotkeyPress(key) // async de fondo; no bloquea la edición de línea
})

function stripFormatting(input) {
  if (input == null) return ''
  const text = typeof input === 'string' ? input
    : typeof input.toString === 'function' ? input.toString()
    : JSON.stringify(input)
  return text.replace(/§#[0-9a-fA-F]{6}/g, '').replace(/§[0-9a-fk-or]/gi, '')
}

// ─── API externa: consulta de gemas ────────────────────────────────────────
// Usa fetchJsonRetry (mismo helper que fetchClanTopData) para reintentar con
// backoff en 429/5xx en vez de fallar a la primera, y loguea el motivo real
// del fallo para poder diferenciar "API caída" de "rate limit" o "campo
// stats.gems ausente en la respuesta".
async function fetchGemsForUsername(username, logId) {
  const url = `https://api.widowmc.net/api/v1/players/${encodeURIComponent(username)}`
  try {
    const json = await fetchJsonRetry(url)
    const gems = json?.stats?.gems
    if (typeof gems !== 'number') {
      if (logId) log(logId, `[gemas] respuesta sin stats.gems para ${username}: ${JSON.stringify(json).slice(0, 200)}`)
      return null
    }
    return gems
  } catch (err) {
    if (logId) log(logId, `[gemas] fallo consultando ${username}: ${err.status ? `HTTP ${err.status}` : err.message}`)
    return null
  }
}

// GET genérico a la API pública de widowmc: resuelve con el JSON parseado o
// rechaza con un Error que lleva `.status` (código HTTP) cuando lo hay, para
// poder distinguir "no encontrado" (4xx) de "rate limit / caído" (429, 5xx).
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent: widowmcAgent }, (res) => {
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

// Igual que fetchJson pero con reintentos + backoff exponencial para 429
// (rate limit) y errores 5xx puntuales de la API.
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

// ─── Top de gemas de un clan (usado por el panel web) ───────────────────────
// Se ejecuta en el backend (sin restricciones de CORS) para evitar que el
// navegador bloquee las peticiones directas a api.widowmc.net.
async function fetchClanTopData(slug, knownGems) {
  const clan = await fetchJsonRetry(`https://api.widowmc.net/api/v1/clans/${encodeURIComponent(slug)}`)
  const members = Array.isArray(clan.members) ? clan.members : []
  const results = []

  // Mapa de gemas ya conocidas (cuentas propias, que ya se muestran en el
  // panel) para no volver a pedirlas a la API y así no gastar cupo de
  // rate limit en consultas redundantes.
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
      fetchJsonRetry(`https://api.widowmc.net/api/v1/players/${encodeURIComponent(m.name)}`)
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

// ─── Histórico de gemas generadas (/paygemas) — persistido en disco ─────────
// La carga/guardado en disco vive en history.js (public/gems-history.json).
// Aquí solo envolvemos esas llamadas para avisar por WebSocket a los
// clientes conectados cuando hay una entrada nueva o se borra el histórico.
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
  return lines.length ? lines.join('\n') : '  (vacío)'
}

function printWindow(id, window) {
  output(`[${id}] Ventana: ${window.title || window.type || 'inventario'} (${window.slots.length} slots)\n${formatWindow(window)}`)
}

// ─── Auto-click por sesión ───────────────────────────────────────────────────
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
      log(session.cfg.id, `[AutoClick] ▶ ${button} cada ${ms}ms`)
    },
    stop() {
      if (this.interval) clearInterval(this.interval)
      this.interval = null
      this.active = false
    },
    toggle(button, ms) {
      if (this.active) { this.stop(); log(session.cfg.id, '[AutoClick] ■ Desactivado') }
      else this.start(button, ms)
    },
  }
}

// ─── Sincronización de reconexión entre cuentas ──────────────────────────────
// Reglas pedidas:
//  1. Al desconectarse una cuenta, espera 15s y reintenta conectar.
//  2. Si ese intento falla, espera 1 minuto y vuelve a intentarlo (y así con
//     cada fallo siguiente, cada 1 minuto).
//  3. Si cualquier intento falla porque el SERVIDOR está caído (no la cuenta:
//     error de red al conectar, no un kick/login fallido), se deja de
//     reintentar por cuenta y se pasa a comprobar cada 1 minuto si el server
//     ya responde.
//  4. Cuando el server vuelve a estar operativo, se espera 30s y se empieza a
//     reconectar las cuentas.
//  5. Todas las cuentas (arranque, reconexión automática, /connect manual y
//     panel web) comparten un mismo "turno" por servidor para no disparar dos
//     conexiones con menos de 15s de diferencia entre ellas, porque el server
//     rechaza conexiones si llegan demasiado rápido seguidas.
const RECONNECT_FIRST_DELAY_MS = 15000    // espera tras desconexión antes del 1er reintento
const RECONNECT_RETRY_DELAY_MS = 60000    // espera entre reintentos si el anterior falló
const SERVER_DOWN_CHECK_INTERVAL_MS = 60000 // frecuencia de chequeo con el server caído
const SERVER_UP_RESUME_DELAY_MS = 30000   // espera tras detectar que el server volvió
const MIN_CONNECT_GAP_MS = 15000          // separación mínima entre intentos al mismo server

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

// Reserva turno para intentar conectar contra el server de `cfg`, esperando lo
// necesario para que hayan pasado al menos MIN_CONNECT_GAP_MS desde el último
// intento a ESE MISMO server (contando el de cualquier cuenta). Se encadena
// sobre una promesa compartida (`queueTail`) para que dos cuentas pidiendo
// turno "a la vez" no calculen el mismo hueco y terminen conectando juntas.
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

// Distingue un fallo "de la cuenta" (login incorrecto, kick, versión, etc,
// donde sí se llegó a hablar con el server) de un fallo "del servidor"
// (no hay nadie escuchando / no responde / se corta la red).
function isServerDownError(err) {
  if (!err) return false
  const code = err.code || ''
  const knownCodes = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET']
  if (knownCodes.includes(code)) return true
  return new RegExp(knownCodes.join('|') + '|timed out', 'i').test(String(err.message || ''))
}

// Chequeo de bajo nivel (TCP puro) para saber si el server ya responde, sin
// pasar por todo el handshake/login de mineflayer.
function checkServerReachable(cfg) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port, timeout: 5000 })
    const finish = (ok) => { socket.destroy(); resolve(ok) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// Marca el server como caído (si no lo estaba ya) y arranca el chequeo
// periódico cada minuto hasta que vuelva a responder.
function markServerDown(cfg) {
  const gate = getServerGate(cfg)
  if (gate.down) return
  gate.down = true
  log(cfg.id, `El servidor ${gate.key} parece caído. Comprobando cada ${SERVER_DOWN_CHECK_INTERVAL_MS / 1000}s hasta que vuelva...`)
  if (gate.checking) return
  gate.checking = true

  const tick = async () => {
    if (!gate.down) { gate.checking = false; return }
    const ok = await checkServerReachable(cfg)
    if (!ok) { setTimeout(tick, SERVER_DOWN_CHECK_INTERVAL_MS); return }

    log(cfg.id, `El servidor ${gate.key} volvió a responder. Esperando ${SERVER_UP_RESUME_DELAY_MS / 1000}s antes de reconectar cuentas...`)
    await sleep(SERVER_UP_RESUME_DELAY_MS)
    gate.down = false
    gate.checking = false
    resumeAccountsForServer(gate.key)
  }
  setTimeout(tick, SERVER_DOWN_CHECK_INTERVAL_MS)
}

// Reconecta (respetando el turno de 15s de cada una) todas las cuentas de un
// server concreto que estén desconectadas y pendientes de reconexión
// automática, una vez confirmado que el server volvió a estar operativo.
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

// Punto de entrada único para conectar una cuenta: arranque, reconexión
// automática, `/connect` manual y panel web pasan todos por aquí, así todos
// respetan el mismo turno de separación mínima entre conexiones al server.
function attemptConnect(cfg) {
  const gate = getServerGate(cfg)
  if (gate.down) return // el chequeo periódico de markServerDown se encarga de retomar
  reserveConnectSlot(cfg).then(() => connect(cfg))
}

// ─── Crear/conectar una cuenta ───────────────────────────────────────────────
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

  // mineflayer puede emitir 'spawn' más de una vez dentro de la MISMA conexión
  // (algunos servidores mandan varios paquetes de posición/teleport seguidos
  // nada más entrar — warps, respawns internos, etc. — y cada uno dispara un
  // 'spawn'). Esta bandera vive en el closure de connect(), así que se
  // resetea sola en cada conexión real nueva, y evita que /login y
  // spawnCommand se reenvíen varias veces en la misma sesión.
  let firstSpawnHandled = false

  bot.on('spawn', () => {
    session.retries = 0
    session.spawnedThisAttempt = true
    broadcastStatus()
    prompt()

    if (firstSpawnHandled) return
    firstSpawnHandled = true

    log(cfg.id, `Conectado a ${cfg.host}:${cfg.port}`)
    if (cfg.password) bot.chat(`/login ${cfg.password}`)

    // ─── spawnCommand (config.js): comando(s) que la cuenta ejecuta sola nada
    // más entrar. Admite un string único o un array de strings (se mandan en
    // orden). Si la cuenta hace /login (tiene "password"), se espera un poco
    // para dar tiempo al servidor a procesar el login antes de mandar más
    // comandos; si no hay login, se manda enseguida.
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

    // ─── Auto-register: si el server menciona "register", mandamos /register <pass> <pass> ──
    // Va antes del check de "muted" para que funcione siempre, y con cooldown para no
    // spamear el comando si el server imprime varias líneas seguidas con esa palabra.
    if (cfg.password && /register/i.test(text)) {
      const now = Date.now()
      if (now - (session.lastAutoRegister || 0) > 5000) {
        session.lastAutoRegister = now
        bot.chat(`/register ${cfg.password} ${cfg.password}`)
        log(cfg.id, `[AutoRegister] Enviado: /register ${cfg.password} ${cfg.password}`)
      }
    }

    // ─── Triggers de chat: igual que auto-register, funcionan aunque esté "muted" ──
    handleChatTriggers(cfg, text).catch((err) => log(cfg.id, `[Trigger error] ${err.message}`))

    if (seen.has(text)) { seen.delete(text); return }
    seen.add(text)
    setImmediate(() => seen.delete(text))

    // ─── Log a fichero: solo la cuenta "primaria", y aunque esté muted en
    // consola/panel (el fichero quiere guardar TODO el chat, no lo que se ve). ──
    if (cfg.id === PRIMARY_ACCOUNT_ID) writeChatLog(text)

    if (session.muted) return
    log(cfg.id, text)
  })

  bot.on('windowOpen', (window) => {
    if (session.muted) return
    printWindow(cfg.id, window)
  })

  bot.on('death', () => { session.autoClick.stop(); bot.respawn() })
  bot.on('kicked', (reason) => log(cfg.id, `Expulsado: ${stripFormatting(reason)}`))
  bot.on('error', (err) => {
    session.lastError = err
    if (!isKnownNoisyError(err)) log(cfg.id, `[Error] ${err.message}`)
  })
  bot.on('end', async (reason) => {
    log(cfg.id, `Desconectado: ${reason}`)
    session.autoClick.stop()
    session.bot = null
    broadcastStatus()
    await sendDiscordWebhook(cfg.id, reason)
    log(cfg.id, 'Aviso enviado a Discord.')

    if (session.manualDisconnect) return
    if (cfg.autoRelog === false) {
      log(cfg.id, 'autoRelog desactivado en config.js: no se reconectará sola.')
      return
    }

    // Fallo de conexión (nunca llegó a spawnear) por un error de red típico de
    // "el server no está levantado": dejamos de reintentar por cuenta y
    // pasamos a comprobar cada minuto hasta que vuelva.
    if (!session.spawnedThisAttempt && isServerDownError(session.lastError)) {
      markServerDown(cfg)
      return
    }

    session.retries += 1
    const delay = session.retries <= 1 ? RECONNECT_FIRST_DELAY_MS : RECONNECT_RETRY_DELAY_MS
    log(cfg.id, `Reintentando conexión en ${delay / 1000}s (intento ${session.retries})...`)
    session.reconnectTimer = setTimeout(() => attemptConnect(cfg), delay)
  })

  return session
}

// ─── Persistencia de "multi" en config.js ───────────────────────────────────
// Reescribe SOLO el campo "multi" del bloque de la cuenta indicada dentro de
// config.js, dejando el resto del archivo (formato, comentarios, otras
// cuentas) intacto. Usa matching de llaves en vez de regex sobre todo el
// fichero para no tocar por error el "multi" de otra cuenta.
const CONFIG_PATH = path.join(__dirname, 'config.js')
function persistMultiToConfig(id, value) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')

    const idMatch = new RegExp(`id:\\s*['"]${id}['"]`).exec(raw)
    if (!idMatch) { log(id, '[Aviso] No se guardó en config.js: id no encontrado en el archivo.'); return }

    // Retrocede hasta la '{' que abre el objeto de esta cuenta.
    const start = raw.lastIndexOf('{', idMatch.index)
    if (start === -1) { log(id, '[Aviso] No se guardó en config.js: no se localizó el inicio del objeto.'); return }

    // Avanza hasta la '}' que cierra ese mismo objeto, contando anidamiento.
    let depth = 0, end = -1
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++
      else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) { log(id, '[Aviso] No se guardó en config.js: no se localizó el cierre del objeto.'); return }

    const block = raw.slice(start, end + 1)
    const newBlock = /multi\s*:\s*[\d.]+/.test(block)
      ? block.replace(/multi\s*:\s*[\d.]+/, `multi: ${value}`)
      : block.replace(/\}\s*$/, `  multi: ${value},\n}`) // si la cuenta no tenía "multi", lo añade

    fs.writeFileSync(CONFIG_PATH, raw.slice(0, start) + newBlock + raw.slice(end + 1), 'utf8')
    log(id, 'Guardado en config.js.')
  } catch (err) {
    log(id, `[Aviso] No se pudo guardar multi en config.js: ${err.message}`)
  }
}

// ─── Ejecutar un comando sobre un bot concreto ──────────────────────────────
async function runCommand(session, trimmed) {
  const { bot, autoClick, cfg } = session
  if (!bot) { log(cfg.id, 'No conectado. Usa /connect ' + cfg.id); return }

  // ─── Macros de tienda dinámicos (ej. "/casco 5" definido en config.js) ────
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/)
    const macro = macroMap.get(parts[0].toLowerCase())
    if (macro) {
      const times = parseInt(parts[1], 10)
      if (isNaN(times) || times <= 0) { log(cfg.id, `Uso: /${macro.name} <numero de clicks> [delayMs]`); return }
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
    log(cfg.id, 'Click derecho')
    return
  }
  if (trimmed.startsWith('/equip')) {
    const slot = parseInt(trimmed.split(/\s+/)[1], 10)
    if (isNaN(slot) || slot < 0 || slot > 8) { log(cfg.id, 'Uso: /equip <slot 0-8>'); return }
    bot.setQuickBarSlot(slot)
    const item = bot.inventory.slots[36 + slot]
    log(cfg.id, `Mano: ${item ? item.displayName : 'Vacío'}`)
    return
  }
  if (trimmed.startsWith('/click')) {
    const parts = trimmed.split(/\s+/)
    const slot = parseInt(parts[1], 10)
    if (isNaN(slot) || !bot.currentWindow) { log(cfg.id, 'Sin ventana abierta o slot inválido'); return }
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
    if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); log(cfg.id, 'Ventana cerrada') }
    else log(cfg.id, 'No hay ventana abierta')
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
    if (isNaN(yaw) || isNaN(pitch)) { log(cfg.id, 'Uso: /look <yaw> <pitch>'); return }
    const toRad = d => (d * Math.PI) / 180
    bot.entity.yaw = toRad(yaw)
    bot.entity.pitch = toRad(pitch)
    bot._client.write('position_look', {
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
      yaw, pitch, flags: 0x00, teleportId: 0,
    })
    log(cfg.id, `Mirando yaw:${yaw}° pitch:${pitch}°`)
    return
  }
  if (trimmed.startsWith('/lookat')) {
    const [, xs, ys, zs] = trimmed.split(/\s+/)
    const x = parseFloat(xs), y = parseFloat(ys), z = parseFloat(zs)
    if ([x, y, z].some(isNaN)) { log(cfg.id, 'Uso: /lookat <x> <y> <z>'); return }
    await bot.lookAt({ x, y, z }, true)
    log(cfg.id, `Mirando a (${x}, ${y}, ${z})`)
    return
  }
  if (trimmed === '/drop') {
    const item = bot.heldItem
    if (!item) { log(cfg.id, 'Nada en la mano'); return }
    try { await bot.tossStack(item); log(cfg.id, `Tirado: ${item.displayName} x${item.count}`) }
    catch (err) { log(cfg.id, `Error: ${err.message}`) }
    return
  }
  if (trimmed === '/dropall') {
    const items = bot.inventory.items()
    if (!items.length) { log(cfg.id, 'Inventario vacío'); return }
    log(cfg.id, `Tirando ${items.length} stacks...`)
    for (const item of items) {
      try { await bot.tossStack(item) }
      catch (err) { log(cfg.id, `Error tirando ${item.displayName}: ${err.message}`) }
    }
    log(cfg.id, 'Inventario vaciado')
    return
  }
  if (trimmed === '/dropallgui') {
    const win = bot.currentWindow
    if (!win) { log(cfg.id, 'No hay ventana abierta. Usa /dropall para el inventario.'); return }
    // win.slots incluye tanto los slots del contenedor (cofre, ender chest, etc.)
    // como los del inventario del jugador, así que un solo barrido vacía ambos.
    const slotsWithItems = []
    win.slots.forEach((item, i) => { if (item) slotsWithItems.push(i) })
    if (!slotsWithItems.length) { log(cfg.id, 'Ventana e inventario ya están vacíos'); return }
    log(cfg.id, `Tirando ${slotsWithItems.length} stacks (ventana + inventario)...`)
    for (const slot of slotsWithItems) {
      try { await bot.clickWindow(slot, 1, 4) } // mode 4 = drop, button 1 = stack completo
      catch (err) { log(cfg.id, `Error tirando slot ${slot}: ${err.message}`) }
    }
    log(cfg.id, 'Ventana e inventario vaciados')
    return
  }

  if (trimmed.startsWith('/multi')) {
    const parts = trimmed.split(/\s+/)
    if (parts[1] == null) {
      log(cfg.id, `Multi actual: x${typeof cfg.multi === 'number' ? cfg.multi : 1}`)
      return
    }
    const value = parseFloat(parts[1])
    if (isNaN(value)) { log(cfg.id, 'Uso: /multi [numero]'); return }
    cfg.multi = value
    log(cfg.id, `Multi actualizado a x${value}`)
    persistMultiToConfig(cfg.id, value)
    broadcastStatus()
    return
  }

  if (trimmed.startsWith('/paygemas') || trimmed.startsWith('paygemas')) {
    const parts = trimmed.split(/\s+/)
    const targetName = parts[1]
    if (!targetName) { log(cfg.id, 'Uso: /paygemas <nombre>'); return }
    log(cfg.id, `Consultando gemas de ${cfg.username}...`)
    const gems = await fetchGemsForUsername(cfg.username, cfg.id)
    if (gems == null) { log(cfg.id, `No se pudo obtener el número de gemas de ${cfg.username} (API caída o error)`); return }
    if (gems <= 0) { log(cfg.id, `${cfg.username} no tiene gemas (0), no se envía nada`); return }
    const cmd = `/gemas pagar ${targetName} ${gems}`
    bot.chat(cmd)
    log(cfg.id, `Enviado: ${cmd}`)
    addGemsHistoryEntry({ ts: Date.now(), botId: cfg.id, target: targetName, gems })
    return
  }

  // Cualquier otra cosa → chat
  bot.chat(trimmed)
}

// ─── Comandos de gestión multi-cuenta ────────────────────────────────────────
function listAccounts() {
  const lines = accounts.map((cfg) => {
    const s = sessions.get(cfg.id)
    const state = s?.bot ? 'conectado' : 'desconectado'
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
Ctrl+T                   → Abre el menú interactivo para cambiar de cuenta
/hotkeys                 → Lista las hotkeys configuradas en config.js
/triggers                → Lista los triggers de chat configurados en config.js
/macros                  → Lista los macros de tienda configurados en config.js
/reload                  → Recarga hotkeys/triggers/macros de config.js a mano (también se recargan solos al guardar)
/reloadhotkeys           → Recarga solo la sección "hotkeys" de config.js
/reloadtriggers          → Recarga solo la sección "triggers" de config.js
/reloadmacros            → Recarga solo la sección "macros" de config.js
/accounts                → Lista cuentas y su estado
/switch <id>             → Cambia la cuenta activa
/connect <id>            → Conecta/reconecta una cuenta
/disconnect [id]         → Desconecta una cuenta (por defecto: la activa)
/mute                    → Deja de mostrar el chat/sistema de la cuenta activa
/unmute                  → Vuelve a mostrar el chat de la cuenta activa
/all <comando o texto>   → Ejecuta el comando/mensaje en TODAS las cuentas conectadas
/q                       → Salir y desconectar todo

Comandos por cuenta (activa o vía /all):
  /stats /pos /inv /use [slot] /equip <slot> /click <slot> [left|right|shift|drop]
  /close /autoclick [left|right] [ms] /look <yaw> <pitch> /lookat <x> <y> <z>
  /drop  /dropall  /dropallgui
  /multi [numero]          → Sin número: muestra el multi actual de la cuenta
                              Con número: cambia el multi de la cuenta (se ve en el panel web)
  /paygemas <nombre>       → Envía "/gemas pagar <nombre> (gemas)" con las gemas actuales del bot
                              (usa /all paygemas <nombre> para vaciar TODOS los bots hacia esa persona)
  /<macro> <numero> [ms]   → Macros de tienda definidos en config.js (ej. "/casco 5")
                              Manda el comando de apertura, espera la ventana y hace
                              <numero> clicks en el slot configurado, con [ms] de delay entre cada uno
  (cualquier otro texto se envía como chat)
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
    if (!accounts.find(a => a.id === id)) output('Cuenta no encontrada en config.js')
    else { activeId = id; broadcastStatus() }
    prompt(); return
  }

  if (trimmed.startsWith('/connect')) {
    const id = trimmed.split(/\s+/)[1] || activeId
    const cfg = accounts.find(a => a.id === id)
    if (!cfg) output('Cuenta no encontrada en config.js')
    else attemptConnect(cfg)
    prompt(); return
  }

  if (trimmed.startsWith('/disconnect')) {
    const id = trimmed.split(/\s+/)[1] || activeId
    const s = sessions.get(id)
    if (s) {
      s.manualDisconnect = true
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      if (s.bot) s.bot.end('Desconexión manual')
      else output('Esa cuenta no está conectada')
    } else output('Esa cuenta no está conectada')
    prompt(); return
  }

  if (trimmed === '/mute') {
    const s = sessions.get(activeId)
    if (s) { s.muted = true; output(`[${activeId}] Chat silenciado`); broadcastStatus() }
    prompt(); return
  }

  if (trimmed === '/unmute') {
    const s = sessions.get(activeId)
    if (s) { s.muted = false; output(`[${activeId}] Chat activado`); broadcastStatus() }
    prompt(); return
  }

  if (trimmed === '/q' || trimmed === '/quit') {
    for (const s of sessions.values()) {
      s.manualDisconnect = true
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      s.autoClick.stop()
      s.bot?.end('Cierre manual')
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

  // Comando normal → va a la cuenta activa
  const active = sessions.get(activeId)
  if (!active) { output('No hay cuenta activa conectada. Usa /connect ' + activeId); prompt(); return }
  await runCommand(active, trimmed)
  prompt()
})

// ─── Panel web ───────────────────────────────────────────────────────────
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
    output(`Panel web escuchando en el puerto ${webConfig.port}. Accede desde otros dispositivos de tu red con:`)
    const urls = getLanUrls(webConfig.port)
    if (urls.length) urls.forEach((u) => output(`  ${u}`))
    else output(`  http://localhost:${webConfig.port} (no se detectó IP de red local)`)
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
      s.bot.end('Desconexión manual (panel web)')
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
      broadcast({ type: 'clantop_result', slug, error: err.message || 'No se pudo cargar el clan', members: [], total: 0, known: 0, count: 0 })
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
  output(`⚠ ADVERTENCIA: id(s) duplicado(s) en config.js: ${[...dupIds].join(', ')}. Cada cuenta necesita un id único o se pisarán entre sí.`)
}

// El propio gate de conexión (reserveConnectSlot) ya se encarga de separar
// cada intento al menos MIN_CONNECT_GAP_MS del anterior por servidor, así que
// no hace falta escalonar aquí a mano: se piden todos los turnos ya, y se van
// resolviendo en orden respetando el hueco mínimo.
// Recarga las secciones "hotkeys"/"triggers"/"macros" de config.js a la vez
// (usado por el watcher de fichero único de más abajo y por /reload).
function reloadAllFromConfig() {
  fullConfig = loadConfigModule()
  hotkeysConfig = fullConfig.hotkeys || []
  triggersConfig = fullConfig.triggers || []
  macrosConfig = fullConfig.macros || {}
  loadHotkeys()
  loadTriggers()
  loadMacros()
  output(`↻ config.js recargado (${hotkeyMap.size} hotkey(s), ${triggerList.length} trigger(s), ${macroMap.size} macro(s)).`)
}

initChatLog()
accounts.forEach((cfg) => attemptConnect(cfg))
startWebServer()
// Nota: "accounts" (las cuentas en sí) NO se recarga en caliente al guardar
// config.js — solo hotkeys/triggers/macros. Cambiar cuentas requiere
// reiniciar el proceso, igual que antes cuando vivían en su propio fichero.
watchConfigReload('config.js', reloadAllFromConfig)
prompt()
