/**
 * LANShare runtime — the single place where signaling, WebRTC and transfer state meet.
 *
 * Components never talk to a service directly; they read state and call actions here.
 * Everything is wired through refs so long-lived callbacks never capture stale state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { config } from '../config';
import { SignalingClient, type SignalingState } from '../services/signaling';
import { PeerManager, type LinkIdentity, type LinkStatus, type SelfIdentity } from '../services/webrtc';
import { TransferManager, type NoticeLevel } from '../services/transfer';
import {
  addHistoryEntry,
  clearHistory as clearHistoryDb,
  listHistory,
  loadReceiveDirectoryHandle,
  saveReceiveDirectoryHandle,
} from '../services/storage';
import {
  createQueuedFile,
  downloadBlob,
  pickSaveDirectory,
  revokeQueuedFile,
  zipBlobs,
  archiveName,
} from '../services/file';
import type { HistoryEntry, IncomingRequest, QueuedFile, TransferRecord } from '../types/transfer';
import type { Peer, PeerStatus } from '../types/peer';
import type { PeerInfo, WelcomeMessage } from '../types/protocol';
import { useSettings } from './settings';
import { useToast } from './toast';
import { normaliseRoomCode, validateFiles, type FileValidationIssue } from '../utils/validation';
import { generateRoomCode } from '../utils/id';
import { log } from '../services/logger';
import { readLocal } from '../utils/safeStorage';
import { decodeManualPayload, encodeManualPayload } from '../services/manualPairing';

export interface AddFilesResult {
  added: number;
  issues: FileValidationIssue[];
}

interface LanShareContextValue {
  /* connection */
  signalingState: SignalingState;
  signalingError: string | null;
  selfId: string | null;
  roomId: string | null;
  peers: Peer[];
  online: boolean;
  /**
   * Set when this deployment is the offline LAN host (`npm run offline`): the server says so
   * in WELCOME and lists the URLs other devices can open.
   */
  offlineLan: { urls: string[] } | null;
  retrySignaling: () => void;
  createPrivateRoom: () => void;
  joinDefaultRoom: () => void;

  /* queue */
  queue: QueuedFile[];
  addFiles: (files: FileList | File[] | null) => Promise<AddFilesResult>;
  removeFile: (id: string) => void;
  clearQueue: () => void;
  moveFile: (id: string, direction: -1 | 1) => void;

  /* text */
  textDraft: string;
  setTextDraft: (value: string) => void;

  /* sending */
  sendQueueTo: (peerId: string) => boolean;
  sendTextTo: (peerId: string, text?: string) => boolean;

  /* transfers */
  transfers: TransferRecord[];
  incoming: IncomingRequest[];
  activeCount: number;
  acceptTransfer: (transferId: string) => void;
  rejectTransfer: (transferId: string) => void;
  cancelTransfer: (transferId: string) => void;
  dismissTransfer: (transferId: string) => void;
  clearFinished: () => void;
  downloadAll: (transferId: string) => Promise<void>;

  /* serverless pairing (no signaling server at all) */
  createServerlessInvite: () => Promise<{ handle: string; payload: string }>;
  joinServerlessInvite: (payload: string) => Promise<{ peerId: string; payload: string }>;
  completeServerlessInvite: (handle: string, answer: string) => Promise<string>;
  cancelServerlessInvite: (handle: string) => void;

  /* devices */
  connectTo: (peerId: string) => void;
  retryPeer: (peerId: string) => void;
  disconnectPeer: (peerId: string) => void;

  /* history */
  history: HistoryEntry[];
  wipeHistory: () => Promise<void>;

  /* receiving folder */
  receiveFolderName: string | null;
  chooseReceiveFolder: () => Promise<void>;
  forgetReceiveFolder: () => Promise<void>;
}

const LanShareContext = createContext<LanShareContextValue | null>(null);

interface PeerRecord extends Peer {
  key?: string;
}

function statusRank(status: PeerStatus): number {
  return ['connected', 'connecting', 'unstable', 'available', 'failed', 'offline'].indexOf(status);
}

export function LanShareProvider({ children }: { children: ReactNode }) {
  const { settings, deviceKind, deviceId, update: updateSettings } = useSettings();
  const toast = useToast();

  const [signalingState, setSignalingState] = useState<SignalingState>('idle');
  const [offlineLan, setOfflineLan] = useState<{ urls: string[] } | null>(null);
  const [signalingError, setSignalingError] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [textDraft, setTextDraft] = useState('');
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [incoming, setIncoming] = useState<IncomingRequest[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [receiveFolderName, setReceiveFolderName] = useState<string | null>(null);

  /* ---------------- refs (state readable from long-lived callbacks) ---------------- */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selfIdRef = useRef<string | null>(null);
  const peersRef = useRef(new Map<string, PeerRecord>());
  const queueRef = useRef<QueuedFile[]>([]);
  queueRef.current = queue;
  const transfersRef = useRef(new Map<string, TransferRecord>());
  const outboundFilesRef = useRef(new Map<string, QueuedFile[]>());
  const pruneTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const receiveDirRef = useRef<FileSystemDirectoryHandle | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const peerManagerRef = useRef<PeerManager | null>(null);
  const transferManagerRef = useRef<TransferManager | null>(null);
  const selfIdentityRef = useRef<SelfIdentity>({ id: null, name: settings.displayName, device: deviceKind });
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialRoomNoticeRef = useRef<string | null>(null);

  /* ---------------- publishing helpers ---------------- */
  const publishPeers = useCallback(() => {
    const list = Array.from(peersRef.current.values()).sort((a, b) => {
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
      return a.name.localeCompare(b.name);
    });
    setPeers(list);
  }, []);

  const publishTransfers = useCallback(() => {
    const list = Array.from(transfersRef.current.values()).sort((a, b) => {
      const aDone = a.status === 'completed' || a.status === 'cancelled' || a.status === 'failed' || a.status === 'rejected';
      const bDone = b.status === 'completed' || b.status === 'cancelled' || b.status === 'failed' || b.status === 'rejected';
      if (aDone !== bDone) return aDone ? 1 : -1;
      return b.startedAt - a.startedAt;
    });
    setTransfers(list);
  }, []);

  const notice = useCallback(
    (level: NoticeLevel, message: string) => {
      toast.push({ variant: level, message });
    },
    [toast],
  );

  const notify = useCallback((title: string, body: string) => {
    const current = settingsRef.current;
    if (!current.notifications) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag: 'lanshare', icon: undefined });
    } catch {
      /* notifications can fail silently — never block the app */
    }
  }, []);

  /* ---------------- peer bookkeeping ---------------- */
  const upsertPeer = useCallback(
    (info: PeerInfo, patch: Partial<PeerRecord> = {}) => {
      const existing = peersRef.current.get(info.id);
      const next: PeerRecord = {
        id: info.id,
        name: info.name,
        device: info.device,
        joinedAt: info.joinedAt,
        status: existing?.status ?? 'available',
        ...(info.key ? { key: info.key } : {}),
        ...(existing?.rttMs !== undefined ? { rttMs: existing.rttMs } : {}),
        ...(existing?.transport ? { transport: existing.transport } : {}),
        ...patch,
      };
      peersRef.current.set(info.id, next);
      const timer = pruneTimers.current.get(info.id);
      if (timer) {
        clearTimeout(timer);
        pruneTimers.current.delete(info.id);
      }
      return next;
    },
    [],
  );

  const setPeerStatus = useCallback(
    (peerId: string, status: PeerStatus, patch: Partial<PeerRecord> = {}) => {
      const existing = peersRef.current.get(peerId);
      if (!existing) return;
      peersRef.current.set(peerId, { ...existing, status, ...patch });
      publishPeers();
    },
    [publishPeers],
  );

  /* ---------------- transfer manager (created once) ---------------- */
  const ensureManagers = useCallback((): {
    signaling: SignalingClient;
    peerManager: PeerManager;
    transferManager: TransferManager;
  } => {
    if (signalingRef.current && peerManagerRef.current && transferManagerRef.current) {
      return {
        signaling: signalingRef.current,
        peerManager: peerManagerRef.current,
        transferManager: transferManagerRef.current,
      };
    }

    const peerManager = new PeerManager(
      config.iceServers,
      {
        onSignal: (peerId, data) => signalingRef.current?.signal(peerId, data),
        onStatusChange: (peerId, status: LinkStatus, detail) => {
          const mapped: PeerStatus =
            status === 'connected'
              ? 'connected'
              : status === 'connecting'
                ? 'connecting'
                : status === 'unstable'
                  ? 'unstable'
                  : status === 'failed'
                    ? 'failed'
                    : 'available';
          const existing = peersRef.current.get(peerId);
          if (!existing && (status === 'connecting' || status === 'connected')) {
            // Link exists but the peer is not in our list yet (reconnect race).
            upsertPeer({ id: peerId, name: 'Nearby device', device: 'unknown', joinedAt: Date.now() }, { status: mapped });
          } else if (existing) {
            setPeerStatus(peerId, mapped, detail ? { transport: detail } : {});
          } else {
            return;
          }
          publishPeers();
          if (status === 'connected') {
            const peer = peersRef.current.get(peerId);
            const label = peer?.name ?? 'device';
            notice('success', `Connected to ${label}`);
            peerManager.announceIdentity(peerId);
          } else if (status === 'failed' && existing) {
            toast.push({
              variant: 'warning',
              message: `Could not connect to ${existing.name}`,
              detail: detail ?? 'Make sure both devices are on the same network, then retry.',
              action: { label: 'Retry', onClick: () => peerManagerRef.current?.retry(peerId) },
            });
          }
        },
        onMessage: (peerId, message) => transferManagerRef.current?.handleMessage(peerId, message),
        onBinary: (peerId, frame) => transferManagerRef.current?.handleBinary(peerId, frame),
        onIdentity: (peerId, identity: LinkIdentity) => {
          const existing = peersRef.current.get(peerId);
          if (existing) {
            peersRef.current.set(peerId, {
              ...existing,
              name: identity.name || existing.name,
              device: (identity.device as PeerRecord['device']) || existing.device,
            });
            publishPeers();
          }
        },
      },
      () => selfIdentityRef.current,
    );

    const transferManager = new TransferManager({
      peers: peerManager,
      getPeerName: (peerId) => peersRef.current.get(peerId)?.name ?? 'Nearby device',
      getReceiveDirectory: () => receiveDirRef.current,
      events: {
        onIncomingRequest: (request) => {
          setIncoming((current) => {
            if (current.some((entry) => entry.id === request.id)) return current;
            return [...current, request];
          });
          const label =
            request.kind === 'text'
              ? 'wants to send text'
              : request.items.length === 1
                ? `wants to send ${request.items[0]?.name}`
                : `wants to send ${request.items.length} files`;
          notify(`${request.peerName} ${label}`, 'Open LANShare to accept or decline.');
          if (settingsRef.current.autoAccept) {
            void transferManager.acceptIncoming(request.id);
            notice('info', `Auto-accepted ${request.peerName}'s transfer.`);
          }
        },
        onIncomingResolved: (transferId, status) => {
          setIncoming((current) => current.filter((entry) => entry.id !== transferId));
          if (status === 'expired') notice('warning', 'The incoming transfer request expired.');
        },
        onUpdate: (record) => {
          transfersRef.current.set(record.id, record);
          publishTransfers();
          if (record.direction === 'receiving' && record.kind === 'files' && record.status === 'completed') {
            const files = record.received.filter((file) => file.blob);
            if (settingsRef.current.autoDownload && settingsRef.current.saveBehavior === 'downloads' && files.length === 1) {
              const file = files[0];
              if (file?.blob) downloadBlob(file.blob, file.name);
            }
          }
          const terminal =
            record.status === 'completed' ||
            record.status === 'cancelled' ||
            record.status === 'failed' ||
            record.status === 'rejected';
          if (terminal && record.direction === 'sending') {
            const files = outboundFilesRef.current.get(record.id);
            if (files) {
              files.forEach((file) => revokeQueuedFile(file));
              outboundFilesRef.current.delete(record.id);
            }
          }
        },
        onNotice: notice,
        onSavedToDisk: (record, folder) => {
          notice('info', `Saved ${record.items.length === 1 ? record.items[0]?.name : `${record.items.length} files`} to “${folder}”.`);
        },
        onHistory: (entry, remember) => {
          if (!remember || !settingsRef.current.keepHistory) return;
          void addHistoryEntry(entry).then(() => {
            void listHistory().then(setHistory);
          });
        },
      },
    });

    const requestedRoom = normaliseRoomCode(new URLSearchParams(window.location.search).get(config.roomParam));

    const signaling = new SignalingClient(
      config.signalingUrl,
      { name: settingsRef.current.displayName, device: deviceKind, key: deviceId, room: requestedRoom ?? undefined },
      {
        onWelcome: (welcome: WelcomeMessage) => {
          if (welcome.roomId && initialRoomNoticeRef.current !== welcome.roomId) {
            const requested = normaliseRoomCode(new URLSearchParams(window.location.search).get(config.roomParam));
            if (requested && requested === welcome.roomId) {
              notice('info', `Joined private room ${welcome.roomId}.`);
            }
            initialRoomNoticeRef.current = welcome.roomId;
          }
          setSelfId(welcome.selfId);
          setRoomId(welcome.roomId);
          selfIdRef.current = welcome.selfId;
          selfIdentityRef.current = {
            id: welcome.selfId,
            name: settingsRef.current.displayName,
            device: deviceKind,
          };
          if (welcome.offline) {
            // The offline host advertises no ICE servers on purpose: nothing outside the LAN
            // can be reached, so only host (mDNS) candidates are used.
            peerManager.useHostCandidatesOnly();
            log.info('offline LAN mode: using host candidates only (no STUN/TURN)');
          } else if (welcome.iceServers?.length) {
            peerManager.setIceServers(welcome.iceServers as RTCIceServer[]);
          }
          // Offline host: no internet anywhere in the path. Kept in state so the UI can say
          // so honestly and offer the join URL/QR instead of leaving people to guess.
          if (welcome.offline || welcome.lan?.urls?.length) {
            setOfflineLan({ urls: welcome.lan?.urls ?? [] });
          }
          setSignalingError(null);
        },
        onPeers: (list) => {
          // Drop peers the server no longer knows about, unless we hold a live link.
          const incomingIds = new Set(list.map((peer) => peer.id));
          peerManager.setRoster(Array.from(incomingIds));
          for (const [id] of Array.from(peersRef.current.entries())) {
            if (incomingIds.has(id)) continue;
            // A device paired without a server is not in the room list by definition.
            if (peerManager.isManual(id)) continue;
            const linkStatus = peerManager.statusOf(id);
            if (linkStatus === 'connected') continue;
            peersRef.current.delete(id);
          }
          for (const info of list) {
            upsertPeer(info);
            peerManager.ensureConnection(info.id);
          }
          publishPeers();
        },
        onPeerJoined: (info) => {
          // Same browser rejoining with a new peer id: keep the existing link alive.
          const previous = Array.from(peersRef.current.values()).find(
            (peer) => peer.key && info.key && peer.key === info.key && peer.id !== info.id,
          );
          if (previous && peerManager.rekeyLink(previous.id, info.id)) {
            peersRef.current.delete(previous.id);
          }
          upsertPeer(info);
          publishPeers();
          peerManager.addToRoster(info.id);
          peerManager.ensureConnection(info.id);
        },
        onPeerLeft: (peerId) => {
          peerManager.removeFromRoster(peerId);
          // A link that can no longer carry data is dead weight once the peer is gone.
          peerManager.dropDeadLink(peerId);
          const peer = peersRef.current.get(peerId);
          if (!peer) return;
          const linkStatus = peerManager.statusOf(peerId);
          if (linkStatus === 'connected' || linkStatus === 'unstable') {
            // Direct connection still alive — keep it usable.
            setPeerStatus(peerId, 'unstable', { transport: 'direct connection' });
          } else {
            setPeerStatus(peerId, 'offline');
            transferManagerRef.current?.handlePeerGone(peerId);
            const timer = setTimeout(() => {
              const current = peersRef.current.get(peerId);
              if (current && current.status === 'offline') {
                peersRef.current.delete(peerId);
                publishPeers();
              }
            }, 60_000);
            timer.unref?.();
            pruneTimers.current.set(peerId, timer);
          }
        },
        onPeerUpdated: (info) => {
          const existing = peersRef.current.get(info.id);
          if (existing) upsertPeer(info, { name: info.name, device: info.device, status: existing.status });
          else upsertPeer(info);
          publishPeers();
        },
        onSignal: (from, data) => {
          void peerManager.handleSignal(from, data);
        },
        onState: (state) => {
          setSignalingState(state);
          if (state === 'connected') {
            setSignalingError(null);
          }
          if (state === 'reconnecting') {
            for (const id of peersRef.current.keys()) {
              if (peerManager.statusOf(id) !== 'connected') setPeerStatus(id, 'connecting');
            }
          }
        },
        onError: (message, fatal) => {
          setSignalingError(message);
          if (fatal) {
            toast.push({
              variant: 'error',
              message: 'Connection service unavailable',
              detail: message,
              action: { label: 'Retry', onClick: () => signalingRef.current?.retryNow() },
              durationMs: 8000,
            });
          } else {
            notice('warning', message);
          }
        },
      },
    );

    signalingRef.current = signaling;
    peerManagerRef.current = peerManager;
    transferManagerRef.current = transferManager;
    return { signaling, peerManager, transferManager };
  }, [deviceId, deviceKind, notice, notify, publishPeers, setPeerStatus, toast, upsertPeer]);

  /* ---------------- lifecycle ---------------- */

  useEffect(() => {
    const { signaling, peerManager, transferManager } = ensureManagers();
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (!signaling.isOpen && signaling.currentState !== 'connecting' && signaling.currentState !== 'reconnecting') {
      signaling.connect();
    }

    return () => {
      // Defer teardown so React 18 StrictMode's double-invoke does not churn connections.
      stopTimerRef.current = setTimeout(() => {
        signaling.disconnect();
        peerManager.dispose();
        transferManager.dispose();
        signalingRef.current = null;
        peerManagerRef.current = null;
        transferManagerRef.current = null;
      }, 250);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      transferManagerRef.current?.dispose();
      signalingRef.current?.disconnect();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /* ---------------- keep the announced identity in sync ---------------- */
  useEffect(() => {
    selfIdentityRef.current = { id: selfIdRef.current, name: settings.displayName, device: deviceKind };
    signalingRef.current?.setIdentity({ name: settings.displayName });
    signalingRef.current?.rename(settings.displayName);
    peerManagerRef.current?.announceIdentity();
  }, [settings.displayName, deviceKind]);

  /* ---------------- history + receive folder bootstrap ---------------- */
  useEffect(() => {
    void listHistory().then(setHistory);
    void loadReceiveDirectoryHandle().then((handle) => {
      if (handle) {
        receiveDirRef.current = handle;
        setReceiveFolderName(handle.name);
      }
    });
  }, []);

  /* ---------------- actions ---------------- */
  const addFiles = useCallback(async (files: FileList | File[] | null): Promise<AddFilesResult> => {
    const list = files ? Array.from(files as ArrayLike<File>) : [];
    if (list.length === 0) return { added: 0, issues: [] };
    const { accepted, issues } = validateFiles(list, queueRef.current.length);
    if (accepted.length === 0) return { added: 0, issues };
    const items = await Promise.all(accepted.map((file) => createQueuedFile(file)));
    setQueue((current) => [...current, ...items]);
    return { added: items.length, issues };
  }, []);

  const removeFile = useCallback((id: string) => {
    setQueue((current) => {
      const target = current.find((item) => item.id === id);
      if (target) revokeQueuedFile(target);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clearQueue = useCallback(() => {
    setQueue((current) => {
      current.forEach(revokeQueuedFile);
      return [];
    });
  }, []);

  const moveFile = useCallback((id: string, direction: -1 | 1) => {
    setQueue((current) => {
      const index = current.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return next;
    });
  }, []);

  const sendQueueTo = useCallback(
    (peerId: string): boolean => {
      const manager = transferManagerRef.current;
      const peerManager = peerManagerRef.current;
      const files = queueRef.current;
      if (!manager || !peerManager) return false;
      if (files.length === 0) {
        notice('warning', 'Add at least one file first.');
        return false;
      }
      const peer = peersRef.current.get(peerId);
      if (!peerManager.isConnected(peerId)) {
        peerManager.ensureConnection(peerId, true);
        notice('info', `Connecting to ${peer?.name ?? 'device'}… try again in a moment.`);
        return false;
      }
      const transferId = manager.send({ peerId, kind: 'files', files });
      if (!transferId) return false;
      outboundFilesRef.current.set(transferId, files);
      setQueue([]); // ownership moves to the transfer (previews are revoked on completion)
      notice('info', `Waiting for ${peer?.name ?? 'the other device'} to accept…`);
      return true;
    },
    [notice],
  );

  const sendTextTo = useCallback(
    (peerId: string, text?: string): boolean => {
      const manager = transferManagerRef.current;
      const peerManager = peerManagerRef.current;
      const payload = (text ?? textDraft).trim();
      if (!manager || !peerManager) return false;
      if (!payload) {
        notice('warning', 'Type or paste something to send.');
        return false;
      }
      if (payload.length > config.maxTextLength) {
        notice('error', 'That text is too long to send.');
        return false;
      }
      if (!peerManager.isConnected(peerId)) {
        peerManager.ensureConnection(peerId, true);
        notice('info', `Connecting to ${peersRef.current.get(peerId)?.name ?? 'device'}… try again in a moment.`);
        return false;
      }
      const transferId = manager.send({ peerId, kind: 'text', text: payload });
      if (!transferId) return false;
      if (text === undefined) setTextDraft('');
      notice('info', 'Text sent — waiting for confirmation…');
      return true;
    },
    [notice, textDraft],
  );

  const acceptTransfer = useCallback((transferId: string) => {
    setIncoming((current) => current.filter((entry) => entry.id !== transferId));
    void transferManagerRef.current?.acceptIncoming(transferId);
  }, []);

  const rejectTransfer = useCallback((transferId: string) => {
    transferManagerRef.current?.rejectIncoming(transferId, 'declined');
    setIncoming((current) => current.filter((entry) => entry.id !== transferId));
  }, []);

  const cancelTransfer = useCallback((transferId: string) => {
    transferManagerRef.current?.cancel(transferId);
  }, []);

  const dismissTransfer = useCallback(
    (transferId: string) => {
      const record = transfersRef.current.get(transferId);
      if (record && record.status === 'active') return;
      if (record) {
        record.received.forEach((file) => {
          if (file.url) URL.revokeObjectURL(file.url);
        });
      }
      transfersRef.current.delete(transferId);
      publishTransfers();
    },
    [publishTransfers],
  );

  const clearFinished = useCallback(() => {
    for (const [id, record] of Array.from(transfersRef.current.entries())) {
      const done =
        record.status === 'completed' || record.status === 'cancelled' || record.status === 'failed' || record.status === 'rejected';
      if (!done) continue;
      record.received.forEach((file) => {
        if (file.url) URL.revokeObjectURL(file.url);
      });
      transfersRef.current.delete(id);
    }
    publishTransfers();
  }, [publishTransfers]);

  const downloadAll = useCallback(
    async (transferId: string) => {
      const record = transfersRef.current.get(transferId);
      if (!record) return;
      const files = record.received.filter((file) => file.blob);
      if (files.length === 0) {
        notice('info', 'These files were saved straight to your chosen folder.');
        return;
      }
      if (files.length === 1) {
        const file = files[0];
        if (file?.blob) downloadBlob(file.blob, file.name);
        return;
      }
      try {
        notice('info', 'Packaging files into a ZIP archive…');
        const blob = await zipBlobs(files.map((file) => ({ name: file.name, blob: file.blob as Blob })));
        downloadBlob(blob, archiveName());
      } catch (error) {
        log.error('zip creation failed', (error as Error).message);
        notice('error', 'Could not create the ZIP archive. Download files individually instead.');
      }
    },
    [notice],
  );

  /**
   * Serverless pairing: the invite text and the answer text *are* the transport. Both peers
   * end up as ordinary entries in the device list, so sending files is unchanged.
   */
  const createServerlessInvite = useCallback(async () => {
    const manager = peerManagerRef.current;
    if (!manager) throw new Error('The connection manager is not ready yet.');
    const { handle, payload } = await manager.createManualInvite();
    return { handle, payload: encodeManualPayload(payload) };
  }, []);

  const joinServerlessInvite = useCallback(
    async (payloadText: string) => {
      const manager = peerManagerRef.current;
      if (!manager) throw new Error('The connection manager is not ready yet.');
      const decoded = decodeManualPayload(payloadText);
      if (!decoded || decoded.k !== 'offer') {
        throw new Error('That pairing code is not a valid LANShare invite.');
      }
      const { peerId, payload } = await manager.acceptManualInvite(decoded);
      // The inviter is a peer from the user's point of view: list it immediately with the name
      // it sent; the in-band HELLO refreshes it once the data channel opens.
      upsertPeer(
        { id: peerId, name: decoded.n, device: decoded.d, joinedAt: Date.now() },
        { status: 'connecting', transport: 'manual' },
      );
      publishPeers();
      return { peerId, payload: encodeManualPayload(payload) };
    },
    [publishPeers, upsertPeer],
  );

  const completeServerlessInvite = useCallback(
    async (handle: string, answer: string) => {
      const manager = peerManagerRef.current;
      if (!manager) throw new Error('The connection manager is not ready yet.');
      const decoded = decodeManualPayload(answer);
      if (!decoded || decoded.k !== 'answer') {
        throw new Error('That is not a valid LANShare reply code.');
      }
      const peerId = await manager.completeManualInvite(handle, decoded);
      upsertPeer(
        { id: peerId, name: decoded.n, device: decoded.d, joinedAt: Date.now() },
        { status: 'connecting', transport: 'manual' },
      );
      publishPeers();
      return peerId;
    },
    [publishPeers, upsertPeer],
  );

  const cancelServerlessInvite = useCallback((handle: string) => {
    peerManagerRef.current?.cancelManualInvite(handle);
  }, []);

  const connectTo = useCallback(
    (peerId: string) => {
      peerManagerRef.current?.ensureConnection(peerId, true);
      const peer = peersRef.current.get(peerId);
      if (peer) setPeerStatus(peerId, 'connecting');
    },
    [setPeerStatus],
  );

  const retryPeer = useCallback((peerId: string) => {
    peerManagerRef.current?.retry(peerId);
  }, []);

  const disconnectPeer = useCallback(
    (peerId: string) => {
      peerManagerRef.current?.closeLink(peerId);
      const peer = peersRef.current.get(peerId);
      if (peer) setPeerStatus(peerId, 'available');
      notice('info', 'Disconnected.');
    },
    [notice, setPeerStatus],
  );

  const retrySignaling = useCallback(() => {
    signalingRef.current?.retryNow();
  }, []);

  const switchRoom = useCallback((room: string | undefined) => {
    const signaling = signalingRef.current;
    if (!signaling) return;
    signaling.setRoom(room);
    signaling.disconnect();
    setTimeout(() => signaling.connect(), 60);
  }, []);

  const createPrivateRoom = useCallback(() => {
    const code = generateRoomCode();
    switchRoom(code);
    toast.push({
      variant: 'info',
      message: `Private room ${code} created`,
      detail: 'Open the QR code and scan it on your other device to join.',
      durationMs: 6000,
    });
  }, [switchRoom, toast]);

  const joinDefaultRoom = useCallback(() => {
    switchRoom(undefined);
    toast.push({ variant: 'info', message: 'You are back in the default nearby room.' });
  }, [switchRoom, toast]);

  /**
   * Debug snapshot — only exposed when the app is run with `?debug=1` or
   * `localStorage['lanshare.debug'] = '1'`. Read-only, contains no file data.
   */
  useEffect(() => {
    const enabled =
      import.meta.env.DEV ||
      (typeof window !== 'undefined' &&
        (window.location.search.includes('debug=1') || readLocal('lanshare.debug') === '1'));
    if (!enabled) return;
    const debugApi = {
      snapshot: () => ({
        signalingState: signalingRef.current?.currentState ?? 'unknown',
        selfId: selfIdRef.current,
        roomId: signalingRef.current?.roomId ?? null,
        peers: Array.from(peersRef.current.values()).map((peer) => ({
          id: peer.id,
          name: peer.name,
          status: peer.status,
          link: peerManagerRef.current?.statusOf(peer.id) ?? 'none',
        })),
        links: peerManagerRef.current?.debugState() ?? [],
        transfers: Array.from(transfersRef.current.values()).map((record) => ({
          id: record.id,
          direction: record.direction,
          status: record.status,
          peer: record.peerName,
          bytes: record.totalBytes,
          total: record.totalSize,
          error: record.error ?? null,
        })),
      }),
      iceServers: () => peerManagerRef.current?.getIceServers() ?? config.iceServers,
    };
    (window as unknown as Record<string, unknown>).__lanshare = debugApi;
    return () => {
      delete (window as unknown as Record<string, unknown>).__lanshare;
    };
  }, []);

  const wipeHistory = useCallback(async () => {
    await clearHistoryDb();
    setHistory([]);
    notice('success', 'Transfer history cleared.');
  }, [notice]);

  const chooseReceiveFolder = useCallback(async () => {
    const result = await pickSaveDirectory();
    if (!result.handle) {
      notice('warning', 'Folder selection is not available in this browser. Files will be saved as downloads.');
      return;
    }
    receiveDirRef.current = result.handle;
    setReceiveFolderName(result.name);
    await saveReceiveDirectoryHandle(result.handle);
    updateSettings({ saveBehavior: 'folder', receiveFolderName: result.name });
    notice('success', `Incoming files will be saved to “${result.name}”.`);
  }, [notice, updateSettings]);

  const forgetReceiveFolder = useCallback(async () => {
    receiveDirRef.current = null;
    setReceiveFolderName(null);
    await saveReceiveDirectoryHandle(null);
    updateSettings({ saveBehavior: 'downloads', receiveFolderName: null });
    notice('info', 'Incoming files will be saved as downloads again.');
  }, [notice, updateSettings]);

  const value = useMemo<LanShareContextValue>(
    () => ({
      signalingState,
      signalingError,
      selfId,
      roomId,
      peers,
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      offlineLan,
      retrySignaling,
      createPrivateRoom,
      joinDefaultRoom,
      queue,
      addFiles,
      removeFile,
      clearQueue,
      moveFile,
      textDraft,
      setTextDraft,
      sendQueueTo,
      sendTextTo,
      transfers,
      incoming,
      activeCount: transfers.filter((transfer) => transfer.status === 'active' || transfer.status === 'requesting').length,
      acceptTransfer,
      rejectTransfer,
      cancelTransfer,
      dismissTransfer,
      clearFinished,
      downloadAll,
      createServerlessInvite,
      joinServerlessInvite,
      completeServerlessInvite,
      cancelServerlessInvite,
      connectTo,
      retryPeer,
      disconnectPeer,
      history,
      wipeHistory,
      receiveFolderName,
      chooseReceiveFolder,
      forgetReceiveFolder,
    }),
    [
      signalingState,
      signalingError,
      selfId,
      roomId,
      peers,
      offlineLan,
      retrySignaling,
      createPrivateRoom,
      joinDefaultRoom,
      queue,
      addFiles,
      removeFile,
      clearQueue,
      moveFile,
      textDraft,
      sendQueueTo,
      sendTextTo,
      transfers,
      incoming,
      acceptTransfer,
      rejectTransfer,
      cancelTransfer,
      dismissTransfer,
      clearFinished,
      downloadAll,
      createServerlessInvite,
      joinServerlessInvite,
      completeServerlessInvite,
      cancelServerlessInvite,
      connectTo,
      retryPeer,
      disconnectPeer,
      history,
      wipeHistory,
      receiveFolderName,
      chooseReceiveFolder,
      forgetReceiveFolder,
    ],
  );

  return <LanShareContext.Provider value={value}>{children}</LanShareContext.Provider>;
}

export function useLanShare(): LanShareContextValue {
  const context = useContext(LanShareContext);
  if (!context) throw new Error('useLanShare must be used inside <LanShareProvider>');
  return context;
}

export function usePeers(): Peer[] {
  return useLanShare().peers;
}

export function useTransfers(): TransferRecord[] {
  return useLanShare().transfers;
}
