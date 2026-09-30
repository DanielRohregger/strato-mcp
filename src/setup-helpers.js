import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ACCESS_MODES, getAccessMode } from "./config.js";

export function writePrivateJson(path, value) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

export async function configurePermissions(terminal, configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(config.accounts) || !config.accounts.length) {
    throw new Error("No mailboxes configured. Run npm run setup first.");
  }
  const accounts = [];
  for (const account of config.accounts) {
    const currentMode = getAccessMode(account);
    const currentChoice = ACCESS_MODES.indexOf(currentMode) + 1;
    console.log(`\nPermissions for ${account.name || account.email} (${account.email}); current mode: ${currentMode}`);
    console.log("1. Read-only mailbox: search, read and index; approved local downloads remain available.");
    console.log("2. Organize and draft: also mark read, change flags, move messages and save drafts; no sending.");
    console.log("3. Full access: also send email. Review client approval prompts for every consequential action.");
    while (true) {
      const answer = (await terminal.question(`Mailbox permission mode [${currentChoice}]: `)).trim();
      const choice = answer || String(currentChoice);
      if (!["1", "2", "3"].includes(choice)) {
        console.log("Enter 1, 2, or 3.");
        continue;
      }
      const accessMode = ACCESS_MODES[Number(choice) - 1];
      if (accessMode === "full" && currentMode !== "full") {
        const consent = (await terminal.question("Full access permits sending email. Type yes to enable it: ")).trim().toLowerCase();
        if (consent !== "yes") {
          console.log("Sending was not enabled. Choose a permission mode.");
          continue;
        }
      }
      accounts.push({ ...account, accessMode, allowSend: accessMode === "full" });
      break;
    }
  }
  writePrivateJson(configPath, { ...config, accounts });
  for (const account of accounts) console.log(`${account.name || account.email}: ${account.accessMode}`);
}

function isWithinDirectory(directory, path) {
  const fromDirectory = relative(directory, path);
  return fromDirectory === "" || (!isAbsolute(fromDirectory) && fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`));
}

export async function configureAttachmentDirectory(terminal, { configPath, defaultDirectory, projectRoot }) {
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  console.log("\nChoose a dedicated attachment folder outside the application directory, so updates keep your files.");
  console.log("Enter an absolute path or a path starting with ~/; press Return to keep the displayed folder.");
  if (process.env.STRATOMCP_ATTACHMENT_DIR) {
    console.log("STRATOMCP_ATTACHMENT_DIR overrides this saved choice in any server launched with that variable.");
  }
  while (true) {
    const answer = (await terminal.question(`Attachment download folder [${defaultDirectory}]: `)).trim();
    const selected = answer || defaultDirectory;
    const expanded = selected.startsWith("~/") ? join(homedir(), selected.slice(2)) : selected;
    if (!isAbsolute(expanded) || expanded.includes("\0")) {
      console.log("Enter an absolute folder path or use ~/ for your home directory.");
      continue;
    }
    const attachmentDir = resolve(expanded);
    if (isWithinDirectory(projectRoot, attachmentDir)) {
      console.log("Choose a folder outside the application directory; updates replace its contents.");
      continue;
    }
    try {
      mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
      if (isWithinDirectory(realpathSync(projectRoot), realpathSync(attachmentDir))) {
        throw new Error("Choose a folder outside the application directory, not a symlink into it.");
      }
      accessSync(attachmentDir, constants.W_OK | constants.X_OK);
    } catch (error) {
      console.log(`Cannot use attachment folder: ${error.message}`);
      continue;
    }
    writePrivateJson(configPath, { ...config, attachmentDir });
    console.log(`Saved attachment download folder: ${attachmentDir}`);
    return attachmentDir;
  }
}

export function isSupportedNodeVersion(version) {
  const [major, minor] = version.split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) && (major > 22 || (major === 22 && minor >= 13));
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function createAccountConfig(email, displayName) {
  return {
    accounts: [
      {
        name: "main",
        email,
        ...(displayName ? { displayName } : {}),
        accessMode: "read-only",
        allowSend: false,
      },
    ],
  };
}

export function mergeClaudeDesktopConfig(config, serverConfig) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Claude Desktop config must contain a JSON object");
  }
  if (
    config.mcpServers !== undefined &&
    (config.mcpServers === null || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))
  ) {
    throw new Error('Claude Desktop config property "mcpServers" must contain a JSON object');
  }
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers || {}),
      strato: serverConfig,
    },
  };
}
