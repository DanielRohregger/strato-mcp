import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function verifyGuidedSetup(t, existingSettings) {
  const root = mkdtempSync(join(tmpdir(), "stratomcp-setup-flow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "accounts.json");
  const savedDirectory = join(root, "chosen attachments");
  const desktopPath = join(root, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (existingSettings) {
    writeFileSync(configPath, JSON.stringify({
      accounts: [{ name: "main", email: "old@example.invalid", allowSend: false }],
      attachmentDir: savedDirectory,
    }));
  }
  mkdirSync(join(desktopPath, ".."), { recursive: true });
  writeFileSync(desktopPath, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import os from "node:os";
    import readline from "node:readline/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { mock } from "node:test";
    import { ImapFlow } from "imapflow";
    Object.defineProperty(process, "platform", { value: "darwin" });
    mock.method(os, "homedir", () => process.env.TEST_HOME);
    const existingSettings = process.env.TEST_EXISTING_SETTINGS === "true";
    const answers = [
      ...(existingSettings ? [["Keep the existing", "n"]] : []),
      ["Strato mailbox", "new@example.invalid"], ["Sender display name", "New User"],
      ["Mailbox permission mode [1]", ""],
      ["Attachment download folder", existingSettings ? "" : process.env.TEST_SAVED_DIR],
      ["Build or update", "n"], ["Connect stratomcp to Claude Desktop", "y"],
      ["Connect stratomcp to Claude Code", "y"], ["Install the optional", "n"],
    ];
    mock.method(readline, "createInterface", () => ({
      async question(prompt) {
        const next = answers.shift();
        assert.ok(next, "unexpected prompt: " + prompt);
        assert.ok(prompt.includes(next[0]), prompt);
        if (next[0] === "Attachment download folder" && existingSettings) assert.ok(prompt.includes(process.env.TEST_SAVED_DIR));
        return next[1];
      },
      close() { assert.equal(answers.length, 0); },
    }));
    mock.method(childProcess, "spawnSync", (command, args) => {
      if (command === "security") return { status: 0 };
      if (command === "which") return { status: 0, stdout: "/synthetic/claude" };
      assert.equal(command, "/synthetic/claude");
      if (args[1] === "add") console.log("TEST_CLAUDE_CODE_REGISTERED");
      return { status: 0 };
    });
    mock.method(ImapFlow.prototype, "connect", async () => {});
    mock.method(ImapFlow.prototype, "logout", async () => {});
    mock.method(ImapFlow.prototype, "list", async () => []);
    syncBuiltinESMExports();
    await import("./src/setup.js");
  `], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      TEST_HOME: root,
      TEST_SAVED_DIR: savedDirectory,
      TEST_EXISTING_SETTINGS: String(existingSettings),
      STRATOMCP_CONFIG: configPath,
      STRATOMCP_ATTACHMENT_DIR: "",
      STRATOMCP_PASSWORD_MAIN: "synthetic-test-password",
    },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Setup complete/);
  assert.match(result.stdout, /TEST_CLAUDE_CODE_REGISTERED/);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.attachmentDir, savedDirectory);
  assert.equal(config.accounts[0].email, "new@example.invalid");
  assert.equal(config.accounts[0].accessMode, "read-only");
  assert.equal(config.accounts[0].allowSend, false);
  const desktop = JSON.parse(readFileSync(desktopPath, "utf8"));
  assert.equal(desktop.theme, "dark");
  assert.equal(desktop.mcpServers.other.command, "other");
  assert.ok(desktop.mcpServers.strato.args[0].endsWith("/src/index.js"));
}

test("fresh setup saves the chosen folder and registers both clients", (t) => verifyGuidedSetup(t, false));
test("setup retains the chosen folder when replacing mailbox settings", (t) => verifyGuidedSetup(t, true));

test("permissions can be changed later without accessing Keychain, mail, or client registrations", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stratomcp-permissions-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "accounts.json");
  const config = {
    attachmentDir: join(root, "downloads"),
    accounts: [{ name: "main", email: "test@example.invalid", accessMode: "full", allowSend: true }],
  };
  writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import readline from "node:readline/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { mock } from "node:test";
    import { ImapFlow } from "imapflow";
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.argv = [process.execPath, "src/setup.js", "--permissions"];
    let prompts = 0;
    mock.method(readline, "createInterface", () => ({
      async question(prompt) {
        assert.match(prompt, /Mailbox permission mode \\[3\\]/);
        prompts++;
        return "1";
      },
      close() { assert.equal(prompts, 1); },
    }));
    mock.method(childProcess, "spawnSync", () => { throw new Error("Unexpected external command"); });
    mock.method(childProcess, "execFileSync", () => { throw new Error("Unexpected Keychain access"); });
    mock.method(ImapFlow.prototype, "connect", async () => { throw new Error("Unexpected mailbox connection"); });
    syncBuiltinESMExports();
    await import("./src/setup.js");
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, STRATOMCP_CONFIG: configPath, STRATOMCP_DB: join(root, "mail.db") },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Permissions saved/);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    ...config, accounts: [{ ...config.accounts[0], accessMode: "read-only", allowSend: false }],
  });
});
