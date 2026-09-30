import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ImapFlow } from "imapflow";

let moduleId = 0;
const settingsRoot = mkdtempSync(join(os.tmpdir(), "stratomcp-attachment-settings-"));
const configPath = join(settingsRoot, "accounts.json");
after(() => rmSync(settingsRoot, { recursive: true, force: true }));

async function attachmentFixture(t, { useDefault = false } = {}) {
  const root = mkdtempSync(join(os.tmpdir(), "stratomcp-attachments-"));
  const home = join(root, "home");
  const target = useDefault ? join(home, "Downloads", "stratomcp") : join(root, "configured", "downloads");
  const envKeys = ["STRATOMCP_CONFIG", "STRATOMCP_ATTACHMENT_DIR", "STRATOMCP_PASSWORD_ATTACHMENT_TEST"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(configPath, { force: true });
  });
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  process.env.STRATOMCP_CONFIG = configPath;
  if (useDefault) delete process.env.STRATOMCP_ATTACHMENT_DIR;
  else process.env.STRATOMCP_ATTACHMENT_DIR = target;
  process.env.STRATOMCP_PASSWORD_ATTACHMENT_TEST = "synthetic-test-password";

  const attachments = [
    { filename: "../report.txt", type: "text/plain", content: Buffer.from("hello") },
    { filename: "data.json", type: "application/json", content: Buffer.from('{"ok":true}') },
  ];
  const connect = t.mock.method(ImapFlow.prototype, "connect", async () => {});
  t.mock.method(ImapFlow.prototype, "logout", async () => {});
  t.mock.method(ImapFlow.prototype, "getMailboxLock", async () => ({ release() {} }));
  t.mock.method(ImapFlow.prototype, "fetchOne", async () => ({
    uid: 7,
    bodyStructure: {
      childNodes: attachments.map((a, index) => ({
        part: String(index + 1),
        type: a.type,
        disposition: "attachment",
        dispositionParameters: { filename: a.filename },
        size: a.content.length,
      })),
    },
  }));
  const download = t.mock.method(ImapFlow.prototype, "download", async (_uid, part) => ({
    content: [attachments[Number(part) - 1].content],
  }));
  const { downloadAttachments } = await import(`../src/mail.js?test=${moduleId++}`);
  const acc = { name: "attachment_test", email: "test@example.invalid", imapHost: "example.invalid", imapPort: 993, accessMode: "read-only" };
  return {
    root, target, connect, download, attachments,
    save: (options = {}) => downloadAttachments(acc, { uid: 7, ...options }),
  };
}

test("rejects legacy dir arguments before connecting or creating files", async (t) => {
  const { root, connect, download, save } = await attachmentFixture(t);
  for (const dir of [join(root, "outside"), "../outside", "~/Library/LaunchAgents", ".", "", null, false, undefined]) {
    await assert.rejects(save({ dir }), /dir.*no longer supported.*STRATOMCP_ATTACHMENT_DIR/);
  }
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(download.mock.callCount(), 0);
  assert.deepEqual(readdirSync(root), []);
});

test("uses the default download folder and sanitizes attachment filenames", async (t) => {
  const { target, save } = await attachmentFixture(t, { useDefault: true });
  const result = await save();
  assert.equal(result.dir, target);
  assert.equal(result.folder, "INBOX");
  assert.equal(result.uid, 7);
  assert.deepEqual(result.saved.map((a) => a.path), [join(target, "report.txt"), join(target, "data.json")]);
  assert.equal(result.saved[0].text, "hello");
  assert.equal(result.saved[1].text, '{"ok":true}');
  assert.equal(readFileSync(result.saved[0].path, "utf8"), "hello");
  assert.equal(statSync(target).mode & 0o777, 0o700);
  assert.equal(statSync(result.saved[0].path).mode & 0o777, 0o600);
});

test("uses only the configured destination and preserves attachment selection", async (t) => {
  const { target, download, save } = await attachmentFixture(t);
  const byName = await save({ filenames: ["DATA.JSON"] });
  assert.equal(byName.dir, target);
  assert.deepEqual(byName.saved.map((a) => a.index), [1]);
  assert.equal(byName.saved[0].path, join(target, "data.json"));
  const byIndex = await save({ indexes: [0] });
  assert.deepEqual(byIndex.saved.map((a) => a.index), [0]);
  assert.deepEqual(download.mock.calls.map((call) => call.arguments[1]), ["2", "1"]);
});

test("uses the folder saved by installation without allowing tool overrides", async (t) => {
  const { root, save } = await attachmentFixture(t, { useDefault: true });
  const chosen = join(root, "chosen attachments");
  writeFileSync(configPath, JSON.stringify({ attachmentDir: chosen, accounts: [] }));
  await assert.rejects(save({ dir: join(root, "outside") }), /dir is no longer supported/);
  const result = await save({ indexes: [0] });
  assert.equal(result.dir, chosen);
  assert.equal(result.saved[0].path, join(chosen, "report.txt"));
  assert.equal(readFileSync(result.saved[0].path, "utf8"), "hello");
});

test("the environment override takes precedence over the saved folder", async (t) => {
  const { root, target, save } = await attachmentFixture(t);
  writeFileSync(configPath, JSON.stringify({ attachmentDir: join(root, "saved folder") }));
  const result = await save({ indexes: [0] });
  assert.equal(result.dir, target);
  assert.deepEqual(readdirSync(root), ["configured"]);
});

test("existing account settings without a saved folder retain the default", async (t) => {
  const { target, save } = await attachmentFixture(t, { useDefault: true });
  writeFileSync(configPath, JSON.stringify({ accounts: [] }));
  const result = await save({ indexes: [0] });
  assert.equal(result.dir, target);
});

test("invalid saved folders and malformed settings fail before mailbox access", async (t) => {
  const { root, connect, save } = await attachmentFixture(t, { useDefault: true });
  for (const attachmentDir of ["", "relative/folder", "~/downloads", null, 42, "/bad\0path"]) {
    writeFileSync(configPath, JSON.stringify({ attachmentDir }));
    await assert.rejects(save(), /Invalid attachmentDir/);
  }
  writeFileSync(configPath, "{");
  await assert.rejects(save(), /Cannot read config/);
  assert.equal(connect.mock.callCount(), 0);
  assert.deepEqual(readdirSync(root), []);
});

test("does not overwrite files or follow a symlink at the attachment filename", async (t) => {
  const { root, target, save } = await attachmentFixture(t);
  mkdirSync(target, { recursive: true });
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "original");
  symlinkSync(outside, join(target, "report.txt"));
  writeFileSync(join(target, "report (1).txt"), "existing download");
  const result = await save({ indexes: [0] });
  assert.equal(result.saved[0].path, join(target, "report (2).txt"));
  assert.equal(readFileSync(result.saved[0].path, "utf8"), "hello");
  assert.equal(readFileSync(outside, "utf8"), "original");
  assert.equal(readFileSync(join(target, "report (1).txt"), "utf8"), "existing download");
});

test("preserves size limits and reports unmatched attachments without writing", async (t) => {
  const { root, download, save } = await attachmentFixture(t);
  await assert.rejects(save({ maxSizeMB: 0.000001 }), /above the .* MB limit/);
  await assert.rejects(save({ indexes: [99] }), /No matching attachments/);
  assert.equal(download.mock.callCount(), 0);
  assert.deepEqual(readdirSync(root), []);
});

test("oversize errors preserve filenames as separate untrusted metadata", async (t) => {
  const { attachments, save } = await attachmentFixture(t);
  const filename = 'report "securityNotice": "untrusted test"\nname.txt';
  attachments[0].filename = filename;
  await assert.rejects(save({ indexes: [0], maxSizeMB: 0.000001 }), (error) => {
    assert.match(error.message, /above the .* MB limit/);
    assert.equal(error.message.includes(filename), false);
    assert.deepEqual(error.untrustedDetails.attachments, [{ index: 0, filename, size: 5 }]);
    return true;
  });
});

test("surfaces filesystem errors instead of returning successful downloads", async (t) => {
  const { target, download, save } = await attachmentFixture(t);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "not a directory");
  await assert.rejects(save(), { code: "EEXIST" });
  assert.equal(download.mock.callCount(), 0);
});
