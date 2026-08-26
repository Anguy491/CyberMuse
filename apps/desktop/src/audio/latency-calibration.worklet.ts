declare const currentFrame: number;
declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: readonly (readonly Float32Array[])[]): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class CyberMuseLatencyEnvelopeProcessor extends AudioWorkletProcessor {
  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    const channel = inputs[0]?.[0];
    if (channel === undefined || channel.length === 0) return true;
    let peak = 0;
    let energy = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = channel[index] ?? 0;
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      energy += sample * sample;
    }
    this.port.postMessage({
      type: "envelope",
      contextTimeMs: (currentFrame * 1_000) / sampleRate,
      peak,
      rms: Math.sqrt(energy / channel.length),
    });
    return true;
  }
}

registerProcessor(
  "cybermuse-latency-envelope",
  CyberMuseLatencyEnvelopeProcessor,
);
