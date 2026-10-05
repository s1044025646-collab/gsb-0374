/** SQLite 持久化：原始字节 + 有效长度 + 索引版本 + 构建报告。
 * 同名重新导入会创建新版本；旧版本数据保留，旧查询仍可复现。 */
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { BitVector, INDEX_VERSION, BitVectorError } from "./bitvector";

export interface VectorRow {
  id: number;
  name: string;
  version: number;
  length: number;
  data: Buffer;
  indexVersion: number;
  report: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        length INTEGER NOT NULL,
        data BLOB NOT NULL,
        index_version INTEGER NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
    `);
  }

  close() { this.db.close(); }

  /** 保存位向量，返回行信息。同名自动递增版本。 */
  save(name: string, bv: BitVector, buildMs: number): VectorRow {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM vectors WHERE name = ?")
      .get(name) as { v: number };
    const version = row.v + 1;
    const report = JSON.stringify({
      indexVersion: INDEX_VERSION,
      length: bv.length,
      totalOnes: bv.totalOnes,
      totalZeros: bv.totalZeros,
      buildMs,
      note: "累计计数在导入时重新计算，不信任外部索引",
    });
    const r = this.db
      .prepare(
        "INSERT INTO vectors(name, version, length, data, index_version, report) VALUES (?,?,?,?,?,?)"
      )
      .run(name, version, bv.length, bv.toBytes(), INDEX_VERSION, report);
    return this.getById(Number(r.lastInsertRowid))!;
  }

  getById(id: number): VectorRow | null {
    const r = this.db.prepare("SELECT * FROM vectors WHERE id = ?").get(id) as any;
    return r ? this.toRow(r) : null;
  }

  /** 按名取（默认最新版本）。 */
  get(name: string, version?: number): VectorRow | null {
    const r = version == null
      ? this.db.prepare("SELECT * FROM vectors WHERE name = ? ORDER BY version DESC LIMIT 1").get(name) as any
      : this.db.prepare("SELECT * FROM vectors WHERE name = ? AND version = ?").get(name, version) as any;
    return r ? this.toRow(r) : null;
  }

  list(): Omit<VectorRow, "data">[] {
    const rows = this.db
      .prepare("SELECT id, name, version, length, index_version, report, created_at FROM vectors ORDER BY name, version")
      .all() as any[];
    return rows.map((r) => ({
      id: r.id, name: r.name, version: r.version, length: r.length,
      indexVersion: r.index_version, report: r.report, createdAt: r.created_at,
    }));
  }

  /** 从行重建索引（不信任 report，重新累计）。 */
  load(row: VectorRow): BitVector {
    if (row.indexVersion !== INDEX_VERSION) {
      throw new BitVectorError("INDEX_VERSION", `索引版本 ${row.indexVersion} 不受支持`);
    }
    return BitVector.fromBytes(row.data, row.length);
  }

  private toRow(r: any): VectorRow {
    return {
      id: r.id, name: r.name, version: r.version, length: r.length,
      data: Buffer.from(r.data), indexVersion: r.index_version,
      report: r.report, createdAt: r.created_at,
    };
  }
}

/** 快照格式：{ format, length, hex }。 */
export function exportSnapshot(bv: BitVector) {
  return {
    format: "bitvector-snapshot-v1",
    length: bv.length,
    hex: bv.toBytes().toString("hex"),
  };
}

export function importSnapshot(snap: any): BitVector {
  if (!snap || snap.format !== "bitvector-snapshot-v1") {
    throw new BitVectorError("BAD_SNAPSHOT", "快照格式标识不正确");
  }
  if (!Number.isInteger(snap.length) || snap.length < 0) {
    throw new BitVectorError("BAD_SNAPSHOT", "快照 length 非法");
  }
  if (typeof snap.hex !== "string" || !/^[0-9a-fA-F]*$/.test(snap.hex) || snap.hex.length % 2 !== 0) {
    throw new BitVectorError("BAD_SNAPSHOT", "快照 hex 非法");
  }
  return BitVector.fromBytes(Buffer.from(snap.hex, "hex"), snap.length);
}
