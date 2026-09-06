// ─────────────────────────────────────────────────────────────────────────
// CONFIG UNIFICADO — antes esto estaba repartido en config.js / hotkeys.js /
// triggers.js / macros.js. Ahora TODO vive aquí en 4 bloques:
//
//   module.exports = {
//     accounts: [ ... ],   // cuentas a controlar (obligatorio)
//     hotkeys:  [ ... ],   // atajos de teclado (opcional, [] si no usas ninguno)
//     triggers: [ ... ],   // triggers de chat  (opcional, [] si no usas ninguno)
//     macros:   { ... },   // macros de tienda  (opcional, {} si no usas ninguno)
//   }
//
// Se recarga en caliente (hotkeys/triggers/macros) al guardar el archivo, o a
// mano con /reload, /reloadhotkeys, /reloadtriggers, /reloadmacros.
// ─────────────────────────────────────────────────────────────────────────

module.exports = {

  // ─── accounts ─────────────────────────────────────────────────────────
  accounts: [
    {
      id: "cuenta1",
      host: "servidor.net",
      port: 25565,
      username: "cuenta1",
      version: "1.20.4",
      password: "",
      auth: "offline",
      autoRelog: false,
      mute: false,
      multi: 1,
      spawnCommand: "",
    },
  ],

  // ─── hotkeys ──────────────────────────────────────────────────────────
  hotkeys: [],

  // ─── triggers ─────────────────────────────────────────────────────────
  triggers: [],

  // ─── macros ───────────────────────────────────────────────────────────
  macros: {},

};