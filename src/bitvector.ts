/** 分块位向量 rank/select 索引。
 *
 * 位序约定（必须明确）：
 *  - 逻辑位 i（0 起）存放在第 floor(i/32) 个 32 位字中；
 *  - 字内采用“低位在前”：位 i 对应字内比特 (i % 32)，即第 0 位是字的最低位。
 *  - 快照字节序同理：字节 b 覆盖位 [8b, 8b+8)，位 i 在字节内比特 (i % 8)（LSB-first）。
 *  - 所有计数使用无符号语义（>>> 0），最高位永不当作负数。
 *
 * 索引结构：
 *  - 每 32 位一个字，每 256 位（8 个字）一个大块（superblock）。
 *  - superOnes[s]  = 大块 s 之前（不含）的 1 的总数（前缀累计）。
 *  - superZeros[s] = 大块 s 之前的 0 的总数（由有效长度推导，不含填充位）。
 *  - wordOnes[t]   = 字 t 在其所属大块内、该字之前的局部 1 计数（0..224 步进）。
 */
export const WORD_BITS = 32;
export const SUPER_BITS = 256;
export const WORDS_PER_SUPER = SUPER_BITS / WORD_BITS; // 8
export const INDEX_VERSION = 1;

export type Bit = 0 | 1;

export class BitVectorError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "BitVectorError";
  }
}

export function popcount32(x: number): number {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) >>> 0;
}

/** 低 n 位掩码，n 取值 [0,32]，避免 1<<32 回绕与符号位问题。 */
export function lowMask(n: number): number {
  if (n <= 0) return 0;
  if (n >= 32) return 0xffffffff;
  return (0xffffffff >>> (32 - n)) >>> 0;
}

export interface RankExplain {
  op: "rank";
  bit: Bit;
  k: number;
  superblock: number;
  superCumulativeOnes: number;
  wordInSuperblock: number;
  wordIndex: number;
  wordLocalOnes: number;
  wordHex: string;
  maskHex: string;
  maskedPopcount: number;
  onesTotal: number;
  result: number;
}

export interface SelectExplain {
  op: "select";
  bit: Bit;
  j: number;
  superblock: number;
  cumulativeBefore: number;
  remaining: number;
  wordIndex: number;
  wordInSuperblock: number;
  wordHex: string;
  validBitsInWord: number;
  bitOffsetInWord: number;
  result: number | null;
  notFound?: boolean;
}

export class BitVector {
  readonly length: number;
  private readonly words: Uint32Array;
  private readonly superOnes: Uint32Array; // 长度 numSupers（每块之前累计）
  private readonly superZeros: Uint32Array;
  private readonly wordOnes: Uint32Array; // 每字在大块内的局部累计
  readonly totalOnes: number;
  readonly totalZeros: number;

  private constructor(length: number, words: Uint32Array) {
    this.length = length;
    this.words = words;
    const numWords = Math.ceil(length / WORD_BITS);
    const numSupers = Math.ceil(length / SUPER_BITS);
    this.superOnes = new Uint32Array(numSupers);
    this.superZeros = new Uint32Array(numSupers);
    this.wordOnes = new Uint32Array(numWords);
    let ones = 0;
    for (let s = 0; s < numSupers; s++) {
      this.superOnes[s] = ones;
      const validBefore = Math.min(s * SUPER_BITS, length);
      this.superZeros[s] = validBefore - ones;
      let local = 0;
      for (let w = 0; w < WORDS_PER_SUPER; w++) {
        const t = s * WORDS_PER_SUPER + w;
        if (t >= numWords) break;
        this.wordOnes[t] = local;
        local += popcount32(this.words[t]);
      }
      ones += local;
    }
    this.totalOnes = ones;
    this.totalZeros = length - ones;
  }

  /** 从 01 文本构建。 */
  static fromBits(bits: string): BitVector {
    if (!/^[01]*$/.test(bits)) {
      throw new BitVectorError("INVALID_BITS", "位串只能包含字符 0 和 1");
    }
    const n = bits.length;
    const words = new Uint32Array(Math.ceil(n / WORD_BITS));
    for (let i = 0; i < n; i++) {
      if (bits.charCodeAt(i) === 49) {
        words[i >>> 5] = (words[i >>> 5] | (1 << (i & 31))) >>> 0;
      }
    }
    return new BitVector(n, words);
  }

  /** 从原始字节 + 有效长度构建（导入快照用，不信任外部索引，重新建累计）。 */
  static fromBytes(data: Buffer, length: number): BitVector {
    if (!Number.isInteger(length) || length < 0) {
      throw new BitVectorError("INVALID_LENGTH", "有效长度必须是非负整数");
    }
    const needBytes = Math.ceil(length / 8);
    if (data.length !== needBytes) {
      throw new BitVectorError(
        "LENGTH_MISMATCH",
        `字节数 ${data.length} 与有效长度 ${length} 不符（应为 ${needBytes}）`
      );
    }
    if (length % 8 !== 0 && data.length > 0) {
      const pad = 8 - (length % 8);
      const last = data[data.length - 1];
      if ((last & (0xff << (8 - pad))) !== 0) {
        throw new BitVectorError("PADDING_NOT_ZERO", "末字节填充位必须为 0");
      }
    }
    const numWords = Math.ceil(length / WORD_BITS);
    const words = new Uint32Array(numWords);
    for (let t = 0; t < numWords; t++) {
      let v = 0;
      for (let b = 0; b < 4; b++) {
        const idx = t * 4 + b;
        if (idx < data.length) v |= data[idx] << (8 * b);
      }
      words[t] = v >>> 0;
    }
    // 屏蔽最后一个字的填充位，防止脏数据进入索引
    if (length % WORD_BITS !== 0 && numWords > 0) {
      words[numWords - 1] &= lowMask(length % WORD_BITS);
    }
    return new BitVector(length, words);
  }

  /** 导出为字节（LSB-first，末字节高位补 0）。 */
  toBytes(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.length / 8));
    for (let i = 0; i < this.length; i++) {
      if (this.getBit(i) === 1) out[i >>> 3] |= 1 << (i & 7);
    }
    return out;
  }

  toBits(): string {
    let s = "";
    for (let i = 0; i < this.length; i++) s += this.getBit(i);
    return s;
  }

  getBit(i: number): Bit {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) {
      throw new BitVectorError("OUT_OF_RANGE", `下标 ${i} 超出 [0, ${this.length})`);
    }
    return ((this.words[i >>> 5] >>> (i & 31)) & 1) as Bit;
  }

  private validateBit(b: number): Bit {
    if (b !== 0 && b !== 1) {
      throw new BitVectorError("INVALID_BIT", "位值必须是 0 或 1");
    }
    return b as Bit;
  }

  private validateK(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k > this.length) {
      throw new BitVectorError(
        "INVALID_K",
        `k 必须是 [0, ${this.length}] 内的整数，收到 ${k}`
      );
    }
    return k;
  }

  private validateJ(j: number): number {
    if (!Number.isInteger(j) || j < 0) {
      throw new BitVectorError("INVALID_J", `j 必须是非负整数，收到 ${j}`);
    }
    return j;
  }

  /** rank(b, k)：前 k 位（[0,k)）中 b 的个数。 */
  rank(b: number, k: number): number {
    return this.rankDetailed(b, k).result;
  }

  rankDetailed(b: number, k: number): { result: number; explain: RankExplain } {
    const bit = this.validateBit(b);
    this.validateK(k);
    const s = k >>> 8; // 所在大块（k==N 且 N 对齐时指向下一块起点，按边界处理）
    const wInSuper = (k >>> 5) & (WORDS_PER_SUPER - 1);
    const off = k & 31;
    const numSupers = this.superOnes.length;
    // 边界：k 落在大块边界（含 k=N）时，直接使用前一块的累计。
    let superIdx: number, superCum: number, wordIdx: number, wordLocal: number,
      wordHex: string, maskHex: string, maskedPop: number, ones: number;
    if (off === 0 && wInSuper === 0) {
      // k 是大块边界：ones = 大块 s 之前的累计（s 可能等于 numSupers，即末尾）
      superIdx = Math.min(s, Math.max(numSupers - 1, 0));
      if (s >= numSupers) {
        ones = this.totalOnes;
        superCum = this.totalOnes;
      } else {
        ones = this.superOnes[s];
        superCum = this.superOnes[s];
      }
      wordIdx = s * WORDS_PER_SUPER;
      wordLocal = 0;
      wordHex = "0x00000000";
      maskHex = "0x00000000";
      maskedPop = 0;
    } else {
      superIdx = s;
      superCum = this.superOnes[s];
      wordIdx = s * WORDS_PER_SUPER + wInSuper;
      if (wordIdx >= this.words.length) {
        // k == N 且 N 恰好是字边界（非大块边界）：字局部累计取大块总计
        const blockEnd = s + 1 < numSupers ? this.superOnes[s + 1] : this.totalOnes;
        wordLocal = blockEnd - superCum;
        wordHex = "0x00000000";
        maskHex = "0x00000000";
        maskedPop = 0;
      } else {
        wordLocal = this.wordOnes[wordIdx];
        const word = this.words[wordIdx] >>> 0;
        const mask = lowMask(off);
        maskedPop = popcount32(word & mask);
        wordHex = "0x" + word.toString(16).padStart(8, "0");
        maskHex = "0x" + mask.toString(16).padStart(8, "0");
      }
      ones = superCum + wordLocal + maskedPop;
    }
    const result = bit === 1 ? ones : k - ones;
    return {
      result,
      explain: {
        op: "rank", bit, k, superblock: superIdx, superCumulativeOnes: superCum,
        wordInSuperblock: wInSuper, wordIndex: wordIdx, wordLocalOnes: wordLocal,
        wordHex, maskHex, maskedPopcount: maskedPop, onesTotal: ones, result,
      },
    };
  }

  /** select(b, j)：第 j 次（0 起）出现的位置；不存在返回 null。 */
  select(b: number, j: number): number | null {
    return this.selectDetailed(b, j).result;
  }

  selectDetailed(b: number, j: number): { result: number | null; explain: SelectExplain } {
    const bit = this.validateBit(b);
    this.validateJ(j);
    const total = bit === 1 ? this.totalOnes : this.totalZeros;
    const numSupers = this.superOnes.length;
    const baseExplain: SelectExplain = {
      op: "select", bit, j, superblock: -1, cumulativeBefore: 0, remaining: j,
      wordIndex: -1, wordInSuperblock: -1, wordHex: "", validBitsInWord: 0,
      bitOffsetInWord: -1, result: null,
    };
    if (j >= total || numSupers === 0) {
      return { result: null, explain: { ...baseExplain, notFound: true } };
    }
    const cum = bit === 1 ? this.superOnes : this.superZeros;
    // 二分：找最后一个 cum[s] <= j 的大块。累计值相等（空块）时取最右，保证正确定位。
    let lo = 0, hi = numSupers - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (cum[mid] <= j) lo = mid; else hi = mid - 1;
    }
    const s = lo;
    const before = cum[s];
    let remaining = j - before;
    for (let w = 0; w < WORDS_PER_SUPER; w++) {
      const t = s * WORDS_PER_SUPER + w;
      if (t >= this.words.length) break;
      const wordStart = t * WORD_BITS;
      if (wordStart >= this.length) break;
      const valid = Math.min(WORD_BITS, this.length - wordStart);
      const word = (this.words[t] & lowMask(valid)) >>> 0;
      const cnt = bit === 1 ? popcount32(word) : valid - popcount32(word);
      if (remaining < cnt) {
        // 在该字内逐位定位
        for (let o = 0; o < valid; o++) {
          const v = ((word >>> o) & 1) as Bit;
          if (v === bit) {
            if (remaining === 0) {
              const pos = wordStart + o;
              return {
                result: pos,
                explain: {
                  ...baseExplain, superblock: s, cumulativeBefore: before,
                  remaining: j - before, wordIndex: t, wordInSuperblock: w,
                  wordHex: "0x" + word.toString(16).padStart(8, "0"),
                  validBitsInWord: valid, bitOffsetInWord: o, result: pos,
                },
              };
            }
            remaining--;
          }
        }
        throw new BitVectorError("INDEX_CORRUPT", "索引内部不一致");
      }
      remaining -= cnt;
    }
    // 理论上不会到达（j < total 已校验）
    throw new BitVectorError("INDEX_CORRUPT", "索引内部不一致");
  }

  /** 块统计信息。 */
  stats() {
    const numSupers = this.superOnes.length;
    const blocks: { superblock: number; onesBefore: number; zerosBefore: number; onesInBlock: number }[] = [];
    for (let s = 0; s < numSupers; s++) {
      const end = s + 1 < numSupers ? this.superOnes[s + 1] : this.totalOnes;
      blocks.push({
        superblock: s,
        onesBefore: this.superOnes[s],
        zerosBefore: this.superZeros[s],
        onesInBlock: end - this.superOnes[s],
      });
    }
    return {
      length: this.length,
      totalOnes: this.totalOnes,
      totalZeros: this.totalZeros,
      wordBits: WORD_BITS,
      superBits: SUPER_BITS,
      numWords: this.words.length,
      numSuperblocks: numSupers,
      indexBytes:
        this.superOnes.byteLength + this.superZeros.byteLength +
        this.wordOnes.byteLength + this.words.byteLength,
      blocks,
    };
  }
}

/** 独立基准：逐位扫描，不经过索引。仅用于测试核对。 */
export function scanRank(bits: string, b: Bit, k: number): number {
  let c = 0;
  for (let i = 0; i < k; i++) if (bits[i] === String(b)) c++;
  return c;
}

export function scanSelect(bits: string, b: Bit, j: number): number | null {
  let c = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === String(b)) {
      if (c === j) return i;
      c++;
    }
  }
  return null;
}
