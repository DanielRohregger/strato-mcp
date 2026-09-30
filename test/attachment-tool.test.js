import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the MCP attachment tool omits dir and rejects legacy overrides", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "stratomcp-attachment-tool-"));
  const client = new Client({ name: "attachment-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: {
      STRATOMCP_CONFIG: join(root, "missing-accounts.json"),
      STRATOMCP_DB: join(root, "mail.db"),
      STRATOMCP_ATTACHMENT_DIR: join(root, "downloads"),
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === "download_attachments");
  assert.ok(tool);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, "dir"), false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const dir of [join(root, "outside"), "../outside", "~/Library/LaunchAgents", "", null]) {
    const result = await client.callTool({ name: "download_attachments", arguments: { uid: 7, dir } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /dir/);
    assert.doesNotMatch(result.content[0].text, /Cannot read config/);
  }
  // A valid call reaches account loading; this fixture intentionally has no real accounts.
  const valid = await client.callTool({ name: "download_attachments", arguments: { uid: 7 } });
  assert.equal(valid.isError, true);
  assert.match(valid.content[0].text, /Cannot read config/);
  assert.deepEqual(readdirSync(root), []);
});
