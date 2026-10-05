export const WORD_BITS = 32;
export const WORDS_PER_BLOCK = 8; // 256 bits per superblock
export const BLOCK_BITS = WORD_BITS * WORDS_PER_BLOCK;
export const INDEX_VERSION = 1;
export const MAX_EXPLAIN_STEPS = 64;

export type Bit = 0 | 1;

export class BvError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "BvError";
  }
}

export function popcount32(x: number): number {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

export interface RankExplain {
  bit: Bit;
  k: number;
  blockIndex: number;
  blockBase: number;
  wordIndexInBlock: number;
  globalWordIndex: number;
  localBefore: number;
  wordValueHex: string;
  maskHex: string;
  maskedBits: number;
  result: number;
}

export interface SelectExplain {
  bit: Bit;
  j: number;
  blockSearchSteps: number;
  blockIndex: number;
  blockBase: number;
  remaining: number;
  wordIndexInBlock: number;
  globalWordIndex: number;
  wordValueHex: string;
  effectiveWordHex: string;
  bitInWord: number;
  result: number;
  truncated: boolean;
}

export class BitVector {
  readonly length: number;
  readonly words: Uint32Array;
  readonly numBlocks: number;
  /** ones before each superblock, plus a sentinel total at the end */
  private readonly blockSums: Uint32Array;
  /** local ones before each word within its superblock */
  private readonly wordSums: Uint32Array;

  private constructor(length: number, words: Uint32Array, blockSums: Uint32Array, wordSums: Uint32Array) {
    this.length = length;
    this.words = words;
    this.numBlocks = Math.max(1, Math.ceil(length / BLOCK_BITS));
    this.blockSums = blockSums;
    this.wordSums = wordSums;
  }

  static fromBitsString(bits: string): BitVector {
    if (!/^[01]*$/.test(bits)) throw new BvError("INVALID_BITS", "bit string must contain only 0/1");
    const n = bits.length;
    const words = new Uint32Array(Math.ceil(n / WORD_BITS));
    for (let i = 0; i < n; i++) {
      if (bits.charCodeAt(i) === 49) words[i >>> 5] |= 1 << (i & 31);
    }
    return BitVector.fromWords(n, words);
  }

  /** Rebuild the index from raw words; never trusts external cumulative data. */
  static fromWords(length: number, words: Uint32Array): BitVector {
    if (!Number.isInteger(length) || length < 0) throw new BvError("INVALID_LENGTH", "length must be a non-negative integer");
    const needWords = Math.ceil(length / WORD_BITS);
    if (words.length !== needWords) throw new BvError("INVALID_LENGTH", `expected ${needWords} words, got ${words.length}`);
    // zero out padding bits beyond length in the last word
    const rem = length & 31;
    if (rem !== 0 && needWords > 0) words[needWords - 1] &= (1 << rem) - 1;
    const numBlocks = Math.max(1, Math.ceil(length / BLOCK_BITS));
    const blockSums = new Uint32Array(numBlocks + 1);
    const wordSums = new Uint32Array(numBlocks * WORDS_PER_BLOCK);
    let acc = 0;
    for (let b = 0; b < numBlocks; b++) {
      blockSums[b] = acc;
      let local = 0;
      for (let w = 0; w < WORDS_PER_BLOCK; w++) {
        const gi = b * WORDS_PER_BLOCK + w;
        wordSums[gi] = local;
        if (gi < words.length) local += popcount32(words[gi]);
      }
      acc += local;
    }
    blockSums[numBlocks] = acc;
    return new BitVector(length, words, blockSums, wordSums);
  }

  static fromHex(length: number, hex: string): BitVector {
    if (!Number.isInteger(length) || length < 0) throw new BvError("INVALID_LENGTH", "length must be a non-negative integer");
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new BvError("CORRUPT_SNAPSHOT", "hex contains non-hex characters");
    const expectBytes = Math.ceil(length / 8);
    if (hex.length !== expectBytes * 2) {
      throw new BvError("CORRUPT_SNAPSHOT", `hex length ${hex.length} does not match ${expectBytes} bytes for length ${length}`);
    }
    // padding bits of the last byte must be zero
    const usedBits = length & 7;
    if (usedBits !== 0) {
      const lastByte = parseInt(hex.slice(-2), 16);
      if ((lastByte & (0xff << usedBits)) !== 0) {
        throw new BvError("CORRUPT_SNAPSHOT", "padding bits in last byte are not zero");
      }
    }
    const words = new Uint32Array(Math.ceil(length / WORD_BITS));
    for (let i = 0; i < words.length; i++) {
      let v = 0;
      for (let b = 0; b < 4; b++) {
        const off = (i * 4 + b) * 2;
        if (off + 2 <= hex.length) v |= parseInt(hex.slice(off, off + 2), 16) << (8 * b);
      }
      words[i] = v >>> 0;
    }
    return BitVector.fromWords(length, words);
  }

  toHex(): string {
    const bytes = Math.ceil(this.length / 8);
    let out = "";
    for (let i = 0; i < bytes; i++) {
      const b = (this.words[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
      out += b.toString(16).padStart(2, "0");
    }
    return out;
  }

  toBitsString(): string {
    let s = "";
    for (let i = 0; i < this.length; i++) s += this.getBit(i) ? "1" : "0";
    return s;
  }

  getBit(i: number): Bit {
    return ((this.words[i >>> 5] >>> (i & 31)) & 1) as Bit;
  }

  totalOnes(): number {
    return this.blockSums[this.numBlocks];
  }

  private checkK(k: number): void {
    if (!Number.isInteger(k) || k < 0 || k > this.length) {
      throw new BvError("OUT_OF_RANGE", `k must be an integer in [0, ${this.length}], got ${k}`);
    }
  }

  private checkJ(j: number): void {
    if (!Number.isInteger(j) || j < 0) {
      throw new BvError("INVALID_INDEX", `j must be a non-negative integer, got ${j}`);
    }
  }

  private checkBit(bit: number): Bit {
    if (bit !== 0 && bit !== 1) throw new BvError("INVALID_BIT", `bit must be 0 or 1, got ${bit}`);
    return bit;
  }

  rank(bit: number, k: number): number {
    return this.rankExplain(bit, k).result;
  }

  rankExplain(bit: number, k: number): RankExplain {
    const b = this.checkBit(bit);
    this.checkK(k);
    if (b === 0) {
      const e = this.rankExplain(1, k);
      return { ...e, bit: 0, result: k - e.result };
    }
    const blockIndex = k >>> 8;
    const rem = k & 255;
    const wib = rem >>> 5;
    const bits = rem & 31;
    const gi = blockIndex * WORDS_PER_BLOCK + wib;
    const mask = bits === 0 ? 0 : (1 << bits) - 1;
    const word = gi < this.words.length ? this.words[gi] : 0;
    const masked = popcount32(word & mask);
    const localBefore = gi < this.wordSums.length ? this.wordSums[gi] : 0;
    const result = this.blockSums[blockIndex] + localBefore + masked;
    return {
      bit: 1, k, blockIndex, blockBase: this.blockSums[blockIndex],
      wordIndexInBlock: wib, globalWordIndex: gi, localBefore,
      wordValueHex: (word >>> 0).toString(16).padStart(8, "0"),
      maskHex: (mask >>> 0).toString(16).padStart(8, "0"),
      maskedBits: masked, result,
    };
  }

  /** Returns index of j-th occurrence (0-based), or -1 when absent. */
  select(bit: number, j: number): number {
    return this.selectExplain(bit, j).result;
  }

  selectExplain(bit: number, j: number): SelectExplain {
    const b = this.checkBit(bit);
    this.checkJ(j);
    const total = b === 1 ? this.totalOnes() : this.length - this.totalOnes();
    if (j >= total) {
      return {
        bit: b, j, blockSearchSteps: 0, blockIndex: -1, blockBase: 0, remaining: j,
        wordIndexInBlock: -1, globalWordIndex: -1, wordValueHex: "", effectiveWordHex: "",
        bitInWord: -1, result: -1, truncated: false,
      };
    }
    // binary search: last block with cumulative count of target bit <= j
    let lo = 0, hi = this.numBlocks, steps = 0;
    const countBefore = (blk: number): number =>
      b === 1 ? this.blockSums[blk] : blk * BLOCK_BITS - this.blockSums[blk];
    while (lo + 1 < hi) {
      steps++;
      const mid = (lo + hi) >>> 1;
      if (countBefore(mid) <= j) lo = mid; else hi = mid;
    }
    const blockIndex = lo;
    const base = countBefore(blockIndex);
    let remaining = j - base;
    // scan words inside the block
    const blockStartBit = blockIndex * BLOCK_BITS;
    const validInBlock = Math.min(BLOCK_BITS, this.length - blockStartBit);
    let wordScans = 0;
    for (let w = 0; w < WORDS_PER_BLOCK; w++) {
      wordScans++;
      const gi = blockIndex * WORDS_PER_BLOCK + w;
      const wordStartBit = w * WORD_BITS;
      if (wordStartBit >= validInBlock) break;
      const validBits = Math.min(WORD_BITS, validInBlock - wordStartBit);
      const rawWord = gi < this.words.length ? this.words[gi] : 0;
      // bits beyond valid length are forced to 1 so they never count as zeros
      const effWord = validBits === 32 ? rawWord >>> 0 : (rawWord | ~((1 << validBits) - 1)) >>> 0;
      const cnt = b === 1 ? popcount32(rawWord) : 32 - popcount32(effWord);
      if (remaining < cnt) {
        const target = b === 1 ? rawWord : ~effWord;
        let t = target >>> 0;
        let pos = -1;
        for (let r = -1; r < remaining; r++) {
          const lowU = (t & (~t + 1)) >>> 0;
          pos = 31 - Math.clz32(lowU);
          t = (t & (t - 1)) >>> 0;
        }
        const bitInWord = pos;
        return {
          bit: b, j, blockSearchSteps: steps, blockIndex, blockBase: base, remaining,
          wordIndexInBlock: w, globalWordIndex: gi,
          wordValueHex: (rawWord >>> 0).toString(16).padStart(8, "0"),
          effectiveWordHex: (effWord >>> 0).toString(16).padStart(8, "0"),
          bitInWord, result: blockStartBit + wordStartBit + bitInWord,
          truncated: false,
        };
      }
      remaining -= cnt;
    }
    // unreachable if index is consistent
    throw new BvError("INTERNAL", "select failed to locate bit inside block");
  }

  blockStats() {
    const stats: { block: number; onesBefore: number; onesInBlock: number; validBits: number }[] = [];
    for (let b = 0; b < this.numBlocks; b++) {
      const valid = Math.max(0, Math.min(BLOCK_BITS, this.length - b * BLOCK_BITS));
      stats.push({
        block: b,
        onesBefore: this.blockSums[b],
        onesInBlock: this.blockSums[b + 1] - this.blockSums[b],
        validBits: valid,
      });
    }
    return {
      length: this.length,
      numWords: this.words.length,
      numBlocks: this.numBlocks,
      totalOnes: this.totalOnes(),
      totalZeros: this.length - this.totalOnes(),
      indexVersion: INDEX_VERSION,
      indexBytes: this.blockSums.byteLength + this.wordSums.byteLength + this.words.byteLength,
      blocks: stats,
    };
  }
}
