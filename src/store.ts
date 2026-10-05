import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { BitVector, INDEX_VERSION } from "./bitvector";

export interface VectorRow {
  id: number;
  name: string;
  version: number;
  length: number;
  data: Buffer;
  index_version: number;
  report: string;
  created_at: string;
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_name ON vectors(name, version);
    `);
  }

  saveVector(name: string, bv: BitVector, report: object): VectorRow {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM vectors WHERE name = ?")
      .get(name) as { v: number };
    const version = row.v + 1;
    const data = Buffer.from(bv.words.buffer, bv.words.byteOffset, bv.words.byteLength);
    const res = this.db
      .prepare(
        "INSERT INTO vectors (name, version, length, data, index_version, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(name, version, bv.length, data, INDEX_VERSION, JSON.stringify(report), new Date().toISOString());
    return this.getById(Number(res.lastInsertRowid))!;
  }

  getById(id: number): VectorRow | null {
    const r = this.db.prepare("SELECT * FROM vectors WHERE id = ?").get(id) as VectorRow | undefined;
    return r ?? null;
  }

  /** Latest version of a name, or a specific version. */
  getByName(name: string, version?: number): VectorRow | null {
    const r = (
      version === undefined
        ? this.db.prepare("SELECT * FROM vectors WHERE name = ? ORDER BY version DESC LIMIT 1").get(name)
        : this.db.prepare("SELECT * FROM vectors WHERE name = ? AND version = ?").get(name, version)
    ) as VectorRow | undefined;
    return r ?? null;
  }

  list(): Omit<VectorRow, "data">[] {
    return this.db
      .prepare("SELECT id, name, version, length, index_version, report, created_at FROM vectors ORDER BY id")
      .all() as Omit<VectorRow, "data">[];
  }

  /** Rebuild index from stored raw bytes; stored cumulative data is never trusted. */
  loadVector(row: VectorRow): BitVector {
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as Uint8Array);
    const words = new Uint32Array(Math.ceil(row.length / 32));
    for (let i = 0; i < words.length; i++) {
      words[i] = i * 4 + 4 <= buf.length ? buf.readUInt32LE(i * 4) : 0;
    }
    return BitVector.fromWords(row.length, words);
  }

  close(): void {
    this.db.close();
  }
}
