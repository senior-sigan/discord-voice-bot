import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type SearchDocument, SearchStore, type TextEmbedder } from "./index.js";

class TestEmbedder implements TextEmbedder {
  readonly dimension = 3;
  readonly identity = "test-v1";
  fail = false;
  passages = 0;
  async split(text: string): Promise<string[]> {
    return text.split("|");
  }
  async embed(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]> {
    if (this.fail && texts.length) throw new Error("inference failed");
    if (purpose === "passage") this.passages += texts.length;
    return texts.map((text) => (text.includes("кот") ? [1, 0, 0] : text.includes("пёс") ? [0, 1, 0] : [0, 0, 1]));
  }
}

test("Zvec persists topic snapshots, filters before top-k, and deduplicates chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-search-"));
  try {
    const model = new TestEmbedder();
    const store = new SearchStore(root, model);
    const documents: SearchDocument[] = [
      { id: "cat", text: "кот|кот снова|кот ещё", date: "2024-05-02", metadata: { source: "one" } },
      { id: "dog", text: "пёс", date: "2025-03-01" },
      { id: "bird", text: "птица", date: "2025-03-02" },
    ];
    await store.sync("memes", documents);
    await store.sync("memory", [{ id: "cat", text: "пёс" }]);
    const reopened = new SearchStore(root, model);
    const result = await reopened.search("memes", "кот", { limit: 3 });
    assert.equal(result.length, 3);
    assert.equal(result[0]?.id, "cat");
    assert.ok(Math.abs((result[0]?.score ?? 0) - 1) < 0.0001);
    assert.deepEqual(result[0]?.metadata, { source: "one" });
    const filtered = await store.search("memes", "кот", { limit: 1, from: "2025-01-01", to: "2025-12-31" });
    assert.notEqual(filtered[0]?.id, "cat");
    assert.equal((await store.search("memory", "пёс"))[0]?.text, "пёс");
    const calls = model.passages;
    assert.equal((await store.sync("memes", documents)).changed, false);
    assert.equal(model.passages, calls);
    const changed = await store.sync("memes", [
      { ...(documents[0] as SearchDocument), metadata: { source: "updated" } },
      { id: "new", text: "пёс" },
    ]);
    assert.equal(changed.reused, 3);
    assert.equal(changed.embedded, 1);
    const updated = await reopened.search("memes", "кот", { limit: 10 });
    assert.deepEqual(
      updated.map(({ id }) => id),
      ["cat", "new"],
    );
    assert.equal(updated[0]?.metadata?.["source"], "updated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed indexing keeps the previous snapshot and releases the writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-search-"));
  try {
    const model = new TestEmbedder();
    const store = new SearchStore(root, model);
    await store.sync("history", [{ id: "one", text: "кот" }]);
    model.fail = true;
    await assert.rejects(store.sync("history", [{ id: "two", text: "пёс" }]), /inference failed/u);
    model.fail = false;
    assert.equal((await store.search("history", "кот"))[0]?.id, "one");
    await assert.rejects(
      store.sync("history", [
        { id: "x", text: "кот" },
        { id: "x", text: "пёс" },
      ]),
      /Duplicate/u,
    );
    await assert.rejects(store.search("../history", "кот"), /Invalid search topic/u);
    await assert.rejects(store.search("missing", "кот"), /not indexed/u);
    await assert.rejects(store.search("history", "кот", { from: "2025' OR 1=1" }), /Invalid/u);
    const mismatch = new SearchStore(root, {
      ...model,
      identity: "other",
      split: model.split.bind(model),
      embed: model.embed.bind(model),
    });
    await assert.rejects(mismatch.search("history", "кот"), /model changed/u);
    writeFileSync(join(root, "history", "current.json"), "broken manifest");
    const repaired = await store.sync("history", [{ id: "one", text: "кот" }], { rebuild: true });
    assert.equal(repaired.embedded, 1);
    assert.equal(repaired.reused, 0);
    assert.equal((await store.search("history", "кот"))[0]?.id, "one");
    await store.sync("history", []);
    assert.deepEqual(await store.search("history", "кот"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second writer cannot replace an in-progress topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-search-"));
  try {
    const model = new TestEmbedder();
    const store = new SearchStore(root, model);
    await store.sync("memes", [{ id: "one", text: "кот" }]);
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    const blocked = new SearchStore(root, {
      identity: model.identity,
      dimension: model.dimension,
      split: async (text) => {
        await barrier;
        return [text];
      },
      embed: model.embed.bind(model),
    });
    const pending = blocked.sync("memes", [{ id: "two", text: "пёс" }]);
    await assert.rejects(store.sync("memes", []), /EEXIST/u);
    assert.equal((await store.search("memes", "кот"))[0]?.id, "one");
    release?.();
    await pending;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
