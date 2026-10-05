/** Independent bit-by-bit scan baseline used ONLY by tests to cross-check the index. */
export function naiveRank(bits: string, bit: 0 | 1, k: number): number {
  let c = 0;
  for (let i = 0; i < k; i++) if (bits[i] === String(bit)) c++;
  return c;
}

export function naiveSelect(bits: string, bit: 0 | 1, j: number): number {
  let c = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === String(bit)) {
      if (c === j) return i;
      c++;
    }
  }
  return -1;
}
