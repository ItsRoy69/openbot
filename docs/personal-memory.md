# Personal memory

Each agent keeps a personal memory that survives restarts, provider switches, and workspace moves.
The user's SQLite database is the source of truth. A teammate's saved facts are read from the
projection only; nothing about them is sent to a provider, a team server, or a plugin unless the
agent runs a memory tool and the provider sees the prompt it was given.

A memory is one short atomic statement with an origin (`automatic` or `manual`), timestamps, and
optional labels. `automatic` memories are written by the agent's own `remember` tool during a turn;
`manual` memories are written by the user. Rows live in `projection_agent_memories`.

## Tools

| Tool | Purpose |
| --- | --- |
| `remember` | Save a new memory, or correct an existing one by `memoryId`. |
| `search_memories` | Full-text query and tag filter over the agent's own memories. |
| `list_memories` | Most-recently-updated listing, capped at `INPUT_LIMITS.memorySearchResults`. |
| `update_memory` | Rewrite text and/or tags of one memory by `memoryId`. |
| `forget_memory` | Delete one memory by `memoryId`. |

`remember` and `update_memory` want at least one of text and tags. Staged memories take effect only
when the turn that wrote them completes: a turn the user interrupts or that fails leaves nothing
behind. A concurrent manual clear bumps a per-agent epoch, and a staged write whose epoch moved is
dropped instead of resurrecting a memory the user deleted.

The existing shipped surfaces keep their behavior and wire shape: the Team API memory route, the
IPC create/update/delete handlers, and the agent-inputs memory block are unchanged. The tools are an
additive entry point into the same projection.

## Limits

`INPUT_LIMITS` in `packages/contracts/src/input-limits.ts` holds the bounds. The hard cap of
`agentMemories` (64) stops any agent's memory from growing forever. Above `agentMemoriesSoft` (32),
a write that adds a new `automatic` memory reaps the least-recent automatic rows; a manual memory is
never reaped automatically — the hard cap is what bounds a user-curated set. A channel keeps the
pre-tags row shape, no search index, and its own cap (`channelMemories`).

The FTS index is what keeps compacted memories reachable: `search_memories` reads through the index,
not the projection list, so an old fact the working set no longer carries is still found by query or
tag.

## Tags

A memory carries at most `memoryTags` (8) labels of at most `memoryTagText` (40) characters. Tags
are trimmed, lower-cased for comparison, and de-duplicated on write; a text-only update keeps the
row's current tags. Searching by tags requires every listed tag to be present on the memory.

`MemoryEntry.tags` is optional because the same type serves channels and rows carried from before
migration 21: `undefined` means the row predates the tags feature, not "an empty set".

## Search

`search_memories` runs FTS5 over memory text and tags, ranked by `bm25` (relevance over recency,
with updated-at tie-breaking), and capped at `memorySearchResults` (20). A structured `tags` filter
is applied with `json_each` and ANDs together. With neither query nor tags the call degrades to the
recency-bound listing. A malformed FTS query surfaces as `The memory search query is not valid.`
instead of a raw engine error.

## Schema

Migration 21 adds the `tags` column to `projection_agent_memories` (JSON array of strings, default
`[]`) and creates the FTS5 external-content index `projection_agent_memories_fts` with the
`projection_agent_memories_ai/_ad/_au` keep-in-step triggers. New installs get the same shape from
`LATEST_SCHEMA_SQL`; upgraded installs backfill the index once, on migration. The schema-parity test
pins the two build paths to the same column order.

The memory aggregate events remain the projection's source of truth, so a hard delete or clear also
forgets the memory's own event history.