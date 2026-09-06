# WidowMc — Bot multi-cuenta para Minecraft (mineflayer)

> Documento de referencia técnica del proyecto. Escrito para que una IA pueda
> entender la arquitectura completa sin tener que leer todo el código fuente
> primero, y para que un humano lo use como mapa rápido del repo.

## 1. Qué es esto

Aplicación Node.js de consola (CLI) que conecta y controla **varias cuentas de
Minecraft a la vez** (multi-bot) contra un mismo servidor, usando la librería
[`mineflayer`](https://github.com/PrismarineJS/mineflayer). Pensado para
farmear/automatizar acciones en un servidor concreto (`widowmc.net`, un
servidor tipo "gemas"/economía).

Tiene tres superficies de control sobre las mismas cuentas:

1. **Consola interactiva** (`readline` sobre stdin/stdout) con comandos tipo
   `/comando` y chat libre.
2. **Hotkeys de teclado** configurables (sección `hotkeys` de `config.js`) —
   combinaciones tipo `ctrl+shift+b` que ejecutan un comando sobre una o
   varias cuentas.
3. **Triggers de chat** configurables (sección `triggers` de `config.js`) —
   igual que las hotkeys pero se disparan al detectar cierto texto en el chat
   que envía el servidor a una cuenta.

Además expone un **panel web** (Express + WebSocket) para controlar las
cuentas desde otro dispositivo de la red local.

## 2. Stack técnico

- Runtime: Node.js (CommonJS, `require`/`module.exports`, no ESM).
- Dependencias (`package.json`):
  - `mineflayer` (^4.37.1) — cliente de protocolo Minecraft, crea el "bot" por cuenta.
  - `express` (^5.2.1) — sirve el panel web estático (`public/`).
  - `ws` (^8.21.1) — WebSocket para el panel web en tiempo real.
- Sin build step, sin TypeScript, sin framework de test. Se ejecuta con
  `node multibot.js`.

## 3. Inventario de archivos

| Archivo               | Rol                                                                 |
|------------------------|----------------------------------------------------------------------|
| `multibot.js`          | **Punto de entrada y todo el motor**: conexión de bots, consola, comandos, hotkeys, triggers, panel web. Todo en un único archivo (~900 líneas). |
| `config.js`             | **Config unificado**: exporta `{ accounts, hotkeys, triggers, macros }`. `accounts` (cuentas a controlar: credenciales, host, multi, autoRelog, spawnCommand, etc) es obligatorio; `hotkeys`, `triggers` y `macros` son opcionales (arrays/objeto vacío si no se usan). Antes vivían en ficheros separados (`hotkeys.js`/`triggers.js`/`macros.js`); ahora todo está en este único fichero. |
| `webconfig.js`          | Puerto y contraseña del panel web. ⚠️ ver sección 8 (la contraseña **no se usa** realmente). |
| `public/index.html`     | Frontend estático del panel web (HTML+CSS+JS vanilla, sin build). |
| `package.json` / `package-lock.json` | Dependencias npm. |

No hay carpeta `src/`, ni módulos separados por responsabilidad: **todo el
backend vive en `multibot.js`**. Si se va a modificar algo, es el único
archivo que hay que tocar (aparte de `config.js`, que reúne toda la
configuración).

## 4. Modelo de datos en memoria

- `accounts` = contenido de `config.js` (array de objetos de cuenta).
- `sessions: Map<id, session>` — una entrada por cuenta *que se ha intentado
  conectar alguna vez*. Cada `session` tiene:
  ```js
  {
    cfg,              // el objeto de config.js de esa cuenta
    bot,              // instancia de mineflayer, o null si desconectado
    autoClick,        // objeto helper de auto-click (ver makeAutoClick)
    muted,            // bool: si se oculta su chat/log en consola y panel
    manualDisconnect, // bool: evita el auto-reconnect si se desconectó a mano
    reconnectTimer,   // handle del setTimeout de reintento
    retries,          // nº de reintentos de reconexión consecutivos
    lastAutoRegister, // timestamp del último /register automático enviado
  }
  ```
- `activeId` — id de la cuenta "activa" en la consola (a la que van los
  comandos escritos sin `/all`, y la que controla el menú `Ctrl+T`).
- `wsClients: Set<WebSocket>` — clientes conectados al panel web.

## 5. Ciclo de vida de una cuenta (`connect(cfg)`)

1. Se crea (o reutiliza) la `session` en el `Map`.
2. `mineflayer.createBot({ host, port, username, version, auth })`.
3. Listeners del bot:
   - `spawn` → loguea conexión, si `cfg.password` existe manda
     `/login <password>`. Si la cuenta tiene `cfg.spawnCommand` (string o
     array de strings, definido en `config.js`), lo ejecuta automáticamente
     vía `runCommand` — con ~1200ms de espera si hubo `/login`, para dar
     tiempo al servidor a procesarlo antes de mandar más comandos. Luego
     `broadcastStatus()`.
   - `message` → texto de chat del servidor. Aquí es donde se enganchan:
     - **auto-register**: si el texto contiene "register" (regex `/register/i`)
       y hay `cfg.password`, manda `/register <pass> <pass>` (con cooldown de
       5s para no hacer spam si el servidor imprime varias líneas seguidas).
     - **triggers de chat** (`handleChatTriggers`) — ver sección 7.
     - Si la cuenta está `muted`, no se imprime nada más; si no, se loguea.
     - Hay una deduplicación (`seen` Set + `setImmediate`) para no imprimir
       dos veces un mensaje que mineflayer a veces emite duplicado en el
       mismo tick.
   - `windowOpen` → imprime el contenido de la ventana/inventario abierto
     (si no está muted).
   - `death` → para el auto-click y respawnea.
   - `kicked`, `error` (filtrando errores "ruidosos" conocidos de la
     librería, ver `isKnownNoisyError`).
   - `end` → loguea desconexión, para auto-click, `broadcastStatus()`,
     envía aviso a Discord (`sendDiscordWebhook`), y si no fue desconexión
     manual y `cfg.autoRelog !== false`, reprograma reconexión con backoff
     (`5s, 10s, 15s...` hasta un tope de 60s).

Al arrancar el proceso, todas las cuentas de `config.js` se conectan en
cascada con `CONNECT_DELAY_MS = 9000` ms de separación entre cada una (para
no levantar sospechas / no saturar el login del server).

## 6. Comandos de cuenta (`runCommand(session, trimmed)`)

Función central que interpreta un string y actúa sobre **un** bot concreto.
La usan: la consola (línea activa o `/all`), las hotkeys, los triggers de
chat y el panel web — todos convergen aquí.

| Comando | Efecto |
|---|---|
| `/stats` | Vida y comida actuales. |
| `/pos` | Posición x/y/z. |
| `/use [slot]` | Selecciona slot (0-8) opcional y hace click derecho (`activateItem`). |
| `/equip <slot>` | Cambia el item activo del hotbar. |
| `/click <slot> [left\|right\|shift\|drop]` | Click en un slot de la ventana abierta. |
| `/inv` | Imprime inventario o ventana abierta. |
| `/close` | Cierra la ventana abierta. |
| `/autoclick [left\|right] [ms]` | Activa/desactiva auto-click periódico (toggle). |
| `/look <yaw> <pitch>` | Orienta la cámara del bot (grados). |
| `/lookat <x> <y> <z>` | Mira hacia una coordenada. |
| `/drop` | Tira el item de la mano. |
| `/dropall` | Tira todo el inventario. |
| `/dropallgui` | Tira todo el contenido de la ventana abierta + inventario (slot por slot, modo "drop stack"). |
| `/multi [numero]` | Sin argumento: muestra el multiplicador de gemas actual (`cfg.multi`). Con argumento: lo cambia (solo informativo, se refleja en el panel web). |
| `/paygemas <nombre>` | Consulta las gemas de la cuenta vía API pública (`api.widowmc.net`) y manda `/gemas pagar <nombre> <gemas>`. |
| *cualquier otro texto* | Se envía tal cual como mensaje de chat (`bot.chat(trimmed)`). |

## 7. Automatizaciones configurables: hotkeys y triggers

Ambos sistemas comparten la misma función de "disparo" (`runOnTarget`), que
resuelve el `target` y llama a `runCommand` sobre la(s) sesión(es)
correspondiente(s):

- `'all'` → todas las cuentas con bot conectado.
- `'active'` → la cuenta activa de la consola en ese momento.
- `'acc1'`, `'acc2'`, ... → una cuenta concreta por su `id` de `config.js`.
- `'self'` → **solo triggers**: la misma cuenta que recibió el mensaje que
  disparó el trigger (no existe en hotkeys porque una tecla no "pertenece" a
  ninguna cuenta).

### 7.1 Hotkeys (sección `hotkeys` de `config.js`)

```js
// dentro de module.exports = { ..., hotkeys: [ ... ], ... }
hotkeys: [
  { combo: 'ctrl+shift+b', target: 'acc3', command: '/home pull;' },
]
```

- `combo`: combinación de teclas normalizada internamente (orden alfabético
  de modificadores + tecla). Debe llevar `ctrl`/`alt` o ser una tecla de
  función (`f1`..`f12`) para no interferir con lo que se escribe en el
  prompt de comandos.
- Captadas vía `process.stdin.on('keypress', ...)` (readline en modo raw).
  Si el menú (`Ctrl+T`) está abierto, las hotkeys no se procesan (el menú
  tiene prioridad exclusiva sobre el teclado mientras está abierto).
- Listado en consola: comando `/hotkeys`.

### 7.2 Triggers de chat (sección `triggers` de `config.js`) — funcionalidad añadida

```js
// dentro de module.exports = { ..., triggers: [ ... ], ... }
triggers: [
  { match: 'te han robado', target: 'self', command: '/home pull;', cooldown: 5000 },
]
```

- `match`: texto plano (coincide por `includes()` case-insensitive) o regex
  escrita como string `'/patron/flags'` (se compila con `new RegExp`).
- `cooldown` (ms, default `3000`): mínimo entre disparos del **mismo**
  trigger para la **misma** cuenta origen, para no repetir la acción si el
  servidor imprime varias líneas seguidas con el mismo texto.
- Se evalúan en `handleChatTriggers(cfg, text)`, llamada desde el listener
  `bot.on('message', ...)` de cada cuenta, **antes** del check de `muted`
  (igual que el auto-register): un trigger se dispara aunque la cuenta esté
  silenciada en consola/panel.
- Listado en consola: comando `/triggers`.

Las secciones `hotkeys` y `triggers` de `config.js` son **opcionales**: si se
dejan como array vacío (`[]`), no hay hotkeys/triggers cargados y no rompe el
arranque.

### 7.3 Macros de tienda (sección `macros` de `config.js`) — funcionalidad añadida

```js
// dentro de module.exports = { ..., macros: { ... } }
macros: {
  casco: { openCommand: '/gemas', slot: 11, button: 'left', delayMs: 350 },
}
```

Cada entrada define un comando dinámico `/<nombre> <numero> [delayMs]` que se
resuelve en `runCommand` (comprobado antes que el resto de comandos fijos):

1. Cierra la ventana actual si había una abierta (para no confundirla con la
   que va a abrir el comando).
2. Manda `openCommand` como chat (ej. `/gemas`).
3. Espera al próximo evento `windowOpen` del bot (con timeout
   `windowTimeoutMs`, por defecto 8000ms); si no llega, cancela el macro.
4. Hace `<numero>` clicks (`clickWindow`) en `slot`, con `delayMs` de espera
   entre cada uno (por defecto el `delayMs` del macro, o 350ms si no se
   especifica ninguno).
5. Al terminar, cierra el menú (`bot.closeWindow`, equivalente al comando
   `/close`) salvo que el macro tenga `closeAfter: false`.

Ejemplo: `/casco 5` → manda `/gemas`, espera la tienda, hace 5 clicks en el
slot 11 con 350ms de delay entre cada uno. `/casco 5 500` usa 500ms en vez
del delay por defecto.

Es **opcional** (igual que hotkeys/triggers): si se deja como objeto vacío
(`{}`), no hay macros cargados y no rompe el arranque. Se recarga en caliente
al guardar `config.js` (o con `/reloadmacros` / `/reload`). Listado en
consola: comando `/macros`.

## 8. Comandos de consola (nivel proceso, no de cuenta)

| Comando | Efecto |
|---|---|
| `Ctrl+T` | Abre un menú interactivo para cambiar la cuenta activa (toma control exclusivo del teclado mientras está abierto). |
| `/help` | Lista de ayuda. |
| `/hotkeys` | Lista hotkeys cargadas. |
| `/triggers` | Lista triggers de chat cargados. |
| `/accounts` | Lista cuentas de `config.js` y su estado (conectada/desconectada, cuál es la activa). |
| `/switch <id>` | Cambia la cuenta activa. |
| `/connect <id>` | Conecta/reconecta una cuenta (por defecto la activa). |
| `/disconnect [id]` | Desconecta una cuenta (marca `manualDisconnect` para que no se auto-reconecte). |
| `/mute` / `/unmute` | Oculta/muestra el chat de la cuenta activa. |
| `/all <comando o texto>` | Ejecuta `runCommand` en todas las cuentas conectadas. |
| `/q` / `/quit` | Desconecta todo y sale del proceso. |
| *cualquier otra línea* | Va como comando/chat a la cuenta activa vía `runCommand`. |

## 9. Panel web (`startWebServer`, `public/index.html`)

- Servidor Express estático sirviendo `public/` + WebSocket en `/ws` (misma
  instancia HTTP, puerto único definido en `webconfig.js` → `port`, escucha
  en `0.0.0.0` para ser accesible desde la LAN).
- Al conectar un cliente WS recibe un `snapshot` con `accountsSnapshot()`
  (id, username, connected, muted, active, multi por cuenta).
- Mensajes que el cliente puede mandar por WS (`handleWebMessage`):
  - `{ type: 'connect', id }`
  - `{ type: 'disconnect', id }`
  - `{ type: 'mute' | 'unmute', id }`
  - `{ type: 'command', id, text, all? }` → `all: true` ejecuta el comando
    en todas las cuentas conectadas, si no solo en `id`.
- El servidor difunde (`broadcast`) eventos `type: 'log'` (línea de chat/log
  de una cuenta) y `type: 'status'` (snapshot actualizado) a todos los
  clientes conectados.
- `public/index.html` es un frontend vanilla (sin framework): tarjetas por
  cuenta, selector de cuenta activa, toolbar, consola de log en vivo, y un
  formulario para mandar comandos (con opción "a todas").

## 8/9-bis. ⚠️ Cosas a tener en cuenta / deuda técnica

- **El panel web NO tiene autenticación real.** `webconfig.js` define
  `password`, y el comentario del archivo advierte de no exponerlo fuera de
  la red local — pero **el código nunca comprueba esa contraseña** en
  ningún punto de `startWebServer`/`handleWebMessage`. Cualquiera que
  acceda al puerto (por defecto `3000`) en la LAN puede leer el chat y
  mandar comandos a todas las cuentas sin login. Si se quiere que la
  contraseña sirva de algo, hay que añadir la comprobación (ej. exigirla en
  el handshake del WebSocket o como query param al servir `public/`).
- **Credenciales en texto plano en `config.js`**: usuario/contraseña de cada
  cuenta van sin cifrar en el propio repo. Si este proyecto se sube a algún
  sitio (GitHub, etc.), `config.js` debería ir en `.gitignore` o moverse a
  variables de entorno.
- **Webhook de Discord hardcodeado** en `multibot.js`
  (`DISCORD_WEBHOOK_URL`, `DISCORD_USER_ID`): se usa para avisar cuando una
  cuenta se desconecta. Al ser una URL secreta incrustada directamente en el
  código (no en `config.js`/`webconfig.js`), cualquiera con el código puede
  spamear ese canal de Discord. Sería más limpio moverlo a un fichero de
  config no versionado.
- **Todo vive en un único archivo (`multibot.js`, ~900 líneas)**: conexión,
  consola, comandos, hotkeys, triggers y servidor web mezclados. Funciona,
  pero cualquier cambio grande se beneficiaría de separarlo en módulos
  (`bot.js`, `commands.js`, `hotkeys.js`/`triggers.js` runtime, `web.js`).
- **`/dropallgui` y `/click`** usan códigos de "mode"/"button" del protocolo
  de inventarios de Minecraft directamente (`clickWindow(slot, button,
  mode)`), sin capa de abstracción — cualquier cambio de versión de
  protocolo podría requerir tocarlos.
- Sin tests automatizados ni linter configurado.

## 10. Cómo se ejecuta

```bash
npm install
node multibot.js
```

Al arrancar: conecta las cuentas de `config.js` en cascada (9s entre cada
una), levanta el panel web en `webconfig.js.port`, y deja la consola
interactiva lista (prompt esperando comandos).
