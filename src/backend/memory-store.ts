import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentMemoryOrigin, MemoryEntry } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { OpenBotDatabase } from "./openbot-database";

/**
 * One owner column and one table name are the whole difference between an agent's memories and a
 * channel's, so the SQL below is written once. Nothing here knows what an owner is: the subclasses
 * in `agent-memory-store.ts` and `channel-memory-store.ts` name it and re-attach the owner id to
 * every row they return.
 *
 * The aggregate type is deliberately per-owner. `database/agent-roster.ts` purges the events of a
 * deleted agent by `aggregate_type`, and a channel must not be swept up by that query.
 */
export interface MemoryTables {
  table: string;
  ownerColumn: "agent_id" | "channel_id";
  aggregateType: "agent-memory" | "channel-memory";
  limit: number;
  limitMessage: string;
  softLimit: number;
  hasTags: boolean;
}

export interface SaveAutomaticMemory {
  memoryId?: string;
  text: string;
  sourceTurnId: string;
  expectedUpdatedAt?: string | null;
  tags?: string[];
  /**
   * A deterministic command id makes the write exactly-once. A channel tool passes the id of its
   * own call, so a retried call reads the receipt instead of saving again. An agent turn stages its
   * memories and commits once, so it has nothing to replay and leaves this unset.
   */
  commandId?: string;
}

export interface MemorySearchOptions {
  query?: string;
  tags?: string[];
  limit?: number;
}

export class MemoryStore {
  readonly #columns: string;
  readonly #ftsTable: string | null;

  constructor(
    readonly database: OpenBotDatabase,
    protected readonly tables: MemoryTables,
  ) {
    this.#columns = `memory_id, text, origin, source_turn_id, created_at, updated_at`;
    if (tables.hasTags) this.#columns += `, tags`;
    this.#ftsTable = tables.hasTags ? `${tables.table}_fts` : null;
  }

  list(ownerId: string): MemoryEntry[] {
    return databaseRows(
      this.database.connection
        .prepare(
          `SELECT ${this.#columns}
           FROM ${this.tables.table}
           WHERE ${this.tables.ownerColumn} = ?
           ORDER BY updated_at DESC, memory_id`,
        )
        .all(ownerId),
    ).map(memoryFromRow);
  }

  get(ownerId: string, memoryId: string): MemoryEntry | null {
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT ${this.#columns}
           FROM ${this.tables.table}
           WHERE ${this.tables.ownerColumn} = ? AND memory_id = ?`,
        )
        .get(ownerId, memoryId),
    );
    return row ? memoryFromRow(row) : null;
  }

  createManual(ownerId: string, text: string, tags?: string[]): MemoryEntry {
    return this.save(ownerId, { text, origin: "manual", sourceTurnId: null, tags });
  }

  duplicate(sourceOwnerId: string, targetOwnerId: string): MemoryEntry[] {
    return this.list(sourceOwnerId).map((memory) =>
      this.save(targetOwnerId, {
        text: memory.text,
        origin: memory.origin,
        sourceTurnId: null,
        tags: memory.tags,
      }),
    );
  }

  updateManual(ownerId: string, memoryId: string, text: string, tags?: string[]): MemoryEntry {
    return this.save(ownerId, { memoryId, text, origin: "manual", sourceTurnId: null, tags });
  }

  /**
   * `expectedUpdatedAt` is the concurrency check: a memory edited meanwhile is left alone.
   *
   * Protected, not public, so each subclass can keep the public `saveAutomatic` its own callers
   * already use - the agent one takes `agentId` inside its input object.
   */
  protected saveAutomaticEntry(ownerId: string, input: SaveAutomaticMemory): MemoryEntry | null {
    if (input.memoryId && input.expectedUpdatedAt !== undefined) {
      const current = this.get(ownerId, input.memoryId);
      if (!current || current.updatedAt !== input.expectedUpdatedAt) return null;
    }
    return this.save(ownerId, {
      memoryId: input.memoryId,
      text: input.text,
      origin: "automatic",
      sourceTurnId: input.sourceTurnId,
      commandId: input.commandId,
      tags: input.tags,
    });
  }

  delete(ownerId: string, memoryId: string, expectedUpdatedAt?: string | null): boolean {
    const current = this.get(ownerId, memoryId);
    if (!current) return false;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return false;
    const { aggregateType, table, ownerColumn } = this.tables;
    this.database.dispatch(
      `${aggregateType}:delete:${randomUUID()}`,
      [
        {
          aggregateType,
          aggregateId: memoryId,
          eventType: `${aggregateType}.deleted`,
          payload: { [ownerColumn === "agent_id" ? "agentId" : "channelId"]: ownerId, memoryId },
        },
      ],
      (db, sequences) => {
        forgetEventsBefore(db, aggregateType, memoryId, sequences[0] ?? 0);
        db.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ? AND memory_id = ?`).run(ownerId, memoryId);
        return true;
      },
    );
    return true;
  }

  clear(ownerId: string): number {
    const memories = this.list(ownerId);
    if (memories.length === 0) return 0;
    const { aggregateType, table, ownerColumn } = this.tables;
    const ownerKey = ownerColumn === "agent_id" ? "agentId" : "channelId";
    return this.database.dispatch(
      `${aggregateType}:clear:${randomUUID()}`,
      memories.map((memory) => ({
        aggregateType,
        aggregateId: memory.id,
        eventType: `${aggregateType}.deleted`,
        payload: { [ownerKey]: ownerId, memoryId: memory.id },
      })),
      (db, sequences) => {
        for (const [index, memory] of memories.entries())
          forgetEventsBefore(db, aggregateType, memory.id, sequences[index] ?? 0);
        db.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`).run(ownerId);
        return memories.length;
      },
    );
  }

  protected save(
    ownerId: string,
    input: {
      memoryId?: string;
      text: string;
      origin: AgentMemoryOrigin;
      sourceTurnId: string | null;
      commandId?: string;
      tags?: string[];
    },
  ): MemoryEntry {
    const text = validateMemoryText(input.text);
    const normalizedText = normalizeMemoryText(text);
    const parsedTags = this.tables.hasTags && input.tags !== undefined ? validateMemoryTags(input.tags) : undefined;
    const duplicate = this.#findByNormalizedText(ownerId, normalizedText);
    if (duplicate && duplicate.id !== input.memoryId) {
      if (input.memoryId) this.delete(ownerId, input.memoryId);
      return duplicate;
    }

    const previous = input.memoryId ? this.get(ownerId, input.memoryId) : null;
    if (input.memoryId && !previous) throw new Error("This memory no longer exists.");
    if (!previous && this.list(ownerId).length >= this.tables.limit) throw new Error(this.tables.limitMessage);
    const tags = this.tables.hasTags ? (parsedTags ?? previous?.tags ?? []) : undefined;

    const now = new Date().toISOString();
    const updatedAt =
      previous && now <= previous.updatedAt ? new Date(Date.parse(previous.updatedAt) + 1).toISOString() : now;
    const memory: MemoryEntry = {
      id: previous?.id ?? randomUUID(),
      text,
      origin: input.origin,
      sourceTurnId: input.sourceTurnId,
      createdAt: previous?.createdAt ?? now,
      updatedAt,
    };
    if (tags !== undefined) memory.tags = tags;
    const { aggregateType, table, ownerColumn } = this.tables;
    const eventType = `${aggregateType}.${previous ? "updated" : "created"}`;
    this.database.dispatch(
      input.commandId ?? `${aggregateType}:${eventType}:${randomUUID()}`,
      [
        {
          aggregateType,
          aggregateId: memory.id,
          eventType,
          payload: { memory: { ...memory, [ownerColumn === "agent_id" ? "agentId" : "channelId"]: ownerId } },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `INSERT INTO ${table} (
             memory_id, ${ownerColumn}, text, normalized_text, origin, source_turn_id,
             created_at, updated_at, last_event_sequence${this.tables.hasTags ? ", tags" : ""}
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${this.tables.hasTags ? ", ?" : ""})
           ON CONFLICT(memory_id) DO UPDATE SET
             text = excluded.text,
             normalized_text = excluded.normalized_text,
             origin = excluded.origin,
             source_turn_id = excluded.source_turn_id,
             updated_at = excluded.updated_at,
             last_event_sequence = excluded.last_event_sequence${this.tables.hasTags ? ", tags = excluded.tags" : ""}`,
        ).run(
          memory.id,
          ownerId,
          memory.text,
          normalizedText,
          memory.origin,
          memory.sourceTurnId,
          memory.createdAt,
          memory.updatedAt,
          sequences[0] ?? 0,
          ...(this.tables.hasTags ? [tags === undefined ? "[]" : JSON.stringify(tags)] : []),
        );
        return memory;
      },
    );
    if (!previous) this.#compact(ownerId);
    return memory;
  }

  search(ownerId: string, options: MemorySearchOptions = {}): MemoryEntry[] {
    const limit = Math.min(options.limit ?? INPUT_LIMITS.memorySearchResults, INPUT_LIMITS.memorySearchResults);
    const query = options.query?.trim() ?? "";
    const tags = options.tags ?? [];
    for (const tag of tags) validateMemoryTags([tag]);
    const ownerColumn = this.tables.ownerColumn;
    const tagFilter = tags
      .map(() => `EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = ?)`)
      .join(" AND ");

    if (!query && tags.length === 0) return this.list(ownerId).slice(0, limit);

    const columns = this.#columns
      .split(", ")
      .map((column) => `m.${column}`)
      .join(", ");

    if (query) {
      if (!this.#ftsTable) throw new Error("Full-text memory search is not available here.");
      let rows: unknown;
      try {
        rows = this.database.connection
          .prepare(
            `SELECT ${columns}
             FROM ${this.tables.table} AS m
             JOIN ${this.#ftsTable} AS f ON f.rowid = m.rowid
             WHERE m.${ownerColumn} = ? AND f.${this.#ftsTable} MATCH ?
               ${tagFilter ? `AND ${tagFilter}` : ""}
             ORDER BY bm25(f.${this.#ftsTable}, 4.0, 2.0), m.updated_at DESC, m.memory_id
             LIMIT ?`,
          )
          .all(ownerId, query, ...tags, limit);
      } catch (error) {
        if (error instanceof Error && /syntax error/i.test(error.message))
          throw new Error("The memory search query is not valid.");
        throw error;
      }
      return databaseRows(rows).map(memoryFromRow);
    }

    const rows = this.database.connection
      .prepare(
        `SELECT ${columns}
         FROM ${this.tables.table} AS m
         WHERE m.${ownerColumn} = ?${tagFilter ? ` AND ${tagFilter}` : ""}
         ORDER BY m.updated_at DESC, m.memory_id
         LIMIT ?`,
      )
      .all(ownerId, ...tags, limit);
    return databaseRows(rows).map(memoryFromRow);
  }

  #compact(ownerId: string): void {
    const { table, ownerColumn, softLimit } = this.tables;
    if (softLimit <= 0 || !this.tables.hasTags) return;
    const row = databaseRow(
      this.database.connection.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${ownerColumn} = ?`).get(ownerId),
    );
    const count = row && isNumber(row.count) ? row.count : 0;
    if (count <= softLimit) return;
    const automatic = databaseRows(
      this.database.connection
        .prepare(
          `SELECT ${this.#columns}
           FROM ${table}
           WHERE ${ownerColumn} = ? AND origin = 'automatic'
           ORDER BY updated_at ASC, memory_id ASC
           LIMIT ?`,
        )
        .all(ownerId, count - softLimit),
    ).map(memoryFromRow);
    for (const memory of automatic) this.delete(ownerId, memory.id);
  }

  #findByNormalizedText(ownerId: string, normalizedText: string): MemoryEntry | null {
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT ${this.#columns}
           FROM ${this.tables.table}
           WHERE ${this.tables.ownerColumn} = ? AND normalized_text = ?`,
        )
        .get(ownerId, normalizedText),
    );
    return row ? memoryFromRow(row) : null;
  }
}

/**
 * A hard delete also erases the memory's own history. Memory text is what the user asked to be
 * forgotten, so leaving it in `orchestration_events` would keep it readable after a clear.
 */
function forgetEventsBefore(db: DatabaseSync, aggregateType: string, memoryId: string, deletionSequence: number): void {
  db.prepare(
    `DELETE FROM orchestration_command_receipts WHERE command_id IN (
       SELECT DISTINCT command_id
       FROM orchestration_events
       WHERE aggregate_type = ? AND aggregate_id = ? AND sequence < ?
     )`,
  ).run(aggregateType, memoryId, deletionSequence);
  db.prepare(
    `DELETE FROM orchestration_events
     WHERE aggregate_type = ? AND aggregate_id = ? AND sequence < ?`,
  ).run(aggregateType, memoryId, deletionSequence);
}

function validateMemoryText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Memory text is required.");
  if (text.length > INPUT_LIMITS.agentMemoryText) throw new Error("Memory text is too long.");
  return text;
}

function normalizeMemoryText(value: string): string {
  return value;
}

function databaseRow(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

function databaseRows(value: unknown): DynamicRecord[] {
  if (!Array.isArray(value)) throw new Error("Invalid memory query result.");
  return value.map((row) => {
    const record = databaseRow(row);
    if (!record) throw new Error("Invalid memory query row.");
    return record;
  });
}

function requiredStringColumn(row: DynamicRecord, key: string): string {
  const value = row[key];
  if (!isString(value)) throw new Error(`Invalid memory column ${key}.`);
  return value;
}

function validateMemoryTags(value: string[] | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("Memory tags must be text.");
    const tag = raw.trim();
    if (!tag) throw new Error("Memory tags must not be empty.");
    if (tag.length > INPUT_LIMITS.memoryTagText) throw new Error("A memory tag is too long.");
    if (tags.length >= INPUT_LIMITS.memoryTags) throw new Error("A memory can carry only a few tags.");
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

function decodeMemoryTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!isString(value)) throw new Error("Invalid memory tags.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid memory tags.");
  }
  if (!Array.isArray(parsed)) throw new Error("Invalid memory tags.");
  return validateMemoryTags(parsed);
}

function memoryFromRow(row: DynamicRecord): MemoryEntry {
  const origin = requiredStringColumn(row, "origin");
  if (origin !== "automatic" && origin !== "manual") throw new Error("Invalid memory origin.");
  const sourceTurnId = row.source_turn_id;
  if (sourceTurnId !== null && !isString(sourceTurnId)) throw new Error("Invalid memory source turn.");
  const memory: MemoryEntry = {
    id: requiredStringColumn(row, "memory_id"),
    text: requiredStringColumn(row, "text"),
    origin,
    sourceTurnId,
    createdAt: requiredStringColumn(row, "created_at"),
    updatedAt: requiredStringColumn(row, "updated_at"),
  };
  const tags = decodeMemoryTags(row.tags);
  if (tags !== undefined) memory.tags = tags;
  return memory;
}
