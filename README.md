# LANShare

**Share anything. Nearby. Instantly.**

LANShare sends files, photos, videos, folders and text straight between devices on the
same network — no accounts, no uploads, no cloud storage. Browsers talk to each other
over an encrypted WebRTC DataChannel; a small WebSocket server only helps the two
devices find each other and agree on the connection.

> Built by **Muhammad Anas**.

---

## How it works

```
   Device A                     Signaling server                  Device B
┌──────────────┐            ┌────────────────────┐           ┌──────────────┐
│  LANShare    │  presence  │  rooms + SDP/ICE   │  presence │  LANShare    │
│  (browser)   │◄──────────►│  relay only        │◄─────────►│  (browser)   │
└──────┬───────┘   over WS  └────────────────────┘   over WS └───────┬──────┘
       │                                                             │
       └──────────── encrypted WebRTC DataChannel (file bytes) ──────┘
                     direct, device-to-device, P2P
```

* **The signaling server never receives file bytes.** It relays presence, chat-free
  SDP/ICE negotiation messages, and ICE server config. Payload data goes peer-to-peer.
* File data is split into 64 KiB chunks with `Blob.slice()` and streamed with
  `bufferedAmount` / `bufferedAmountLowThreshold` backpressure, so large files never
  sit in memory as one blob and never freeze the tab. This is measured, not asserted:
  the E2E suite sends 64 MB while sampling the sender's heap (see Testing below).
* In-band control frames (`FILE_START`, `FILE_END`, `TRANSFER_DONE`) travel on the same
  ordered data channel as the bytes, so completion can never overtake the payload.
* Every signaling message and peer message is validated with **zod** on arrival.

## Features

| | |
|---|---|
| **Device discovery** | Friendly random names (e.g. "Silent Falcon"), auto-detected on the same room; no IPs, OS or fingerprints shown |
| **Send files** | Any number of files or a whole folder, drag & drop, paste, or the system share sheet (PWA share target) |
| **Send text & links** | Paste text or URLs; links are rendered as text only and never opened automatically |
| **Receiver consent** | Every transfer waits for an explicit Accept/Decline on the receiving device (auto-accept is available, **off by default**) |
| **Live progress** | Percentage, bytes, smoothed speed and ETA per transfer |
| **Integrity** | SHA-256 verified for files up to 16 MiB before a transfer is called complete |
| **Cancellation** | Either side can cancel in flight; queues, buffers and partial files are cleaned up |
| **Previews** | Local thumbnails/previews for images, video, audio and text before sending |
| **Multi-file download** | Download each file, or get everything as one ZIP (built client-side with `fflate`) |
| **Text receive view** | Copy or save as `.txt`, rendered as text (no `innerHTML`, no auto-navigation) |
| **History** | Recent transfers in IndexedDB (metadata only), with one-tap clear |
| **Themes** | Light / dark / system, persisted in `localStorage` |
| **PWA** | Manifest, maskable icons, offline app shell, installable |
| **QR pairing** | Private room via QR code or link (`?room=CODE`) for devices on different rooms/subnets |
| **Accessibility** | Keyboard-operable dialogs with focus trapping, ARIA labels, visible focus, `prefers-reduced-motion` respected, and an axe-core audit in CI (0 violations across 7 surfaces) |
| **Responsive** | Mobile-first layout that scales up to desktop |

### Privacy, accurately stated

* Transfers are encrypted in transit by WebRTC (DTLS-SRTP) and go directly between the
  two browsers. **No file content is uploaded to a server.**
* The signaling server can see that two devices are present and relays connection
  metadata (room id, peer ids, display names, SDP/ICE). It cannot read file bytes.
* Device names are randomly generated in the browser; no IP addresses, operating
  systems or browser fingerprints are displayed in the UI.
* Transfer history (file names, sizes, direction, timestamps) is stored **only** in the
  receiving device's own IndexedDB and can be cleared from Settings. Message text is not
  written to history.
* Notification permission is requested **only** after you enable notifications yourself.
* This is a LAN-first tool: if you expose the signaling server to the public internet,
  add TLS (`wss://`) and an `ALLOWED_ORIGINS` allow-list (see `.env.example`).

## Quick start

```bash
git clone <your-fork> && cd lan-share
npm install
npm --prefix server install

# terminal 1 — signaling server (WebSocket, port 8080)
npm run serve:signaling

# terminal 2 — frontend (Vite dev server, port 5173, proxies /ws → :8080)
npm run dev
```

…or run both with one command:

```bash
npm run start:all
```

Open `http://localhost:5173` in two browser tabs (or on two devices in the same
network, using your machine's LAN address) and they will find each other automatically.

No internet at all? See [Offline: sharing with no internet](#offline-sharing-with-no-internet)
— one command, one URL, phone to PC.

> **Secure contexts, measured rather than assumed:** `RTCPeerConnection` and data channels
> work on a plain-HTTP LAN origin (`http://192.168.x.x`) in current Chromium — verified in this
> repository's offline suite. What requires HTTPS is the camera/microphone, notifications and
> the service worker (so PWA installation). `localhost` counts as secure either way.

### Production build

```bash
npm run build          # → dist/ (static files)
npm run preview        # serve the build locally
```

Deploy `dist/` anywhere static (GitHub Pages, Netlify, S3, nginx) and run the signaling
server somewhere Node runs (Docker, Render, Fly.io, a VPS). Because GitHub Pages cannot
serve a WebSocket, the frontend must be told where the server is:

```bash
VITE_SIGNALING_URL=wss://signaling.example.com/ws npm run build
```

`VITE_BASE_PATH=/your-repo/` handles project-site sub-paths. A ready-made Pages workflow
lives in `.github/workflows/deploy-pages.yml`. The signaling image builds with
`docker build -t lanshare-signaling ./`; every instruction in that Dockerfile is replayed by
`npm run verify:docker` (run in CI on every push), so only the container layer itself is
unverified here.

That deployment shape — sub-path build plus a signaling server on another origin behind an
origin allow-list — is exercised end to end by `npm run e2e:pages` (also in CI), so a Pages
deployment is not just documented but tested. Note the server refuses a connection whose
`Origin` is not in `ALLOWED_ORIGINS` **before** the WebSocket handshake completes, so the
frontend's origin must be listed (browsers always send `Origin`; non-browser clients that
omit it are refused when a list is configured).

### Docker (signaling server)

```bash
docker build -t lanshare-signaling .
docker run --rm -p 8080:8080 \
  -e ALLOWED_ORIGINS=https://your-frontend.example \
  -e TURN_URLS=turn:turn.example.com:3478 \
  -e TURN_SECRET=... \
  lanshare-signaling
```

The image runs as an unprivileged user, exposes `/health`, and contains no frontend
build. Any static host can serve the UI.

## Offline: sharing with no internet

Three ways to run this with no internet. Pick by what the situation allows — the first line of
each row is the shortest path to a working transfer.

| Situation | Use | What it needs |
|---|---|---|
| **A computer is available** (phone → PC, or PC → PC) | `npm run offline`, or double-click **Start LANShare** from the bundle | Node.js on that computer. Other devices just open a URL. |
| **Nobody can run a server** (two phones, a locked-down PC) | `LANShare.html` — the whole app in one file, opened on both devices, then **pair with a code** | Nothing: no install, no server, no build. Carry the file by USB, AirDrop, chat or email. |
| **You want to install it as an app on a phone** | `npm run cert` then `npm run offline:secure` | A one-time certificate warning, because app installation requires HTTPS. |

`npm run offline` makes this machine the entire product: **one process serves the built
frontend *and* the WebRTC signaling WebSocket**, advertises no external ICE servers, and
prints the address other devices should open. Nothing in the path touches the internet. While
it runs, the pairing panel also offers **“Save the app for later”**, which hands a phone the
single-file copy so it keeps working once the computer is switched off.

```bash
npm run offline                 # prints http://<your-lan-ip>:8080 — open that anywhere
```

### Phone → PC (the usual case: no router, no internet)

1. On the computer: `npm run offline`
2. Turn on the phone's **hotspot**, join it from the computer (or put both on the same Wi-Fi).
3. On the phone: open the printed `http://<lan-ip>:8080` — or press **Pair another device**
   on the computer and scan the QR code shown there.
4. The phone appears under **Nearby devices**; pick it, choose files, send.

### PC → PC

Both computers on the same router/hotspot (a cable works too). Run `npm run offline` on one,
open the printed address on the other, send either way.

### What is actually verified (`npm run e2e:offline` → 12/12)

* the built app is served from the host's LAN address by the same process as signaling
  (driven through a **non-loopback** interface, not `localhost`);
* a desktop and a phone-sized browser context discover each other and open the data channel
  with **no ICE servers configured at all** — host/mDNS candidates only;
* a 1 MiB file transfers and the downloaded bytes hash to the source;
* **nothing left the LAN**: every request both browsers make is recorded, and a single
  request to any other host fails the suite (this is what makes "offline" a measured claim
  rather than a description);
* the HTTPS variant (self-signed, generated by the suite) serves and connects too, and its
  origin is a secure context, so the installable-PWA path is covered;
* traversal attempts against the static host are refused, and a missing asset is a 404 rather
  than the HTML shell.

### Install it as an app on the phone (optional)

Service workers require HTTPS, so installability needs a certificate:

```bash
npm run cert            # self-signed, SANs include every LAN address (`openssl` required)
npm run offline:secure  # serves the same thing over https://<lan-ip>:8443
```

Each device then shows a **one-time warning** for the self-signed certificate (Android:
*Advanced → Proceed*; iPhone: *Show Details → visit this website*, and to install the app you
must additionally trust the profile in Settings). Transfers themselves do **not** need any of
this — that is why plain HTTP is the default.

### No server at all: pair with a code

If **no** device can run LANShare — no Node on the computer, two phones, a machine you cannot
install anything on — pairing still works. Each device must already have the app open
(an installed PWA, or a page it loaded earlier), and the two devices must be able to reach each
other (same Wi-Fi or a phone hotspot). What they do *not* need is anything in between:

* **Pair another device → “No server available? Pair with a code instead”.**
* The first device shows an **invite code** (a QR image plus the text).
* The second device pastes it and shows a **reply code** back.
* The first device applies it and both appear in each other's **Nearby devices**, exactly like a
  normal session. Files then transfer over the same direct data channel as always.

The code is the offer/answer exchange compressed and encoded as text — nothing else. Both
representations are produced and the smaller one is kept, because (measured, not assumed) deflate
plus base64 is *larger* than the raw description for a small SDP and smaller only as the
description grows. In the suite's runs the invite is **~650 characters** carrying a **~590-byte**
description; a device with more network interfaces produces more candidates and a longer code,
still comfortably inside a QR code. The code is single-use, and it stops working when the dialog
closes.

### One file that *is* the app (`npm run build:single`)

`npm run build:single` produces `dist-offline/LANShare.html` — the entire application
(JavaScript, CSS, icons) inlined into one document of about **450 kB**. Opened straight from
disk (`file://`), it runs with no server, no install and no network:

* both devices carry the same file, open it, and use **Pair another device → Pair with a code**;
* the transfer then runs over a direct WebRTC data channel, exactly as everywhere else.

Verified by `npm run e2e:single-file` (10 checks), which opens the file from disk in two browser
contexts and asserts the whole journey: the app boots, it honestly reports that there is **no
connection service** (rather than pretending to connect), the two devices pair with a code, a
512 KiB file arrives with a matching SHA-256 — and the document makes **no network request of any
kind**. A `file://` page is a secure context in Chrome, which is why this works at all.

### Give it to somebody: the offline bundle (`npm run bundle:offline`)

For a computer that has no repository, no toolchain and no patience:

```bash
npm run bundle:offline   # writes dist-offline/LANShare-Offline-<version>.zip  (~1.2 MB)
npm run verify:bundle    # extracts it and runs it the way a user would
```

The archive contains `LANShare.html` (no server needed), `web/` (the served build), `server/`
(the compiled server with only its two runtime dependencies — `ws` and `zod`, no TypeScript, no
test runner), double-click launchers for Windows and macOS/Linux, and a plain-language
`README-OFFLINE.txt`. Node.js is the only prerequisite for the served flow, and nothing at all
for the single-file flow. `npm run verify:bundle` checks the archive with an independent ZIP
implementation, extracts it, and then boots that extracted copy — serving the app, answering
`/health`, performing discovery and relaying SDP — and opens it in a real browser.

### Honest limits

* **Same network required.** Devices must be able to reach each other directly; a guest
  network that isolates clients, or two different VLANs, will not work. This applies to the
  pairing-code flow too — the code replaces the *server*, not the network.
* **Multicast/mDNS.** Browsers hide host addresses behind `*.local` mDNS names and resolve
  them over multicast, which is normal on home routers and phone hotspots but is blocked on
  some corporate or public networks. If devices never connect there, the phone-hotspot route
  above is the reliable one.
* **Both devices need the app already.** Without a server, nothing can be downloaded from
  anywhere: each device has to open LANShare from something it already has — most practically an
  installed PWA (install once from any deployment, and the service worker keeps it working
  offline afterwards). If neither device has it, run `npm run offline` on one machine instead.
* **No re-negotiation.** A manual connection has no server to renegotiate through, so if it
  drops it stays down; the app says so and you create a new code rather than pretending to retry.
* **The host must stay running.** It *is* the signaling server and the web host; closing it
  ends discovery for everyone. There is no internet fallback and no relay: if a direct
  connection cannot be established, no transfer happens (the app says so rather than
  pretending).
* **Nothing is uploaded anywhere** — including in this mode, there is no server-side storage
  of file bytes; the host only serves its own build files and relays SDP/ICE.
* Verified between browser contexts on one machine over a real non-loopback interface. A
  physical phone-to-laptop run is listed in the manual test matrix rather than claimed here.

## Configuration

All frontend tuning lives in **`src/config.ts`** (single `config` object: chunk size,
backpressure watermarks, time limits, reconnect backoff, history limits, ICE servers).
Server tuning is environment-driven in `server/src/config.ts`. Copy `.env.example` and
adjust as needed — every value has a working default.

| Frontend (build-time) | Purpose |
|---|---|
| `VITE_BASE_PATH` | Base path for static hosting (`/lan-share/`) |
| `VITE_SIGNALING_URL` | WebSocket URL of the signaling server (required for split deploys) |
| `VITE_ICE_SERVERS` | JSON array of `RTCIceServer` entries |
| `VITE_APP_NAME`, `VITE_AUTHOR_URL`, `VITE_REPO_URL` | Branding/credit links |

| Server (runtime) | Purpose |
|---|---|
| `PORT`, `HOST` | Listen address (default `8080`, `0.0.0.0`) |
| `ALLOWED_ORIGINS` | Comma-separated Origin allow-list for the WebSocket upgrade |
| `DEFAULT_ROOM` | Room everyone joins automatically (default `NEARBY`) |
| `MAX_PEERS_PER_ROOM`, `MAX_ROOMS` | Room limits; empty rooms are swept |
| `MAX_MESSAGE_BYTES` | Largest signaling frame (SDP/ICE only) |
| `ROOM_TTL_MS`, `SWEEP_INTERVAL_MS` | Room lifetime and cleanup cadence |
| `HEARTBEAT_INTERVAL_MS`, `HELLO_TIMEOUT_MS` | Liveness / handshake deadline |
| `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_BURST` | Token-bucket rate limit per socket |
| `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `TURN_SECRET` | ICE servers; `TURN_SECRET` mints short-lived coturn credentials |
| `OFFLINE_MODE` | `true` = advertise no external ICE servers (host candidates only) — used by `npm run offline` |
| `SERVE_STATIC`, `STATIC_ROOT` | Serve the built frontend from this process (`dist/` by default) |
| `TLS_CERT`, `TLS_KEY` | Optional PEM pair; with both set the server speaks HTTPS (needed only for PWA install) |
| `SINGLE_FILE_PATH` | Absolute path of the single-file app to offer at `/LANShare.html` |

## Testing

```bash
npm run typecheck      # strict TypeScript, frontend
npm run test           # unit tests (protocol, frame codec, transfer, WebRTC links, storage safety, utils)
npm run test:server    # signaling server tests
npm run e2e            # full browser end-to-end suite (needs a build)
npm run e2e:reconnect  # focused reconnect regression (reload mid-session)
npm run e2e:pages      # deployment shape: sub-path build + cross-origin signaling
npm run e2e:offline    # offline LAN: one host, no internet, no external ICE servers
npm run e2e:serverless # no signaling server at all: pair by code, then transfer
npm run build:single   # build the whole app as one self-contained HTML file
npm run e2e:single-file # open that file from file:// on two "devices" and transfer
npm run bundle:offline # build the give-to-somebody archive (~1.2 MB)
npm run verify:bundle  # extract the archive and run it as a user would
npm run verify:docker  # replay every Dockerfile step (docker NOT required)
npm run probe:live     # end-to-end against an already-running dev server (see below)
npm run offline        # run the app on a LAN with no internet (see Offline above)
npm run test:all       # unit + server + e2e + offline LAN + serverless + single file
```

`npm run probe:live` covers the one path the suites above do not: the app served by the **dev
server** (`npm run start:all`), where the frontend resolves its signaling URL as same-origin
`/ws` and must reach the signaling server through the Vite proxy from a non-localhost
hostname. Start the app in one terminal and run the probe in another; it drives two isolated
browser tabs and asserts dev-server boot, signaling open, discovery, an open `ctl`/`bin` data
channel, the offer → receiver-approval gate, a 512 KiB transfer completed on both sides, a
SHA-256 match of the downloaded bytes, and a clean console. It is deliberately not part of
`test:all` or CI, because it needs a running dev server rather than a build.

`npm run e2e` runs **31 checks** with two isolated browser contexts against a real signaling
server and a real `vite preview` build, driving the actual UI and asserting on observable
behaviour: discovery, the consent gate, live progress/speed/ETA, completion, SHA-256 of
downloaded bytes, ZIP contents, text sharing, decline, cancel, a 20 MB transfer with
chunking and backpressure, a 64 MB send whose sender heap is sampled to prove the file is
streamed rather than buffered (measured: +4–16 MB of heap for a 64 MB file, against +92 MB
for a deliberately naive whole-file implementation), strict live-progress sampling, an OS share
arriving through the service worker's share target (live and on load), the unsupported
screen for browsers without WebRTC, no notification prompt on load with auto-accept off by
default, a device rename announced over both signalling and the live data channel, private
room pairing via `?room=CODE`, booting the built app inside a sandboxed `allow-scripts`
iframe — an opaque origin where `localStorage` throws and module scripts are fetched with
`Origin: null` — and asserting the shell renders, signalling still connects, the settings
sheet honestly says preferences are session-only there, and the frame logs no errors, an
axe-core accessibility audit across eight surfaces
(desktop, mobile, dialogs, boot overlay, dark theme, offline banner — including a check that
the mobile layout never scrolls sideways and the settings sheet fits the viewport), theme
persistence, QR pairing, settings, IndexedDB history, the offline PWA shell with an
automatic reconnect, and a clean console.

The audit bar is *no violations at all* (not just serious/critical) and it audits with
`prefers-reduced-motion: reduce` emulated, so entrance fades are not measured mid-transition
— that also exercises the reduced-motion path. Current state: **0 violations across all
eight surfaces**, and a separate sweep of eight states in both themes is clean too.

Running it requires `puppeteer` (set `PUPPETEER_PATH` or install it as a dev dependency) and
a `dist/` build. A red run keeps its evidence: `pageA.png` / `pageB.png`, both pages' debug
snapshots and a `summary.json` are written to the run's temporary directory (printed as
`artefacts kept for inspection: …`), and CI uploads it. Artefacts from *earlier* runs are
pruned at startup, so repeated failures cannot fill the temp filesystem.

The checks themselves are verified by fault injection — ten injected defects each fail the
check that owns them, and two of them only after the checks were tightened: disabling the
receiver's percentage rendering fails the strict live-progress check (while the tolerant
small-transfer check still passes on the metered rate), removing the creator name fails the
footer check, disabling the service worker's share-target interception fails the OS-share
check, skipping the capability gate fails the unsupported-screen check, flipping the
auto-accept default fails the defaults check, disabling either the rename announcement or
the room code fails its own check, ignoring `VITE_BASE_PATH` fails five deployment checks, and
a naive whole-file implementation fails the streaming check, and restoring the unguarded
`localStorage` read fails the embedded-frame check.

`npm run e2e:pages` covers the deployment shape that none of the other suites touch. It
builds the app with `VITE_BASE_PATH=/lan-share/` and `VITE_SIGNALING_URL=ws://…` (a *different*
origin), serves the result from a throwaway static host that only mounts that sub-path — as
GitHub Pages does — and then, in two browsers, verifies: the built HTML keeps every asset
inside the base path, two devices discover each other over the cross-origin socket, a file
transfers with matching SHA-256, the service worker is scoped to the base path, the manifest
and every icon resolve, nothing 404s, and the console stays clean. It also asserts the
server's `ALLOWED_ORIGINS` allow-list refuses a disallowed origin at the HTTP upgrade (403,
before any WebSocket exists) while the configured origin still connects. Ignoring
`VITE_BASE_PATH` fails five of its eight checks.

`npm run verify:docker` covers the signaling-server image without `docker`: it replays both
Dockerfile stages in a scratch directory (including the `.dockerignore` contract — every
`COPY` source must survive the ignore file), starts `node dist/index.js` exactly as `CMD`
does, runs the image's own `HEALTHCHECK` command both while the server is up and while it is
down, checks `EXPOSE`/healthcheck/config agree on the default port and that a bare run
(no `PORT` set) actually serves, completes a real discovery + SDP relay handshake against
that runtime stage, and asserts the server source contains no payload-persistence API. It
cannot verify the *container layer* (Alpine base, `USER node`, healthcheck scheduling) —
that still needs a real `docker build`. Which side dials is decided
by peer id, so it redraws sessions until it lands on the hardest reconnect case — the
device that did *not* reload keeps owning the dialer link whose data channels died with the
other page — holds that page offline for 12 s (so the survivor's offer is guaranteed to be
sent into a session that no longer exists), and then asserts the app rebuilds the link by
itself within 25 s, with no reload and no manual retry on the surviving side.
`E2E_OFFLINE_DWELL_MS` and `E2E_RECOVERY_TIMEOUT_MS` tune it; `E2E_TRACE_RECONNECT=1`
dumps per-sample snapshots of both pages during the offline check in the main suite.

### Manual test matrix

The offline recipes are the ones a physical device run matters most for:

| # | Scenario | Expected |
|---|---|---|
| 1 | Open two devices in the same room | Each shows the other with a random name and "Connected" |
| 2 | Send one file | Receiver sees an incoming dialog naming the file; nothing downloads before Accept |
| 3 | Accept | Both sides show %/speed/ETA, then "Completed"; receiver can download it |
| 4 | Decline | Sender is told; no file appears on the receiver |
| 5 | Cancel mid-transfer | Both sides show cancelled; late bytes stop; receiver keeps nothing partial |
| 6 | Send 20 files + a folder | Queue lists every file; "Download all (ZIP)" yields a valid archive |
| 7 | Send a 2 GB video | Memory stays flat, speed/ETA update, transfer completes |
| 8 | Send text with a link | Receiver sees the text; link is not clickable/auto-opened |
| 9 | Refresh the receiver mid-transfer | Sender reports the disconnect; no partial file is kept |
| 10 | Unplug the network briefly | Banner shows reconnecting; transfer resumes or reports failure honestly |
| 11 | Toggle light/dark/system, reload | Theme persists |
| 12 | Pair via QR on a second network | Private room id appears; both devices find each other |
| 13 | Install as PWA, then go offline | App shell loads offline; transfers need both devices online |
| 14 | Keyboard-only pass | Every control is reachable; dialogs trap focus and restore it |
| 15 | `npm run offline`, then open the printed URL on a phone over a hotspot | Phone sees the host under Nearby devices and can send/receive with no internet |
| 16 | Same, with `npm run cert` + `npm run offline:secure` | One certificate warning, then the app installs as a PWA and still transfers |
| 17 | Two devices with the app already open, no server: pair with a code (QR to one device, reply code back) | Both appear in Nearby devices and a file transfers; a wrong code is refused with a clear message |
| 18 | Copy `LANShare.html` to a phone (AirDrop/USB), open it from Files, pair with a code against the computer | The file opens as the full app; pairing and transfer work with the computer's server stopped |
| 19 | Unzip the offline bundle on a machine with Node installed, double-click the launcher | It prints the LAN address, the browser opens, and a phone can send/receive; no `npm install` needed |

## Architecture

```
server/src/
  server.ts      WebSocket lifecycle, upgrade, heartbeat, rate limits
  rooms.ts       room registry, membership, cleanup sweeps
  protocol.ts    zod schemas for signaling frames
  config.ts      environment-driven configuration
src/
  config.ts      single frontend config object
  services/
    signaling.ts  reconnect with exponential backoff + jitter (and an immediate retry
                  when the browser reports that the network is back)
    webrtc.ts     RTCPeerConnection per peer, ctl/bin data channels, ICE restarts,
                  link health checks + full rebuild when data channels are gone,
                  dead-link cleanup when a peer leaves
    transfer.ts   chunked outbound streaming, inbound assembly, cancellation
    frame.ts      binary frame codec (kind byte + JSON header + payload)
    storage.ts    IndexedDB history (metadata only)
    file.ts       ZIP creation (fflate), Blob downloads, previews
  state/         React context: settings, transfers, toasts
  components/    UI (dialogs, transfer list, queue, settings, QR, history…)
```

**Protocol v2.** Binary frames are `[1-byte kind][2-byte header length][JSON header][payload]`.
Chunks (`kind 0`) carry `{transferId, fileIndex, offset, length}`; in-band control frames
(`kind 1`) carry `FILE_START`, `FILE_END` (with optional SHA-256) and `TRANSFER_DONE`.
Because they share one ordered stream, a file's completion marker is always delivered
after its last byte.

## Browser support

Chromium 100+, Firefox 100+, Safari 15.4+, Edge 100+. The app checks for
`RTCPeerConnection`, DataChannels and Blob APIs at startup and shows a clear message
instead of failing silently. Direct-to-disk receiving (File System Access API) is used
when available and falls back to in-memory download elsewhere.

### Embedded and storage-blocked contexts

The app also runs where browser storage is not available — an iframe with
`sandbox="allow-scripts"`, some private modes, locked-down webviews. There, reading
`window.localStorage` throws a `SecurityError` outright, so the app never touches it
directly: everything goes through `src/utils/safeStorage.ts`, which probes the store once
and falls back to an in-memory copy, and the settings sheet says plainly that preferences
are kept for the session only rather than pretending they were saved. To let such an
opaque-origin frame load the app at all, the bundled **dev and preview** servers reflect the
request origin (`cors: { origin: true }` in `vite.config.ts`) — a sandboxed frame fetches
module scripts with `Origin: null`, which the default localhost-only CORS policy refuses.
Deployments are unaffected: a static host (GitHub Pages) serves its own files and does not
need — or get — that setting, and the app works there in a normal tab. `npm run e2e` covers
both halves with a dedicated check. The **offline host** (`npm run offline`) marks its build
files `Access-Control-Allow-Origin: *` for the same reason: the directory only ever contains
the public build output, and an embedded frame must be able to load the app from it.

## License

MIT — see `LICENSE`. Built by Muhammad Anas.
