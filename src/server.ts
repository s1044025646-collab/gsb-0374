import * as http from "node:http";
import { Store } from "./store";
import { BitVector, BvError } from "./bitvector";

const MAX_RANGE = 4096;
const MAX_BATCH = 1000;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BvError("BAD_JSON", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function buildReport(bv: BitVector, source: string, started: number) {
  const st = bv.blockStats();
  return {
    source,
    length: bv.length,
    totalOnes: st.totalOnes,
    totalZeros: st.totalZeros,
    numBlocks: st.numBlocks,
    indexBytes: st.indexBytes,
    buildMs: Date.now() - started,
  };
}

export function createServer(store: Store): http.Server {
  const cache = new Map<number, BitVector>();
  const getBv = (id: number): { row: NonNullable<ReturnType<Store["getById"]>>; bv: BitVector } => {
    const row = store.getById(id);
    if (!row) throw new BvError("NOT_FOUND", `vector id ${id} not found`);
    let bv = cache.get(id);
    if (!bv) {
      bv = store.loadVector(row);
      cache.set(id, bv);
    }
    return { row, bv };
  };

  const resolveRef = (ref: string): number => {
    if (/^\d+$/.test(ref)) return Number(ref);
    const m = ref.match(/^(.+?)(?:@(\d+))?$/);
    const row = store.getByName(m![1], m![2] ? Number(m![2]) : undefined);
    if (!row) throw new BvError("NOT_FOUND", `vector '${ref}' not found`);
    return row.id;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const body = req.method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};

      if (req.method === "GET" && url.pathname === "/vectors") {
        return json(res, 200, { vectors: store.list() });
      }

      if (req.method === "POST" && url.pathname === "/vectors") {
        const { name, bits } = body as { name?: string; bits?: string };
        if (!name || typeof bits !== "string") throw new BvError("BAD_REQUEST", "need {name, bits}");
        const t0 = Date.now();
        const bv = BitVector.fromBitsString(bits);
        const row = store.saveVector(name, bv, buildReport(bv, "bits", t0));
        return json(res, 201, { id: row.id, name: row.name, version: row.version, length: row.length, report: JSON.parse(row.report) });
      }

      if (req.method === "POST" && url.pathname === "/vectors/import") {
        const { name, length, hex } = body as { name?: string; length?: number; hex?: string };
        if (!name || typeof length !== "number" || typeof hex !== "string")
          throw new BvError("BAD_REQUEST", "need {name, length, hex}");
        const t0 = Date.now();
        const bv = BitVector.fromHex(length, hex);
        const row = store.saveVector(name, bv, buildReport(bv, "snapshot", t0));
        return json(res, 201, { id: row.id, name: row.name, version: row.version, length: row.length, report: JSON.parse(row.report) });
      }

      if (parts[0] === "vectors" && parts.length >= 2) {
        const id = resolveRef(decodeURIComponent(parts[1]));
        const { row, bv } = getBv(id);
        const sub = parts[2];

        if (req.method === "GET" && !sub) {
          const previewLen = Math.min(256, bv.length);
          return json(res, 200, {
            id: row.id, name: row.name, version: row.version, length: row.length,
            indexVersion: row.index_version, report: JSON.parse(row.report),
            preview: bv.toBitsString().slice(0, previewLen),
            previewTruncated: bv.length > previewLen,
          });
        }

        if (req.method === "POST" && sub === "rank") {
          const explain = body.explain === true || url.searchParams.get("explain") === "true";
          if (Array.isArray(body.queries)) {
            if (body.queries.length > MAX_BATCH) throw new BvError("TOO_MANY", `batch limit ${MAX_BATCH}`);
            const results = body.queries.map((q: { bit: number; k: number }) =>
              explain ? bv.rankExplain(q.bit, q.k) : { result: bv.rank(q.bit, q.k) }
            );
            return json(res, 200, { results });
          }
          const { bit, k } = body as { bit: number; k: number };
          return json(res, 200, explain ? bv.rankExplain(bit, k) : { result: bv.rank(bit, k) });
        }

        if (req.method === "POST" && sub === "select") {
          const explain = body.explain === true || url.searchParams.get("explain") === "true";
          if (Array.isArray(body.queries)) {
            if (body.queries.length > MAX_BATCH) throw new BvError("TOO_MANY", `batch limit ${MAX_BATCH}`);
            const results = body.queries.map((q: { bit: number; j: number }) =>
              explain ? bv.selectExplain(q.bit, q.j) : { result: bv.select(q.bit, q.j) }
            );
            return json(res, 200, { results });
          }
          const { bit, j } = body as { bit: number; j: number };
          return json(res, 200, explain ? bv.selectExplain(bit, j) : { result: bv.select(bit, j) });
        }

        if (req.method === "GET" && sub === "range") {
          const from = Number(url.searchParams.get("from") ?? "0");
          const to = Number(url.searchParams.get("to") ?? String(bv.length));
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > bv.length)
            throw new BvError("OUT_OF_RANGE", `need 0 <= from <= to <= ${bv.length}`);
          if (to - from > MAX_RANGE) throw new BvError("TOO_MANY", `range limited to ${MAX_RANGE} bits`);
          return json(res, 200, { from, to, bits: bv.toBitsString().slice(from, to) });
        }

        if (req.method === "GET" && sub === "stats") {
          return json(res, 200, bv.blockStats());
        }

        if (req.method === "GET" && sub === "snapshot") {
          return json(res, 200, { format: "bv1", length: bv.length, hex: bv.toHex() });
        }
      }

      throw new BvError("NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof BvError) {
        const status =
          e.code === "NOT_FOUND" ? 404 : e.code === "INTERNAL" ? 500 : 400;
        json(res, status, { error: { code: e.code, message: e.message } });
      } else {
        json(res, 500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
  });
}

export function startServer(store: Store, port: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}
