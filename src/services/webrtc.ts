/**
 * WebRTC link manager.
 *
 * One `RTCPeerConnection` per peer with two reliable, ordered data channels:
 *   - `ctl` : JSON control messages (protocol.ts)
 *   - `bin` : binary file frames
 *
 * Which side dials is decided deterministically from peer ids, so two devices can
 * never both create an offer at the same time (no glare). The dialer also performs
 * ICE restarts when a connection degrades.
 */
import { config } from '../config';
import {
  PROTOCOL_VERSION,
  parsePeerMessage,
  type FrameControl,
  type PeerMessage,
  type SignalData,
} from '../types/protocol';
import { encodeControlFrame } from './frame';
import { log } from './logger';
import {
  waitForIceGatheringComplete,
  type ManualPairingPayload,
} from './manualPairing';
import { randomPeerId } from '../utils/id';

export type LinkStatus = 'connecting' | 'connected' | 'unstable' | 'failed' | 'closed';

export interface LinkIdentity {
  name: string;
  device: string;
  protocol: number;
}

export interface SelfIdentity {
  id: string | null;
  name: string;
  device: string;
}

export interface LinkEvents {
  onStatusChange: (peerId: string, status: LinkStatus, detail?: string) => void;
  onMessage: (peerId: string, message: PeerMessage) => void;
  onBinary: (peerId: string, frame: ArrayBuffer) => void;
  onIdentity: (peerId: string, identity: LinkIdentity) => void;
  /** Called when a link needs to (re)negotiate and we are the dialer. */
  onSignal: (peerId: string, data: SignalData) => void;
}

interface PeerLink {
  peerId: string;
  pc: RTCPeerConnection;
  ctl: RTCDataChannel | null;
  bin: RTCDataChannel | null;
  initiator: boolean;
  status: LinkStatus;
  makingOffer: boolean;
  /** A negotiation was requested while another one was in flight. */
  negotiationPending: boolean;
  ignoringOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  pingId: number;
  lastPongAt: number;
  identity: LinkIdentity | null;
  remoteDescriptionSet: boolean;
  /** Creation time — gives the non-dialer's placeholder a first-offer grace period. */
  createdAt: number;
  /** Watchdog that tears down a link stuck without usable data channels. */
  connectTimer: ReturnType<typeof setTimeout> | null;
  /** How many times this link has already been rebuilt from scratch. */
  rebuildCount: number;
  /**
   * A link created by the serverless pairing flow: its negotiation travels through the user
   * (QR / pasted text), not through a signaling server, and it can never be renegotiated.
   */
  manual: boolean;
}

export class PeerManager {
  /** How often one link may be rebuilt from scratch before we surface a failure. */
  private static readonly MAX_LINK_REBUILDS = 3;

  private links = new Map<string, PeerLink>();
  private disposed = false;
  /** Room membership as last reported by signaling (null while it is still unknown). */
  private roster: Set<string> | null = null;

  constructor(
    private iceServers: RTCIceServer[],
    private events: LinkEvents,
    private getSelf: () => SelfIdentity,
  ) {}

  setIceServers(servers: RTCIceServer[]): void {
    if (servers.length) this.iceServers = servers;
  }

  /**
   * Offline LAN mode: there is no internet, so no STUN/TURN server can be reached.
   * Configuring one anyway makes ICE attempt (and time out on) servers that will never
   * answer, so the host-candidate-only configuration is used instead — which is exactly
   * what two devices on the same network need.
   */
  useHostCandidatesOnly(): void {
    this.iceServers = [];
  }

  /** The ICE configuration peer connections are currently built with (used by tests/debug). */
  getIceServers(): RTCIceServer[] {
    return this.iceServers;
  }

  /** Room membership from signaling: links to departed peers are never rebuilt. */
  setRoster(peerIds: string[]): void {
    this.roster = new Set(peerIds);
  }

  addToRoster(peerId: string): void {
    this.roster?.add(peerId);
  }

  removeFromRoster(peerId: string): void {
    this.roster?.delete(peerId);
  }

  hasLink(peerId: string): boolean {
    return this.links.has(peerId);
  }

  statusOf(peerId: string): LinkStatus | 'idle' {
    return this.links.get(peerId)?.status ?? 'idle';
  }

  identityOf(peerId: string): LinkIdentity | null {
    return this.links.get(peerId)?.identity ?? null;
  }

  /**
   * True only when the link can actually carry a transfer: the transport is connected *and*
   * both data channels are open. This is the guard the state layer uses before sending, so it
   * must not be optimistic about a `bin` channel that has not opened yet.
   */
  isConnected(peerId: string): boolean {
    const link = this.links.get(peerId);
    if (!link || link.status !== 'connected') return false;
    return this.isLinkUsable(link);
  }

  connectedPeers(): string[] {
    return Array.from(this.links.values())
      .filter((link) => link.status === 'connected')
      .map((link) => link.peerId);
  }

  /** Deterministic dialer election: the lexicographically smaller id dials. */
  isDialer(peerId: string): boolean {
    const selfId = this.getSelf().id;
    if (!selfId) return false;
    return selfId < peerId;
  }

  /** A link can carry traffic only while *both* channels are open. */
  private isLinkUsable(link: PeerLink): boolean {
    return link.ctl?.readyState === 'open' && link.bin?.readyState === 'open';
  }

  /**
   * A link is "alive" while it works or is still actively negotiating (a fresh peer
   * connection holds its channels in `connecting`). Anything else — most importantly a
   * link whose channels are `closed` because the other device reloaded — is dead:
   * a closed data channel can never be revived, so the link has to be rebuilt.
   */
  private isLinkAlive(link: PeerLink): boolean {
    if (this.isLinkUsable(link)) return true;
    const ctl = link.ctl?.readyState;
    const bin = link.bin?.readyState;
    // While a negotiation is genuinely in flight the channels sit in `connecting`. That
    // state is only trusted for one connect-timeout window: a channel that never opens
    // means the negotiation went nowhere (stale session, lost offer) and we start over.
    if (ctl === 'connecting' || bin === 'connecting') {
      return Date.now() - link.createdAt < config.rtcConnectTimeoutMs;
    }
    // The non-dialer's placeholder owns no channel until the first offer arrives.
    if (!link.initiator && !link.ctl && !link.bin && link.pc.connectionState !== 'failed') {
      return Date.now() - link.createdAt < config.rtcConnectTimeoutMs;
    }
    return false;
  }

  /** Stop and forget the "link never came up" watchdog. */
  private stopConnectWatchdog(link: PeerLink): void {
    if (link.connectTimer) {
      clearTimeout(link.connectTimer);
      link.connectTimer = null;
    }
  }

  /**
   * Watch every new link while it comes up. A negotiation that produces no open
   * channel — the classic symptom of a peer that reloaded and dropped its channels —
   * would otherwise sit in "connecting" forever.
   */
  private startConnectWatchdog(link: PeerLink): void {
    this.stopConnectWatchdog(link);
    link.connectTimer = setTimeout(() => {
      link.connectTimer = null;
      if (this.disposed || !this.links.has(link.peerId)) return;
      if (this.isLinkUsable(link)) return;
      if (this.isLinkAlive(link) && Date.now() - link.createdAt < config.rtcConnectTimeoutMs * 3) {
        // Still negotiating (or inside the placeholder grace window): wait longer
        // instead of tearing down a live attempt.
        this.startConnectWatchdog(link);
        return;
      }
      this.setStatus(link, 'connecting');
      this.rebuildLink(link, 'connect-timeout');
    }, config.rtcConnectTimeoutMs);
  }

  /**
   * Tear a link down and start over with a fresh peer connection.
   *
   * An ICE restart repairs a broken *path*, but it can never revive a closed data
   * channel. Whenever the channels are gone, only a new peer connection (with new
   * `ctl`/`bin` channels) can restore the link, so both roles rebuild here: the
   * dialer immediately offers again, the other side drops its dead link and answers
   * the incoming offer on a fresh connection.
   */
  private rebuildLink(link: PeerLink, reason: string): void {
    if (this.disposed) return;
    const { peerId } = link;
    if (!this.links.has(peerId)) return;
    if (link.manual) {
      // There is no server to re-negotiate through, so a manual link that dies stays dead.
      this.stopConnectWatchdog(link);
      this.setStatus(link, 'failed', 'This manual connection dropped. Create a new pairing code.');
      return;
    }
    if (this.roster && !this.roster.has(peerId)) {
      // Signaling says the device left the room — leave the peer status to the state
      // layer instead of offering to a session that no longer exists.
      log.debug('rtc: skipped rebuild for a departed peer', { peerId, reason });
      this.stopConnectWatchdog(link);
      return;
    }
    const attempt = link.rebuildCount + 1;
    const dialer = this.isDialer(peerId);
    if (attempt > PeerManager.MAX_LINK_REBUILDS) {
      this.stopConnectWatchdog(link);
      this.setStatus(link, 'failed', 'The connection could not be re-established. Use retry.');
      return;
    }
    const previousStatus = link.status;
    log.debug('rtc: rebuilding link', { peerId, reason, attempt, dialer });
    this.closeLink(peerId, false);
    const fresh = this.createLink(peerId, dialer);
    fresh.rebuildCount = attempt;
    if (previousStatus !== 'connecting') this.events.onStatusChange(peerId, 'connecting');
    if (dialer) void this.negotiate(fresh, false);
  }

  /**
   * Called when a channel closes or the transport drops: decide between an ICE
   * restart (path hiccup, channels intact) and a full rebuild (channels gone).
   */
  private checkLinkHealth(link: PeerLink, reason: string): void {
    if (this.disposed || !this.links.has(link.peerId)) return;
    if (this.isLinkUsable(link)) return;
    if (this.isLinkAlive(link)) {
      this.startConnectWatchdog(link);
      return;
    }
    if (link.restartTimer) return;
    link.restartTimer = setTimeout(() => {
      link.restartTimer = null;
      if (this.disposed || !this.links.has(link.peerId)) return;
      if (this.isLinkUsable(link)) return;
      this.rebuildLink(link, reason);
    }, config.rtcIceRestartAfterMs);
  }

  /**
   * Called whenever a peer shows up (or after a manual retry).
   * Only the elected dialer actually creates the connection; the other side waits
   * for the offer, which keeps negotiation single-threaded.
   */
  ensureConnection(peerId: string, force = false): void {
    if (this.disposed) return;
    const existing = this.links.get(peerId);
    if (existing) {
      if (!force && this.isLinkAlive(existing)) return;
      if (force && existing.status === 'connected' && this.isLinkUsable(existing)) return;
      // A stale link (dead channels, or a negotiation that never finished) must not be
      // reused: close it and build a fresh peer connection below.
      this.closeLink(peerId, false);
    }
    if (!this.isDialer(peerId)) {
      // Still create a placeholder so the UI can show "connecting".
      this.createLink(peerId, false);
      this.setStatus(this.links.get(peerId) as PeerLink, 'connecting');
      return;
    }
    const link = this.createLink(peerId, true);
    void this.negotiate(link, false);
  }

  private createLink(peerId: string, initiator: boolean, manual = false): PeerLink {
    const pc = new RTCPeerConnection({
      // A manual link exists precisely because there may be no internet: host candidates are
      // the only thing two devices on the same network need, and they are always reachable.
      iceServers: manual ? [] : this.iceServers,
      iceCandidatePoolSize: 2,
      bundlePolicy: 'max-bundle',
    });

    const link: PeerLink = {
      peerId,
      pc,
      ctl: null,
      bin: null,
      initiator,
      status: 'connecting',
      makingOffer: false,
      negotiationPending: false,
      ignoringOffer: false,
      pendingCandidates: [],
      restartCount: 0,
      restartTimer: null,
      keepAliveTimer: null,
      pingId: 0,
      lastPongAt: Date.now(),
      identity: null,
      remoteDescriptionSet: false,
      createdAt: Date.now(),
      connectTimer: null,
      rebuildCount: 0,
      manual,
    };
    this.links.set(peerId, link);

    pc.onicecandidate = (event) => {
      // Manual links have no signaling channel to trickle over: their description is
      // serialised once, after gathering completes, and handed over by the user.
      if (manual) return;
      if (event.candidate) {
        this.events.onSignal(peerId, {
          kind: 'ice',
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? null,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
            usernameFragment: event.candidate.usernameFragment ?? null,
          },
        });
      }
    };

    /**
     * Accept channels created by the other side. Only the elected dialer creates
     * channels, but a reconnect race or a changed peer id could flip roles, so the
     * receiver must always be able to adopt incoming channels.
     */
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'ctl') {
        if (link.ctl && link.ctl.readyState === 'open') {
          channel.close();
          return;
        }
        link.ctl = channel;
      } else if (channel.label === 'bin') {
        if (link.bin && link.bin.readyState === 'open') {
          channel.close();
          return;
        }
        link.bin = channel;
      } else {
        // Unknown channel label — never trust it.
        try {
          channel.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.attachChannel(link, channel);
    };

    pc.onnegotiationneeded = () => {
      if (this.disposed) return;
      // Only the elected dialer offers; the queued negotiation coalesces the extra
      // notification caused by creating the data channels.
      if (link.initiator) void this.negotiate(link, false);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      log.debug('rtc: connection state', { peerId, state });
      if (state === 'connected') {
        // The data channel usually opens a few milliseconds later; the channel's own
        // `onopen` calls this again so the status becomes "connected" either way.
        this.refreshStatus(link);
      } else if (state === 'disconnected') {
        this.setStatus(link, 'unstable');
        this.scheduleRestart(link);
      } else if (state === 'failed') {
        this.scheduleRestart(link, 0);
      } else if (state === 'closed') {
        this.setStatus(link, 'closed');
      }
    };

    if (initiator) {
      link.ctl = this.createChannel(link, 'ctl');
      link.bin = this.createChannel(link, 'bin');
    }

    this.startConnectWatchdog(link);
    return link;
  }

  private createChannel(link: PeerLink, label: 'ctl' | 'bin'): RTCDataChannel {
    const channel = link.pc.createDataChannel(label, {
      ordered: true, // reliable + ordered delivery (required for in-order file assembly)
      protocol: label === 'ctl' ? 'lanshare-ctl/1' : 'lanshare-bin/1',
    });
    this.attachChannel(link, channel);
    return channel;
  }

  private attachChannel(link: PeerLink, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      log.debug('rtc: channel open', { peerId: link.peerId, label: channel.label });
      this.refreshStatus(link);
      if (channel.label === 'bin') return;
      const self = this.getSelf();
      this.sendControl(
        link.peerId,
        { t: 'HELLO', name: self.name || 'LANShare device', device: (self.device as 'unknown') || 'unknown', protocol: PROTOCOL_VERSION },
        true,
      );
      this.startKeepAlive(link);
    };

    channel.onclose = () => {
      log.debug('rtc: channel closed', { peerId: link.peerId, label: channel.label });
      if (channel.label === 'ctl') {
        this.stopKeepAlive(link);
        if (link.status === 'connected') this.setStatus(link, 'unstable');
        // The other device may have reloaded (its channels die, the transport may even
        // recover): rebuild the link rather than staying stuck without a channel.
        this.checkLinkHealth(link, 'channel-closed');
      }
    };

    channel.onerror = (event) => {
      log.warn('rtc: channel error', { peerId: link.peerId, label: channel.label, event: String(event) });
    };

    channel.onmessage = (event: MessageEvent) => {
      if (channel.label === 'ctl') {
        if (typeof event.data !== 'string') return;
        if (event.data.length > 128 * 1024) {
          log.warn('rtc: oversized control message dropped');
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = parsePeerMessage(raw);
        if (!message) return;
        if (message.t === 'PONG') {
          link.lastPongAt = Date.now();
          return;
        }
        if (message.t === 'PING') {
          this.sendControl(link.peerId, { t: 'PONG', id: message.id, at: message.at });
          return;
        }
        if (message.t === 'HELLO') {
          link.identity = { name: message.name, device: message.device, protocol: message.protocol };
          this.events.onIdentity(link.peerId, link.identity);
          return;
        }
        this.events.onMessage(link.peerId, message);
        return;
      }

      const data = event.data as ArrayBuffer | Blob;
      if (data instanceof ArrayBuffer) {
        this.events.onBinary(link.peerId, data);
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => this.events.onBinary(link.peerId, buffer));
      }
    };
  }

  /** Re-advertise our display name (used after a rename). */
  announceIdentity(peerId?: string): void {
    const self = this.getSelf();
    const targets = peerId ? [peerId] : Array.from(this.links.keys());
    for (const target of targets) {
      this.sendControl(target, {
        t: 'HELLO',
        name: self.name || 'LANShare device',
        device: (self.device as 'unknown') || 'unknown',
        protocol: PROTOCOL_VERSION,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Serverless pairing (no signaling server anywhere)
   * ------------------------------------------------------------------ */


  /**
   * Serialise a local description for hand-over, refusing one that carries no candidates.
   *
   * Gathering normally completes in milliseconds, but when it does not the description is
   * silently useless: the other device gets a code that can never connect. Counting candidates
   * turns that into an immediate, explicit error instead of a mysterious failure later.
   */
  private describeForHandover(pc: RTCPeerConnection, gathered: boolean): string {
    const description = pc.localDescription;
    if (!description?.sdp) throw new Error('The connection description could not be created.');
    const candidates = description.sdp.match(/^a=candidate:/gm)?.length ?? 0;
    if (candidates === 0) {
      throw new Error(
        gathered
          ? 'No local network address could be found for this device. Check that it is connected to a network and try again.'
          : 'Preparing the pairing code took too long on this device. Try again.',
      );
    }
    return description.sdp;
  }

  /**
   * Step 1 — the inviting device. Creates the connection, an offer, and returns the payload
   * the user shows as a QR code / sends to the other device.
   */
  async createManualInvite(): Promise<{ handle: string; payload: ManualPairingPayload }> {
    // A throwaway local key: the real peer id is only known once the answer comes back.
    const handle = `invite-${randomPeerId(10)}`;
    const link = this.createLink(handle, true, true);
    this.setStatus(link, 'connecting');

    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    const gathered = await waitForIceGatheringComplete(link.pc, config.manualPairing.iceGatherTimeoutMs);
    const sdp = this.describeForHandover(link.pc, gathered);

    const self = this.getSelf();
    return {
      handle,
      payload: {
        v: 1,
        k: 'offer',
        id: self.id && /^[a-z0-9]{6,32}$/.test(self.id) ? self.id : randomPeerId(10),
        n: self.name || 'LANShare device',
        d: (self.device as 'unknown') || 'unknown',
        sdp,
      },
    };
  }

  /**
   * Step 2 — the joining device. Takes the invite payload and produces the answer payload.
   * The link is keyed by the inviter's peer id, so it is indistinguishable from a normal peer
   * from here on.
   */
  async acceptManualInvite(payload: ManualPairingPayload): Promise<{ peerId: string; payload: ManualPairingPayload }> {
    const peerId = payload.id;
    // A previous attempt with the same id would leave two connections fighting over one link.
    if (this.links.has(peerId)) this.closeLink(peerId, false);

    const link = this.createLink(peerId, false, true);
    this.setStatus(link, 'connecting');

    await link.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    link.remoteDescriptionSet = true;

    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    const gathered = await waitForIceGatheringComplete(link.pc, config.manualPairing.iceGatherTimeoutMs);
    const sdp = this.describeForHandover(link.pc, gathered);

    const self = this.getSelf();
    return {
      peerId,
      payload: {
        v: 1,
        k: 'answer',
        id: self.id && /^[a-z0-9]{6,32}$/.test(self.id) ? self.id : randomPeerId(10),
        n: self.name || 'LANShare device',
        d: (self.device as 'unknown') || 'unknown',
        sdp,
      },
    };
  }

  /**
   * Step 3 — the inviting device applies the answer and re-keys its temporary link to the
   * joining device's peer id, at which point both sides behave like any other pair.
   */
  async completeManualInvite(handle: string, payload: ManualPairingPayload): Promise<string> {
    const link = this.links.get(handle);
    if (!link) throw new Error('This invite is no longer active.');
    await link.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    link.remoteDescriptionSet = true;
    if (payload.id !== handle) this.rekeyLink(handle, payload.id);
    return payload.id;
  }

  /** Abandon an invite that was never completed (the user closed the dialog). */
  cancelManualInvite(handle: string): void {
    if (this.links.has(handle)) this.closeLink(handle, true);
  }

  /** True when this peer was paired without a signaling server. */
  isManual(peerId: string): boolean {
    return this.links.get(peerId)?.manual === true;
  }

  /**
   * Derive the link status from the transport. Called from both the peer connection
   * and the data channel events because either one can become ready first.
   */
  private refreshStatus(link: PeerLink): void {
    if (link.pc.connectionState === 'connected' && link.ctl?.readyState === 'open') {
      this.setStatus(link, 'connected');
      return;
    }
    if (link.pc.connectionState === 'failed') return; // handled by the restart logic
    if (link.pc.connectionState === 'disconnected') {
      this.setStatus(link, 'unstable');
      return;
    }
    if (this.links.has(link.peerId)) this.setStatus(link, 'connecting');
  }

  /**
   * Create and send an offer. Serialised per link: only one negotiation may be in
   * flight, otherwise the second `setLocalDescription` fails with an m-line mismatch.
   */
  private async negotiate(link: PeerLink, iceRestart: boolean): Promise<void> {
    if (this.disposed || link.pc.signalingState === 'closed') return;
    if (link.makingOffer || (!iceRestart && link.pc.signalingState !== 'stable')) {
      link.negotiationPending = true;
      return;
    }
    link.makingOffer = true;
    link.negotiationPending = false;
    try {
      const offer = await link.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (this.disposed || link.pc.signalingState !== 'stable') return;
      await link.pc.setLocalDescription(offer);
      if (link.pc.localDescription) {
        this.events.onSignal(link.peerId, { kind: 'offer', sdp: link.pc.localDescription.sdp });
      }
    } catch (error) {
      const message = (error as Error).message;
      // Racing negotiation attempts are expected and harmless — the queued one wins.
      const racing = /m-lines|order of m-lines|signalingState/i.test(message);
      if (!racing) log.warn(`rtc: offer failed for ${link.peerId}: ${message}`);
      if (!racing && link.pc.connectionState !== 'connected') {
        this.setStatus(link, 'failed', 'The connection could not be established.');
      }
    } finally {
      link.makingOffer = false;
      if (link.negotiationPending && !this.disposed) {
        link.negotiationPending = false;
        // Defer so we never recurse inside the same microtask chain.
        setTimeout(() => void this.negotiate(link, false), 0);
      }
    }
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    if (this.disposed) return;
    let link = this.links.get(from);
    if (!link) {
      link = this.createLink(from, false);
      this.setStatus(link, 'connecting');
    }

    try {
      if (data.kind === 'offer') {
        const offerUfrag = /^a=ice-ufrag:(\S+)/m.exec(data.sdp)?.[1] ?? null;
        const currentUfrag = link.pc.remoteDescription
          ? (/^a=ice-ufrag:(\S+)/m.exec(link.pc.remoteDescription.sdp)?.[1] ?? null)
          : null;
        const remoteRestarted = Boolean(offerUfrag && currentUfrag && offerUfrag !== currentUfrag);
        // A peer that reloaded offers from a brand-new peer connection while we still
        // hold one that cannot carry data: answer on a fresh connection of our own.
        if (!this.isLinkUsable(link) && (remoteRestarted || !this.isLinkAlive(link))) {
          this.closeLink(from, false);
          link = this.createLink(from, false);
          this.events.onStatusChange(from, 'connecting');
        }
        const collision = link.makingOffer || link.pc.signalingState !== 'stable';
        const polite = !link.initiator;
        if (collision && !polite) {
          log.debug('rtc: ignoring colliding offer', { peerId: from });
          return;
        }
        if (collision) {
          // Polite side rolls back and accepts the remote offer.
          await link.pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit).catch(() => undefined);
        }
        await link.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        link.remoteDescriptionSet = true;
        await this.flushCandidates(link);
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        if (link.pc.localDescription) {
          this.events.onSignal(from, { kind: 'answer', sdp: link.pc.localDescription.sdp });
        }
        return;
      }

      if (data.kind === 'answer') {
        if (link.pc.signalingState !== 'have-local-offer') {
          log.debug('rtc: unexpected answer ignored', { peerId: from, state: link.pc.signalingState });
          return;
        }
        await link.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        link.remoteDescriptionSet = true;
        await this.flushCandidates(link);
        return;
      }

      if (data.kind === 'ice') {
        const candidate: RTCIceCandidateInit = {
          candidate: data.candidate.candidate,
          sdpMid: data.candidate.sdpMid ?? undefined,
          sdpMLineIndex: data.candidate.sdpMLineIndex ?? undefined,
          usernameFragment: data.candidate.usernameFragment ?? undefined,
        };
        if (!link.remoteDescriptionSet) {
          if (link.pendingCandidates.length < 64) link.pendingCandidates.push(candidate);
          return;
        }
        await link.pc.addIceCandidate(candidate).catch((error: Error) => {
          log.debug('rtc: addIceCandidate failed', { peerId: from, error: error.message });
        });
      }
    } catch (error) {
      log.warn(`rtc: signaling failed for ${from} (${data.kind}): ${(error as Error).message}`);
      this.setStatus(link, 'failed', 'The connection could not be established.');
    }
  }

  private async flushCandidates(link: PeerLink): Promise<void> {
    const pending = link.pendingCandidates.splice(0, link.pendingCandidates.length);
    for (const candidate of pending) {
      try {
        await link.pc.addIceCandidate(candidate);
      } catch {
        /* non-fatal */
      }
    }
  }

  private scheduleRestart(link: PeerLink, delayOverride?: number): void {
    if (this.disposed) return;
    if (link.restartTimer) return;
    if (!this.isLinkAlive(link)) {
      // Channels are already gone — an ICE restart cannot bring them back, so rebuild.
      this.rebuildLink(link, 'dead-channels');
      return;
    }
    if (!link.initiator) {
      // The dialer owns renegotiation; just surface the state.
      if (link.pc.connectionState === 'failed') this.setStatus(link, 'failed', 'Waiting for the other device to reconnect.');
      return;
    }
    if (link.restartCount >= 2) {
      this.setStatus(link, 'failed', 'The connection could not be re-established.');
      return;
    }
    const delay = delayOverride ?? Math.min(config.rtcIceRestartAfterMs * 2 ** link.restartCount, 20_000);
    link.restartTimer = setTimeout(() => {
      link.restartTimer = null;
      if (this.disposed || link.pc.connectionState === 'connected') return;
      link.restartCount += 1;
      log.debug('rtc: ICE restart', { peerId: link.peerId, attempt: link.restartCount });
      void this.negotiate(link, true);
    }, delay);
  }

  private startKeepAlive(link: PeerLink): void {
    this.stopKeepAlive(link);
    link.lastPongAt = Date.now();
    link.keepAliveTimer = setInterval(() => {
      if (this.disposed) return;
      if (link.ctl?.readyState !== 'open') return;
      link.pingId += 1;
      this.sendControl(link.peerId, { t: 'PING', id: link.pingId, at: Date.now() });
      if (Date.now() - link.lastPongAt > config.keepAliveIntervalMs * 3) {
        log.debug('rtc: peer unresponsive', { peerId: link.peerId });
        this.setStatus(link, 'unstable', 'The other device is not responding.');
      }
    }, config.keepAliveIntervalMs);
  }

  private stopKeepAlive(link: PeerLink): void {
    if (link.keepAliveTimer) {
      clearInterval(link.keepAliveTimer);
      link.keepAliveTimer = null;
    }
  }

  private setStatus(link: PeerLink, status: LinkStatus, detail?: string): void {
    if (link.status === status) return;
    link.status = status;
    if (status === 'connected') {
      link.restartCount = 0;
      this.stopKeepAlive(link);
      this.startKeepAlive(link);
    }
    this.events.onStatusChange(link.peerId, status, detail);
  }

  sendControl(peerId: string, message: PeerMessage, silent = false): boolean {
    const link = this.links.get(peerId);
    if (!link?.ctl || link.ctl.readyState !== 'open') {
      if (!silent) log.debug('rtc: control channel not open', { peerId, type: message.t });
      return false;
    }
    try {
      link.ctl.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.warn('rtc: control send failed', { peerId, error: (error as Error).message });
      return false;
    }
  }

  /**
   * Send an in-band control frame on the *data* channel. Used for markers that must
   * stay ordered with the bytes (file start/end), unlike the `ctl` channel.
   */
  sendInBand(peerId: string, message: FrameControl): boolean {
    const channel = this.links.get(peerId)?.bin;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(encodeControlFrame(message));
      return true;
    } catch (error) {
      log.warn('rtc: in-band control send failed', { peerId, error: (error as Error).message });
      return false;
    }
  }

  bufferedAmount(peerId: string): number {
    const channel = this.links.get(peerId)?.bin;
    if (!channel) return 0;
    return channel.bufferedAmount;
  }

  sendBinary(peerId: string, payload: ArrayBuffer): boolean {
    const channel = this.links.get(peerId)?.bin;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(payload);
      return true;
    } catch (error) {
      log.warn('rtc: binary send failed', { peerId, error: (error as Error).message });
      return false;
    }
  }

  /**
   * Wait until the outbound buffer drains below the low-water mark.
   * This is the backpressure gate that keeps memory flat on large files.
   */
  async waitForDrain(peerId: string, timeoutMs = 30_000): Promise<boolean> {
    const channel = this.links.get(peerId)?.bin;
    if (!channel) return false;
    channel.bufferedAmountLowThreshold = config.bufferedAmountLowThreshold;
    if (channel.bufferedAmount <= config.bufferedAmountLowThreshold) return true;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        resolve(value);
      };
      const onLow = () => finish(true);
      const onClose = () => finish(false);
      const drained = () => channel.bufferedAmount <= config.bufferedAmountLowThreshold;
      const timer = setTimeout(() => finish(drained()), timeoutMs);
      const poll = setInterval(() => {
        if (channel.readyState !== 'open') finish(false);
        else if (drained()) finish(true);
      }, 40);
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
      // `bufferedamountlow` only fires on a threshold transition: if the buffer
      // drained before this listener existed, no event would ever arrive.
      if (drained()) finish(true);
    });
  }

  /** Keep an existing link but swap the signaling peer id (server reconnect). */
  rekeyLink(oldPeerId: string, newPeerId: string): boolean {
    const link = this.links.get(oldPeerId);
    if (!link) return false;
    this.links.delete(oldPeerId);
    link.peerId = newPeerId;
    this.links.set(newPeerId, link);
    // The manager's own roster must follow the rename *before* anything below consults it,
    // otherwise the rebuild looks like it is aimed at a peer that left the room.
    if (this.roster) {
      this.roster.delete(oldPeerId);
      this.roster.add(newPeerId);
    }
    if (!this.isLinkUsable(link)) {
      // The device came back on a fresh signalling session. Anything we negotiated towards
      // the previous one died with it, so start over now instead of waiting for ICE to
      // notice (that used to take ~40 s): the dialer offers again immediately, the other
      // side answers the next offer on a clean peer connection.
      this.rebuildLink(link, 'peer-rekeyed');
    }
    return true;
  }

  /**
   * Drop a link that can no longer carry data — used when signalling reports the peer has
   * left the room. Without this, a departed device leaves a `connecting` link behind whose
   * channels will never open, and every later reconnect has to work around it.
   */
  dropDeadLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    if (this.isLinkUsable(link)) return;
    log.debug('rtc: dropping link to a departed peer', { peerId });
    this.closeLink(peerId, false);
  }

  retry(peerId: string): void {
    this.closeLink(peerId, false);
    this.ensureConnection(peerId, true);
  }

  closeLink(peerId: string, notify = true): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    this.stopKeepAlive(link);
    this.stopConnectWatchdog(link);
    if (link.restartTimer) clearTimeout(link.restartTimer);
    try {
      link.ctl?.close();
      link.bin?.close();
      link.pc.close();
    } catch {
      /* ignore */
    }
    if (notify) this.events.onStatusChange(peerId, 'closed');
  }

  /** Read-only diagnostics used by the `?debug=1` snapshot API. */
  debugState(): Array<Record<string, unknown>> {
    return Array.from(this.links.values()).map((link) => ({
      peerId: link.peerId,
      status: link.status,
      initiator: link.initiator,
      connectionState: link.pc.connectionState,
      iceConnectionState: link.pc.iceConnectionState,
      iceGatheringState: link.pc.iceGatheringState,
      signalingState: link.pc.signalingState,
      ctl: link.ctl?.readyState ?? 'none',
      bin: link.bin?.readyState ?? 'none',
      identity: link.identity,
    }));
  }

  dispose(): void {
    this.disposed = true;
    for (const peerId of Array.from(this.links.keys())) this.closeLink(peerId, false);
    this.links.clear();
  }
}
