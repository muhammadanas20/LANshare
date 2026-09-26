# PROJECT COMPLETED — LANShare

**Share anything. Nearby. Instantly.**
Built by **Muhammad Anas** · v1.0.0 · MIT

A complete, working LAN file/text sharing app: static React frontend (deployable to GitHub
Pages), a separate Node WebSocket signaling server that never touches file bytes, and
direct browser-to-browser WebRTC DataChannel transfers.

---

## 1. Verification (everything below was actually executed)

| Step | Command | Result |
|---|---|---|
| Frontend typecheck | `npm run typecheck` | ✅ clean (strict TS, no `any` escapes in app code) |
| Frontend unit tests | `npx vitest run` | ✅ **10 files / 111 tests passed** (incl. 11 for the WebRTC link lifecycle, 6 for storage safety) |
| Signaling server tests | `npm --prefix server run test` | ✅ **47 tests passed** (rate limiting, static serving, offline LAN mode, path-traversal safety) |
| Production build | `npm run build` | ✅ built in ~3.6 s (`dist/` ≈ 146 kB app + 134 kB react + 118 kB vendor, gzip 32–43 kB each) |
| End-to-end suite | `npm run e2e` | ✅ **31/31 checks passed** — repeated green runs; the reconnect phase is steady at 0.3–0.5 s (it used to vary between 0.9 s and 42.5 s) |
| Accessibility audit | inside `npm run e2e` | ✅ **axe-core: 0 violations across 8 surfaces** (desktop page + settings sheet, mobile page + settings sheet, boot overlay, fresh session, dark theme, offline banner), `axe-core` as a dev dependency |
| Reconnect regression | `npm run e2e:reconnect` | ✅ 1/1 in every run (hard dialer ordering forced, page held offline 12 s; recovered on its own **0.7 s** after connectivity returned) |
| Full pipeline | `npm run test:all` | ✅ exit 0 (111 + 47 + 31/31 + 12/12 offline + 10/10 serverless), rerun after every fix in this list |
| Deployment test teeth | fault injection | ✅ ignoring `VITE_BASE_PATH` fails **5 of 8** deployment checks; restored, all 8 pass |
| New checks have teeth | fault injection | ✅ every injected fault fails its check: service-worker share interception, the capability gate, the auto-accept default, the rename announcement, an ignored room code, an ignored `VITE_BASE_PATH`, the receiver's percentage rendering, the author credit, whole-file buffering on the sender, and the storage-blocked boot regression (ten; three only after the checks themselves were tightened — see bug 18) |
| Streaming, measured | inside `npm run e2e` | ✅ sending a 64 MB file grows the sender's heap by **+4.2 … +16.0 MB** (budget 32 MB); the same suite with a deliberately naive whole-file implementation measures **+91.6 MB** and fails |
| Both servers boot | signaling `:8080/health` + `vite` `:5173` | ✅ HTTP 200 from both |
| Single-file app (no install, no server) | `npm run e2e:single-file` | ✅ **10/10 checks** — the whole app built as one **448 kB** HTML file, opened from `file://` in two browser contexts: it boots, honestly reports that there is no connection service, pairs both devices with a code, opens the data channel, and transfers a 512 KiB file whose downloaded bytes hash to the source — with **no network request of any kind** |
| Offline bundle (give-it-to-somebody) | `npm run bundle:offline` + `npm run verify:bundle` | ✅ **8/8 steps** — a **1.2 MB** archive holding the single-file app, the served build, the compiled server with only `ws`/`zod`, double-click launchers and instructions; verified by extracting it with an *independent* ZIP implementation, then booting that extracted copy (serves the app, `/health`, discovery + SDP relay) and driving it in a real browser, with no dev toolchain present |
| Serverless pairing | `npm run e2e:serverless` | ✅ **10/10 checks** — the app is served as plain static files with **no `/ws` route at all**; two contexts produce and exchange pairing codes (**~650 characters** carrying a ~590-byte session description), both list each other, a data channel opens on host candidates, a 768 KiB file arrives with a matching SHA-256, and a malformed code is refused with a clear message |
| Offline host, documented flow | `npm run cert` → `npm run offline:secure` | ✅ certificate carries the LAN address in its SANs; the HTTPS origin is a **secure context**, the shell renders, signalling connects, the **service worker registers** (PWA install path) and no ICE servers are configured |
| Offline LAN (no internet) | `npm run e2e:offline` | ✅ **12/12 checks** — one process serves the app *and* signaling on the machine's non-loopback address, two browser contexts (desktop + phone-sized) discover each other with **no ICE servers configured**, a 1 MiB file arrives with a matching SHA-256, the HTTPS variant is a secure context with a registered service worker, traversal is refused — and **zero requests left the LAN** (every request from both browsers is recorded; one foreign host fails the suite) |
| Deployment shape (GitHub Pages style) | `npm run e2e:pages` | ✅ **8/8 checks passed** — sub-path build (`/lan-share/`), cross-origin signaling, `ALLOWED_ORIGINS` allow-list, discovery + data channel + a 512 KiB transfer with matching SHA-256, service-worker scope, manifest/icons, zero 404s |
| Live dev-server path | `npm run probe:live` (against a running `npm run start:all`) | ✅ **6/6 steps** — dev-server boot, signaling open through the Vite `/ws` proxy from a non-localhost host, discovery, an open `ctl`/`bin` data channel, the offer → approval gate, a 512 KiB transfer completed on both sides, and a SHA-256 match of the downloaded bytes (0 console errors) |
| Dockerfile dry-run | `npm run verify:docker` | ✅ every instruction replayed: build + runtime stages, `CMD`, the image's own `HEALTHCHECK` (up & down), default-port agreement, a real discovery + SDP relay handshake in the runtime stage, and the no-payload-persistence invariant |
| Icon/PWA generation | `npm run icons` | ✅ favicon, 16/32/192/512/maskable/icons, apple-touch, og-image |

The E2E suite drives **two isolated browser contexts** against a real signaling server and
a real `vite preview` build and asserts on observable behaviour:

1. both clients boot and connect to signaling
2. welcome dialog appears only on the first visit
3. each device discovers the other
4. a direct WebRTC data channel is established automatically
5. files can be added to the queue with previews and metadata
6. receiver must approve before any data flows (nothing downloads pre-consent)
7. both sides report live progress, speed and ETA (a ~3 MB loopback transfer can finish
   inside a single paint, so this one accepts live samples *or* the metered rate that
   replaced them — a transfer with neither still fails)
8. transfer completes on both sides
9. received file integrity — downloaded bytes hash matches the source (SHA-256)
10. multi-file download produces a valid ZIP containing both files (`fflate.unzipSync` verified)
11. text and links can be shared (link shown as text, no `javascript:` rendering)
12. a declined transfer notifies the sender and transfers nothing
13. the sender can cancel a transfer in flight
14. a 20 MB file transfers intact with chunking and backpressure
15. the sender streams a large file instead of buffering it in memory — a 64 MB send with
    `performance.memory` sampled every 100 ms through the whole transfer (baseline and peak
    taken around a forced GC); the heap must grow by less than half the file size, which a
    whole-file implementation cannot do
16. both sides render live progress, speed and ETA during the large transfer (strict: at
    least one live percentage on each side plus speed/ETA samples, which is what makes the
    tolerant check in 7 safe rather than toothless)
17. an OS share reaches the app through the share target — the multipart POST the OS share
    sheet makes is sent through the real service worker, the file lands in the queue, the
    parked payload is consumed, and (in a fresh session) a payload parked while the app was
    closed is collected on load and the `?share=1` parameter is cleaned up
18. a browser without WebRTC gets an honest unsupported screen (naming the missing
    capability, keeping the author credit, and not booting the app anyway)
19. no notification permission prompt on load and auto-accept defaults to off
20. renaming this device is announced to the other device — over **both** channels: the
    signalling `PEER_UPDATED` broadcast and the in-band `HELLO` on the live data channel —
    and the new name is persisted
21. a private room code (`?room=CODE`) pairs two devices away from the default room, with
    exactly one peer in that room
22. the interface passes an automated accessibility audit (axe-core over eight surfaces at
    desktop and mobile widths, including the boot overlay, the dark theme and the offline
    banner; the mobile pass also asserts no sideways scrolling and that the settings sheet
    fits the viewport)
23. theme switching and persistence work (survives reload)
24. the QR pairing dialog renders a code and room id
25. settings expose theme, device name, privacy and about
26. transfer history is stored in IndexedDB (read directly from the `history` object store)
    and the Clear-history action empties it
27. the footer credits the author — asserted on the app's own `<footer>` element, not on "somewhere on the page"
28. the PWA manifest and service worker are served — the service worker takes control, the
    `lanshare-shell-v2` cache holds the hashed scripts, and a reload with the network
    switched **off** still renders the app shell
29. the offline shell loads without a network and the app reconnects — while offline the
    app reports the lost connection (asserted on the signalling state, not on wording), and
    once the network is back it rebuilds the direct link by itself within 20 s; the check
    asserts on the real `ctl`/`bin` channels being `open`, not on UI text, and prints a
    per-phase timing line (`service-worker → shell-cache → offline-reload → offline-shell →
    back-online → app-booted → data-channel`) that makes a slow reconnect readable
30. no uncaught console errors during the whole session
31. the app boots inside a sandboxed, storage-blocked frame (embedded preview) — the built
    app is loaded in an iframe with `sandbox="allow-scripts"`, i.e. an opaque origin where
    reading `window.localStorage` throws and module-script requests carry `Origin: null`. The
    check asserts the shell renders, signalling reaches "Ready to receive", the storage error
    is genuinely present (`SecurityError`), no error boundary replaces the app, the settings
    sheet says preferences are session-only here, and the frame logs zero console errors. It
    deliberately loads the frame **without** `?debug=1`, because that flag short-circuits the
    very read that used to crash the app. This is the check that would have caught bug 23, and
    reverting the fix fails it (30/31) while everything else stays green.

Seven focused suites sit alongside the main one, each covering a shape the main suite does
not: `npm run e2e:reconnect` (a forced mid-session reload), `npm run e2e:pages` (sub-path
build + cross-origin signaling + origin allow-list), `npm run e2e:offline` (the whole product
on one LAN host with no internet — 12 checks, including a no-foreign-request audit),
`npm run e2e:serverless` (no signaling server anywhere: pairing by text code, then a transfer),
`npm run e2e:single-file` (the app opened straight from disk, no server and no install) and
`npm run verify:docker` / `npm run verify:bundle` (the Dockerfile replayed without `docker`; the
give-to-somebody archive extracted and run on its own). All seven run in CI.

A sixth unit file uses the same reason the E2E suites did: `src/utils/safeStorage.test.ts`
pins the storage accessor (round-trip when storage works, `SecurityError` on read, an
in-memory fallback when only writes are rejected, and remove) — the accessor that keeps a
blocked context from taking the app down.

The unit suites grew for the same reason the E2E suites did: `src/services/webrtc.test.ts`
covers the link lifecycle with a fake `RTCPeerConnection` (dialer election, connected state
requiring both channels, no reuse of a link with dead channels, immediate rebuild on re-key,
the departed-peer roster guard, the rebuild cap, adopting channels offered by the other side,
answering on a fresh connection after a peer restart) — the code behind the hardest bugs in
this project, previously covered only end to end. The server suite gained rate-limit tests:
a flooding socket is throttled and closed with a fatal `rate-limited` error, while a
correctly paced client is never throttled.

`npm run e2e:reconnect` covers the hardest reconnect case deterministically. The dialer is
elected from peer ids, so the script redraws sessions until the device that survives keeps
owning a dialer link whose data channels died with the other page (page A reloads while
offline, page B never reloads). It then holds A offline for 12 s — longer than the survivor
needs to notice the dead channels and offer again, so that offer is guaranteed to be sent
into a session that no longer exists — before A returns on a brand-new signalling session
and the link has to be rebuilt from scratch within 25 s.

* against the pre-fix build: **fails** after 45.2 s with `ctl=none` / `ctl=closed`
* against the first fixed build: passes, but takes 20.7 s (the lost offer was only repaired
  when ICE finally failed)
* against the shipped build: **0.7 s** after connectivity returns, in every run

Environment knobs: `E2E_OFFLINE_DWELL_MS`, `E2E_RECOVERY_TIMEOUT_MS`,
`E2E_RECONNECT_ATTEMPTS`; `E2E_TRACE_RECONNECT=1` makes the full suite dump per-sample
snapshots of both pages during the offline check.

`puppeteer` is required for step 4+ (`npm i -D puppeteer` or `PUPPETEER_PATH`); the browser
is resolved from `~/.cache/puppeteer`.

---

## 2. Bugs found by actually running it (and fixed)

These were real defects caught by the test suites — not theoretical:

1. **Completion markers raced the payload.** `FILE_START`/`FILE_END` travelled on the `ctl`
   channel while bytes travelled on `bin` — two separate SCTP streams, so a completion
   could overtake the last chunks (observed: sender sent 48 frames, receiver got 37, missing
   offsets 2424832…3080192). Fixed by moving the markers **in-band onto the data channel**
   (protocol v2: `[kind][headerLen][JSON][payload]`, `FILE_START` / `FILE_END` /
   `TRANSFER_DONE`).
2. **Receiver never completed.** Completion was gated only on markers, but `FILE_END`
   handling is asynchronous (SHA-256 + Blob assembly), so the download UI never appeared.
   Fixed with an explicit `endsSeen` + `senderDone` + "all files assembled" gate.
3. **Concurrency limit counted finished transfers.** Completed records linger ~60 s for
   cleanup/history, so after a few sends every new transfer was refused with "Too many
   transfers are already running". Fixed: only `requesting`/`active` transfers count.
4. **A finished transfer swallowed the next one.** The binary `FrameDecoder` was kept per
   transfer, so a lingering completed transfer consumed the bytes of the following
   transfer on the same link (20 MB transfer: sender `completed`, receiver stuck at
   `0 bytes`). Fixed: one decoder **per peer**, dispatch by each frame's `transferId`.
5. **Backpressure wait could park for 30 s.** `bufferedamountlow` only fires on a
   threshold transition; if the buffer drained between the size check and the listener
   attach, no event ever arrived. Fixed with a drained re-check plus a 40 ms poll and
   a listener that reports the true buffer state on timeout.
6. **Modal stole focus on every parent re-render** (typing into the text box registered a
   single character before focus jumped to "Close dialog"). Fixed with a ref-based Escape
   handler, an effect keyed on `open` only, and focus claims that respect whatever is
   already focused.
7. **No speed readout for small files.** The smoothing meter needed ≥ 0.2 s of samples, so
   fast transfers rendered "—". Fixed by seeding the average with the measured rate.
8. **Negotiation guard crashed on `signalingState === 'closed'`** (TS2367). Replaced with
   `this.disposed || link.pc.signalingState !== 'stable'`.
9. **`new URL('sw.js', '/')` threw at module load** → service worker registration broke the
   boot sequence. Fixed by resolving against `window.location.origin`.
10. **Identifiers no longer use `Math.random()`** anywhere (peer ids, room codes, toast ids,
    reconnect jitter) — WebCrypto only, with a documented non-`Math.random` fallback and a
    regression test that greps the source.
11. **Auto-reconnect deadlock after a peer reload (the hardest one).** Reproduced by the
    offline-shell check: page A reloads, its session id changes; the survivor B re-keys its
    existing link to the new id, and `ensureConnection` returned early because a link
    already existed. An ICE restart could recover the *transport* (`connectionState:
    connected`), but the old `ctl`/`bin` channels were `closed` for good — so the link sat
    in `connecting` with `ctl: none` / `ctl: closed` forever while both sides showed
    "connected" peer connections. Root cause: nothing ever rebuilt a link whose data
    channels had died, and the surviving dialer kept offering on the same dead peer
    connection. Fixed in `src/services/webrtc.ts`:
    * `isLinkUsable` / `isLinkAlive` distinguish a link that is still negotiating from one
      whose channels are gone (a closed data channel can never be revived);
    * `ensureConnection` now tears down a stale link instead of early-returning, so a
      re-join builds a fresh peer connection and fresh channels;
    * `rebuildLink` (capped at 3 attempts, then an honest "could not be re-established"
      state the user can retry) is triggered from the channel-close handler, from a
      connect timeout watchdog, and from the ICE-restart path — ICE restarts are now only
      used when the channels themselves are still alive;
    * an incoming offer from a restarted peer connection (different ICE ufrag, or a link
      that cannot carry data) is answered on a fresh connection instead of the dead one;
    * signalling room membership is mirrored into the manager (`setRoster`) so links to
      devices that actually left are never rebuilt and never spray "device no longer
      available" errors.
    Verified: `npm run e2e:reconnect` fails on the pre-fix build (45.2 s timeout, exact
    dead-channel state) and passes on the fixed build (rebuild in ~0.6–2.6 s).

12. **Recovery waited for ICE to *fail* (~40 s).** With bug 11 fixed things reconnected
    again, but a per-phase timing line added to the offline check showed the whole delay
    sitting in one phase: `connected 42.5 s`. Cause: the survivor rebuilds as soon as it
    notices the dead channels, and if the other page is still offline (or still booting)
    that offer is delivered to a signalling session that no longer exists — so the fresh
    peer connection sat with its channels in `connecting` until ICE consent timed out
    (~30 s) and the ICE-restart path happened to re-offer successfully. Three fixes:
    * `rekeyLink` starts over immediately when the re-keyed link cannot carry data — the
      device came back on a new session, so anything negotiated towards the old one is
      lost, no reason to wait for ICE;
    * the manager's own roster now follows a re-key (delete old id, add new id) *before*
      the rebuild consults it, otherwise the immediate rebuild was skipped as if the peer
      had left;
    * `isLinkAlive` trusts a channel in `connecting` for only one connect-timeout window
      (20 s), so a negotiation that goes nowhere is rebuilt by the watchdog instead of
      waiting for ICE failure.
13. **A page that booted while offline waited out its backoff tick.** Signalling retries
    used exponential backoff (correct), but nothing reacted to the browser's `online`
    event, so a page that loaded offline could sit up to ~10 s (the capped delay) before
    even trying again after the network returned. `SignalingClient` now listens for
    `online` and reconnects immediately (it also removes the listener on `disconnect()`).
    Observed effect: reconnect 0.7 s after connectivity returned.

14. **A flaky progress check, and the CI that could not have caught any of this.**
    Two things were wrong with the *verification*, not the app:
    * the "live progress" check demanded a percentage from a ~3 MB loopback transfer, which
      can complete inside a single paint. Instrumenting the sampler settled it — the log
      showed `gaps≈49 ms` (the sampler was never throttled) with `percent=0`, i.e. the
      receiver genuinely never painted one. The check now accepts live samples *or* the
      metered rate (a transfer with neither still fails) and a new, strict check asserts
      live percentages plus speed/ETA on the 20 MB transfer, where the active window lasts
      seconds. The footer check was also tightened to read the app's own `<footer>` rather
      than any text on the page;
    * the CI `end-to-end` job ran `npm ci` for the server but never built it, so both E2E
      scripts would have failed instantly on `server/dist/index.js is missing`; and its
      "upload failure screenshots" step was decorative — no screenshots were taken and the
      artefact directory was deleted even on failure. The job now builds the signaling
      server, and a red run keeps `pageA/B.png`, both debug snapshots and `summary.json`
      for upload. Both workflow files parse; the job's steps were replayed locally with its
      exact port settings.

    Both harness fixes were verified by fault injection: with the receiver's progress rows
    disabled the strict check fails (`samples=42 gaps≈49ms withPercent=0 percent=0
    speed=42`) while the tolerant check still passes, and with the creator name replaced in
    the built bundle the footer check fails with the footer's own text quoted in the error.

15. **Accessibility audit found four real defects** (and one deliberate harness decision).
    Adding axe-core to the suite turned claims into evidence, and the first runs were not
    clean:
    * the dialog title bar was a `<header>` inside `<div role="dialog">` — because a plain
      div with `role="dialog"` is not sectioning content, that element kept its `banner`
      mapping, so every dialog created a **duplicate banner landmark** (`landmark-no-duplicate-banner`, `landmark-unique`). Now a styled `div`;
    * the same thing happened during boot: the app's `<main>` and the boot overlay's content
      coexisted, so the overlay is now `<main>` (it *is* the main content while it is up) and
      the shell's `<main>` carries `aria-hidden` until the overlay fades — no duplicate
      `main`, and the boot text sits inside a landmark;
    * the light-theme `--warning` on the status chip measured **4.35:1** and the banner
      detail (`opacity-90` on `--text-muted`) **4.07:1** — both under the 4.5:1 floor for
      small text. The opacity is gone and `--warning`/`--danger` were darkened (now 5.7:1
      and 4.9:1 on their tints) so the *connecting* and *offline* states — exactly when the
      user needs to read them — pass;
    The one harness decision, stated plainly: audits emulate `prefers-reduced-motion:
    reduce`, because entrance animations fade text in from 0 opacity and axe caught a
    measurement mid-fade (muted text at ~73 % opacity, ratio 4.42). That is a few-hundred-
    millisecond transition, not a readable-state defect, and the app already zeroes
    animation/transition durations for users who ask for reduced motion — which the audit
    therefore exercises as a side effect. With that in place, an out-of-suite sweep across
    eight states in both themes (boot, ready, reconnecting, offline, light and dark) ends at
    **0 violations**, and the in-suite check reports 0 across its seven surfaces.

16. **A departed device left a dead link behind.** With the audit's throwaway device joining
    and leaving, page B kept a `connecting` link to it whose channels could never open — and
    with two links churning, the later offline check's reconnect exceeded its 20 s budget
    once. Signalling now tells the link manager to drop a link that cannot carry data when
    its peer leaves (`dropDeadLink`), so a departed device costs nothing afterwards. The
    audit's theme/offline excursions were also moved onto the throwaway page: perturbing the
    mid-suite pages was what surfaced the problem, and page A is now untouched by the audit.

17. **The GitHub Pages deployment shape had never been exercised** — and the origin
    allow-list was enforced too late. Two findings from building `npm run e2e:pages`
    (build with `VITE_BASE_PATH`, serve it from a sub-path, signal over a *different*
    origin):
    * the server checked `Origin` in `wss.on('connection')` — i.e. **after** the WebSocket
      handshake completed — and then closed with 1008. A disallowed page therefore did get a
      socket (no frame could be exchanged, but the correct place to refuse is the upgrade).
      The check moved into `verifyClient`, so a blocked origin now gets **HTTP 403 before any
      WebSocket exists**; the server test was updated to assert the stronger contract
      (refused upgrade *and* the allowed origin still handshakes normally);
    * the deployment test found nothing else broken — sub-path asset URLs, service-worker
      scope, manifest and icon paths, cross-origin signaling, discovery, a 512 KiB transfer
      with matching SHA-256, and a clean console all pass on the deployed build. As a
      teeth-check, ignoring `VITE_BASE_PATH` fails five of its eight checks.

18. **Two of the new checks passed for the wrong reason** (found by fault injection, which
    is why every new check gets one):
    * the auto-accept assertion located the switch by searching the settings sheet for text
      and taking the first `role="switch"` it found — that was the *notifications* toggle, so
      it read `false` no matter what auto-accept was set to. It now targets the switch by its
      own accessible name (`aria-label="Auto-accept incoming transfers"`), and setting the
      default to ON now fails the check;
    * the rename check only saw the rename arrive over signalling (`PEER_UPDATED`), so
      disabling the in-band `HELLO` re-announcement entirely still passed. It now also asserts
      the link identity learnt from the peer's HELLO on the live data channel — the rename is
      verified over both transport paths, and disabling either one fails it.
    A third injected fault (an ignored room code) was itself invalid at first — it left a
    variable unused, `tsc` refused to build, and the suite ran against a stale `dist/`. The
    build must be green for a fault to be a fault; that is now the habit.

19. **E2E servers leaked their grandchildren.** `npx vite preview` spawns vite as a child
    process, so killing the launched process left the real server holding the port (several
    runs had accumulated `vite preview` and `tsx` processes — the same leak that once caused
    the renderer-OOM episode). Both E2E scripts now spawn detached and kill the whole
    process group; a full suite run leaves zero processes and frees its ports.

20. **"Memory stays flat" had never been measured** — and the measurement is now in the
    suite. A 64 MB send samples `performance.memory.usedJSHeapSize` every 100 ms, with the
    baseline and peak taken around a forced GC: the shipped app grows the sender's heap by
    **+4.2 MB to +16.0 MB** across runs (settling back afterwards), while the same suite with
    a deliberately naive implementation that pulls each file into an `ArrayBuffer` first
    measures **+91.6 MB** and fails. The check is what makes the streaming claim falsifiable
    instead of aspirational.

21. **A link was reported "connected" while its binary channel was still closed.**
    `isConnected()` — the guard the state layer uses before allowing a send — checked the
    transport plus the `ctl` channel only. Writing the unit tests surfaced it: a send could be
    approved on a link whose `bin` channel had not opened yet. It now requires both channels
    (the same predicate the internal link-health logic uses), and 30/30 E2E plus the reconnect
    suite still pass.

22. **Failure artefacts accumulated until they were the problem.** A red run deliberately
    keeps its evidence (`pageA/B.png`, both debug snapshots, `summary.json`) — but nothing
    pruned older runs, and seven kept directories filled 434 MB of the ~1 GB tmpfs, which is
    the same condition that once produced renderer crashes and phantom timeouts. Both suites
    now remove artefacts left by *previous* runs at startup (this run's own directory is
    untouched), and Chromium's default `~/Downloads` is cleaned even when the run fails
    instead of only on success. Verified by planting two stale directories, forcing a failing
    check: exactly one — the current run's — survived, the empty `~/Downloads` was gone, and
    the kept directory still held both screenshots and the summary. After the probe was
    removed, a green run leaves the tmpfs clean (51 MB used, 942 MB free).

23. **The app white-screened where storage is blocked** (found by a probe for the embedded
    preview case, not by any existing check). In a document with an opaque origin — an
    iframe with `sandbox="allow-scripts"`, some private modes, locked-down webviews —
    *reading* `window.localStorage` throws a `SecurityError`. A debug-snapshot effect read
    it unguarded, so the error boundary replaced the whole app with "Something went wrong".
    Two fixes: every storage touch now goes through `src/utils/safeStorage.ts` (a probed
    accessor with an in-memory fallback, so a blocked context silently keeps preferences for
    the session), and the settings sheet says so honestly ("Preferences are kept for this
    session only — this browser context blocks local storage") instead of claiming they are
    stored on the device. Verified by a new E2E check that loads the built app in a sandboxed
    frame and asserts the shell renders, signalling reaches "Ready to receive", the storage
    error is real (`SecurityError`), no error boundary appears, that note is shown, and the
    frame logs zero console errors — plus 6 unit tests for the accessor (global: 95).
    Fault-verified: restoring the old unguarded read fails that check (30/31) while
    everything else stays green.

24. **An opaque-origin frame could not load the app at all.** Module scripts are fetched with
    CORS, and a sandboxed frame sends `Origin: null`; the Vite dev/preview servers answered
    only the default localhost origins, so the shell never even started there. Both servers
    now reflect the request origin (`cors: { origin: true }`, documented in the README, and
    scoped to the dev/preview servers — a static deployment serves its own files). The same
    probe that found bug 23 is what surfaced this: with CORS fixed, the app renders inside
    the sandboxed frame and connects to signalling from an opaque origin.

25. **Offline mode made the app chase STUN servers that cannot exist.** With the host
    advertising no ICE servers (`OFFLINE_MODE=1`), the client kept its built-in Google STUN
    default, because `setIceServers()` ignored empty lists and nothing told the client that
    "offline" meant "there is no internet". Two changes: the server now says
    `offline: true` in WELCOME, and the client reacts to it by configuring *host candidates
    only* — the configuration two devices on one network actually need. Found by a check that
    reads the live ICE configuration the peer connections are built with; fault-verified by
    removing the reaction (the suite drops to 11/12 and names the STUN list it saw).

26. **The offline host answered `/` with JSON instead of the app.** The signaling server's
    "this is a signaling server" blurb was registered on `/` before the static handler, so a
    phone opening the printed address got JSON. Document routes now belong to the frontend
    when this process hosts one; the blurb only answers when there is no frontend to serve.
    Caught by the first end-to-end run of the offline suite (the app bundle was simply not in
    the document).

27. **A verification invariant was too blunt, and one of my fault checks was aimed at the
    wrong thing.** The Dockerfile dry-run refused *any* `node:fs` use in the server source, so
    streaming a public build directory looked like a violation of the "never stores file data"
    promise. It now asserts the thing that matters and is stronger than before: **no
    filesystem write API anywhere**, and **no file reads at all** in the modules on the
    signaling/payload path (`rooms`, `server`, `protocol`, `lan`) — the two legitimate readers
    are the static host and the TLS loader. Separately, the first offline failure I diagnosed
    as "unreachable STUN stalls the connection" was actually my assertion being blind (the
    receiver page was loaded without the debug hook, so its state read `null`): the fix for
    25 is still correct and verified, but the stall explanation was wrong and is not claimed.

28. **Pairing codes were being inflated by the encoder's own "optimisation".** The first
    version always deflated the session description before base64-encoding it. Measured against
    real payload sizes, that produced a code **larger than the raw description** for a small SDP
    (deflate overhead plus base64 expansion ≈ 2.1×, and ≈ 1.4× even on a busier one) — a denser
    QR code for no benefit. The encoder now builds both representations and keeps the shorter
    one, with the choice visible in the payload prefix so decoding never has to guess; the unit
    tests assert the choice and that both decode.

29. **The serverless suite's own size report was wrong before it was right.** Inspecting the
    payload in Node threw "incorrect header check" because fflate emits *raw* DEFLATE while
    Node's `inflateSync` expects a zlib wrapper. The app was correct; the inspection was not
    (now `inflateRawSync`). Worth recording because "the test disagrees with the app" is the
    moment to check which one is lying.

30. **An invite could be handed out with no candidates in it.** `waitForIceGatheringComplete`
    returns whether gathering actually finished, and the first version ignored that — so when
    gathering was slow (the suite caught one reply taking 4.1 s against a 4 s window), the
    description was serialized without candidates and the pairing code was silently dead: the
    two devices would pair, then never connect. Now the gathered result is used, the window is
    8 s (measured need, documented in the config), and a description containing **zero**
    candidates is refused outright with an actionable message instead of being shown as a code.
    Found only in a combined run — the suite passed standalone and failed inside `test:all`,
    which is exactly why the battery runs the suites back to back.

31. **Two of my own checks were wrong before they were right** (the product was fine both
    times). The bundle verifier reported "the POSIX launcher is not executable" because Python's
    `zipfile -e` ignores unix permission bits — Finder, Ark and `unzip` restore them — so the
    declared mode is now applied and asserted, and the launcher instructions mention the `sh`
    fallback. Then it reported "signalling did not connect" because it sampled the transport the
    instant the device list rendered, which happens *before* the WebSocket handshake finishes; it
    now waits for the transport itself. Both are recorded because a check that fails for a
    harness reason is indistinguishable from a real defect until it is diagnosed.

32. **The server suite only passed because of a mistake in my own checkout.** Running
    `vitest` inside `server/` made Vite walk up the tree, find the repository-root
    `postcss.config.js` and try to load `tailwindcss` — a *frontend* dependency. Locally that
    resolved, because a full-repository install had already populated the root `node_modules`;
    the CI signaling job deliberately installs only `server/`, so the suite died with
    *Cannot find module 'tailwindcss'* before running a single test. `server/vitest.config.ts`
    now pins the root to the server package and hands Vite an inline, empty PostCSS config, so
    the suite is self-contained. Reproduced and then fixed in a fresh `git clone` of the pushed
    repository with no root `node_modules` present — 47/47 there, which is the only environment
    that could prove it.
33. **The Pages workflow could not switch Pages on by itself.** `actions/configure-pages@v5`
    fails on a repository where Pages has never been enabled, which is exactly the state of a
    brand-new repo on its first push, so the first deployment went red for a reason unrelated to
    the code. It now passes `enablement: true` (using the `pages: write` permission the workflow
    already declared), so the first run enables Pages and deploys. Discovered by reading the
    failing run's jobs through the GitHub API — the failures of a workflow are as much a part of
    "verified" as the passes.

34. **A rename could not be confirmed because the channel was not there yet** (the check was
    wrong twice over). The rename test read the peer's data-channel identity the instant the
    *device list* showed the new name — two different paths, one over the signalling server, one
    in band — so on a slower machine it reported a null identity while the app was behaving
    correctly. Waiting properly then exposed the second half: the checks that run just before it
    (a 64 MB transfer, a cancellation, a declined transfer) can leave the transport rebuilding,
    and a rename genuinely cannot be confirmed over a channel that does not exist yet. The check
    now requires a usable channel first (the app re-announces your current name whenever a
    channel opens, so this heals by itself) and then waits for the identity, and on failure it
    prints **both** sides' link state — which is what showed the pattern: a stale `unstable` link
    with a closed channel beside the live one. Reverting the fix and removing the rename
    announcement from the app fails exactly this check (`30/31`, with the expected message), so
    the check still has teeth.
35. **A brand-new repository cannot let its own workflow enable Pages.** `actions/configure-pages`
    asks GitHub to create the Pages site (`enablement: true`), and that call is refused with
    *Resource not accessible by integration* on a repository where Pages has never been enabled,
    because creating the site needs an account-level permission a workflow token does not carry.
    Pages was therefore enabled once through the API (build type: workflow), and both the
    workflow comment and the README now state the one manual step instead of implying the first
    push is enough.

Test-harness (not app) issues fixed along the way: a channel that never opens inside the
serverless suite now reports both sides' link state (ICE gathering/connection state, channel
readiness) instead of a bare timeout, because "which state machine stuck" is the whole
diagnosis for a direct-connection failure; the offline check used to spend 20 s
waiting for a "Reconnecting…" banner that a fast reconnect never leaves on screen long
enough to sample (it now asserts the disconnected *state* while offline plus open data
channels after recovery); the progress check could read its in-page sample log before the
receiver rendered its first percentage (now given a bounded window); Chromium's default
`~/Downloads` folder is removed again when a run created it (only if empty);
isolated browser contexts need
`Browser.setDownloadBehavior` **with** `browserContextId` or downloads are silently
dropped; dialogs must be targeted by `aria-label` because they stack; each device sees the
*other* peer under a locally generated name; `assert` must never be called inside
`page.evaluate`; the harness now sets `protocolTimeout` and reports renderer crashes
(a page crash under memory pressure used to look like a timeout).

---

## 3. What was delivered

```
lan-share/
├─ src/                        React + TypeScript app (Vite, Tailwind, zod)
│  ├─ config.ts                single config object (everything tunable)
│  ├─ services/                signaling · webrtc · transfer · frame · file · storage · shareTarget · logger
│  ├─ state/                   lanshare (transfers/peers) · settings · toast
│  ├─ components/              26 components (dialogs, queue, transfer list, QR, settings, history…)
│  ├─ utils/                   id · randomName · format · speed · validation
│  └─ pwa.ts                   service worker registration
├─ server/                     Node + TypeScript signaling server (ws + zod)
│  └─ src/                     config · protocol · rooms · logger · server · index (+ 27 tests)
├─ scripts/
│  ├─ e2e/run.mjs              full two-browser end-to-end suite (22 checks)
│  ├─ e2e/reconnect.mjs        deterministic reconnect regression (hard dialer ordering)
│  ├─ dev-all.mjs              `npm run start:all` — signaling + dev server together
│  └─ generate-icons.mjs       favicons / PWA icons / og-image from the LANShare logo
├─ public/                     manifest.webmanifest · sw.js · icons · favicon
├─ .github/workflows/          ci.yml (typecheck+tests+E2E) · deploy-pages.yml
├─ Dockerfile                  multi-stage, non-root, health-checked signaling server
├─ .env.example                every server + frontend environment variable, documented
├─ README.md                   architecture, features, setup, config, test matrix, deployment
└─ LICENSE                     MIT © Muhammad Anas
```

**Acceptance criteria coverage**

| Requirement | Where |
|---|---|
| React + TS + Vite frontend, GitHub Pages-ready | `src/`, `vite.config.ts` (`VITE_BASE_PATH`), `deploy-pages.yml` |
| Separate signaling server, never sees file bytes | `server/` — relays SDP/ICE + presence only |
| WebRTC P2P with chunking + backpressure | `Blob.slice()` 64 KiB frames, `bufferedAmount`/`bufferedAmountLowThreshold` |
| Device discovery, friendly random names | `server/src/rooms.ts`, `utils/randomName.ts` |
| File / text / URL sharing | `SharePanel`, `TextShare`, `transfer.ts` |
| Receiver accept / decline | `IncomingDialog`, consent gate verified in E2E |
| Progress + speed + ETA | `ProgressBar`, `SpeedMeter`, live-updating rows |
| Cancellation cleans up | sender + receiver cancel paths, verified in E2E |
| Local media previews | `FileCard`, `FileTypeIcon`, image/video/audio/text previews |
| Client-side ZIP for multi-file | `services/file.ts` (`fflate`) |
| Dark / light / system, persisted | `state/settings.tsx` + `data-theme`, reload test in E2E |
| QR pairing modal | `QRModal` (room code + copy link), verified in E2E |
| PWA: manifest, SW, 192/512/maskable | `public/` + `scripts/generate-icons.mjs` |
| Transfer history in IndexedDB + clear | `services/storage.ts`, `HistoryList` |
| Settings, auto-accept default OFF | `SettingsSheet`; notifications requested only on opt-in |
| First-visit onboarding, privacy/about | `Onboarding`, `SettingsSheet` privacy + about sections |
| Accessible, responsive UI | focus-trapped dialogs, ARIA labels, `prefers-reduced-motion`, mobile-first |
| zod validation everywhere | `types/protocol.ts` (peer + signaling), `server/src/protocol.ts` |
| Secure random ids | `utils/id.ts` (WebCrypto) |
| XSS / URL safety | no `innerHTML`, links rendered as text, no auto-navigation, http(s) only |
| Rate limits, room cleanup | `server/src/server.ts` (token bucket), `rooms.ts` (TTL sweeps) |
| Capability detection, readable errors | `UnsupportedScreen`, `ConnectionBanner`, backoff with jitter |
| Docker / README / env docs | `Dockerfile`, `README.md`, `.env.example` |
| Tests: frontend, WebRTC, server, manual matrix | 78 + 27 unit tests, 20 E2E checks, README manual matrix |
| “Built by Muhammad Anas” visible | footer, loading screen, onboarding, settings/about |

---

## 4. Honest limitations

* **Docker image not *built*, but its every step is replayed.** `docker` is unavailable in
  this environment. `npm run verify:docker` (also a CI step) replays both stages in a scratch
  directory — including the `.dockerignore` contract — then runs the runtime stage with
  `node dist/index.js`, exercises the image's own `HEALTHCHECK` command while up *and* down,
  asserts `EXPOSE`/healthcheck/config agree on 8080 and that a bare run without `PORT`
  serves, and completes a real two-client discovery + SDP relay handshake against it. Two
  injected faults (a `.dockerignore` entry that would break `COPY server/src`, a healthcheck
  pointing at the wrong default port) both fail the dry-run. What remains unverified is the
  container layer only: the Alpine base, `USER node` privileges and healthcheck scheduling.
  Note the runtime stage uses `npm install --omit=dev` (which still honours the committed
  lockfile) rather than `npm ci`, which would additionally fail on any lockfile drift.
* **E2E needs puppeteer + Chrome.** It downloads Chrome into `~/.cache/puppeteer`; the final
  console-cleanliness check of the suite is authoritative for regressions.
* **Which side dials is decided by peer id**, so the full E2E reconnect check only lands on
  the hardest ordering about half the time — that is why the deterministic
  `npm run e2e:reconnect` companion exists.
* **STUN only by default.** Devices behind symmetric NAT need TURN; the server mints
  coturn-style short-lived credentials when `TURN_SECRET` is set, but no public TURN
  server is bundled.
* **Direct-to-disk receiving** uses the File System Access API where available (Chromium);
  other browsers buffer to memory and download from a Blob.
* The sandbox that produced this build has ~2 GB RAM; a renderer crash under memory
  pressure is reported by the harness instead of being mistaken for a hang.

---

## 5. Run it

```bash
npm install && npm --prefix server install

npm run start:all        # signaling (:8080) + dev server (:5173) in one command
# or:  npm run serve:signaling   /   npm run dev

open http://localhost:5173       # two tabs, or two devices on the same network

npm run build && npm run preview  # production build
docker build -t lanshare-signaling .   # signaling server image
npm run test:all                  # 78 unit + 27 server + 20 end-to-end checks
```

**PROJECT COMPLETED.**
