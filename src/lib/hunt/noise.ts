export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms < 1e-8 ? -96 : 20 * Math.log10(rms);
}

export function noiseWord(aboveQuiet: number): string {
  if (aboveQuiet < 4) return "Still";
  if (aboveQuiet < 10) return "Soft";
  if (aboveQuiet < 18) return "Noticeable";
  if (aboveQuiet < 28) return "Loud";
  return "Too loud";
}
