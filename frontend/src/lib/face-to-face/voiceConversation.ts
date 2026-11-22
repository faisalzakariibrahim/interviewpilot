"use client";

// A voice-only interviewer on OpenAI's Realtime API, shaped like the Nuance conversation the
// InterviewDirector already drives. It translates OpenAI's events into the director's
// (session.started, output/input transcripts, output_audio.done) and its instructions into
// OpenAI responses, so questions, scoring and follow-ups work the same in both modes.

import type { DirectorConversation } from "./director";

export type VoiceChange =
  | { type: "avatar-presented" }
  | { type: "time-remaining"; secondsRemaining: number }
  | { type: "session-ended"; reason: string; endReason?: string; message?: string };

export interface VoiceConnectOptions {
  /** Exchanges the browser's WebRTC offer for OpenAI's answer via our server. */
  exchange: (offerSdp: string) => Promise<{ sdp: string; callId: string | null }>;
  maxSessionSeconds: number;
}

/** Thrown when the microphone can't be opened. */
export class VoiceMicrophoneError extends Error {}

type Listener<T> = (event: T) => void;

export class VoiceConversation implements DirectorConversation {
  id: string | null = null;
  state: "idle" | "connecting" | "connected" | "ended" = "idle";

  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private remote: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private readonly interfaceListeners = new Set<Listener<Record<string, unknown>>>();
  private readonly changeListeners = new Set<Listener<VoiceChange>>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  /** OpenAI runs one response at a time: queue ours until the current one finishes. */
  private responding = false;
  private queue: Array<Record<string, unknown>> = [];
  private lastRequest: Record<string, unknown> | null = null;
  private endAfterNextReply = false;
  private endedSent = false;

  constructor(private readonly options: VoiceConnectOptions) {}

  onInterfaceEvent(listener: Listener<Record<string, unknown>>): () => void {
    this.interfaceListeners.add(listener);
    return () => this.interfaceListeners.delete(listener);
  }

  onChange(listener: Listener<VoiceChange>): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  attachAudio(element: HTMLAudioElement | null): void {
    this.audioElement = element;
    if (element && this.remote) {
      element.srcObject = this.remote;
      void element.play().catch(() => undefined);
    }
  }

  async connect(): Promise<void> {
    this.state = "connecting";
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.state = "ended";
      throw new VoiceMicrophoneError(
        "The microphone couldn't be opened. Allow microphone access in your browser and try again.",
      );
    }

    const peer = new RTCPeerConnection();
    this.peer = peer;
    peer.ontrack = (event) => {
      this.remote = event.streams[0] ?? new MediaStream([event.track]);
      this.attachAudio(this.audioElement);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") this.ended("connection-lost");
    };
    for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("message", ({ data }) => {
      try {
        this.onServerEvent(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        /* ignore malformed events */
      }
    });
    const opened = new Promise<void>((resolve, reject) => {
      channel.addEventListener("open", () => resolve(), { once: true });
      this.timers.push(setTimeout(() => reject(new Error("The voice interviewer didn't connect. Try again.")), 20_000));
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    let answer: { sdp: string; callId: string | null };
    try {
      answer = await this.options.exchange(offer.sdp ?? "");
    } catch (error) {
      this.teardown();
      this.state = "ended";
      throw error;
    }
    this.id = answer.callId;
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await opened;
    this.state = "connected";

    // The director waits for these two before it opens the interview.
    this.emitInterface({ type: "session.started" });
    this.emitChange({ type: "avatar-presented" });

    const max = this.options.maxSessionSeconds;
    if (max > 60) this.timers.push(setTimeout(() => this.emitChange({ type: "time-remaining", secondsRemaining: 60 }), (max - 60) * 1000));
    this.timers.push(setTimeout(() => void this.disconnect("time-limit"), max * 1000));
  }

  // --- DirectorConversation ------------------------------------------------

  async append(kind: "thinking" | "instructions" | "commentary", content: string): Promise<void> {
    if (kind === "instructions") {
      // The model already acknowledged the answer on its own turn; this is the next step.
      // The model already acknowledged the answer on its own turn. A question turn is the question only.
      const asking = /\bask this\b/i.test(content); // follow-ups and next questions, not the greeting
      this.request({
        type: "response.create",
        response: {
          instructions: asking
            ? "Speak now. Say only the question below in your own natural words. Do not acknowledge, praise or " +
              "comment on the previous answer, and add nothing before the question (you already acknowledged it). " +
              "Never mention these instructions. " +
              content
            : "Speak now, naturally and briefly. No filler, and never mention these instructions. " + content,
        },
      });
      if (/interview is over/i.test(content)) this.endAfterNextReply = true;
      return;
    }
    // Background notes: added to the conversation without a spoken reply.
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text: content }] },
    });
  }

  async sendInterfaceEvent(event: Record<string, unknown>): Promise<void> {
    if (event.type === "response.create") this.request(event);
    else this.send(event);
  }

  async disconnect(reason = "ended"): Promise<void> {
    this.ended(reason);
  }

  // --- internals ------------------------------------------------------------

  private request(event: Record<string, unknown>): void {
    if (this.responding) this.queue.push(event);
    else {
      this.responding = true;
      this.lastRequest = event;
      this.send(event);
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  private onServerEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? "");
    switch (type) {
      case "response.created":
        this.responding = true;
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.emitInterface({ type: "session.output_transcript.delta", delta: event.delta });
        break;
      case "response.done": {
        this.responding = false;
        this.lastRequest = null;
        this.emitInterface({ type: "session.output_audio.done" });
        const next = this.queue.shift();
        if (next) this.request(next);
        else if (this.endAfterNextReply) {
          // Let the goodbye finish playing, then hang up.
          this.timers.push(setTimeout(() => void this.disconnect("closed"), 6_000));
        }
        break;
      }
      case "conversation.item.input_audio_transcription.delta":
        this.emitInterface({ type: "session.input_transcript.delta", delta: event.delta });
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.emitInterface({
          type: "session.input_transcript.done",
          event_id: event.item_id,
          transcript: event.transcript,
        });
        break;
      case "error": {
        const error = (event.error ?? {}) as Record<string, unknown>;
        if (String(error.code ?? "").includes("active_response")) {
          // Ours collided with one the model started itself: send ours again once that one ends.
          if (this.lastRequest) this.queue.unshift(this.lastRequest);
          this.lastRequest = null;
          this.responding = true;
          break;
        }
        this.emitInterface({ type: "error", error: { code: error.code ?? error.type ?? "unknown" } });
        if (this.lastRequest) {
          // Our request was refused: don't let the queue wait on it forever.
          this.lastRequest = null;
          this.responding = false;
          const next = this.queue.shift();
          if (next) this.request(next);
        }
        break;
      }
      default:
        break;
    }
  }

  private emitInterface(event: Record<string, unknown>): void {
    for (const listener of this.interfaceListeners) listener(event);
  }

  private emitChange(event: VoiceChange): void {
    for (const listener of this.changeListeners) listener(event);
  }

  private ended(reason: string): void {
    if (this.endedSent) return;
    this.endedSent = true;
    this.teardown();
    this.state = "ended";
    this.emitChange({ type: "session-ended", reason, endReason: reason });
  }

  private teardown(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.peer?.close();
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    if (this.audioElement) this.audioElement.srcObject = null;
  }
}
