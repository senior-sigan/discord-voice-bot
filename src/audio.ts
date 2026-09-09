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
  let output = 0;
  for (const value of samples) {
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32_767);
    pcm.writeInt16LE(sample, output);
    pcm.writeInt16LE(sample, output + 2);
    output += 4;
  }
  return pcm;
}

export function pcm16MonoToFloat(pcm: Buffer): Float32Array {
  if (pcm.length % 2 !== 0) throw new Error(`invalid mono PCM size: ${pcm.length}`);
  const samples = new Float32Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = pcm.readInt16LE(index * 2) / 32_768;
  }
  return samples;
}

export function floatMonoToWav(samples: Float32Array, sampleRate: number): Buffer {
  const wav = Buffer.allocUnsafe(44 + samples.length * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2);
  }
  return wav;
}
