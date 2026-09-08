# WidowMc — Offline multi-account bot for Minecraft (mineflayer)

> Technical reference document for the project. Written so an AI can
> understand the whole architecture without having to read all the source
> code first, and so a human can use it as a quick map of the repo.

## 1. What this is

A Node.js console (CLI) application that connects and controls **several
Minecraft accounts at once** (multi-bot) against the same server, using the
[`mineflayer`](https://github.com/PrismarineJS/mineflayer) library. Built to
farm/automate actions on a specific server (a "gems"/economy-type
server — the host and API endpoint are placeholders in this copy of the
project; set your own in `config.js`/`multibot.js`).

It has three control surfaces over the same accounts:

1. **Interactive console** (`readline` over stdin/stdout) with `/command`
   style commands and free chat.
2. **Configurable keyboard hotkeys** (`hotkeys` section of `config.js`) —
   combinations like `ctrl+shift+b` that run a command on one or several
   accounts.
3. **Configurable chat triggers** (`triggers` section of `config.js`) — same
   idea as hotkeys, but they fire when certain text is detected in the chat
   the server sends to an account.

It also exposes a **web panel** (Express + WebSocket) to control the
accounts from another device on the local network.

## 2. Tech stack

- Runtime: Node.js (CommonJS, `require`/`module.exports`, no ESM).
- Dependencies (`package.json`):
  - `mineflayer` (^4.37.1) — Minecraft protocol client, creates the "bot" per account.
  - `express` (^5.2.1) — serves the static web panel (`public/`).
  - `ws` (^8.21.1) — WebSocket for the real-time web panel.
- No build step, no TypeScript, no test framework. Run with `node multibot.js`.

## 3. File inventory

| File               | Role                                                                 |
|------------------------|----------------------------------------------------------------------|
| `multibot.js`          | **Entry point and the whole engine**: bot connections, console, commands, hotkeys, triggers, web panel. Everything in a single file (~900 lines). |
| `config.js`             | **Unified config**: exports `{ accounts, hotkeys, triggers, macros }`. `accounts` (accounts to control: credentials, host, multi, autoRelog, spawnCommand, etc.) is required; `hotkeys`, `triggers`, and `macros` are optional (empty arrays/object if unused). They used to live in separate files (`hotkeys.js`/`triggers.js`/`macros.js`); now everything is in this single file. |
| `webconfig.js`          | Port and password for the web panel. ⚠️ see section 8 (the password **isn't actually used**). |
| `public/index.html`     | Static frontend of the web panel (plain HTML+CSS+JS, no build). |
| `package.json` / `package-lock.json` | npm dependencies. |

There's no `src/` folder, and no modules split by responsibility: **the
entire backend lives in `multibot.js`**. If something needs to be changed,
it's the only file you need to touch (aside from `config.js`, which brings
together all the configuration).

## 4. In-memory data model

- `accounts` = contents of `config.js` (array of account objects).
- `sessions: Map<id, session>` — one entry per account *that has ever been
  attempted to connect*. Each `session` has:
  ```js
  {
    cfg,              // the config.js object for that account
    bot,              // mineflayer instance, or null if disconnected
    autoClick,        // auto-click helper object (see makeAutoClick)
    muted,            // bool: whether its chat/log is hidden in console and panel
    manualDisconnect, // bool: prevents auto-reconnect if manually disconnected
    reconnectTimer,   // handle of the reconnect retry setTimeout
    retries,          // number of consecutive reconnection retries
    lastAutoRegister, // timestamp of the last automatic /register sent
  }
  ```
- `activeId` — id of the "active" account in the console (the one that
  receives commands typed without `/all`, and the one controlled by the
  `Ctrl+T` menu).
- `wsClients: Set<WebSocket>` — clients connected to the web panel.

## 5. Lifecycle of an account (`connect(cfg)`)

1. The `session` is created (or reused) in the `Map`.
2. `mineflayer.createBot({ host, port, username, version, auth })`.
3. Bot listeners:
   - `spawn` → logs the connection; if `cfg.password` exists, sends
     `/login <password>`. If the account has `cfg.spawnCommand` (a string or
     array of strings, defined in `config.js`), it's run automatically via
     `runCommand` — with a ~1200ms wait if a `/login` happened, to give the
     server time to process it before sending more commands. Then
     `broadcastStatus()`.
   - `message` → server chat text. This is where the following hook in:
     - **auto-register**: if the text contains "register" (regex
       `/register/i`) and `cfg.password` exists, sends
       `/register <pass> <pass>` (with a 5s cooldown to avoid spamming if
       the server prints several lines in a row).
     - **chat triggers** (`handleChatTriggers`) — see section 7.
     - If the account is `muted`, nothing else is printed; otherwise it's
       logged.
     - There's deduplication (`seen` Set + `setImmediate`) to avoid
       printing twice a message that mineflayer sometimes emits duplicated
       in the same tick.
   - `windowOpen` → prints the contents of the open window/inventory (if
     not muted).
   - `death` → stops auto-click and respawns.
   - `kicked`, `error` (filtering out known "noisy" library errors, see
     `isKnownNoisyError`).
   - `end` → logs the disconnection, stops auto-click, `broadcastStatus()`,
     sends a Discord notification (`sendDiscordWebhook`), and if it wasn't a
     manual disconnect and `cfg.autoRelog !== false`, schedules a
     reconnection with backoff (`5s, 10s, 15s...` up to a cap of 60s).

When the process starts, all accounts in `config.js` connect in cascade with
`CONNECT_DELAY_MS = 9000` ms between each one (to avoid raising suspicion /
overloading the server's login).

## 6. Account commands (`runCommand(session, trimmed)`)

Central function that interprets a string and acts on **one** specific bot.
Used by: the console (active line or `/all`), hotkeys, chat triggers, and
the web panel — all of them converge here.

| Command | Effect |
|---|---|
| `/stats` | Current health and food. |
| `/pos` | x/y/z position. |
| `/use [slot]` | Selects an optional slot (0-8) and right-clicks (`activateItem`). |
| `/equip <slot>` | Changes the active hotbar item. |
| `/click <slot> [left\|right\|shift\|drop]` | Clicks a slot in the open window. |
| `/inv` | Prints the inventory or open window. |
| `/close` | Closes the open window. |
| `/autoclick [left\|right] [ms]` | Toggles periodic auto-click on/off. |
| `/look <yaw> <pitch>` | Orients the bot's camera (degrees). |
| `/lookat <x> <y> <z>` | Looks toward a coordinate. |
| `/drop` | Drops the item in hand. |
| `/dropall` | Drops the whole inventory. |
| `/dropallgui` | Drops the whole contents of the open window + inventory (slot by slot, "drop stack" mode). |
| `/multi [number]` | Without an argument: shows the current gem multiplier (`cfg.multi`). With an argument: changes it (informational only, reflected in the web panel). |
| `/paygemas <name>` | Checks the account's gems via the server's public API and sends `/gemas pagar <name> <gems>`. |
| *any other text* | Sent as-is as a chat message (`bot.chat(trimmed)`). |

## 7. Configurable automations: hotkeys and triggers

Both systems share the same "trigger" function (`runOnTarget`), which
resolves the `target` and calls `runCommand` on the corresponding
session(s):

- `'all'` → every account with a connected bot.
- `'active'` → the console's currently active account.
- `'acc1'`, `'acc2'`, ... → a specific account by its `id` from `config.js`.
- `'self'` → **triggers only**: the same account that received the message
  that fired the trigger (doesn't exist for hotkeys, since a key doesn't
  "belong" to any account).

### 7.1 Hotkeys (`hotkeys` section of `config.js`)

```js
// inside module.exports = { ..., hotkeys: [ ... ], ... }
hotkeys: [
  { combo: 'ctrl+shift+b', target: 'acc3', command: '/home pull;' },
]
```

- `combo`: internally normalized key combination (modifiers in alphabetical
  order + key). Must include `ctrl`/`alt` or be a function key (`f1`..`f12`)
  so it doesn't interfere with what's typed at the command prompt.
- Captured via `process.stdin.on('keypress', ...)` (readline in raw mode).
  If the menu (`Ctrl+T`) is open, hotkeys aren't processed (the menu has
  exclusive priority over the keyboard while it's open).
- Listed in the console: `/hotkeys` command.

### 7.2 Chat triggers (`triggers` section of `config.js`) — added feature

```js
// inside module.exports = { ..., triggers: [ ... ], ... }
triggers: [
  { match: 'te han robado', target: 'self', command: '/home pull;', cooldown: 5000 },
]
```

- `match`: plain text (matched via case-insensitive `includes()`) or a regex
  written as a string `'/pattern/flags'` (compiled with `new RegExp`).
- `cooldown` (ms, default `3000`): minimum time between firings of the
  **same** trigger for the **same** source account, to avoid repeating the
  action if the server prints several lines in a row with the same text.
- Evaluated in `handleChatTriggers(cfg, text)`, called from each account's
  `bot.on('message', ...)` listener, **before** the `muted` check (just like
  auto-register): a trigger fires even if the account is silenced in the
  console/panel.
- Listed in the console: `/triggers` command.

The `hotkeys` and `triggers` sections of `config.js` are **optional**: if
left as an empty array (`[]`), no hotkeys/triggers are loaded and startup
isn't affected.

### 7.3 Shop macros (`macros` section of `config.js`) — added feature

```js
// inside module.exports = { ..., macros: { ... } }
macros: {
  casco: { openCommand: '/gemas', slot: 11, button: 'left', delayMs: 350 },
}
```

Each entry defines a dynamic `/<name> <number> [delayMs]` command that's
resolved in `runCommand` (checked before the rest of the fixed commands):

1. Closes the current window if one was open (so it isn't confused with the
   one the command is about to open).
2. Sends `openCommand` as chat (e.g. `/gemas`).
3. Waits for the bot's next `windowOpen` event (with a timeout of
   `windowTimeoutMs`, 8000ms by default); if it doesn't arrive, the macro is
   cancelled.
4. Performs `<number>` clicks (`clickWindow`) on `slot`, waiting `delayMs`
   between each one (defaults to the macro's `delayMs`, or 350ms if none is
   specified).
5. When done, closes the menu (`bot.closeWindow`, equivalent to the
   `/close` command) unless the macro has `closeAfter: false`.

Example: `/casco 5` → sends `/gemas`, waits for the shop, does 5 clicks on
slot 11 with a 350ms delay between each. `/casco 5 500` uses 500ms instead
of the default delay.

It's **optional** (just like hotkeys/triggers): if left as an empty object
(`{}`), no macros are loaded and startup isn't affected. It's hot-reloaded
when `config.js` is saved (or via `/reloadmacros` / `/reload`). Listed in
the console: `/macros` command.

## 8. Console commands (process level, not account level)

| Command | Effect |
|---|---|
| `Ctrl+T` | Opens an interactive menu to switch the active account (takes exclusive control of the keyboard while open). |
| `/help` | Help listing. |
| `/hotkeys` | Lists loaded hotkeys. |
| `/triggers` | Lists loaded chat triggers. |
| `/accounts` | Lists accounts from `config.js` and their status (connected/disconnected, which one is active). |
| `/switch <id>` | Switches the active account. |
| `/connect <id>` | Connects/reconnects an account (the active one by default). |
| `/disconnect [id]` | Disconnects an account (marks `manualDisconnect` so it doesn't auto-reconnect). |
| `/mute` / `/unmute` | Hides/shows the active account's chat. |
| `/all <command or text>` | Runs `runCommand` on every connected account. |
| `/q` / `/quit` | Disconnects everything and exits the process. |
| *any other line* | Sent as a command/chat to the active account via `runCommand`. |

## 9. Web panel (`startWebServer`, `public/index.html`)

- Static Express server serving `public/` + WebSocket at `/ws` (same HTTP
  instance, single port defined in `webconfig.js` → `port`, listens on
  `0.0.0.0` to be reachable from the LAN).
- When a WS client connects it receives a `snapshot` with
  `accountsSnapshot()` (id, username, connected, muted, active, multi per
  account).
- Messages the client can send over WS (`handleWebMessage`):
  - `{ type: 'connect', id }`
  - `{ type: 'disconnect', id }`
  - `{ type: 'mute' | 'unmute', id }`
  - `{ type: 'command', id, text, all? }` → `all: true` runs the command on
    every connected account; otherwise only on `id`.
- The server broadcasts (`broadcast`) `type: 'log'` events (a chat/log line
  from an account) and `type: 'status'` events (updated snapshot) to all
  connected clients.
- `public/index.html` is a plain (framework-free) frontend: per-account
  cards, active account selector, toolbar, live log console, and a form to
  send commands (with a "to all" option).

## 8/9-bis. ⚠️ Things to keep in mind / technical debt

- **The web panel has NO real authentication.** `webconfig.js` defines a
  `password`, and the file's comment warns not to expose it outside the
  local network — but **the code never actually checks that password**
  anywhere in `startWebServer`/`handleWebMessage`. Anyone who reaches the
  port (`3000` by default) on the LAN can read the chat and send commands
  to every account without logging in. If the password is meant to do
  anything, the check needs to be added (e.g. requiring it in the WebSocket
  handshake or as a query param when serving `public/`).
- **Plaintext credentials in `config.js`**: each account's username/password
  go unencrypted in the repo itself. If this project is pushed anywhere
  (GitHub, etc.), `config.js` should go in `.gitignore` or be moved to
  environment variables.
- **Hardcoded Discord webhook** in `multibot.js` (`DISCORD_WEBHOOK_URL`,
  `DISCORD_USER_ID`): used to notify when an account disconnects. Since it's
  a secret URL embedded directly in the code (not in
  `config.js`/`webconfig.js`), anyone with the code can spam that Discord
  channel. It would be cleaner to move it to an unversioned config file.
- **Everything lives in a single file (`multibot.js`, ~900 lines)**:
  connection, console, commands, hotkeys, triggers, and the web server all
  mixed together. It works, but any large change would benefit from
  splitting it into modules (`bot.js`, `commands.js`, hotkeys/triggers
  runtime, `web.js`).
- **`/dropallgui` and `/click`** use Minecraft's inventory protocol
  "mode"/"button" codes directly (`clickWindow(slot, button, mode)`), with
  no abstraction layer — any protocol version change could require touching
  them.
- No automated tests or linter configured.

## 10. How to run it

```bash
npm install
node multibot.js
```

On startup: it connects the accounts from `config.js` in cascade (9s
between each one), spins up the web panel on `webconfig.js.port`, and
leaves the interactive console ready (prompt waiting for commands).