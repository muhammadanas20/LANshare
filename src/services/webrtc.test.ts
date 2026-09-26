/**
 * PeerManager link-lifecycle tests.
 *
 * These pin down the reconnect state machine — the code behind the hardest bugs in this
 * project: a peer that reloads leaves the survivor holding a peer connection whose data
 * channels are gone for good. The E2E suites cover that end to end in real browsers; these
 * tests cover it deterministically, including paths that are awkward to force in a browser
 * (the rebuild cap, the departed-peer roster guard, the placeholder grace window).
 *
 * A minimal fake `RTCPeerConnection`/`RTCDataChannel` pair is used, so the tests assert
 * *decisions* (rebuild, ICE restart, no-op) rather than transport behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerManager, type LinkEvents } from './webrtc';

/* ------------------------------ fakes ------------------------------ */

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(public label: string) {}

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  /** Simulate the channel dying with the remote page (reload / vanished peer). */
  kill(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }

  send(payload: string | ArrayBuffer): void {
    this.sent.push(typeof payload === 'string' ? payload : '<binary>');
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }

  addEventListener(): void {
    /* the manager only uses the on* handlers */
  }

  removeEventListener(): void {
    /* no-op */
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  createdChannels: FakeDataChannel[] = [];
  closed = false;

  static instances: FakePeerConnection[] = [];

  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.createdChannels.push(channel);
    return channel;
  }

  createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:fresh\r\n' });
  }

  setLocalDescription(description?: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description ?? { type: 'offer', sdp: 'v=0\r\n' };
    return Promise.resolve();
  }

  setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: 'v=0\r\na=ice-ufrag:answer\r\n' });
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  /** Simulate the transport recovering while the data channels stay dead. */
  markConnected(): void {
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

type FakePC = FakePeerConnection;
type FakeDC = FakeDataChannel;

/* ------------------------------ harness ------------------------------ */

interface Harness {
  manager: PeerManager;
  events: LinkEvents & { statuses: Array<{ peerId: string; status: string; detail?: string }>; signals: string[] };
  peers: Map<string, FakePC>;
  channels: (label: string) => FakeDC | null;
}

function createHarness(selfId = 'aaaaaa'): Harness {
  const statuses: Array<{ peerId: string; status: string; detail?: string }> = [];
  const signals: string[] = [];
  const events = {
    onStatusChange: (peerId: string, status: string, detail?: string) => statuses.push({ peerId, status, detail }),
    onMessage: () => undefined,
    onBinary: () => undefined,
    onIdentity: () => undefined,
    onSignal: (_peerId: string, data: { kind: string }) => signals.push(data.kind),
    statuses,
    signals,
  } as LinkEvents & { statuses: typeof statuses; signals: typeof signals };

  const peers = new Map<string, FakePC>();
  // Track which fake connection belongs to which peer by looking it up lazily.
  const manager = new PeerManager([], events, () => ({ id: selfId, name: 'Tester', device: 'desktop' }));

  return {
    manager,
    events,
    peers,
    channels: (label: string) => {
      const latest = FakePeerConnection.instances.at(-1);
      return latest?.createdChannels.find((channel) => channel.label === label) ?? null;
    },
  };
}

/**
 * The test setup defines `RTCPeerConnection` as a writable-but-not-configurable property, so
 * `vi.stubGlobal` (which redefines it) throws. Assignment is what the property allows.
 */
const globalWithRtc = globalThis as unknown as { RTCPeerConnection: unknown };

beforeEach(() => {
  FakePeerConnection.instances = [];
  globalWithRtc.RTCPeerConnection = FakePeerConnection;
  vi.useFakeTimers();
});

afterEach(() => {
  globalWithRtc.RTCPeerConnection = undefined;
  vi.useRealTimers();
});

const lastPc = (): FakePC => {
  const instance = FakePeerConnection.instances.at(-1);
  if (!instance) throw new Error('no peer connection was created');
  return instance;
};

/* ------------------------------ tests ------------------------------ */

describe('PeerManager link lifecycle', () => {
  it('creates both data channels when it is the dialer and offers immediately', async () => {
    const { manager, events } = createHarness('aaaaaa');
    manager.ensureConnection('zzzzzz'); // self id is smaller, so we dial
    await vi.runOnlyPendingTimersAsync();

    expect(manager.hasLink('zzzzzz')).toBe(true);
    expect(lastPc().createdChannels.map((channel) => channel.label)).toEqual(['ctl', 'bin']);
    expect(events.signals).toContain('offer');
  });

  it('stays passive as the non-dialer: no channels, no offer', async () => {
    const { manager, events } = createHarness('zzzzzz');
    manager.ensureConnection('aaaaaa'); // peer id is smaller, so they dial
    await vi.runOnlyPendingTimersAsync();

    expect(manager.statusOf('aaaaaa')).toBe('connecting');
    expect(lastPc().createdChannels).toHaveLength(0);
    expect(events.signals).toHaveLength(0);
  });

  it('reports connected only when the transport AND both channels are open', async () => {
    const { manager } = createHarness('aaaaaa');
    manager.ensureConnection('zzzzzz');
    const pc = lastPc();
    const ctl = pc.createdChannels[0];
    const bin = pc.createdChannels[1];

    pc.markConnected();
    expect(manager.isConnected('zzzzzz')).toBe(false); // channels still connecting

    ctl.open();
    expect(manager.isConnected('zzzzzz')).toBe(false); // bin is still missing

    bin.open();
    expect(manager.isConnected('zzzzzz')).toBe(true);
    expect(manager.connectedPeers()).toEqual(['zzzzzz']);
  });

  it('keeps a healthy link when ensureConnection runs again', async () => {
    const { manager } = createHarness('aaaaaa');
    manager.ensureConnection('zzzzzz');
    const first = lastPc();
    first.markConnected();
    first.createdChannels.forEach((channel) => channel.open());

    manager.ensureConnection('zzzzzz');
    expect(FakePeerConnection.instances).toHaveLength(1); // no second connection
    expect(first.closed).toBe(false);
  });

  it('does not reuse a link whose data channels died — it builds a fresh one (reload case)', async () => {
    const { manager } = createHarness('aaaaaa');
    manager.ensureConnection('zzzzzz');
    const first = lastPc();
    first.markConnected();
    first.createdChannels.forEach((channel) => channel.open());
    expect(manager.statusOf('zzzzzz')).toBe('connected');

    // The other device reloads: its channels close, while our transport may recover.
    first.createdChannels[0].kill();
    vi.setSystemTime(Date.now() + 9000); // past the grace/ICE window
    await vi.advanceTimersByTimeAsync(9000);

    expect(first.closed).toBe(true);
    expect(FakePeerConnection.instances.length).toBeGreaterThan(1);
    // The replacement is a real attempt: the dialer creates channels and offers again.
    expect(lastPc().createdChannels.map((channel) => channel.label)).toEqual(['ctl', 'bin']);
  });

  it('starts over immediately when a re-keyed link cannot carry data (peer rejoined with a new id)', () => {
    const { manager } = createHarness('aaaaaa');
    manager.setRoster(['old-id']);
    manager.ensureConnection('old-id');
    const first = lastPc();
    first.markConnected();
    first.createdChannels.forEach((channel) => channel.open());

    expect(manager.rekeyLink('old-id', 'new-id')).toBe(true);
    // Re-keyed while channels are open → the link is kept (a signalling hiccup).
    expect(first.closed).toBe(false);
    expect(manager.statusOf('new-id')).toBe('connected');

    // Now the dead-channel case: a link that never opened is rebuilt on re-key.
    const second = createHarness('aaaaaa');
    second.manager.setRoster(['old-id']);
    second.manager.ensureConnection('old-id');
    const deadFirst = lastPc();
    deadFirst.createdChannels[0].kill(); // never opened
    second.manager.addToRoster('new-id');
    expect(second.manager.rekeyLink('old-id', 'new-id')).toBe(true);
    expect(deadFirst.closed).toBe(true);
    expect(FakePeerConnection.instances.at(-1)).not.toBe(deadFirst);
    expect(lastPc().createdChannels.map((channel) => channel.label)).toEqual(['ctl', 'bin']);
  });

  it('does not rebuild a link to a peer that has left the room', async () => {
    const { manager } = createHarness('aaaaaa');
    manager.setRoster(['zzzzzz']);
    manager.ensureConnection('zzzzzz');
    const pc = lastPc();
    pc.createdChannels[0].kill();

    manager.removeFromRoster('zzzzzz');
    manager.dropDeadLink('zzzzzz');
    await vi.advanceTimersByTimeAsync(20000);

    // The dead link was dropped rather than rebuilt, and nothing new was offered.
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(pc.closed).toBe(true);
  });

  it('gives up after a few rebuilds instead of looping forever', async () => {
    const { manager, events } = createHarness('aaaaaa');
    manager.setRoster(['zzzzzz']);
    manager.ensureConnection('zzzzzz');

    // Nobody calls ensureConnection again here: the link's own health checks drive the
    // retries, which is exactly the loop the cap has to stop.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastPc().createdChannels.forEach((channel) => channel.kill());
      await vi.advanceTimersByTimeAsync(20_000);
    }

    const failure = events.statuses.find((entry) => entry.status === 'failed');
    expect(failure).toBeDefined();
    expect(failure?.detail).toMatch(/re-established/i);
    // One original link + three rebuilds, then it stops and reports honestly.
    expect(FakePeerConnection.instances.length).toBe(4);
    expect(manager.statusOf('zzzzzz')).toBe('failed');
  });

  it('adopts channels created by the other side (offer arrives on a fresh connection)', async () => {
    const { manager } = createHarness('zzzzzz'); // non-dialer
    manager.ensureConnection('aaaaaa');
    const pc = lastPc();

    const remoteCtl = new FakeDataChannel('ctl');
    const remoteBin = new FakeDataChannel('bin');
    pc.ondatachannel?.({ channel: remoteCtl });
    pc.ondatachannel?.({ channel: remoteBin });
    pc.markConnected();
    remoteCtl.open();
    remoteBin.open();

    expect(manager.isConnected('aaaaaa')).toBe(true);
    // The adopted control channel is greeted and kept alive.
    expect(remoteCtl.sent.some((payload) => payload.includes('HELLO'))).toBe(true);
  });

  it('answers an offer that arrives on a dead link from a restarted peer connection', async () => {
    const { manager, events } = createHarness('zzzzzz'); // non-dialer
    manager.ensureConnection('aaaaaa');
    const dead = lastPc();
    dead.createdChannels.forEach((channel) => channel.kill());
    dead.remoteDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old\r\n' };

    const before = FakePeerConnection.instances.length;
    await manager.handleSignal('aaaaaa', {
      kind: 'offer',
      sdp: 'v=0\r\na=ice-ufrag:new-session\r\n',
    });

    // A fresh peer connection was built and answered on, instead of answering on the dead one.
    expect(FakePeerConnection.instances.length).toBe(before + 1);
    expect(events.signals).toContain('answer');
    expect(dead.closed).toBe(true);
  });

  it('closes and forgets everything on dispose', () => {
    const { manager } = createHarness('aaaaaa');
    manager.ensureConnection('zzzzzz');
    const pc = lastPc();
    manager.dispose();
    expect(pc.closed).toBe(true);
    expect(manager.hasLink('zzzzzz')).toBe(false);
    expect(manager.statusOf('zzzzzz')).toBe('idle');
  });
});
