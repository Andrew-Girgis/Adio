interface StreamMetric {
  sessionId: string;
  streamId: string;
  provider: string;
  startedAt: string;
  timeToFirstAudioMs?: number;
  approxCharsPerSecond?: number;
  status: "active" | "completed" | "stopped" | "error";
}

interface TtsErrorMetric {
  at: string;
  sessionId: string;
  provider: string;
  code: string;
  retryable: boolean;
  fallbackUsed: boolean;
  message: string;
}

interface SttStreamMetrics {
  timeToFirstTranscriptMs: number | null;
  partialCadenceMs: number | null;
  finalizationLatencyMs: number | null;
  partialCount: number;
}

interface SttStreamMetric {
  sessionId: string;
  streamId: string;
  provider: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "stopped" | "error";
  metrics: SttStreamMetrics;
}

export class MetricsStore {
  private readonly launchedAt = new Date().toISOString();
  private activeSessions = 0;
  private totalSessions = 0;
  private totalStreams = 0;
  private totalSttStreams = 0;
  private ttsAttemptCount = 0;
  private ttsFallbackCount = 0;
  private ttsDecodeFailCount = 0;
  private ttsStreamTimeoutCount = 0;
  private ttsErrors = 0;
  private sttErrors = 0;
  private readonly ttfaSamples: number[] = [];
  private readonly ttftSamples: number[] = [];
  private readonly streamMetrics = new Map<string, StreamMetric>();
  private readonly sttStreamMetrics = new Map<string, SttStreamMetric>();
  private readonly lastTtsErrorBySession = new Map<string, TtsErrorMetric>();
  private readonly lastVoicePathBySession = new Map<string, string>();

  onSessionStart(): void {
    this.activeSessions += 1;
    this.totalSessions += 1;
  }

  onSessionEnd(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }

  onStreamStart(streamId: string, sessionId: string, provider: string): void {
    this.totalStreams += 1;
    this.streamMetrics.set(streamId, {
      streamId,
      sessionId,
      provider,
      startedAt: new Date().toISOString(),
      status: "active"
    });
  }

  onFirstAudio(streamId: string, timeToFirstAudioMs: number): void {
    this.ttfaSamples.push(timeToFirstAudioMs);
    if (this.ttfaSamples.length > 200) {
      this.ttfaSamples.shift();
    }

    const current = this.streamMetrics.get(streamId);
    if (!current) {
      return;
    }

    current.timeToFirstAudioMs = timeToFirstAudioMs;
    this.streamMetrics.set(streamId, current);
  }

  onStreamEnd(streamId: string, status: StreamMetric["status"], approxCharsPerSecond?: number): void {
    const current = this.streamMetrics.get(streamId);
    if (!current) {
      return;
    }

    current.status = status;
    current.approxCharsPerSecond = approxCharsPerSecond;
    this.streamMetrics.set(streamId, current);
  }

  onSttStreamStart(streamId: string, sessionId: string, provider: string): void {
    this.totalSttStreams += 1;
    this.sttStreamMetrics.set(streamId, {
      sessionId,
      streamId,
      provider,
      startedAt: new Date().toISOString(),
      status: "active",
      metrics: {
        timeToFirstTranscriptMs: null,
        partialCadenceMs: null,
        finalizationLatencyMs: null,
        partialCount: 0
      }
    });
  }

  onFirstTranscript(streamId: string, timeToFirstTranscriptMs: number): void {
    this.ttftSamples.push(timeToFirstTranscriptMs);
    if (this.ttftSamples.length > 200) {
      this.ttftSamples.shift();
    }

    const current = this.sttStreamMetrics.get(streamId);
    if (!current) {
      return;
    }

    current.metrics.timeToFirstTranscriptMs = timeToFirstTranscriptMs;
    this.sttStreamMetrics.set(streamId, current);
  }

  onSttStreamEnd(
    streamId: string,
    status: Exclude<SttStreamMetric["status"], "active">,
    metrics: SttStreamMetrics
  ): void {
    const current = this.sttStreamMetrics.get(streamId);
    if (!current) {
      return;
    }

    current.status = status;
    current.endedAt = new Date().toISOString();
    current.metrics = metrics;
    this.sttStreamMetrics.set(streamId, current);

    if (status === "error") {
      this.sttErrors += 1;
    }
  }

  onTtsAttempt(): void {
    this.ttsAttemptCount += 1;
  }

  onTtsFallback(): void {
    this.ttsFallbackCount += 1;
  }

  onTtsDecodeFail(): void {
    this.ttsDecodeFailCount += 1;
  }

  onTtsStreamTimeout(): void {
    this.ttsStreamTimeoutCount += 1;
  }

  onTtsError(error: Omit<TtsErrorMetric, "at">): void {
    this.ttsErrors += 1;
    this.lastTtsErrorBySession.set(error.sessionId, {
      ...error,
      at: new Date().toISOString()
    });
  }

  onVoicePath(sessionId: string, path: string): void {
    this.lastVoicePathBySession.set(sessionId, path);
  }

  snapshot(debugSessions: Array<{ sessionId: string; stepIndex: number; status: string; phase: string }>) {
    const avgTtfaMs =
      this.ttfaSamples.length === 0
        ? null
        : Math.round(this.ttfaSamples.reduce((sum, value) => sum + value, 0) / this.ttfaSamples.length);

    const avgTtftMs =
      this.ttftSamples.length === 0
        ? null
        : Math.round(this.ttftSamples.reduce((sum, value) => sum + value, 0) / this.ttftSamples.length);

    const recentStreams = [...this.streamMetrics.values()].slice(-20);
    const recentSttStreams = [...this.sttStreamMetrics.values()].slice(-20);
    const sessions = debugSessions.map((session) => ({
      ...session,
      lastTtsError: this.lastTtsErrorBySession.get(session.sessionId) ?? null,
      lastVoicePath: this.lastVoicePathBySession.get(session.sessionId) ?? null
    }));

    return {
      launchedAt: this.launchedAt,
      activeSessions: this.activeSessions,
      totalSessions: this.totalSessions,
      totalStreams: this.totalStreams,
      totalSttStreams: this.totalSttStreams,
      ttsAttemptCount: this.ttsAttemptCount,
      ttsFallbackCount: this.ttsFallbackCount,
      ttsDecodeFailCount: this.ttsDecodeFailCount,
      ttsStreamTimeoutCount: this.ttsStreamTimeoutCount,
      ttsErrors: this.ttsErrors,
      sttErrors: this.sttErrors,
      avgTtfaMs,
      avgTtftMs,
      recentStreams,
      recentSttStreams,
      sessions
    };
  }
}
