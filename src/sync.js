#!/usr/bin/env node
// Usage: node src/sync.js [account] [--years N]
import { loadAccounts, getAccount } from "./config.js";
import { syncIndex } from "./index-db.js";

const args = process.argv.slice(2);
const yi = args.indexOf("--years");
const years = yi >= 0 ? Number(args.splice(yi, 2)[1]) : 3;
const accounts = loadAccounts();
const targets = args[0] ? [getAccount(accounts, args[0])] : accounts;

for (const acc of targets) {
  const started = Date.now();
  const res = await syncIndex(acc, { years, log: (m) => console.error(`[${acc.name}] ${m}`) });
  console.log(JSON.stringify({ account: acc.name, seconds: Math.round((Date.now() - started) / 1000), ...res }, null, 2));
}
