import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BitVector, BitVectorError, scanRank, scanSelect, popcount32, lowMask,
} from "../src/bitvector";
import { Store, exportSnapshot, importSnapshot } from "../src/store";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("演示用例 101001", () => {
  const bv = BitVector.fromBits("101001");
  assert.equal(bv.rank(1, 4), 2);
  assert.equal(bv.rank(0, 4), 2);
  assert.equal(bv.select(1, 2), 5);
  assert.equal(bv.select(0, 0), 1);
});

test("边界 k=0 / k=N / 空向量", () => {
  const bv = BitVector.fromBits("101001");
  assert.equal(bv.rank(1, 0), 0);
  assert.equal(bv.rank(0, 0), 0);
  assert.equal(bv.rank(1, 6), 3);
  assert.equal(bv.rank(0, 6), 3);
  const empty = BitVector.fromBits("");
  assert.equal(empty.rank(1, 0), 0);
  assert.equal(empty.select(1, 0), null);
  assert.equal(empty.select(0, 0), null);
});

test("select 第一个与最后一个出现", () => {
  const bv = BitVector.fromBits("101001");
  assert.equal(bv.select(1, 0), 0);
  assert.equal(bv.select(1, 2), 5);
  assert.equal(bv.select(1, 3), null); // 不存在，返回 null 而非 0
  assert.equal(bv.select(0, 2), 4);
  assert.equal(bv.select(0, 3), null);
});

test("非法输入拒绝", () => {
  const bv = BitVector.fromBits("1010");
  for (const bad of [2, -1, 0.5, NaN]) {
    assert.throws(() => bv.rank(bad as any, 2), BitVectorError);
  }
  for (const k of [-1, 5, 1.5, NaN]) {
    assert.throws(() => bv.rank(1, k), BitVectorError);
  }
  assert.throws(() => bv.select(1, -1), BitVectorError);
  assert.throws(() => bv.select(1, 0.5), BitVectorError);
  assert.throws(() => BitVector.fromBits("10201"), BitVectorError);
});

test("全零 / 全一 / 交替 / 连续空大块 / 不完整尾字", () => {
  const cases = [
    "0".repeat(700),
    "1".repeat(700),
    "10".repeat(350),
    "0".repeat(512) + "1" + "0".repeat(300), // 连续空大块
    "1".repeat(255) + "0".repeat(300) + "1", // 跨 256 边界
    "101", // 不足一个整字
    "1".repeat(32) + "0" + "1".repeat(31), // 跨字
  ];
  for (const bits of cases) {
    const bv = BitVector.fromBits(bits);
    for (let k = 0; k <= bits.length; k++) {
      assert.equal(bv.rank(1, k), scanRank(bits, 1, k), `rank1 ${k} of ${bits.length}`);
      assert.equal(bv.rank(0, k), scanRank(bits, 0, k), `rank0 ${k}`);
    }
    for (const b of [0, 1] as const) {
      for (let j = 0; j <= bits.length; j++) {
        assert.equal(bv.select(b, j), scanSelect(bits, b, j), `select(${b},${j})`);
      }
    }
  }
});

test("填充零不计入末字（长度 33 全 1）", () => {
  const bv = BitVector.fromBits("1".repeat(33));
  assert.equal(bv.rank(1, 33), 33);
  assert.equal(bv.rank(0, 33), 0);
  assert.equal(bv.select(0, 0), null);
});

test("最高位（第 31 位）不当负数", () => {
  assert.equal(popcount32(0x80000000 >>> 0), 1);
  assert.equal(popcount32(-1), 32); // 0xffffffff
  assert.equal(lowMask(32), 0xffffffff);
  assert.equal(lowMask(0), 0);
  const bv = BitVector.fromBits("1".repeat(32));
  assert.equal(bv.rank(1, 32), 32);
});

test("随机短向量全枚举，对照独立扫描", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 50; t++) {
    const n = 1 + Math.floor(rand() * 120);
    let bits = "";
    for (let i = 0; i < n; i++) bits += rand() < 0.5 ? "1" : "0";
    const bv = BitVector.fromBits(bits);
    for (let k = 0; k <= n; k++) {
      assert.equal(bv.rank(1, k), scanRank(bits, 1, k));
      assert.equal(bv.rank(0, k), scanRank(bits, 0, k));
    }
    for (const b of [0, 1] as const) {
      const total = scanRank(bits, b, n);
      for (let j = 0; j < total; j++) {
        const pos = bv.select(b, j)!;
        assert.equal(pos, scanSelect(bits, b, j));
        assert.equal(bv.rank(b, pos + 1), j + 1, "rank(b, select(b,j)+1) = j+1");
      }
      assert.equal(bv.select(b, total), null);
    }
  }
});

test("长向量跨 32/256 边界", () => {
  const n = 5000;
  let bits = "";
  for (let i = 0; i < n; i++) bits += i % 3 === 0 ? "1" : "0";
  const bv = BitVector.fromBits(bits);
  for (const k of [0, 1, 31, 32, 33, 255, 256, 257, 2048, 4999, 5000]) {
    assert.equal(bv.rank(1, k), scanRank(bits, 1, k));
    assert.equal(bv.rank(0, k), scanRank(bits, 0, k));
  }
  const ones = scanRank(bits, 1, n);
  assert.equal(bv.select(1, 0), scanSelect(bits, 1, 0));
  assert.equal(bv.select(1, ones - 1), scanSelect(bits, 1, ones - 1));
});

test("快照导出导入与损坏检测", () => {
  const bv = BitVector.fromBits("101001" + "1".repeat(300));
  const snap = exportSnapshot(bv);
  const bv2 = importSnapshot(snap);
  assert.equal(bv2.length, bv.length);
  assert.equal(bv2.toBits(), bv.toBits());
  // 长度与字节数不符
  assert.throws(() => importSnapshot({ format: "bitvector-snapshot-v1", length: 9, hex: "ff" }), BitVectorError);
  // 末字节填充位非零
  assert.throws(() => importSnapshot({ format: "bitvector-snapshot-v1", length: 5, hex: "ff" }), BitVectorError);
  // 格式标识错误
  assert.throws(() => importSnapshot({ format: "x", length: 0, hex: "" }), BitVectorError);
  // 非法 hex
  assert.throws(() => importSnapshot({ format: "bitvector-snapshot-v1", length: 8, hex: "zz" }), BitVectorError);
});

test("SQLite 版本化持久化与重启后查询", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-test-"));
  const db = path.join(dir, "t.db");
  {
    const store = new Store(db);
    store.save("a", BitVector.fromBits("101001"), 0);
    store.save("a", BitVector.fromBits("111000"), 0); // 修改 -> 新版本
    store.close();
  }
  {
    // 重新打开（模拟重启），无需重新输入
    const store = new Store(db);
    const v1 = store.get("a", 1)!;
    const v2 = store.get("a")!; // 最新
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    const bv1 = store.load(v1);
    const bv2 = store.load(v2);
    assert.equal(bv1.rank(1, 4), 2); // 旧查询对应旧数据
    assert.equal(bv2.rank(1, 4), 3);
    assert.equal(store.list().length, 2);
    store.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("解释字段完整", () => {
  const bv = BitVector.fromBits("1".repeat(300) + "0".repeat(100));
  const e1 = bv.rankDetailed(1, 290).explain;
  assert.equal(e1.superblock, 1);
  assert.equal(e1.superCumulativeOnes, 256);
  assert.ok(e1.wordHex.startsWith("0x"));
  assert.equal(e1.result, 290);
  const e2 = bv.selectDetailed(0, 50).explain;
  assert.equal(e2.result, 350);
  assert.equal(e2.superblock, 1);
  const e3 = bv.selectDetailed(0, 100).explain;
  assert.equal(e3.result, null);
  assert.equal(e3.notFound, true);
});
