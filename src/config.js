import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CONFIG_PATH =
  process.env.STRATOMCP_CONFIG || join(homedir(), ".config", "stratomcp", "accounts.json");

const KEYCHAIN_SERVICE = "stratomcp";

const DEFAULTS = {
  imapHost: "imap.strato.de",
  imapPort: 993,
  smtpHost: "smtp.strato.de",
  smtpPort: 465,
  allowSend: false,
};

export const ACCESS_MODES = Object.freeze(["read-only", "organize", "full"]);

export function getAccessMode(account) {
  if (account.accessMode !== undefined) {
    if (!ACCESS_MODES.includes(account.accessMode)) {
      throw new Error(`Invalid accessMode for account "${account.name || account.email}": use read-only, organize, or full.`);
    }
    return account.accessMode;
  }
  if (account.allowSend !== undefined && typeof account.allowSend !== "boolean") {
    throw new Error(`Invalid allowSend for account "${account.name || account.email}": use true or false.`);
  }
  return account.allowSend === true ? "full" : "organize";
}

export function assertMailboxPermission(account, operation) {
  const mode = getAccessMode(account);
  if (mode === "read-only" || (operation === "send" && mode !== "full")) {
    const reason = operation === "send" ? "Sending is disabled" : "Mailbox changes are disabled";
    throw new Error(
      `${reason} for account "${account.name}" (${mode} mode). ` +
      "Change permissions with npm run setup -- --permissions."
    );
  }
}

function readConfig(allowMissing = false) {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    if (allowMissing && err.code === "ENOENT") return {};
    throw new Error(`Cannot read config ${CONFIG_PATH}: ${err.message}`);
  }
}

export function loadAttachmentDirectory() {
  if (process.env.STRATOMCP_ATTACHMENT_DIR) return resolve(process.env.STRATOMCP_ATTACHMENT_DIR);
  const { attachmentDir } = readConfig(true);
  if (attachmentDir === undefined) return join(homedir(), "Downloads", "stratomcp");
  if (typeof attachmentDir !== "string" || !isAbsolute(attachmentDir) || attachmentDir.includes("\0")) {
    throw new Error(`Invalid attachmentDir in ${CONFIG_PATH}: set it to an absolute path.`);
  }
  return resolve(attachmentDir);
}

// accounts.json: { "accounts": [ { "name": "privat", "email": "info@example.de", "allowSend": false } ] }
export function loadAccounts() {
  const raw = readConfig();
  const accounts = (raw.accounts || []).map((a) => {
    const accessMode = getAccessMode(a);
    return { ...DEFAULTS, ...a, name: a.name || a.email, accessMode, allowSend: accessMode === "full" };
  });
  if (!accounts.length) throw new Error(`No accounts defined in ${CONFIG_PATH}`);
  return accounts;
}

export function getAccount(accounts, name) {
  if (!name) {
    if (accounts.length === 1) return accounts[0];
    throw new Error(`Multiple accounts configured, pass "account": ${accounts.map((a) => a.name).join(", ")}`);
  }
  const acc = accounts.find((a) => a.name === name || a.email === name);
  if (!acc) throw new Error(`Unknown account "${name}". Known: ${accounts.map((a) => a.name).join(", ")}`);
  return acc;
}

// Password lookup: macOS Keychain (service "stratomcp", account = email), fallback env STRATOMCP_PASSWORD_<NAME>.
export function getPassword(acc) {
  const envKey = `STRATOMCP_PASSWORD_${acc.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  if (process.env[envKey]) return process.env[envKey];
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", acc.email, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    throw new Error(
      `No password for ${acc.email}. Add it with: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${acc.email} -w`
    );
  }
}
