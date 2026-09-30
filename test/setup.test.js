import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureAttachmentDirectory,
  configurePermissions,
  createAccountConfig,
  isSupportedNodeVersion,
  isValidEmail,
  mergeClaudeDesktopConfig,
} from "../src/setup-helpers.js";

test("accepts the minimum supported Node.js version", () => {
  assert.equal(isSupportedNodeVersion("22.13.0"), true);
  assert.equal(isSupportedNodeVersion("22.12.0"), false);
  assert.equal(isSupportedNodeVersion("24.0.0"), true);
});

test("validates mailbox addresses", () => {
  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("missing-domain@"), false);
  assert.equal(isValidEmail("not an email"), false);
});

test("creates a read-only account configuration", () => {
  assert.deepEqual(createAccountConfig("user@example.com", "Example User"), {
    accounts: [
      {
        name: "main",
        email: "user@example.com",
        displayName: "Example User",
        accessMode: "read-only",
        allowSend: false,
      },
    ],
  });
});

test("adds the server without changing other Claude Desktop settings", () => {
  const original = {
    theme: "dark",
    mcpServers: {
      existing: { command: "existing-server" },
    },
  };
  const result = mergeClaudeDesktopConfig(original, {
    command: "/usr/local/bin/node",
    args: ["/path/to/src/index.js"],
  });

  assert.deepEqual(result, {
    theme: "dark",
    mcpServers: {
      existing: { command: "existing-server" },
      strato: {
        command: "/usr/local/bin/node",
        args: ["/path/to/src/index.js"],
      },
    },
  });
  assert.equal(original.mcpServers.strato, undefined);
});

test("rejects a malformed Claude Desktop server collection", () => {
  assert.throws(
    () => mergeClaudeDesktopConfig({ mcpServers: [] }, { command: "node", args: [] }),
    /mcpServers/
  );
});

test("installation saves a chosen folder and keeps it on subsequent runs", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "stratomcp-folder-setup-"));
  const configPath = join(root, "settings", "accounts.json");
  const projectRoot = join(root, "app");
  mkdirSync(projectRoot);
  const defaultDirectory = join(root, "downloads");
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(os, "homedir", () => root);
  syncBuiltinESMExports();
  t.mock.method(console, "log", () => {});
  const prompts = [];
  const terminal = { async question(prompt) { prompts.push(prompt); return "~/My Mail/attachments"; } };
  const selected = await configureAttachmentDirectory(terminal, { configPath, defaultDirectory, projectRoot });
  assert.equal(selected, join(root, "My Mail", "attachments"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).attachmentDir, selected);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(selected).mode & 0o777, 0o700);

  const original = { ...createAccountConfig("user@example.com", "User"), attachmentDir: selected };
  writeFileSync(configPath, JSON.stringify(original));
  terminal.question = async (prompt) => { prompts.push(prompt); return ""; };
  assert.equal(
    await configureAttachmentDirectory(terminal, { configPath, defaultDirectory: selected, projectRoot }),
    selected
  );
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
  assert.ok(prompts[1].includes(selected));
});

test("installation retries invalid, app-local and unusable download folders", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "stratomcp-folder-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = t.mock.method(console, "log", () => {});
  const configPath = join(root, "accounts.json");
  const projectRoot = join(root, "app");
  mkdirSync(projectRoot);
  const linkedApplication = join(root, "linked-app");
  symlinkSync(projectRoot, linkedApplication);
  const defaultDirectory = join(root, "downloads");
  const file = join(root, "file.txt");
  writeFileSync(file, "not a folder");
  const answers = ["relative/path", projectRoot, join(projectRoot, "downloads"), linkedApplication, file, ""];
  let calls = 0;
  const terminal = { async question() {
    assert.ok(calls < answers.length, "unexpected extra prompt");
    return answers[calls++];
  } };
  const selected = await configureAttachmentDirectory(terminal, { configPath, defaultDirectory, projectRoot });
  assert.equal(selected, defaultDirectory);
  assert.equal(calls, answers.length);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).attachmentDir, selected);
  assert.ok(log.mock.calls.some((call) => call.arguments[0].includes("Cannot use attachment folder")));
});

test("permission setup preserves legacy modes and unrelated settings for every mailbox", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "stratomcp-permission-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const configPath = join(root, "accounts.json");
  const original = {
    attachmentDir: join(root, "downloads"),
    accounts: [
      { name: "first", email: "first@example.invalid", allowSend: false, displayName: "First" },
      { name: "second", email: "second@example.invalid", allowSend: true, smtpPort: 465 },
      { name: "third", email: "third@example.invalid", accessMode: "read-only", allowSend: false },
    ],
  };
  writeFileSync(configPath, JSON.stringify(original));
  const prompts = [];
  await configurePermissions({ async question(prompt) { prompts.push(prompt); return ""; } }, configPath);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.attachmentDir, original.attachmentDir);
  assert.deepEqual(saved.accounts, original.accounts.map((account, index) => ({
    ...account, accessMode: ["organize", "full", "read-only"][index],
  })));
  assert.deepEqual(prompts.map((prompt) => prompt.match(/\[(\d)\]/)[1]), ["2", "3", "1"]);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});

test("permission setup validates choices, confirms sending, and supports upgrades and downgrades", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "stratomcp-permission-transitions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const configPath = join(root, "accounts.json");
  writeFileSync(configPath, JSON.stringify(createAccountConfig("test@example.invalid", "")));
  for (const [choices, accessMode] of [
    [["invalid", "3", "no", "2"], "organize"],
    [["3", "yes"], "full"],
    [["1"], "read-only"],
  ]) {
    const answers = [...choices];
    await configurePermissions({ async question() {
      assert.ok(answers.length, "unexpected permission prompt");
      return answers.shift();
    } }, configPath);
    assert.equal(answers.length, 0);
    const [account] = JSON.parse(readFileSync(configPath, "utf8")).accounts;
    assert.equal(account.accessMode, accessMode);
    assert.equal(account.allowSend, accessMode === "full");
  }
});
