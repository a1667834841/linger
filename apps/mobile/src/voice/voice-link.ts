// The start every voice feature shares: a VoiceSession and its grant, the
// microphone, and a Bridge stream that publishes it. Audio captured before
// the Runtime is ready stays on the phone and goes out once released, so the
// first words are not lost while the computer gets ready.
import { getVoiceSession } from "../api/teamhub";
import type { VoiceSession, VoiceSessionPurpose } from "../api/types";
import { documentFiles } from "../computer/store-expo";
import { HttpError } from "../session/http";
import { SessionClosed } from "../session/session";
import {
  MicrophoneBusy,
  openMicrophone,
  type AudioUse,
  type Microphone,
  type MicrophoneOptions,
} from "./audio";
import {
  BridgeClient,
  BridgeFailed,
  type BridgeListener,
} from "./bridge-client";
import type { SessionSource } from "./use-session-source";
import {
  VoiceNotReady,
  closeVoice,
  openVoiceSession,
  waitForInputReady,
} from "./voice-session";

const PUBLISH_TIMEOUT_MS = 20_000;

export interface VoiceLink {
  readonly voice: VoiceSession;
  readonly bridge: BridgeClient;
  readonly microphone: Microphone;
  /** Resolves once the Bridge published and the Runtime is ready; audio is still held. */
  readonly ready: Promise<void>;
  /** Stops the Bridge and closes the VoiceSession; the microphone stops separately. */
  close(): Promise<void>;
}

const uses: Record<VoiceSessionPurpose, AudioUse> = {
  chat_dictation: "dictate",
  chat_live: "live",
  hardware_control: "record",
};

/** An open session within a few seconds, or undefined. */
async function sessionSoon(source: SessionSource, ms: number) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await source(abort.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function openVoiceLink(input: {
  readonly purpose: VoiceSessionPurpose;
  readonly roomId: string;
  readonly hostId: string;
  readonly sessions: SessionSource;
  readonly signal: AbortSignal;
  readonly listener?: BridgeListener;
  readonly microphone?: Omit<MicrophoneOptions, "use" | "onFrame">;
  /** True once the Runtime already spoke, which proves it listens. */
  activity?(): boolean;
}): Promise<VoiceLink> {
  const { sessions, signal } = input;
  const session = await sessions(signal);
  const opened = await openVoiceSession({
    session,
    files: documentFiles,
    hostId: input.hostId,
    roomId: input.roomId,
    purpose: input.purpose,
  });
  const voice = opened.voice;
  let published!: (value: { generation: number }) => void;
  let refused!: (error: Error) => void;
  const publishing = new Promise<{ generation: number }>((resolve, reject) => {
    published = resolve;
    refused = reject;
  });
  publishing.catch(() => undefined);
  const listener = input.listener ?? {};
  const bridge = new BridgeClient({
    voiceSessionId: voice.id,
    credential: opened.credential.credential,
    purpose: input.purpose,
    held: true,
    session: sessions,
    listener: {
      ...listener,
      published(value) {
        published(value);
        listener.published?.(value);
      },
      failed(code) {
        refused(new BridgeFailed(code));
        listener.failed?.(code);
      },
    },
  });
  const close = async () => {
    bridge.stop();
    await closeVoice({
      session: await sessionSoon(sessions, 5_000),
      files: documentFiles,
      hostId: input.hostId,
      voiceSessionId: voice.id,
    });
  };
  let microphone: Microphone;
  try {
    microphone = await openMicrophone({
      ...input.microphone,
      use: uses[input.purpose],
      onFrame: (frame) => bridge.sendAudio(frame),
    });
  } catch (error) {
    await close();
    throw error;
  }
  bridge.start();
  const ready = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { generation } = await Promise.race([
      publishing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new VoiceNotReady()),
          PUBLISH_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    await waitForInputReady({
      read: async (readSignal) =>
        getVoiceSession(await sessions(readSignal), voice.id, readSignal),
      generation,
      signal,
      activity: input.activity,
    });
  })();
  ready.catch(() => undefined);
  return { voice, bridge, microphone, ready, close };
}

const bridgeMessages: Record<string, string> = {
  TOO_MANY_SESSIONS:
    "Your computer is already serving its most voice sessions.",
  CONNECT_FAILED: "Your computer could not start voice. Try again.",
  ROOM_CLOSED: "The voice session ended on your computer.",
  HOLD_EXPIRED: "The phone was away from your computer for too long.",
  SHUTTING_DOWN: "Voice is restarting on your computer. Try again.",
};

const httpMessages: Record<string, string> = {
  LIVE_UNAVAILABLE: "Live needs Another Me to be ready on your computer.",
  VOICE_CAPTURE_CONFLICT:
    "Another voice session from this phone is still open. Try again in a moment.",
  VOICE_MEDIA_UNAVAILABLE: "Voice is not available on your computer right now.",
  NOT_AVAILABLE_ON_MOBILE:
    "Update Linger on your computer to use voice from the phone.",
};

/** A sentence for the screen; the code decides it, never an error's prose. */
export function describeVoiceError(error: unknown): string {
  if (error instanceof BridgeFailed)
    return bridgeMessages[error.code] ?? `Voice stopped (${error.code}).`;
  if (error instanceof HttpError)
    return (
      httpMessages[error.code] ?? `Your computer refused voice (${error.code}).`
    );
  if (error instanceof SessionClosed)
    return "Connect to your computer to use voice.";
  if (error instanceof MicrophoneBusy || error instanceof VoiceNotReady)
    return error.message;
  return "Voice could not start. Try again.";
}
