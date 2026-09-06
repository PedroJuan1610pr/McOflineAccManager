// ─── history.js ───────────────────────────────────────────────────────────
// Persistencia del histórico de gemas generadas (comando /paygemas).
//
// Antes este historial solo vivía en el localStorage del navegador: se
// perdía al cambiar de dispositivo, al limpiar datos del navegador, o
// simplemente no existía hasta que el navegador procesaba las líneas de log.
//
// Este módulo guarda cada pago en un fichero JSON dentro de public/
// (gems-history.json), así que:
//   - El panel web recupera el mismo histórico lo abras desde donde lo
//     abras (no depende del navegador/dispositivo).
//   - Sobrevive a reinicios del proceso (node multibot.js).
//
// No sabe nada de WebSockets ni de Express: solo carga/guarda datos en
// disco. multibot.js es quien lo usa y se encarga de avisar a los clientes
// conectados (broadcast) cuando hay una entrada nueva o se borra el
// histórico.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs')
const path = require('path')

// Se guarda DENTRO de public/ tal y como se pidió, para que sea el mismo
// fichero que ya sirve express.static(). Ojo: eso también significa que es
// descargable directamente desde el panel (ej. http://<host>:<puerto>/gems-history.json),
// igual que el resto de contenido de public/ — no hay nada sensible en él
// (solo nombre de bot, nombre del destinatario y cantidad de gemas), pero
// merece la pena tenerlo en cuenta si el panel se expone fuera de la LAN.
const HISTORY_PATH = path.join(__dirname, 'public', 'gems-history.json')

// Límite de entradas guardadas para que el fichero no crezca sin límite.
const MAX_ENTRIES = 3000

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // No existe todavía (primera vez) o está corrupto/ilegible: empezamos
    // de cero en vez de tirar el proceso abajo.
    return []
  }
}

// Estado en memoria, cargado una vez al arrancar el proceso.
let history = loadFromDisk()

function saveToDisk() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history))
  } catch (err) {
    console.error(`⚠ No se pudo guardar ${HISTORY_PATH}: ${err.message}`)
  }
}

// Devuelve el histórico completo (array de { ts, botId, target, gems }).
function getAll() {
  return history
}

// Añade una entrada nueva, recorta al máximo y persiste en disco.
// Devuelve la propia entrada (por comodidad, para poder usarla en el broadcast).
function add(entry) {
  history.push(entry)
  if (history.length > MAX_ENTRIES) history = history.slice(-MAX_ENTRIES)
  saveToDisk()
  return entry
}

// Vacía el histórico (botón "Borrar historial" del panel) y persiste.
function clear() {
  history = []
  saveToDisk()
}

module.exports = { getAll, add, clear, HISTORY_PATH }
