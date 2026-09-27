import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

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

// accounts.json: { "accounts": [ { "name": "privat", "email": "info@example.de", "allowSend": false } ] }
export function loadAccounts() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read config ${CONFIG_PATH}: ${err.message}`);
  }
  const accounts = (raw.accounts || []).map((a) => ({ ...DEFAULTS, ...a, name: a.name || a.email }));
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
