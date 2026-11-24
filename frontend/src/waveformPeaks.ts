export function peakMaximum(peaks: readonly number[] | null): number {
  let maximum = 0;
  for (const peak of peaks ?? []) {
    if (Number.isFinite(peak) && peak > maximum) maximum = peak;
  }
  return maximum || 1;
}

export function peakBins(
  peaks: readonly number[],
  count: number,
  start = 0,
  end = peaks.length,
): Float32Array {
  const bins = new Float32Array(Math.max(0, Math.floor(count)));
  if (bins.length === 0 || end <= start) return bins;
  const step = (end - start) / bins.length;
  for (let bin = 0; bin < bins.length; bin++) {
    const from = Math.max(0, Math.floor(start + bin * step));
    const to = Math.min(peaks.length, Math.ceil(start + (bin + 1) * step));
    let maximum = 0;
    for (let i = from; i < to; i++) {
      const peak = peaks[i];
      if (Number.isFinite(peak) && peak > maximum) maximum = peak;
    }
    bins[bin] = maximum;
  }
  return bins;
}
