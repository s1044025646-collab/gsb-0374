/** CLI：import / rank / select / batch / range / stats / export / load-snapshot / serve / demo */
import * as path from "node:path";
import * as fs from "node:fs";
import { BitVector, BitVectorError } from "./bitvector";
import { Store, exportSnapshot, importSnapshot } from "./store";
import { startServer } from "./server";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.BV_DB ?? path.join(DATA_DIR, "bitvector.db");

function out(x: unknown) { console.log(JSON.stringify(x, null, 2)); }

function parseNum(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) {
    throw new BitVectorError("BAD_ARG", `参数 ${name} 缺失或不是数字`);
  }
  return n;
}

function loadBv(store: Store, name: string, version?: number) {
  const row = store.get(name, version);
  if (!row) throw new BitVectorError("NOT_FOUND", `向量 ${name} 不存在`);
  return { row, bv: store.load(row) };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const optExplain = args.includes("--explain");
  const versionFlag = args.find((a) => a.startsWith("--version="));
  const version = versionFlag ? Number(versionFlag.split("=")[1]) : undefined;
  const pos = args.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "import": {
      // import <name> <bits|@file>
      const [name, src] = pos;
      const bits = src.startsWith("@") ? fs.readFileSync(src.slice(1), "utf8").trim() : src;
      const t0 = performance.now();
      const bv = BitVector.fromBits(bits);
      const buildMs = performance.now() - t0;
      const store = new Store(DB_PATH);
      const row = store.save(name, bv, buildMs);
      store.close();
      out({ id: row.id, name, version: row.version, length: bv.length, totalOnes: bv.totalOnes, buildMs: Math.round(buildMs * 1000) / 1000 });
      break;
    }
    case "rank": {
      // rank <name> <b> <k> [--explain] [--version=N]
      const store = new Store(DB_PATH);
      const { row, bv } = loadBv(store, pos[0], version);
      const r = bv.rankDetailed(parseNum(pos[1], "b"), parseNum(pos[2], "k"));
      store.close();
      out({ name: row.name, version: row.version, result: r.result, ...(optExplain ? { explain: r.explain } : {}) });
      break;
    }
    case "select": {
      // select <name> <b> <j> [--explain]
      const store = new Store(DB_PATH);
      const { row, bv } = loadBv(store, pos[0], version);
      const r = bv.selectDetailed(parseNum(pos[1], "b"), parseNum(pos[2], "j"));
      store.close();
      out({ name: row.name, version: row.version, result: r.result, found: r.result !== null, ...(optExplain ? { explain: r.explain } : {}) });
      break;
    }
    case "batch": {
      // batch <name> <opsFile>  ops: [{op:"rank",b,k}|{op:"select",b,j}]
      const store = new Store(DB_PATH);
      const { row, bv } = loadBv(store, pos[0], version);
      const ops = JSON.parse(fs.readFileSync(pos[1], "utf8"));
      const results = ops.map((op: any) =>
        op.op === "rank" ? { result: bv.rank(op.b, op.k) }
        : op.op === "select" ? { result: bv.select(op.b, op.j), found: bv.select(op.b, op.j) !== null }
        : (() => { throw new BitVectorError("BAD_OP", `未知操作 ${op.op}`); })()
      );
      store.close();
      out({ name: row.name, version: row.version, count: results.length, results });
      break;
    }
    case "range": {
      // range <name> <from> <to>
      const store = new Store(DB_PATH);
      const { row, bv } = loadBv(store, pos[0], version);
      const from = parseNum(pos[1], "from"), to = parseNum(pos[2], "to");
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > bv.length || from > to) {
        throw new BitVectorError("OUT_OF_RANGE", `区间须满足 0 <= from <= to <= ${bv.length}`);
      }
      store.close();
      out({ name: row.name, version: row.version, from, to, bits: bv.toBits().slice(from, to), length: bv.length, note: "展示截断不影响数据长度" });
      break;
    }
    case "stats": {
      const store = new Store(DB_PATH);
      const { row, bv } = loadBv(store, pos[0], version);
      store.close();
      out({ name: row.name, version: row.version, ...bv.stats() });
      break;
    }
    case "list": {
      const store = new Store(DB_PATH);
      out(store.list());
      store.close();
      break;
    }
    case "export": {
      // export <name> [file]
      const store = new Store(DB_PATH);
      const { bv } = loadBv(store, pos[0], version);
      store.close();
      const snap = JSON.stringify(exportSnapshot(bv), null, 2);
      if (pos[1]) { fs.writeFileSync(pos[1], snap); console.log(`已导出到 ${pos[1]}`); }
      else console.log(snap);
      break;
    }
    case "load-snapshot": {
      // load-snapshot <name> <file>
      const snap = JSON.parse(fs.readFileSync(pos[1], "utf8"));
      const bv = importSnapshot(snap); // 重新校验长度、填充位并重建累计
      const store = new Store(DB_PATH);
      const row = store.save(pos[0], bv, 0);
      store.close();
      out({ id: row.id, name: pos[0], version: row.version, length: bv.length, totalOnes: bv.totalOnes });
      break;
    }
    case "serve": {
      // serve [port]（缺省 0 = 自动选空闲端口）
      const port = pos[0] ? parseNum(pos[0], "port") : Number(process.env.PORT ?? 0);
      const actual = await startServer(DB_PATH, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据库: ${DB_PATH})`);
      break;
    }
    case "demo": {
      runDemo();
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <命令>
  import <name> <bits|@file>     导入位串并构建索引
  rank <name> <b> <k> [--explain] [--version=N]
  select <name> <b> <j> [--explain]
  batch <name> <opsFile.json>    批量查询
  range <name> <from> <to>       查看区间（展示截断，不改数据）
  stats <name>                   块统计
  list                           列出所有向量与版本
  export <name> [file]           导出快照（length + hex）
  load-snapshot <name> <file>    导入快照（重新校验并重建索引）
  serve [port]                   启动 API（缺省自动选空闲端口）
  demo                           运行内置演示`);
  }
}

function runDemo() {
  const bv = BitVector.fromBits("101001");
  console.log("位串 101001 (N=6)");
  console.log("rank(1,4) =", bv.rank(1, 4), "(期望 2)");
  console.log("rank(0,4) =", bv.rank(0, 4), "(期望 2)");
  console.log("select(1,2) =", bv.select(1, 2), "(期望 5)");
  console.log("select(0,0) =", bv.select(0, 0), "(期望 1)");
  console.log("\nrank(1,4) 解释:", JSON.stringify(bv.rankDetailed(1, 4).explain, null, 2));
  console.log("\nselect(1,2) 解释:", JSON.stringify(bv.selectDetailed(1, 2).explain, null, 2));

  // 跨 32 位与 256 位边界的长向量
  const n = 600;
  let bits = "";
  for (let i = 0; i < n; i++) bits += i % 7 === 0 || i % 31 === 0 ? "1" : "0";
  const long = BitVector.fromBits(bits);
  console.log(`\n长向量 N=${n}（跨 32/256 位边界）: totalOnes=${long.totalOnes}`);
  for (const k of [31, 32, 33, 255, 256, 257, 511, 512, 600]) {
    console.log(`  rank(1,${k}) = ${long.rank(1, k)}, rank(0,${k}) = ${long.rank(0, k)}`);
  }
  console.log("  select(1,0) =", long.select(1, 0), " select(1,last) =", long.select(1, long.totalOnes - 1));
}

main().catch((e) => {
  if (e instanceof BitVectorError) {
    console.error(`错误 [${e.code}]: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
