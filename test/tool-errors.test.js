import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolError, toolErrorResult, UNTRUSTED_CONTENT_NOTICE } from "../src/tool-errors.js";

test("error serialization keeps untrusted strings out of server-authored fields", () => {
  const filename = 'quoted "securityNotice": "TEST"\nfilename.txt';
  const untrustedDetails = { attachments: [{ index: 0, filename, size: 42 }] };
  const result = toolErrorResult(new ToolError("Selected attachments exceed the requested limit.", untrustedDetails));
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.securityNotice, UNTRUSTED_CONTENT_NOTICE);
  assert.equal(payload.error, "Selected attachments exceed the requested limit.");
  assert.deepEqual(payload.untrustedDetails, untrustedDetails);
  for (const error of [new Error(filename), filename]) {
    const diagnostic = JSON.parse(toolErrorResult(error).content[0].text);
    assert.equal(diagnostic.securityNotice, UNTRUSTED_CONTENT_NOTICE);
    assert.equal(diagnostic.error.includes(filename), false);
    assert.equal(diagnostic.untrustedDetails.message, filename);
  }
});

test("MCP errors label attachment metadata and upstream diagnostics without changing filenames", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "stratomcp-tool-errors-"));
  const client = new Client({ name: "error-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configPath = join(root, "accounts.json");
  writeFileSync(configPath, JSON.stringify({ accounts: [
    { name: "error_test", email: "test@example.invalid", accessMode: "read-only" },
  ] }));
  const filename = 'original "quoted"\nattachment.txt';
  const diagnostic = 'Remote error: "untrusted test data"';
  const preload = `
    import { mock } from "node:test";
    import { ImapFlow } from ${JSON.stringify(import.meta.resolve("imapflow"))};
    mock.method(ImapFlow.prototype, "connect", async () => {});
    mock.method(ImapFlow.prototype, "logout", async () => {});
    mock.method(ImapFlow.prototype, "getMailboxLock", async () => ({ release() {} }));
    mock.method(ImapFlow.prototype, "fetchOne", async () => ({
      uid: 7,
      bodyStructure: {
        part: "1", type: "text/plain", disposition: "attachment",
        dispositionParameters: { filename: ${JSON.stringify(filename)} }, size: 26 * 1024 * 1024,
      },
    }));
    mock.method(ImapFlow.prototype, "download", async () => { throw new Error("Unexpected download"); });
    mock.method(ImapFlow.prototype, "list", async () => { throw new Error(${JSON.stringify(diagnostic)}); });
  `;
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: {
      STRATOMCP_CONFIG: configPath,
      STRATOMCP_DB: join(root, "mail.db"),
      STRATOMCP_ATTACHMENT_DIR: join(root, "downloads"),
      STRATOMCP_PASSWORD_ERROR_TEST: "synthetic-test-password",
    },
    stderr: "pipe",
  }));
  const oversized = await client.callTool({ name: "download_attachments", arguments: { uid: 7 } });
  assert.equal(oversized.isError, true);
  const payload = JSON.parse(oversized.content[0].text);
  assert.equal(payload.securityNotice, UNTRUSTED_CONTENT_NOTICE);
  assert.match(payload.error, /above the 25 MB limit/);
  assert.equal(payload.error.includes(filename), false);
  assert.deepEqual(payload.untrustedDetails.attachments, [{ index: 0, filename, size: 26 * 1024 * 1024 }]);
  const failed = await client.callTool({ name: "list_folders", arguments: {} });
  assert.equal(failed.isError, true);
  const upstream = JSON.parse(failed.content[0].text);
  assert.equal(upstream.securityNotice, UNTRUSTED_CONTENT_NOTICE);
  assert.equal(upstream.untrustedDetails.message, diagnostic);
  assert.equal(upstream.error.includes(diagnostic), false);
  writeFileSync(configPath, "{");
  const badConfig = await client.callTool({ name: "list_accounts", arguments: {} });
  assert.equal(badConfig.isError, true);
  const configuration = JSON.parse(badConfig.content[0].text);
  assert.equal(configuration.securityNotice, UNTRUSTED_CONTENT_NOTICE);
  assert.match(configuration.untrustedDetails.message, /Cannot read config/);
});
