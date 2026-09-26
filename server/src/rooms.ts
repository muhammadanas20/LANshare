/**
 * Room + peer registry.
 *
 * Deliberately in-memory and stateless-by-design: rooms exist only while devices are
 * connected and are destroyed as soon as they empty out (spec §81). No message that
 * passes through here ever contains file bytes.
 */
import type { DeviceKind, PeerInfo, ServerMessage, SignalData } from './protocol.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function randomFrom(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  // Node's webcrypto is available on every supported runtime (>=18).
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[(bytes[i] as number) % alphabet.length];
  return out;
}

export interface PeerRecord {
  id: string;
  name: string;
  device: DeviceKind;
  joinedAt: number;
  roomId: string;
  lastSeen: number;
  /** Opaque random client key (not identifying) used to survive signaling reconnects. */
  key?: string;
  /** Best-effort connection info for logs only — never sent to other peers. */
  origin?: string;
  address?: string;
  /** Sends a validated server message to this peer. */
  send: (message: ServerMessage) => void;
  /** Force-closes the transport. */
  close: (code: number, reason: string) => void;
}

export interface Room {
  id: string;
  createdAt: number;
  lastActivity: number;
  peers: Map<string, PeerRecord>;
}

export type JoinResult =
  | { ok: true; room: Room; created: boolean }
  | { ok: false; code: 'room-full' | 'room-limit' | 'bad-room'; message: string };

export interface RoomManagerOptions {
  maxPeersPerRoom: number;
  maxRooms: number;
  roomTtlMs: number;
}

export interface ManagerStats {
  rooms: number;
  peers: number;
  largestRoom: number;
  uptimeMs: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new Map<string, PeerRecord>();
  private readonly startedAt = Date.now();

  constructor(private readonly options: RoomManagerOptions) {}

  /** Unique, cryptographically random peer id (retries on the astronomically unlikely clash). */
  reservePeerId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomFrom(ID_ALPHABET, 6);
      if (!this.peers.has(id)) return id;
    }
    return randomFrom(ID_ALPHABET, 12);
  }

  reserveRoomId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomFrom(ROOM_ALPHABET, 6);
      if (!this.rooms.has(id)) return id;
    }
    return randomFrom(ROOM_ALPHABET, 10);
  }

  getPeer(id: string): PeerRecord | undefined {
    return this.peers.get(id);
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  peerCount(): number {
    return this.peers.size;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  stats(): ManagerStats {
    let largest = 0;
    for (const room of this.rooms.values()) largest = Math.max(largest, room.peers.size);
    return {
      rooms: this.rooms.size,
      peers: this.peers.size,
      largestRoom: largest,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  peerInfo(peer: PeerRecord): PeerInfo {
    return {
      id: peer.id,
      name: peer.name,
      device: peer.device,
      joinedAt: peer.joinedAt,
      ...(peer.key ? { key: peer.key } : {}),
    };
  }

  listPeers(roomId: string, exceptPeerId?: string): PeerInfo[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const out: PeerInfo[] = [];
    for (const peer of room.peers.values()) {
      if (peer.id === exceptPeerId) continue;
      out.push(this.peerInfo(peer));
    }
    return out;
  }

  join(peer: Omit<PeerRecord, 'roomId'>, requestedRoomId?: string): JoinResult {
    let room: Room | undefined;
    let created = false;

    if (requestedRoomId) {
      room = this.rooms.get(requestedRoomId);
      if (!room) {
        if (this.rooms.size >= this.options.maxRooms) {
          return { ok: false, code: 'room-limit', message: 'The server is at capacity. Try again shortly.' };
        }
        created = true;
      }
    } else if (this.rooms.size >= this.options.maxRooms) {
      return { ok: false, code: 'room-limit', message: 'The server is at capacity. Try again shortly.' };
    }

    if (room && room.peers.size >= this.options.maxPeersPerRoom) {
      return { ok: false, code: 'room-full', message: 'That room already has the maximum number of devices.' };
    }

    if (!room) {
      const id = requestedRoomId ?? this.reserveRoomId();
      room = { id, createdAt: Date.now(), lastActivity: Date.now(), peers: new Map() };
      this.rooms.set(id, room);
      created = true;
    }

    const record: PeerRecord = {
      ...peer,
      roomId: room.id,
      name: this.uniqueName(room, peer.name),
    };
    room.peers.set(record.id, record);
    room.lastActivity = Date.now();
    this.peers.set(record.id, record);
    return { ok: true, room, created };
  }

  /** Append a counter so two "Blue Falcon" devices remain distinguishable. */
  private uniqueName(room: Room, desired: string): string {
    const taken = new Set(Array.from(room.peers.values(), (p) => p.name.toLowerCase()));
    if (!taken.has(desired.toLowerCase())) return desired;
    for (let i = 2; i < 50; i += 1) {
      const candidate = `${desired} ${i}`.slice(0, 32);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${desired.slice(0, 28)} ${randomFrom(ID_ALPHABET, 3)}`;
  }

  rename(peerId: string, name: string): PeerInfo | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const room = this.rooms.get(peer.roomId);
    if (!room) return null;
    if (peer.name.toLowerCase() === name.toLowerCase()) return this.peerInfo(peer);
    // Temporarily remove so the peer does not collide with itself.
    room.peers.delete(peer.id);
    peer.name = this.uniqueName(room, name);
    room.peers.set(peer.id, peer);
    room.lastActivity = Date.now();
    return this.peerInfo(peer);
  }

  touch(peerId: string, at = Date.now()): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.lastSeen = at;
    const room = this.rooms.get(peer.roomId);
    if (room) room.lastActivity = at;
  }

  findSignalTarget(peerId: string, targetId: string): PeerRecord | null {
    const peer = this.peers.get(peerId);
    const target = this.peers.get(targetId);
    if (!peer || !target) return null;
    if (peer.roomId !== target.roomId) return null; // cross-room signaling is forbidden
    return target;
  }

  /** Removes a peer, notifies the room and destroys the room when it empties. */
  leave(peerId: string): { peer: PeerRecord; roomDestroyed: boolean } | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    this.peers.delete(peerId);
    const room = this.rooms.get(peer.roomId);
    let roomDestroyed = false;
    if (room) {
      room.peers.delete(peerId);
      room.lastActivity = Date.now();
      if (room.peers.size === 0) {
        this.rooms.delete(room.id);
        roomDestroyed = true;
      }
    }
    return { peer, roomDestroyed };
  }

  /** Periodic cleanup of idle rooms. Returns the number destroyed. */
  sweep(now = Date.now()): number {
    if (this.options.roomTtlMs <= 0) return 0;
    let destroyed = 0;
    for (const [id, room] of this.rooms) {
      const idleFor = now - room.lastActivity;
      if (room.peers.size === 0 || idleFor > this.options.roomTtlMs) {
        for (const peer of room.peers.values()) {
          this.peers.delete(peer.id);
          peer.close(1001, 'Room expired');
        }
        this.rooms.delete(id);
        destroyed += 1;
      }
    }
    return destroyed;
  }

  /** Close everything (used on shutdown and in tests). */
  clear(closeCode = 1001, reason = 'Server shutting down'): void {
    for (const peer of this.peers.values()) {
      try {
        peer.close(closeCode, reason);
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.rooms.clear();
  }
}

export function encodeMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function makeSignal(target: string, data: SignalData): ServerMessage {
  return { type: 'SIGNAL', from: target, data };
}
