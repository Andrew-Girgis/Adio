function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

export function createToneWavBase64({
  durationSec,
  frequencyHz,
  sampleRate,
  gain = 0.18
}: {
  durationSec: number;
  frequencyHz: number;
  sampleRate: number;
  gain?: number;
}): string {
  const sampleCount = Math.max(1, Math.floor(durationSec * sampleRate));
  const pcm = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / (sampleRate * 0.01), (sampleCount - i) / (sampleRate * 0.02));
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * gain * envelope;
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }

  const dataSize = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(44 + i * 2, pcm[i], true);
  }

  return Buffer.from(buffer).toString("base64");
}
