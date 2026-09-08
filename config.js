// ─────────────────────────────────────────────────────────────────────────
// UNIFIED CONFIG — this used to be split across config.js / hotkeys.js /
// triggers.js / macros.js. Now EVERYTHING lives here in 4 blocks:
//
//   module.exports = {
//     accounts: [ ... ],   // accounts to control (required)
//     hotkeys:  [ ... ],   // keyboard shortcuts (optional, [] if unused)
//     triggers: [ ... ],   // chat triggers      (optional, [] if unused)
//     macros:   { ... },   // shop macros        (optional, {} if unused)
//   }
//
// Hotkeys/triggers/macros are hot-reloaded when the file is saved, or
// manually with /reload, /reloadhotkeys, /reloadtriggers, /reloadmacros.
// ─────────────────────────────────────────────────────────────────────────

module.exports = {

  // ─── accounts ─────────────────────────────────────────────────────────
  accounts: [
    {
      id: "account1",
      host: "server.net",
      port: 25565,
      username: "account1",
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
