// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMemories } from "./agent/agent-memories";
import { ConversationRuntime } from "./agent/conversation-runtime";
import type { OpenBotToolResponse } from "./agent/routine-tools";
import { AgentStore } from "./agent-store";
import type { OpenBotDatabase } from "./openbot-database";
import type { DynamicToolCallParams } from "./protocol";

const roots: string[] = [];
let agentStore: AgentStore;
let memories: AgentMemories;
let database: OpenBotDatabase;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-memory-tools-"));
  roots.push(root);
  agentStore = new AgentStore(join(root, "data"), join(root, "home"));
  await agentStore.initialize();
  await agentStore.getOrCreate("chief");
  await agentStore.getOrCreate("peer");
  database = agentStore.database;
  memories = new AgentMemories({
    store: agentStore,
    conversation: new ConversationRuntime(
      agentStore,
      () => undefined,
      () => agentStore.list(),
    ),
    emit: vi.fn(),
    emitError: vi.fn(),
  });
});

afterEach(async () => {
  database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentMemories: memory tools", () => {
  it("stages a remembered fact with tags and commits it on a completed turn", () => {
    const response = callTool("turn-1", "remember", {
      text: "Thursdays are release day",
      tags: ["release", "  cadence "],
    });

    expect(payload(response)).toEqual({ status: "staged", memoryId: null });
    expect(memories.listFor("chief")).toEqual([]);

    memories.finishTurn("turn-1", "completed");

    const [saved] = memories.listFor("chief");
    expect(saved).toMatchObject({ text: "Thursdays are release day", tags: ["release", "cadence"] });
  });

  it("discards a staged write when the turn does not complete", () => {
    callTool("turn-1", "remember", { text: "Thursdays are release day" });
    memories.finishTurn("turn-1", "failed");

    expect(memories.listFor("chief")).toEqual([]);
  });

  it("corrects an existing memory without dropping its tags", () => {
    callTool("turn-1", "remember", { text: "Thursdays are release day", tags: ["release"] });
    memories.finishTurn("turn-1", "completed");
    const saved = memories.listFor("chief")[0];

    callTool("turn-2", "remember", { memoryId: saved.id, text: "Fridays are release day" });
    memories.finishTurn("turn-2", "completed");

    expect(memories.listFor("chief")).toHaveLength(1);
    expect(memories.listFor("chief")[0]).toMatchObject({
      id: saved.id,
      text: "Fridays are release day",
      tags: ["release"],
    });
  });

  it("updates text and tags by id, or clears tags on request", () => {
    callTool("turn-1", "remember", { text: "Thursdays are release day", tags: ["release"] });
    memories.finishTurn("turn-1", "completed");
    const saved = memories.listFor("chief")[0];

    callTool("turn-2", "update_memory", { memoryId: saved.id, text: "Fridays are release day", tags: ["schedule"] });
    memories.finishTurn("turn-2", "completed");
    expect(memories.listFor("chief")[0]).toMatchObject({ text: "Fridays are release day", tags: ["schedule"] });

    callTool("turn-3", "update_memory", { memoryId: saved.id, tags: [] });
    memories.finishTurn("turn-3", "completed");
    expect(memories.listFor("chief")[0]).toMatchObject({ text: "Fridays are release day", tags: [] });

    expect(() => callTool("turn-4", "update_memory", { memoryId: saved.id })).toThrow(
      "Update at least one of text and tags.",
    );
  });

  it("searches and lists immediately, scoped to the calling agent", () => {
    callTool("turn-1", "remember", { text: "Thursdays are release day", tags: ["release"] }, "call-1");
    callTool("turn-1", "remember", { text: "Use metric units in reports", tags: ["formatting"] }, "call-2");
    memories.finishTurn("turn-1", "completed");

    const list = payload(callTool("turn-2", "list_memories", {}, "call-3"));
    if (!("memories" in list)) throw new Error("Expected a memory list reply.");
    expect(list.memories).toHaveLength(2);

    const search = payload(callTool("turn-2", "search_memories", { query: "metric units" }, "call-4"));
    if (!("memories" in search)) throw new Error("Expected a memory search reply.");
    expect(search.memories.map((memory) => memory.text)).toEqual(["Use metric units in reports"]);

    expect(payload(callTool("turn-3", "search_memories", { tags: ["release"] }, "call-5"))).toEqual({
      memories: [
        {
          id: expect.any(String),
          text: "Thursdays are release day",
          origin: "automatic",
          sourceTurnId: "turn-1",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          tags: ["release"],
          agentId: "chief",
        },
      ],
    });
  });

  it("rejects a memoryId that belongs to another agent", () => {
    callTool("turn-1", "remember", { text: "Peer fact" });
    memories.finishTurn("turn-1", "completed");
    const peer = memories.listFor("chief")[0];

    expect(() => callTool("turn-2", "update_memory", { memoryId: peer.id, text: "Nope" }, "call-1", "peer")).toThrow(
      "This memory does not belong to the current agent.",
    );
    expect(() => callTool("turn-3", "forget_memory", { memoryId: peer.id }, "call-1", "peer")).toThrow(
      "This memory does not belong to the current agent.",
    );
  });

  it("drops a staged write when the user cleared the memories meanwhile", () => {
    callTool("turn-1", "remember", { text: "Thursdays are release day" });
    memories.clear("chief");
    memories.finishTurn("turn-1", "completed");

    expect(memories.listFor("chief")).toEqual([]);
  });
});

function callTool(
  turnId: string,
  tool: string,
  args: unknown,
  callId = "call-1",
  senderAgentId = "chief",
): OpenBotToolResponse | null {
  return memories.handleTool(
    { threadId: "thread-1", turnId, callId, namespace: null, tool, arguments: args } satisfies DynamicToolCallParams,
    senderAgentId,
  );
}

type MemoryToolReply = { status: "staged"; memoryId: string | null } | { memories: MemoryEntry[] };

function payload(response: OpenBotToolResponse | null): MemoryToolReply {
  if (!response) throw new Error("A memory tool did not answer.");
  return JSON.parse(response.contentItems[0].text);
}
