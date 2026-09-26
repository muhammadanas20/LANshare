/**
 * Wire protocol — single source of truth for:
 *   1. client <-> signaling server messages (WebSocket, JSON)
 *   2. peer   <-> peer   messages (RTCDataChannel `ctl` channel, JSON)
 *
 * Every inbound message is parsed through these schemas before it is allowed
 * anywhere near application state.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Signaling server schemas (client -> server)
 * ------------------------------------------------------------------ */

export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024; // metadata only, never file bytes
export const MAX_NAME_LENGTH = 32;
export const MAX_ROOM_LENGTH = 32;
export const MAX_SDP_LENGTH = 32 * 1024;

export const RoomIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(MAX_ROOM_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'Room ids may contain letters, numbers, dash and underscore only');

export const DeviceKindSchema = z.enum(['desktop', 'mobile', 'tablet', 'unknown']);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const PeerNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);

const sdpPayload = z.string().min(1).max(MAX_SDP_LENGTH);

export const SignalDataSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('offer'),
    sdp: sdpPayload,
  }),
  z.object({
    kind: z.literal('answer'),
    sdp: sdpPayload,
  }),
  z.object({
    kind: z.literal('ice'),
    candidate: z.object({
      candidate: z.string().max(2048),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(128).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
]);
export type SignalData = z.infer<typeof SignalDataSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('HELLO'),
    name: PeerNameSchema,
    device: DeviceKindSchema.default('unknown'),
    room: RoomIdSchema.optional(),
    /**
     * Random, locally generated, non-identifying key that stays stable for this
     * browser. Lets peers keep an existing WebRTC link alive when the signaling
     * socket reconnects and the server hands out a fresh peer id.
     */
    key: z.string().min(6).max(32).optional(),
  }),
  z.object({
    type: z.literal('RENAME'),
    name: PeerNameSchema,
  }),
  z.object({
    type: z.literal('SIGNAL'),
    to: z.string().min(1).max(64),
    data: SignalDataSchema,
  }),
  z.object({
    type: z.literal('PING'),
    t: z.number().optional(),
  }),
  z.object({
    type: z.literal('LEAVE'),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ------------------------------------------------------------------ *
 * Signaling server schemas (server -> client)
 * ------------------------------------------------------------------ */

export const PeerInfoSchema = z.object({
  id: z.string().min(1).max(64),
  name: PeerNameSchema,
  device: DeviceKindSchema,
  joinedAt: z.number(),
  key: z.string().min(6).max(32).optional(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerConfig = z.infer<typeof IceServerSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('WELCOME'),
    selfId: z.string().min(1).max(64),
    roomId: RoomIdSchema,
    name: PeerNameSchema,
    peers: z.array(PeerInfoSchema).max(64),
    iceServers: z.array(IceServerSchema).max(8).optional(),
    /** The host is running the offline LAN mode: no internet is involved anywhere. */
    offline: z.boolean().optional(),
    /** Join URLs the host is reachable at, for the "open this on your phone" + QR panel. */
    lan: z.object({ urls: z.array(z.string().max(255)).max(8) }).optional(),
    limits: z
      .object({
        maxPeers: z.number().int().positive(),
        maxMessageBytes: z.number().int().positive(),
        serverTime: z.number(),
      })
      .optional(),
    roomCreated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('PEER_LIST'),
    peers: z.array(PeerInfoSchema).max(64),
  }),
  z.object({
    type: z.literal('PEER_JOINED'),
    peer: PeerInfoSchema,
  }),
  z.object({
    type: z.literal('PEER_LEFT'),
    peerId: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('PEER_UPDATED'),
    peer: PeerInfoSchema,
  }),
  z.object({
    type: z.literal('SIGNAL'),
    from: z.string().min(1).max(64),
    data: SignalDataSchema,
  }),
  z.object({
    type: z.literal('PONG'),
    t: z.number().optional(),
  }),
  z.object({
    type: z.literal('ERROR'),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(300),
    fatal: z.boolean().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type WelcomeMessage = Extract<ServerMessage, { type: 'WELCOME' }>;

/* ------------------------------------------------------------------ *
 * Peer <-> peer data-channel protocol
 * ------------------------------------------------------------------ */

export const MAX_TEXT_LENGTH = 256 * 1024;
export const MAX_ITEMS_PER_TRANSFER = 300;

export const TransferItemSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
  mime: z.string().max(160).default('application/octet-stream'),
  /** Relative path when a folder was selected (display only, sanitised before use). */
  relPath: z.string().max(1024).optional(),
});
export type TransferItem = z.infer<typeof TransferItemSchema>;

const transferId = z.string().min(6).max(64);

export const PeerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('HELLO'),
    name: PeerNameSchema,
    device: DeviceKindSchema,
    protocol: z.number().int().min(1).max(99),
  }),
  z.object({
    t: z.literal('TRANSFER_REQUEST'),
    transferId,
    kind: z.enum(['files', 'text']),
    items: z.array(TransferItemSchema).max(MAX_ITEMS_PER_TRANSFER),
    totalSize: z.number().int().min(0),
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    createdAt: z.number(),
  }),
  z.object({
    t: z.literal('TRANSFER_ACCEPT'),
    transferId,
    /** Receiver may request streaming-to-disk (best effort, informational). */
    direct: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('TRANSFER_REJECT'),
    transferId,
    reason: z.enum(['declined', 'busy', 'too-large', 'unsupported']).default('declined'),
  }),
  z.object({
    t: z.literal('TRANSFER_COMPLETE'),
    transferId,
    bytes: z.number().int().min(0),
  }),
  z.object({
    t: z.literal('TRANSFER_CANCEL'),
    transferId,
    by: z.enum(['sender', 'receiver']),
    reason: z.string().max(160).optional(),
  }),
  z.object({
    t: z.literal('TRANSFER_ERROR'),
    transferId,
    code: z.string().max(64),
    message: z.string().max(240),
  }),
  z.object({
    /** Receiver-driven flow control: pause/resume an in-flight transfer. */
    t: z.literal('FLOW'),
    transferId,
    paused: z.boolean(),
  }),
  z.object({
    t: z.literal('PING'),
    id: z.number(),
    at: z.number(),
  }),
  z.object({
    t: z.literal('PONG'),
    id: z.number(),
    at: z.number(),
  }),
]);
export type PeerMessage = z.infer<typeof PeerMessageSchema>;

/** Header of every binary frame sent on the `bin` data channel. */
export const FrameHeaderSchema = z.object({
  transferId,
  fileIndex: z.number().int().min(0).max(MAX_ITEMS_PER_TRANSFER),
  offset: z.number().int().min(0),
  length: z.number().int().min(0).max(8 * 1024 * 1024),
});
export type FrameHeader = z.infer<typeof FrameHeaderSchema>;

/**
 * In-band control messages that travel on the *data* channel, interleaved with file
 * bytes, so their ordering relative to the payload is guaranteed.
 */
export const FrameControlSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('FILE_START'),
    transferId,
    fileIndex: z.number().int().min(0).max(MAX_ITEMS_PER_TRANSFER),
    size: z.number().int().min(0),
  }),
  z.object({
    t: z.literal('FILE_END'),
    transferId,
    fileIndex: z.number().int().min(0).max(MAX_ITEMS_PER_TRANSFER),
    bytes: z.number().int().min(0),
    sha256: z.string().max(64).optional(),
  }),
  z.object({
    t: z.literal('TRANSFER_DONE'),
    transferId,
    bytes: z.number().int().min(0),
  }),
]);
export type FrameControl = z.infer<typeof FrameControlSchema>;

export const PROTOCOL_VERSION = 2;

/** Soft validation used by both sides; returns null when the message is not usable. */
export function parsePeerMessage(raw: unknown): PeerMessage | null {
  const result = PeerMessageSchema.safeParse(raw);
  if (!result.success) {
    if (import.meta.env.DEV) {
      console.warn('[LANShare] Rejected peer message', result.error.issues.slice(0, 3));
    }
    return null;
  }
  return result.data;
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  const result = ServerMessageSchema.safeParse(raw);
  if (!result.success) {
    if (import.meta.env.DEV) {
      console.warn('[LANShare] Rejected signaling message', result.error.issues.slice(0, 3));
    }
    return null;
  }
  return result.data;
}
