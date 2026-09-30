import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import * as mail from "../src/mail.js";
import { getAccessMode } from "../src/config.js";

function mailboxFixture(t, permissions) {
  const previous = process.env.STRATOMCP_PASSWORD_PERMISSIONS_TEST;
  process.env.STRATOMCP_PASSWORD_PERMISSIONS_TEST = "synthetic-test-password";
  t.after(() => {
    if (previous === undefined) delete process.env.STRATOMCP_PASSWORD_PERMISSIONS_TEST;
    else process.env.STRATOMCP_PASSWORD_PERMISSIONS_TEST = previous;
  });
  const acc = {
    name: "permissions_test", email: "test@example.invalid",
    imapHost: "example.invalid", imapPort: 993, ...permissions,
  };
  const effects = [];
  const connect = t.mock.method(ImapFlow.prototype, "connect", async () => {});
  t.mock.method(ImapFlow.prototype, "logout", async () => {});
  t.mock.method(ImapFlow.prototype, "getMailboxLock", async () => ({ release() {} }));
  const message = {
    uid: 7, flags: new Set(), envelope: { subject: "Synthetic message" },
    bodyStructure: { part: "1", type: "text/plain", size: 4 },
  };
  t.mock.method(ImapFlow.prototype, "fetchOne", async () => message);
  t.mock.method(ImapFlow.prototype, "fetchAll", async () => [message]);
  t.mock.method(ImapFlow.prototype, "search", async () => [7]);
  t.mock.method(ImapFlow.prototype, "download", async () => ({ content: [Buffer.from("TEST")] }));
  t.mock.method(ImapFlow.prototype, "list", async () => [
    { path: "Drafts", specialUse: "\\Drafts" }, { path: "Sent", specialUse: "\\Sent" },
  ]);
  t.mock.method(ImapFlow.prototype, "messageFlagsAdd", async () => { effects.push("flags"); });
  t.mock.method(ImapFlow.prototype, "messageFlagsRemove", async () => { effects.push("flags"); });
  t.mock.method(ImapFlow.prototype, "messageMove", async () => {
    effects.push("move");
    return { uidMap: new Map([[7, 8]]) };
  });
  t.mock.method(ImapFlow.prototype, "append", async (folder) => {
    effects.push(folder);
    return { uid: 8 };
  });
  const smtp = t.mock.method(nodemailer, "createTransport", () => ({
    async sendMail() {
      effects.push("send");
      return { messageId: "test@example.invalid", accepted: ["recipient@example.invalid"], rejected: [] };
    },
  }));
  return { acc, effects, connect, smtp };
}

const draft = { to: "recipient@example.invalid", subject: "Synthetic draft", text: "TEST" };
const mutations = [
  ["markSeen", (acc) => mail.getMessage(acc, { uid: 7, markSeen: true })],
  ["batch markSeen", (acc) => mail.getMessage(acc, { uids: [7, 8], markSeen: true })],
  ["flags", (acc) => mail.updateFlags(acc, { uids: [7], seen: false, flagged: true })],
  ["move", (acc) => mail.moveMessages(acc, { uids: [7], destination: "Archive" })],
  ["draft", (acc) => mail.saveDraft(acc, draft)],
];

test("read-only blocks every mailbox mutation before network or credential access", async (t) => {
  const { acc, effects, connect, smtp } = mailboxFixture(t, { accessMode: "read-only", allowSend: true });
  for (const [name, run] of mutations) {
    await assert.rejects(run(acc), /read-only/, name);
  }
  await assert.rejects(mail.sendMessage(acc, draft), /Sending is disabled/);
  assert.deepEqual(effects, []);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(smtp.mock.callCount(), 0);
});

for (const permissions of [
  { accessMode: "organize", allowSend: true },
  { accessMode: "full", allowSend: false },
  { allowSend: false },
  { allowSend: true },
  {},
]) {
  test(`preserves the mutation permissions of ${JSON.stringify(permissions)}`, async (t) => {
    const { acc, effects, smtp } = mailboxFixture(t, permissions);
    for (const [, run] of mutations) await run(acc);
    assert.ok(effects.includes("flags"));
    assert.ok(effects.includes("move"));
    assert.ok(effects.includes("Drafts"));
    const canSend = permissions.accessMode === "full" || (!permissions.accessMode && permissions.allowSend === true);
    if (canSend) {
      const result = await mail.sendMessage(acc, draft);
      assert.deepEqual(result.accepted, ["recipient@example.invalid"]);
      assert.ok(effects.includes("send"));
      assert.ok(effects.includes("Sent"));
    } else {
      await assert.rejects(mail.sendMessage(acc, draft), /Sending is disabled/);
      assert.equal(smtp.mock.callCount(), 0);
    }
  });
}

for (const accessMode of ["read-only", "organize", "full"]) {
  test(`${accessMode} permits read operations without changing the mailbox`, async (t) => {
    const { acc, effects } = mailboxFixture(t, { accessMode });
    assert.equal((await mail.getMessage(acc, { uid: 7 })).body, "TEST");
    assert.equal((await mail.getMessage(acc, { uids: [7, 8] })).messages.length, 2);
    assert.equal((await mail.searchMessages(acc, {})).messages.length, 1);
    assert.equal((await mail.listFolders(acc)).length, 2);
    assert.deepEqual(effects, []);
  });
}

test("unknown permission modes fail closed", async (t) => {
  const { acc, effects, connect, smtp } = mailboxFixture(t, { accessMode: "typo", allowSend: true });
  for (const [, run] of mutations) await assert.rejects(run(acc), /Invalid accessMode/);
  await assert.rejects(mail.sendMessage(acc, draft), /Invalid accessMode/);
  assert.deepEqual(effects, []);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(smtp.mock.callCount(), 0);
});

test("mode resolution rejects invalid values and gives explicit modes precedence", () => {
  for (const accessMode of ["", "typo", null, true, "__proto__", {}]) {
    assert.throws(() => getAccessMode({ accessMode, allowSend: true }), /Invalid accessMode/);
  }
  for (const allowSend of ["false", "true", 1, null]) {
    assert.throws(() => getAccessMode({ allowSend }), /Invalid allowSend/);
  }
  assert.equal(getAccessMode({ accessMode: "read-only", allowSend: true }), "read-only");
  assert.equal(getAccessMode({ accessMode: "organize", allowSend: true }), "organize");
  assert.equal(getAccessMode({ accessMode: "full", allowSend: false }), "full");
  assert.equal(getAccessMode({}), "organize");
});

test("loading accounts normalizes permissions without rewriting legacy configuration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "stratomcp-permission-config-"));
  const configPath = join(root, "accounts.json");
  const previous = process.env.STRATOMCP_CONFIG;
  process.env.STRATOMCP_CONFIG = configPath;
  t.after(() => {
    if (previous === undefined) delete process.env.STRATOMCP_CONFIG;
    else process.env.STRATOMCP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const source = JSON.stringify({ accounts: [
    { name: "legacy", email: "legacy@example.invalid" },
    { name: "sender", email: "sender@example.invalid", allowSend: true },
    { name: "reader", email: "reader@example.invalid", accessMode: "read-only", allowSend: true },
  ] });
  writeFileSync(configPath, source);
  const { loadAccounts } = await import("../src/config.js?permissions-test");
  assert.deepEqual(loadAccounts().map(({ accessMode, allowSend }) => ({ accessMode, allowSend })), [
    { accessMode: "organize", allowSend: false },
    { accessMode: "full", allowSend: true },
    { accessMode: "read-only", allowSend: false },
  ]);
  assert.equal(readFileSync(configPath, "utf8"), source);
  writeFileSync(configPath, JSON.stringify({ accounts: [{ name: "invalid", accessMode: "typo", allowSend: true }] }));
  assert.throws(loadAccounts, /Invalid accessMode/);
});
