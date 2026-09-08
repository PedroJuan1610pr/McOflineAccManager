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
| `multibot.js`          | **Entry point and the whole engine**: bot connections, console, commands, hotkeys, triggers, web panel. Everything in a single file (~1600 lines). |
| `config.js`             | **Unified config**: exports `{ accounts, hotkeys, triggers, macros }`. `accounts` (accounts to control: credentials, host, multi, autoRelog, spawnCommand, etc.) is required; `hotkeys`, `triggers`, and `macros` are optional (empty arrays/object if unused). They used to live in separate files (`hotkeys.js`/`triggers.js`/`macros.js`); now everything is in this single file. |
| `history.js`            | **Gems-payment history persistence**: loads `public/gems-history.json` on startup and exposes `add`, `clear`, and `getAll`. Used by `multibot.js` to persist `/paygemas` entries across process restarts and broadcast them to web-panel clients. |
| `webconfig.js`          | Port and password for the web panel. ⚠️ see section 9 (the password **isn't actually used**). |
| `public/index.html`     | Static frontend of the web panel (plain HTML+CSS+JS, no build). |
| `public/gems-history.json` | Persisted payment history written by `history.js`; also directly downloadable from the panel. |
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
    cfg,                // the config.js object for that account
    bot,                // mineflayer instance, or null if disconnected
    autoClick,          // auto-click helper object (see makeAutoClick)
    muted,              // bool: whether its chat/log is hidden in console and panel
    manualDisconnect,   // bool: prevents auto-reconnect if manually disconnected
    reconnectTimer,     // handle of the reconnect retry setTimeout
    retries,            // number of consecutive reconnection retries
    lastAutoRegister,   // timestamp of the last automatic /register sent
    spawnedThisAttempt, // bool: whether the bot successfully spawned in the current connection attempt (used to distinguish account failures from server-down errors)
    lastError,          // last Error received from the bot's 'error' event (used together with spawnedThisAttempt to detect server-down situations)
  }
  ```
- `activeId` — id of the "active" account in the console (the one that
  receives commands typed without `/all`, and the one controlled by the
  `Ctrl+T` menu).
- `wsClients: Set<WebSocket>` — clients connected to the web panel.
- `serverGates: Map<host:port, gate>` — one gate per server, used to
  serialize connection attempts (minimum gap of `MIN_CONNECT_GAP_MS = 15000`ms
  between attempts to the same server) and to track whether the server is
  currently considered down.
- `PRIMARY_ACCOUNT_ID` — id of the first account in `config.js`; used as the
  sole source for the chat-log file so messages aren't duplicated.
- `chatLogStream` — writable file stream for the chat log (`chatlog/` folder).

## 5. Lifecycle of an account (`connect(cfg)`)

1. The `session` is created (or reused) in the `Map`.
2. `mineflayer.createBot({ host, port, username, version, auth })`.
3. Right after creation, `patchNoisyScoreboardListeners` wraps the internal
   mineflayer listeners for `scoreboard_score` / `scoreboard_objective`
   packets in a try/catch to prevent a known library bug from crashing the
   process.
4. Bot listeners:
   - `spawn` → logs the connection; if `cfg.password` exists, sends
     `/login <password>`. If the account has `cfg.spawnCommand` (a string or
     array of strings, defined in `config.js`), it's run automatically via
     `runCommand` — with a ~1200ms wait if a `/login` happened, to give the
     server time to process it before sending more commands. Then
     `broadcastStatus()`. A `firstSpawnHandled` flag prevents `/login` and
     `spawnCommand` from firing again if the server sends multiple position
     packets in the same session.
   - `message` → server chat text. This is where the following hook in:
     - **auto-register**: if the text contains "register" (regex
       `/register/i`) and `cfg.password` exists, sends
       `/register <pass> <pass>` (with a 5s cooldown to avoid spamming if
       the server prints several lines in a row).
     - **chat triggers** (`handleChatTriggers`) — see section 7.
     - **chat log**: if this is the primary account, the line is written to
       the daily log file in `chatlog/` (even if the account is muted).
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
     reconnection: **15s** before the first retry; **60s** between every
     subsequent retry. If the bot never managed to spawn and the error looks
     like a network failure, `markServerDown` is called instead (see
     section 5.1).

When the process starts, all accounts in `config.js` call `attemptConnect`
immediately. Spacing between connections is handled automatically by
`reserveConnectSlot` (minimum `MIN_CONNECT_GAP_MS = 15000`ms between attempts
to the same server), so two accounts never connect less than 15s apart.

### 5.1 Server-down detection and recovery

If a connection attempt fails before the bot ever spawns and the error is a
network-level failure (`ECONNREFUSED`, `ETIMEDOUT`, etc.), `markServerDown`
is called for that server. From that point:

- Per-account reconnect timers are stopped.
- A periodic TCP check runs every `SERVER_DOWN_CHECK_INTERVAL_MS = 60000`ms.
- Once the server responds again, the process waits `SERVER_UP_RESUME_DELAY_MS = 30000`s
  and then calls `attemptConnect` for every disconnected account on that server.

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
| `/multi [number]` | Without an argument: shows the current gem multiplier (`cfg.multi`). With an argument: changes it and persists the value to `config.js`. |
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
| `/macros` | Lists loaded shop macros. |
| `/reload` | Reloads all of `hotkeys`, `triggers`, and `macros` from `config.js`. |
| `/reloadhotkeys` | Reloads only the `hotkeys` section. |
| `/reloadtriggers` | Reloads only the `triggers` section. |
| `/reloadmacros` | Reloads only the `macros` section. |
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
  account) and the full gems-payment history from `history.js`.
- Messages the client can send over WS (`handleWebMessage`):
  - `{ type: 'connect', id }`
  - `{ type: 'disconnect', id }`
  - `{ type: 'mute' | 'unmute', id }`
  - `{ type: 'command', id, text, all? }` → `all: true` runs the command on
    every connected account; otherwise only on `id`.
  - `{ type: 'gems_history_clear' }` → clears the payment history.
  - `{ type: 'clantop_request', slug, known }` → fetches the clan gem
    leaderboard from the server's API and broadcasts the result.
- The server broadcasts (`broadcast`) `type: 'log'` events (a chat/log line
  from an account) and `type: 'status'` events (updated snapshot) to all
  connected clients.
- `public/index.html` is a plain (framework-free) frontend: per-account
  cards, active account selector, toolbar, live log console, and a form to
  send commands (with a "to all" option).

## 10. ⚠️ Things to keep in mind / technical debt

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
- **Discord webhook config** in `multibot.js` (`DISCORD_WEBHOOK_URL`,
  `DISCORD_USER_ID`): used to notify when an account disconnects. Both are
  empty strings by default (no notification is sent until you fill them in).
  Since they're embedded directly in the source code rather than in
  `config.js`/`webconfig.js`, anyone with the code can see or reuse them if
  you set them. It would be cleaner to move them to an unversioned config file.
- **Everything lives in a single file (`multibot.js`, ~1600 lines)**:
  connection, console, commands, hotkeys, triggers, and the web server all
  mixed together. It works, but any large change would benefit from
  splitting it into modules (`bot.js`, `commands.js`, hotkeys/triggers
  runtime, `web.js`).
- **`/dropallgui` and `/click`** use Minecraft's inventory protocol
  "mode"/"button" codes directly (`clickWindow(slot, button, mode)`), with
  no abstraction layer — any protocol version change could require touching
  them.
- **`gems-history.json` is publicly downloadable**: it lives inside
  `public/` and is served by `express.static`. The file only contains bot
  names, recipient names, and gem amounts (nothing sensitive), but it's
  worth keeping in mind if the panel is ever exposed outside the LAN.
- No automated tests or linter configured.

## 11. How to run it

```bash
npm install
node multibot.js
```

On startup: it connects the accounts from `config.js` (spacing them at least
15s apart via `reserveConnectSlot`), spins up the web panel on
`webconfig.js.port`, initializes the chat-log file in `chatlog/`, and leaves
the interactive console ready (prompt waiting for commands).
