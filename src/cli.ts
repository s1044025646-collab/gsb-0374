import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store";
import { BitVector, BvError } from "./bitvector";
import { startServer } from "./server";

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.BV_DB ?? path.join(DATA_DIR, "bitvector.db");

function usage(): never {
  console.log(`bitvector-cli <command> [args]

Commands:
  serve [--port N]                 start HTTP API (default port 0 = auto free port)
  import <name> <bits>             import bit string, build index, new version
  import-hex <name> <len> <hex>    import snapshot (length + hex bytes)
  build <name>                     rebuild index from stored bytes and report stats
  rank <ref> <bit> <k> [--explain]   ref = id | name | name@version
  select <ref> <bit> <j> [--explain]
  range <ref> <from> <to>
  stats <ref>
  export <ref>                     print snapshot {format,length,hex}
  list
  demo                             run the 101001 demo and boundary checks`);
  process.exit(1);
}

function parseRef(store: Store, ref: string): { id: number; bv: BitVector } {
  let row;
  if (/^\d+$/.test(ref)) row = store.getById(Number(ref));
  else {
    const m = ref.match(/^(.+?)(?:@(\d+))?$/);
    row = store.getByName(m![1], m![2] ? Number(m![2]) : undefined);
  }
  if (!row) {
    console.error(`error NOT_FOUND: vector '${ref}' not found`);
    process.exit(1);
  }
  return { id: row.id, bv: store.loadVector(row) };
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (!cmd) usage();
  const store = new Store(DB_PATH);
  const explain = args.includes("--explain");

  switch (cmd) {
    case "serve": {
      const pi = args.indexOf("--port");
      const port = pi >= 0 ? Number(args[pi + 1]) : Number(process.env.PORT ?? 0);
      startServer(store, Number.isInteger(port) && port >= 0 ? port : 0).then(({ port: p }) => {
        console.log(`bitvector API listening on http://127.0.0.1:${p} (db: ${DB_PATH})`);
      });
      return; // keep process alive
    }
    case "import": {
      const [name, bits] = args;
      const t0 = Date.now();
      const bv = BitVector.fromBitsString(bits);
      const row = store.saveVector(name, bv, { source: "cli-bits", length: bv.length, buildMs: Date.now() - t0 });
      console.log(JSON.stringify({ id: row.id, name: row.name, version: row.version, length: row.length }));
      break;
    }
    case "import-hex": {
      const [name, len, hex] = args;
      const t0 = Date.now();
      const bv = BitVector.fromHex(Number(len), hex);
      const row = store.saveVector(name, bv, { source: "cli-snapshot", length: bv.length, buildMs: Date.now() - t0 });
      console.log(JSON.stringify({ id: row.id, name: row.name, version: row.version, length: row.length }));
      break;
    }
    case "build": {
      const { bv } = parseRef(store, args[0]);
      const st = bv.blockStats();
      console.log(JSON.stringify({ rebuilt: true, ...st, blocks: `[${st.blocks.length} blocks]` }));
      break;
    }
    case "rank": {
      const { bv } = parseRef(store, args[0]);
      const bit = Number(args[1]);
      const k = Number(args[2]);
      console.log(JSON.stringify(explain ? bv.rankExplain(bit, k) : { result: bv.rank(bit, k) }));
      break;
    }
    case "select": {
      const { bv } = parseRef(store, args[0]);
      const bit = Number(args[1]);
      const j = Number(args[2]);
      console.log(JSON.stringify(explain ? bv.selectExplain(bit, j) : { result: bv.select(bit, j) }));
      break;
    }
    case "range": {
      const { bv } = parseRef(store, args[0]);
      const from = Number(args[1]);
      const to = Number(args[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > bv.length) {
        console.error(`error OUT_OF_RANGE: need 0 <= from <= to <= ${bv.length}`);
        process.exit(1);
      }
      console.log(JSON.stringify({ from, to, bits: bv.toBitsString().slice(from, to) }));
      break;
    }
    case "stats": {
      const { bv } = parseRef(store, args[0]);
      console.log(JSON.stringify(bv.blockStats(), null, 1));
      break;
    }
    case "export": {
      const { bv } = parseRef(store, args[0]);
      console.log(JSON.stringify({ format: "bv1", length: bv.length, hex: bv.toHex() }));
      break;
    }
    case "list": {
      console.log(JSON.stringify(store.list(), null, 1));
      break;
    }
    case "demo": {
      const bv = BitVector.fromBitsString("101001");
      console.log("bits: 101001 (index 0..5)");
      console.log("rank(1,4)  =", bv.rank(1, 4), "(expect 2)");
      console.log("rank(0,4)  =", bv.rank(0, 4), "(expect 2)");
      console.log("select(1,2)=", bv.select(1, 2), "(expect 5)");
      console.log("select(0,0)=", bv.select(0, 0), "(expect 1)");
      // long vector crossing 32-bit and 256-bit boundaries
      const n = 700;
      let long = "";
      for (let i = 0; i < n; i++) long += i % 3 === 0 || i === 31 || i === 255 || i === 256 ? "1" : "0";
      const lv = BitVector.fromBitsString(long);
      const t0 = Date.now();
      let checksum = 0;
      for (let k = 0; k <= n; k++) checksum += lv.rank(1, k);
      console.log(`long vector n=${n}: ${lv.blockStats().numBlocks} blocks, ones=${lv.totalOnes()}, full rank sweep ${Date.now() - t0}ms, checksum=${checksum}`);
      console.log("rank(1,32)=", lv.rank(1, 32), "rank(1,256)=", lv.rank(1, 256), "select(1,0)=", lv.select(1, 0));
      break;
    }
    default:
      usage();
  }
  store.close();
}

try {
  main();
} catch (e) {
  if (e instanceof BvError) {
    console.error(`error ${e.code}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
