// Shared by migration 21 and the separate new-database schema. IF NOT EXISTS throughout, because
// this text is both the migration and the tail of the latest schema: a database built from the
// latest schema and then replayed forward - which is how a test fakes an older version - meets its
// own index.
//
// The tags column is not here. New databases receive it from the substituted
// `projection_agent_memories` table; an upgrade runs `ALTER TABLE ... ADD COLUMN` in the
// migration's `up` before this text. The ALTER cannot live in this string: a fresh database
// already has the column, and SQLite rejects adding it twice.
//
// External-content FTS5 keeps one source of truth. `content` and `content_rowid` point at the
// projection, so the index does not store a second copy of the text. The three triggers keep
// that index in step with insert, delete and update; without them a remember or forget would
// leave search pointing at a row that is gone, or missing a row that is there.
//
// The INSERT at the end is the upgrade backfill. On a new database the projection is empty and
// the statement inserts nothing. On an upgrade it fills the index from rows that already exist,
// which the AFTER INSERT trigger will not see.
export const MEMORY_FTS_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS projection_agent_memories_fts USING fts5(
    memory_id UNINDEXED,
    text,
    tags,
    content='projection_agent_memories',
    content_rowid='rowid'
  );
  CREATE TRIGGER IF NOT EXISTS projection_agent_memories_ai AFTER INSERT ON projection_agent_memories BEGIN
    INSERT INTO projection_agent_memories_fts(rowid, memory_id, text, tags)
    VALUES (new.rowid, new.memory_id, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS projection_agent_memories_ad AFTER DELETE ON projection_agent_memories BEGIN
    INSERT INTO projection_agent_memories_fts(projection_agent_memories_fts, rowid, memory_id, text, tags)
    VALUES ('delete', old.rowid, old.memory_id, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS projection_agent_memories_au AFTER UPDATE ON projection_agent_memories BEGIN
    INSERT INTO projection_agent_memories_fts(projection_agent_memories_fts, rowid, memory_id, text, tags)
    VALUES ('delete', old.rowid, old.memory_id, old.text, old.tags);
    INSERT INTO projection_agent_memories_fts(rowid, memory_id, text, tags)
    VALUES (new.rowid, new.memory_id, new.text, new.tags);
  END;
  INSERT INTO projection_agent_memories_fts(rowid, memory_id, text, tags)
  SELECT rowid, memory_id, text, tags FROM projection_agent_memories;
`;
