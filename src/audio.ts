export function stereoPcmToMono(pcm: Buffer): Float32Array {
  if (pcm.length % 4 !== 0) throw new Error(`invalid stereo PCM size: ${pcm.length}`);
  const samples = new Float32Array(pcm.length / 4);
  for (let input = 0, output = 0; input < pcm.length; input += 4, output++) {
    samples[output] = (pcm.readInt16LE(input) + pcm.readInt16LE(input + 2)) / 65_536;
  }
  return samples;
}

export function floatMonoToStereoPcm(samples: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * 4);
  for (let input = 0, output = 0; input < samples.length; input++, output += 4) {
    const sample = Math.round(Math.max(-1, Math.min(1, samples[input]!)) * 32_767);
    pcm.writeInt16LE(sample, output);
    pcm.writeInt16LE(sample, output + 2);
  }
  return pcm;
}

export function pcm16MonoWavToFloat(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("invalid WAV header");
  }

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataOffset: number | undefined;
  let dataSize: number | undefined;

  for (let offset = 12; offset + 8 <= wav.length; ) {
    const chunk = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new Error(`truncated WAV ${chunk} chunk`);

    if (chunk === "fmt ") {
      if (size < 16) throw new Error("invalid WAV fmt chunk");
      audioFormat = wav.readUInt16LE(start);
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bitsPerSample = wav.readUInt16LE(start + 14);
    } else if (chunk === "data") {
      dataOffset = start;
      dataSize = size;
    }
    offset = end + (size % 2);
  }

  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate) {
    throw new Error("Qwen TTS must return mono 16-bit PCM WAV audio");
  }
  if (dataOffset === undefined || dataSize === undefined || dataSize % 2 !== 0) {
    throw new Error("invalid WAV data chunk");
  }

  const samples = new Float32Array(dataSize / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = wav.readInt16LE(dataOffset + index * 2) / 32_768;
  }
  return { samples, sampleRate };
}
