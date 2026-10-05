/** HTTP API：导入、构建、rank/select（含解释）、批量、区间查看、块统计、快照导入导出。 */
import * as http from "node:http";
import { Store, exportSnapshot, importSnapshot } from "./store";
import { BitVector, BitVectorError } from "./bitvector";

const MAX_EXPLAIN_BATCH = 100; // 大输入限制解释数量

function json(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function err(res: http.ServerResponse, e: unknown) {
  if (e instanceof BitVectorError) {
    json(res, 400, { error: { code: e.code, message: e.message } });
  } else {
    json(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BitVectorError("BAD_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const body = req.method === "POST" ? await readBody(req) : {};

      // GET /vectors
      if (req.method === "GET" && parts.length === 1 && parts[0] === "vectors") {
        return json(res, 200, { vectors: store.list() });
      }

      // POST /vectors { name, bits } 或 { name, snapshot }
      if (req.method === "POST" && parts.length === 1 && parts[0] === "vectors") {
        if (typeof body.name !== "string" || !body.name) {
          throw new BitVectorError("BAD_NAME", "name 必须是非空字符串");
        }
        const t0 = performance.now();
        let bv;
        if (typeof body.bits === "string") {
          bv = BitVector.fromBits(body.bits);
        } else if (body.snapshot) {
          bv = importSnapshot(body.snapshot);
        } else {
          throw new BitVectorError("BAD_INPUT", "需要 bits 或 snapshot 字段");
        }
        const row = store.save(body.name, bv, 0);
        const buildMs = performance.now() - t0;
        return json(res, 201, {
          id: row.id, name: row.name, version: row.version,
          length: bv.length, totalOnes: bv.totalOnes, totalZeros: bv.totalZeros,
          buildMs: Math.round(buildMs * 1000) / 1000,
        });
      }

      // 解析向量：/vectors/:name[/v:version]/...
      if (parts[0] === "vectors" && parts.length >= 2) {
        const name = decodeURIComponent(parts[1]);
        const version = url.searchParams.get("version");
        const row = store.get(name, version == null ? undefined : Number(version));
        if (!row) throw new BitVectorError("NOT_FOUND", `向量 ${name} 不存在`);
        const bv = store.load(row);
        const sub = parts[2];

        // GET /vectors/:name/range?from=&to=
        if (req.method === "GET" && sub === "range") {
          const from = Number(url.searchParams.get("from") ?? "0");
          const to = Number(url.searchParams.get("to") ?? String(bv.length));
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > bv.length || from > to) {
            throw new BitVectorError("OUT_OF_RANGE", `区间须满足 0 <= from <= to <= ${bv.length}`);
          }
          return json(res, 200, {
            name, version: row.version, from, to,
            bits: bv.toBits().slice(from, to),
            note: "展示截断不影响数据长度",
            length: bv.length,
          });
        }

        // GET /vectors/:name/stats
        if (req.method === "GET" && sub === "stats") {
          return json(res, 200, { name, version: row.version, ...bv.stats() });
        }

        // GET /vectors/:name/snapshot
        if (req.method === "GET" && sub === "snapshot") {
          return json(res, 200, { name, version: row.version, snapshot: exportSnapshot(bv) });
        }

        // POST /vectors/:name/rank { b, k, explain? }
        if (req.method === "POST" && sub === "rank") {
          const r = bv.rankDetailed(body.b, body.k);
          return json(res, 200, {
            name, version: row.version, result: r.result,
            ...(body.explain ? { explain: r.explain } : {}),
          });
        }

        // POST /vectors/:name/select { b, j, explain? }
        if (req.method === "POST" && sub === "select") {
          const r = bv.selectDetailed(body.b, body.j);
          return json(res, 200, {
            name, version: row.version, result: r.result,
            found: r.result !== null,
            ...(body.explain ? { explain: r.explain } : {}),
          });
        }

        // POST /vectors/:name/batch { ops: [{op:"rank",b,k}|{op:"select",b,j}], explain? }
        if (req.method === "POST" && sub === "batch") {
          if (!Array.isArray(body.ops)) {
            throw new BitVectorError("BAD_INPUT", "ops 必须是数组");
          }
          const explain = body.explain === true && body.ops.length <= MAX_EXPLAIN_BATCH;
          const results = body.ops.map((op: any) => {
            if (op.op === "rank") {
              const r = bv.rankDetailed(op.b, op.k);
              return { result: r.result, ...(explain ? { explain: r.explain } : {}) };
            }
            if (op.op === "select") {
              const r = bv.selectDetailed(op.b, op.j);
              return { result: r.result, found: r.result !== null, ...(explain ? { explain: r.explain } : {}) };
            }
            throw new BitVectorError("BAD_OP", `未知操作 ${op.op}`);
          });
          return json(res, 200, {
            name, version: row.version, count: results.length,
            explainIncluded: explain, results,
          });
        }
      }

      json(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (e) {
      err(res, e);
    }
  });
}

export function startServer(dbPath: string, port: number): Promise<number> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // port 传 0 时由系统分配空闲端口（默认行为）
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
