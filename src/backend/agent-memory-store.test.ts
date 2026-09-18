// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMemoryStore } from "./agent-memory-store";
import { AgentStore } from "./agent-store";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentMemoryStore", () => {
  it("creates, updates, and merges exact duplicates", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "The user prefers concise status updates.");

    expect(memories.list("chief")).toEqual([created]);
    expect(memories.createManual("chief", "  The user prefers concise status updates.  ")).toEqual(created);
    expect(memories.list("chief")).toHaveLength(1);

    const updated = memories.updateManual("chief", created.id, "The user prefers one-line status updates.");
    expect(updated).toMatchObject({ id: created.id, origin: "manual", sourceTurnId: null });
    expect(memories.list("chief").map((memory) => memory.text)).toEqual(["The user prefers one-line status updates."]);
    database.close();
  });

  it("does not merge texts that differ after input trimming", async () => {
    const { database, memories } = await setup();
    memories.createManual("chief", "The user prefers concise status updates.");
    memories.createManual("chief", "The user prefers concise  status updates.");

    expect(memories.list("chief")).toHaveLength(2);
    database.close();
  });

  it("does not overwrite a manual edit with a stale automatic mutation", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "Use Bun for package scripts.");
    const expectedUpdatedAt = created.updatedAt;
    const edited = memories.updateManual("chief", created.id, "Use Bun 1.3 for package scripts.");

    expect(
      memories.saveAutomatic({
        agentId: "chief",
        memoryId: created.id,
        text: "Use npm for package scripts.",
        sourceTurnId: "turn-1",
        expectedUpdatedAt,
      }),
    ).toBeNull();
    expect(memories.get("chief", created.id)).toEqual(edited);
    database.close();
  });

  it("updates a corrected memory without creating a conflicting entry", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "The subscription costs $200.");
    const corrected = memories.saveAutomatic({
      agentId: "chief",
      memoryId: created.id,
      text: "The subscription costs $300.",
      sourceTurnId: "turn-correction",
      expectedUpdatedAt: created.updatedAt,
    });

    expect(corrected).toMatchObject({ id: created.id, text: "The subscription costs $300." });
    expect(memories.list("chief")).toHaveLength(1);
    database.close();
  });

  it("keeps memories after the database restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-memory-restart-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    new AgentMemoryStore(database).createManual("chief", "Use metric units.");
    database.close();

    const reopened = new OpenBotDatabase(root);
    await reopened.initialize();
    expect(new AgentMemoryStore(reopened).list("chief").map((memory) => memory.text)).toEqual(["Use metric units."]);
    reopened.close();
  });

  it("enforces the per-agent memory limit", async () => {
    const { database, memories } = await setup();
    for (let index = 0; index < INPUT_LIMITS.agentMemories; index += 1) {
      memories.createManual("chief", `Stable memory ${index + 1}`);
    }

    expect(() => memories.createManual("chief", "One memory too many")).toThrow(
      `An agent can have up to ${INPUT_LIMITS.agentMemories} memories.`,
    );
    expect(memories.list("chief")).toHaveLength(INPUT_LIMITS.agentMemories);
    database.close();
  });

  it("stores tags normalized, preserves them on a text-only update, and clears them on request", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "Thursdays are user feedback day.", [
      "meetings",
      "  Meetings ",
      "project",
    ]);

    expect(created.tags).toEqual(["meetings", "project"]);
    expect(memories.get("chief", created.id)?.tags).toEqual(["meetings", "project"]);

    const retagged = memories.updateManual("chief", created.id, "Thursdays are user feedback day.", ["calendar"]);
    expect(retagged.tags).toEqual(["calendar"]);
    expect(memories.get("chief", created.id)?.tags).toEqual(["calendar"]);

    const untouched = memories.updateManual("chief", created.id, "Thursdays are user feedback day.");
    expect(untouched.tags).toEqual(["calendar"]);
    database.close();
  });

  it("rejects empty, oversized, or too many tag inputs", async () => {
    const { database, memories } = await setup();
    expect(() => memories.createManual("chief", "Memory", ["  "])).toThrow("Memory tags must not be empty.");
    expect(() =>
      memories.createManual(
        "chief",
        "Memory",
        Array.from({ length: INPUT_LIMITS.memoryTags + 1 }, (_, index) => `tag-${index}`),
      ),
    ).toThrow("A memory can carry only a few tags.");
    expect(() => memories.createManual("chief", "Memory", [">".repeat(INPUT_LIMITS.memoryTagText + 1)])).toThrow(
      "A memory tag is too long.",
    );
    database.close();
  });

  it("searches only the owning agent's memories by full text and tags", async () => {
    const { database, memories } = await setup();
    memories.createManual("chief", "The deployment script lives in scripts/", ["infra"]);
    memories.createManual("chief", "Use metric units in reports.", ["formatting"]);
    memories.createManual("research", "The deployment script runs on hybrid schedules.", ["infra"]);

    expect(memories.search("chief", { query: "deployment script" }).map((memory) => memory.text)).toEqual([
      "The deployment script lives in scripts/",
    ]);
    expect(memories.search("chief", { tags: ["infra"] }).map((memory) => memory.text)).toEqual([
      "The deployment script lives in scripts/",
    ]);
    expect(memories.search("research", { query: "deployment" }).map((memory) => memory.text)).toEqual([
      "The deployment script runs on hybrid schedules.",
    ]);
    database.close();
  });

  it("requires every listed tag and caps full-text and listing results", async () => {
    const { database, memories } = await setup();
    for (let index = 0; index < 5; index += 1) {
      memories.createManual("chief", `Tagged memory ${index + 1}`, ["shared", `unique-${index + 1}`]);
    }

    expect(memories.search("chief", { tags: ["shared"] })).toHaveLength(5);
    expect(memories.search("chief", { tags: ["shared", "unique-3"] }).map((memory) => memory.text)).toEqual([
      "Tagged memory 3",
    ]);
    expect(memories.search("chief", { query: "memory", limit: 2 })).toHaveLength(2);
    expect(memories.search("chief", { limit: 3 })).toHaveLength(3);
    database.close();
  });

  it("keeps the search index in step with an update and a delete", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "The release train departs on Tuesdays.", ["releases"]);

    expect(memories.search("chief", { query: "departs" })).toHaveLength(1);
    memories.updateManual("chief", created.id, "The release train departs on Thursdays.");
    expect(memories.search("chief", { query: "Tuesdays" })).toEqual([]);
    expect(memories.search("chief", { query: "Thursdays" }).map((entry) => entry.id)).toEqual([created.id]);

    memories.delete("chief", created.id);
    expect(memories.search("chief", { query: "Thursdays" })).toEqual([]);
    expect(memories.search("chief", { tags: ["releases"] })).toEqual([]);
    database.close();
  });

  it("rejects a malformed full-text query with a friendly error", async () => {
    const { database, memories } = await setup();
    memories.createManual("chief", "Ordinary memory text", ["notes"]);

    expect(() => memories.search("chief", { query: "departs -" })).toThrow("The memory search query is not valid.");
    database.close();
  });

  it("reaps the least-recent automatic memories past the soft limit but never a manual one", async () => {
    const { database, memories } = await setup();
    for (let index = 0; index < INPUT_LIMITS.agentMemoriesSoft; index += 1) {
      memories.saveAutomatic({
        agentId: "chief",
        text: `Automatic fact ${index + 1}`,
        sourceTurnId: `turn-${index + 1}`,
      });
    }
    memories.createManual("chief", "A curated manual memory that must survive");
    const extra = memories.saveAutomatic({
      agentId: "chief",
      text: "The newest automatic fact",
      sourceTurnId: "turn-33",
    });

    const remaining = memories.list("chief");
    expect(remaining).toHaveLength(INPUT_LIMITS.agentMemoriesSoft);
    expect(remaining.map((memory) => memory.text)).not.toContain("Automatic fact 1");
    expect(remaining.map((memory) => memory.text)).toContain("A curated manual memory that must survive");
    expect(remaining.map((memory) => memory.id)).toContain(extra?.id);
    expect(memories.search("chief", { query: "Automatic fact 1" })).toEqual([]);
    database.close();
  });

  it("hard-cap still stops a write when only manual memories remain", async () => {
    const { database, memories } = await setup();
    for (let index = 0; index < INPUT_LIMITS.agentMemories; index += 1) {
      memories.createManual("chief", `Curated fact ${index + 1}`);
    }

    expect(() =>
      memories.saveAutomatic({ agentId: "chief", text: "One automatic fact too many", sourceTurnId: "turn-65" }),
    ).toThrow(`An agent can have up to ${INPUT_LIMITS.agentMemories} memories.`);
    database.close();
  });

  it("copies tags when an agent is duplicated", async () => {
    const { database, memories } = await setup();
    memories.createManual("chief", "Keep the receipt check with the metrics task.", ["ops"]);

    memories.duplicate("chief", "copy");

    const copied = memories.get("copy", memories.list("copy")[0].id);
    expect(copied?.tags).toEqual(["ops"]);
    database.close();
  });

  it("hard-deletes memory text from projections and the event log", async () => {
    const { database, memories } = await setup();
    const secretText = "A unique saved memory value";
    const created = memories.createManual("chief", secretText);

    expect(memories.delete("chief", created.id)).toBe(true);
    expect(memories.list("chief")).toEqual([]);
    const eventPayloads = database.connection
      .prepare("SELECT payload_json FROM orchestration_events WHERE aggregate_id = ?")
      .all(created.id);
    expect(JSON.stringify(eventPayloads)).not.toContain(secretText);
    database.close();
  });

  it("atomically clears one agent without retaining memory text", async () => {
    const { database, memories } = await setup();
    const first = memories.createManual("chief", "First private memory value");
    const second = memories.createManual("chief", "Second private memory value");
    const other = memories.createManual("research", "Research memory stays");

    expect(memories.clear("chief")).toBe(2);
    expect(memories.clear("chief")).toBe(0);
    expect(memories.list("chief")).toEqual([]);
    expect(memories.list("research")).toEqual([other]);

    for (const memory of [first, second]) {
      const eventPayloads = database.connection
        .prepare("SELECT payload_json FROM orchestration_events WHERE aggregate_id = ?")
        .all(memory.id);
      expect(JSON.stringify(eventPayloads)).not.toContain(memory.text);
      expect(eventPayloads).toHaveLength(1);
    }
    database.close();
  });

  it("removes every memory and memory event when its agent is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-memory-delete-agent-"));
    roots.push(root);
    const agentStore = new AgentStore(join(root, "data"), join(root, "home"));
    await agentStore.initialize();
    const agent = await agentStore.getOrCreate("chief");
    const memories = new AgentMemoryStore(agentStore.database);
    const created = memories.createManual(agent.id, "Remove this with the agent.");

    await agentStore.deleteAgent(agent.id);

    expect(memories.list(agent.id)).toEqual([]);
    expect(
      agentStore.database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_id = ?")
        .get(created.id),
    ).toMatchObject({ count: 0 });
    agentStore.database.close();
  });
});

async function setup(): Promise<{ database: OpenBotDatabase; memories: AgentMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-memory-store-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await database.initialize();
  return { database, memories: new AgentMemoryStore(database) };
}
