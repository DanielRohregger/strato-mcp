#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { CONFIG_PATH, getAccount, getPassword, loadAccounts } from "./config.js";
import { syncIndex } from "./index-db.js";
import { listFolders } from "./mail.js";
import {
  createAccountConfig,
  isSupportedNodeVersion,
  isValidEmail,
  mergeClaudeDesktopConfig,
} from "./setup-helpers.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_PATH = join(PROJECT_ROOT, "src", "index.js");
const CLAUDE_DESKTOP_CONFIG = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json"
);

function writePrivateJson(path, value) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error.message}`);
  }
}

function commandPath(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runInteractive(command, args, description) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw new Error(`${description}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${description} failed with exit code ${result.status}`);
}

async function askYesNo(terminal, question, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  while (true) {
    const answer = (await terminal.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Enter y or n.");
  }
}

async function askEmail(terminal) {
  while (true) {
    const email = (await terminal.question("Strato mailbox address: ")).trim();
    if (isValidEmail(email)) return email;
    console.log("Enter a complete email address.");
  }
}

function configureClaudeDesktop() {
  const existing = existsSync(CLAUDE_DESKTOP_CONFIG) ? readJson(CLAUDE_DESKTOP_CONFIG) : {};
  const updated = mergeClaudeDesktopConfig(existing, {
    command: process.execPath,
    args: [SERVER_PATH],
  });
  if (existsSync(CLAUDE_DESKTOP_CONFIG)) {
    const backupPath = `${CLAUDE_DESKTOP_CONFIG}.backup`;
    copyFileSync(CLAUDE_DESKTOP_CONFIG, backupPath);
    chmodSync(backupPath, 0o600);
  }
  writePrivateJson(CLAUDE_DESKTOP_CONFIG, updated);
  console.log(`Configured Claude Desktop: ${CLAUDE_DESKTOP_CONFIG}`);
}

function configureClaudeCode(claudePath) {
  const existing = spawnSync(claudePath, ["mcp", "get", "strato"], { stdio: "ignore" });
  if (existing.status === 0) {
    runInteractive(claudePath, ["mcp", "remove", "strato"], "Removing the existing Claude Code registration");
  }
  runInteractive(
    claudePath,
    ["mcp", "add", "--scope", "user", "strato", "--", process.execPath, SERVER_PATH],
    "Configuring Claude Code"
  );
  console.log("Configured Claude Code.");
}

function installHelperAgents() {
  const target = join(homedir(), ".claude", "agents");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["mail-search.md", "mail-analyst.md"]) {
    const destination = join(target, name);
    copyFileSync(join(PROJECT_ROOT, "agents", name), destination);
    chmodSync(destination, 0o600);
  }
  console.log(`Installed helper agents: ${target}`);
}

function storePassword(email) {
  console.log(`\nEnter the mailbox password for ${email} when Keychain prompts. Input is hidden.`);
  runInteractive(
    "security",
    ["add-generic-password", "-U", "-s", "stratomcp", "-a", email, "-w"],
    "Saving the password in macOS Keychain"
  );
}

async function configureAccounts(terminal) {
  if (existsSync(CONFIG_PATH) && (await askYesNo(terminal, "Keep the existing mailbox settings?"))) {
    const accounts = loadAccounts();
    for (const account of accounts) {
      try {
        getPassword(account);
      } catch {
        storePassword(account.email);
      }
    }
    return accounts;
  }

  const email = await askEmail(terminal);
  const displayName = (await terminal.question("Sender display name (optional): ")).trim();
  writePrivateJson(CONFIG_PATH, createAccountConfig(email, displayName));
  console.log(`Saved account settings: ${CONFIG_PATH}`);

  storePassword(email);
  return [getAccount(loadAccounts(), "main")];
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The guided setup currently supports macOS only");
  }
  if (!isSupportedNodeVersion(process.versions.node)) {
    throw new Error(`Node.js 22.13 or newer is required; found ${process.versions.node}`);
  }

  console.log("\nstratomcp setup");
  console.log("================\n");
  console.log("Your password will be stored in macOS Keychain, never in a file.\n");

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const accounts = await configureAccounts(terminal);

    for (const account of accounts) {
      console.log(`\nTesting ${account.email}...`);
      const folders = await listFolders(account);
      console.log(`Connected successfully. Found ${folders.length} folders.`);
    }

    if (await askYesNo(terminal, "Build or update the local three-year search index?")) {
      console.log("Indexing mail. This can take several minutes.");
      for (const account of accounts) {
        const result = await syncIndex(account, {
          years: 3,
          log: (message) => console.log(`[${account.name}] ${message}`),
        });
        console.log(`[${account.name}] Index ready with ${result.indexed} messages.`);
      }
    }

    if (await askYesNo(terminal, "Connect stratomcp to Claude Desktop?")) {
      configureClaudeDesktop();
    }

    const claudePath = commandPath("claude");
    if (claudePath && (await askYesNo(terminal, "Connect stratomcp to Claude Code?"))) {
      configureClaudeCode(claudePath);
      if (await askYesNo(terminal, "Install the optional Claude Code mail helper agents?")) {
        installHelperAgents();
      }
    }

    console.log("\nSetup complete.");
    console.log("Restart Claude Desktop or open a new Claude Code session, then ask: Which mail folders do I have?");
    console.log("Sending remains disabled until allowSend is set to true in the account settings.");
  } finally {
    terminal.close();
  }
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  process.exitCode = 1;
});
