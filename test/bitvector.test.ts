import { test } from "node:test";
import assert from "node:assert/strict";
import { BitVector, BvError } from "../src/bitvector";
import { naiveRank, naiveSelect } from "../src/naive";

function randBits(n: number, seed: number): string {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
  let out = "";
  for (let i = 0; i < n; i++) out += rnd() < 0.5 ? "0" : "1";
  return out;
}

function checkExhaustive(bits: string) {
  const bv = BitVector.fromBitsString(bits);
  for (const bit of [0, 1] as const) {
    for (let k = 0; k <= bits.length; k++) {
      assert.equal(bv.rank(bit, k), naiveRank(bits, bit, k), `rank(${bit},${k}) of ${bits.slice(0, 40)}`);
    }
    const total = naiveRank(bits, bit, bits.length);
    for (let j = 0; j < total; j++) {
      const pos = bv.select(bit, j);
      assert.equal(pos, naiveSelect(bits, bit, j), `select(${bit},${j})`);
      assert.equal(bv.rank(bit, pos + 1), j + 1, `rank(${bit}, select+1)`);
    }
    assert.equal(bv.select(bit, total), -1, "select beyond total must be -1");
  }
}

test("demo vector 101001", () => {
  const bv = BitVector.fromBitsString("101001");
  assert.equal(bv.rank(1, 4), 2);
  assert.equal(bv.rank(0, 4), 2);
  assert.equal(bv.select(1, 2), 5);
  assert.equal(bv.select(0, 0), 1);
});

test("empty vector", () => {
  const bv = BitVector.fromBitsString("");
  assert.equal(bv.rank(0, 0), 0);
  assert.equal(bv.rank(1, 0), 0);
  assert.equal(bv.select(0, 0), -1);
  assert.equal(bv.select(1, 0), -1);
});

test("all zeros / all ones / alternating", () => {
  checkExhaustive("0".repeat(300));
  checkExhaustive("1".repeat(300));
  checkExhaustive("10".repeat(150));
  checkExhaustive("01".repeat(130));
});

test("consecutive empty superblocks", () => {
  const bits = "1" + "0".repeat(256 * 3) + "1" + "0".repeat(256 * 2) + "1";
  const bv = BitVector.fromBitsString(bits);
  assert.equal(bv.select(1, 0), 0);
  assert.equal(bv.select(1, 1), 1 + 256 * 3);
  assert.equal(bv.select(1, 2), bits.length - 1);
  assert.equal(bv.select(1, 3), -1);
  assert.equal(bv.rank(1, bits.length), 3);
  assert.equal(bv.rank(0, bits.length), bits.length - 3);
  checkExhaustive("1" + "0".repeat(600) + "11");
});

test("cross 32-bit and 256-bit boundaries", () => {
  for (const n of [31, 32, 33, 63, 64, 65, 255, 256, 257, 511, 512, 513, 700]) {
    checkExhaustive(randBits(n, n * 2654435761));
  }
});

test("last incomplete word padding zeros are not counted", () => {
  const bv = BitVector.fromBitsString("1".repeat(40)); // 40 bits, 2 words, 24 padding bits
  assert.equal(bv.rank(0, 40), 0);
  assert.equal(bv.select(0, 0), -1);
  const bv2 = BitVector.fromBitsString("1".repeat(33));
  assert.equal(bv2.rank(0, 33), 0);
});

test("random short vectors exhaustive vs naive", () => {
  for (let seed = 1; seed <= 40; seed++) {
    checkExhaustive(randBits(seed * 7, seed));
  }
});

test("validation errors", () => {
  const bv = BitVector.fromBitsString("1010");
  assert.throws(() => bv.rank(2, 1), (e: BvError) => e.code === "INVALID_BIT");
  assert.throws(() => bv.rank(1, -1), (e: BvError) => e.code === "OUT_OF_RANGE");
  assert.throws(() => bv.rank(1, 5), (e: BvError) => e.code === "OUT_OF_RANGE");
  assert.throws(() => bv.rank(1, 1.5), (e: BvError) => e.code === "OUT_OF_RANGE");
  assert.throws(() => bv.select(1, -1), (e: BvError) => e.code === "INVALID_INDEX");
  assert.throws(() => bv.select(1, 0.5), (e: BvError) => e.code === "INVALID_INDEX");
  assert.throws(() => BitVector.fromBitsString("10201"), (e: BvError) => e.code === "INVALID_BITS");
});

test("explain fields for rank and select", () => {
  const bv = BitVector.fromBitsString(randBits(300, 42));
  const re = bv.rankExplain(1, 200);
  assert.equal(re.blockIndex, 0);
  assert.equal(re.wordIndexInBlock, 6);
  assert.equal(re.result, bv.rank(1, 200));
  assert.ok(re.maskHex.length === 8);
  const se = bv.selectExplain(1, 10);
  assert.equal(se.result, bv.select(1, 10));
  assert.ok(se.blockSearchSteps >= 0);
  const se0 = bv.selectExplain(0, 5);
  assert.equal(se0.result, bv.select(0, 5));
});

test("snapshot roundtrip and corruption", () => {
  const bits = randBits(100, 7);
  const bv = BitVector.fromBitsString(bits);
  const hex = bv.toHex();
  assert.equal(hex.length, Math.ceil(100 / 8) * 2);
  const bv2 = BitVector.fromHex(100, hex);
  assert.equal(bv2.toBitsString(), bits);
  assert.equal(bv2.rank(1, 100), bv.rank(1, 100));
  // wrong length
  assert.throws(() => BitVector.fromHex(100, hex + "00"), (e: BvError) => e.code === "CORRUPT_SNAPSHOT");
  // non-hex chars
  assert.throws(() => BitVector.fromHex(8, "zz"), (e: BvError) => e.code === "CORRUPT_SNAPSHOT");
  // padding bits set in last byte (length 4 -> high 4 bits must be 0)
  assert.throws(() => BitVector.fromHex(4, "f0"), (e: BvError) => e.code === "CORRUPT_SNAPSHOT");
  assert.equal(BitVector.fromHex(4, "0f").toBitsString(), "1111");
  // length 0 snapshot
  assert.equal(BitVector.fromHex(0, "").length, 0);
});

test("bit 0 and bit 31 of a word, MSB not negative", () => {
  const bv = BitVector.fromBitsString("1" + "0".repeat(30) + "1"); // bits 0 and 31
  assert.equal(bv.rank(1, 32), 2);
  assert.equal(bv.select(1, 1), 31);
  const w = bv.words[0];
  assert.equal(w >>> 0, 0x80000001);
});
