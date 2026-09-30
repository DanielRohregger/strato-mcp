import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP enforces configured modes, ignores argument overrides and reloads permission changes", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "stratomcp-permission-tools-"));
  const client = new Client({ name: "permission-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configPath = join(root, "accounts.json");
  const saveMode = (accessMode) => writeFileSync(configPath, JSON.stringify({ accounts: [
    { name: "reader", email: "reader@example.invalid", accessMode, allowSend: true },
    { name: "organizer", email: "organizer@example.invalid", accessMode: "organize" },
  ] }));
  saveMode("read-only");
  const preload = `
    import { mock } from "node:test";
    import { ImapFlow } from ${JSON.stringify(import.meta.resolve("imapflow"))};
    import nodemailer from ${JSON.stringify(import.meta.resolve("nodemailer"))};
    mock.method(ImapFlow.prototype, "connect", async () => { throw new Error("Unexpected mailbox connection"); });
    mock.method(nodemailer, "createTransport", () => { throw new Error("Unexpected SMTP connection"); });
  `;
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: {
      STRATOMCP_CONFIG: configPath,
      STRATOMCP_DB: join(root, "mail.db"),
      STRATOMCP_PASSWORD_READER: "synthetic-test-password",
      STRATOMCP_PASSWORD_ORGANIZER: "synthetic-test-password",
    },
    stderr: "pipe",
  }));
  const list = async () => {
    const result = await client.callTool({ name: "list_accounts", arguments: {} });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual((await list()).map(({ accessMode, allowSend }) => ({ accessMode, allowSend })), [
    { accessMode: "read-only", allowSend: false }, { accessMode: "organize", allowSend: false },
  ]);
  const requests = [
    ["get_message", { uid: 7, markSeen: true }],
    ["get_message", { uids: [7, 8], markSeen: true }],
    ["update_flags", { uids: [7], seen: true }],
    ["move_messages", { uids: [7], destination: "Archive" }],
    ["save_draft", { to: "test@example.invalid", subject: "TEST", text: "TEST" }],
    ["send_message", { to: "test@example.invalid", subject: "TEST", text: "TEST" }],
  ];
  for (const [name, args] of requests) {
    const result = await client.callTool({ name, arguments: {
      ...args, account: "reader", accessMode: "full", allowSend: true, confirmed: true,
    } });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.match(payload.untrustedDetails.message, /read-only mode/);
    assert.doesNotMatch(payload.untrustedDetails.message, /Unexpected .* connection/);
  }
  const organizer = await client.callTool({
    name: "send_message", arguments: { account: "organizer", to: "test@example.invalid", subject: "TEST" },
  });
  assert.equal(organizer.isError, true);
  assert.match(JSON.parse(organizer.content[0].text).untrustedDetails.message, /Sending is disabled/);
  saveMode("full");
  assert.equal((await list())[0].allowSend, true);
  saveMode("read-only");
  assert.equal((await list())[0].allowSend, false);
  const downgraded = await client.callTool({
    name: "move_messages", arguments: { account: "reader", uids: [7], destination: "Archive" },
  });
  assert.equal(downgraded.isError, true);
  assert.match(JSON.parse(downgraded.content[0].text).untrustedDetails.message, /read-only mode/);
});
