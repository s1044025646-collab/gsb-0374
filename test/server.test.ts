import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Store } from "../src/store";
import { startServer } from "../src/server";

async function api(port: number, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("store + server end to end", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bvtest-"));
  const store = new Store(path.join(dir, "t.db"));
  const { server, port } = await startServer(store, 0);
  assert.ok(port > 0);

  // import
  let r = await api(port, "POST", "/vectors", { name: "demo", bits: "101001" });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.version, 1);

  // rank / select
  r = await api(port, "POST", `/vectors/${id}/rank`, { bit: 1, k: 4 });
  assert.equal(r.body.result, 2);
  r = await api(port, "POST", `/vectors/${id}/rank`, { bit: 0, k: 4 });
  assert.equal(r.body.result, 2);
  r = await api(port, "POST", `/vectors/${id}/select`, { bit: 1, j: 2 });
  assert.equal(r.body.result, 5);
  r = await api(port, "POST", `/vectors/${id}/select`, { bit: 0, j: 0 });
  assert.equal(r.body.result, 1);
  r = await api(port, "POST", `/vectors/${id}/select`, { bit: 1, j: 99 });
  assert.equal(r.body.result, -1);

  // explain
  r = await api(port, "POST", `/vectors/${id}/rank`, { bit: 1, k: 4, explain: true });
  assert.equal(r.body.blockIndex, 0);
  assert.equal(r.body.result, 2);

  // batch
  r = await api(port, "POST", `/vectors/${id}/rank`, { queries: [{ bit: 1, k: 0 }, { bit: 1, k: 6 }] });
  assert.deepEqual(r.body.results.map((x: any) => x.result), [0, 3]);

  // range / stats / snapshot
  r = await api(port, "GET", `/vectors/${id}/range?from=1&to=4`);
  assert.equal(r.body.bits, "010");
  r = await api(port, "GET", `/vectors/${id}/stats`);
  assert.equal(r.body.totalOnes, 3);
  r = await api(port, "GET", `/vectors/${id}/snapshot`);
  assert.equal(r.body.length, 6);

  // reimport snapshot as new vector
  r = await api(port, "POST", "/vectors/import", { name: "copy", length: r.body.length, hex: r.body.hex });
  assert.equal(r.status, 201);

  // corrupt snapshot rejected
  r = await api(port, "POST", "/vectors/import", { name: "bad", length: 6, hex: "ffff" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "CORRUPT_SNAPSHOT");

  // versioning: modify bits creates new version, old id keeps old data
  r = await api(port, "POST", "/vectors", { name: "demo", bits: "111" });
  assert.equal(r.body.version, 2);
  const newId = r.body.id;
  r = await api(port, "POST", `/vectors/${id}/rank`, { bit: 1, k: 6 });
  assert.equal(r.body.result, 3); // old data
  r = await api(port, "POST", `/vectors/${newId}/rank`, { bit: 1, k: 3 });
  assert.equal(r.body.result, 3);
  r = await api(port, "POST", `/vectors/demo@1/rank`, { bit: 1, k: 6 });
  assert.equal(r.body.result, 3);

  // validation errors
  r = await api(port, "POST", `/vectors/${id}/rank`, { bit: 3, k: 1 });
  assert.equal(r.body.error.code, "INVALID_BIT");
  r = await api(port, "POST", `/vectors/${id}/rank`, { bit: 1, k: 7 });
  assert.equal(r.body.error.code, "OUT_OF_RANGE");
  r = await api(port, "POST", `/vectors/9999/rank`, { bit: 1, k: 0 });
  assert.equal(r.status, 404);

  server.close();
  store.close();

  // restart: new Store on same file, queries still work
  const store2 = new Store(path.join(dir, "t.db"));
  const row = store2.getById(id)!;
  const bv = store2.loadVector(row);
  assert.equal(bv.rank(1, 4), 2);
  assert.equal(bv.select(0, 0), 1);
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
