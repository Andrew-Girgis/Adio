interface StreamMetric {
  sessionId: string;
  streamId: string;
  provider: string;
  startedAt: string;
  timeToFirstAudioMs?: number;
  approxCharsPerSecond?: number;
  status: "active" | "completed" | "stopped" | "error";
}

export class MetricsStore {
  private readonly launchedAt = new Date().toISOString();
  private activeSessions = 0;
  private totalSessions = 0;
  private totalStreams = 0;
  private ttsErrors = 0;
  private readonly ttfaSamples: number[] = [];
  private readonly streamMetrics = new Map<string, StreamMetric>();

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

  onTtsError(): void {
    this.ttsErrors += 1;
  }

  snapshot(debugSessions: Array<{ sessionId: string; stepIndex: number; status: string }>) {
    const avgTtfaMs =
      this.ttfaSamples.length === 0
        ? null
        : Math.round(this.ttfaSamples.reduce((sum, value) => sum + value, 0) / this.ttfaSamples.length);

    const recentStreams = [...this.streamMetrics.values()].slice(-20);

    return {
      launchedAt: this.launchedAt,
      activeSessions: this.activeSessions,
      totalSessions: this.totalSessions,
      totalStreams: this.totalStreams,
      ttsErrors: this.ttsErrors,
      avgTtfaMs,
      recentStreams,
      sessions: debugSessions
    };
  }
}
