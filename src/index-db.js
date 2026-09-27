import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { simpleParser } from "mailparser";
import { withImap, describeParts, downloadText, htmlToText } from "./mail.js";

export const DB_PATH =
  process.env.STRATOMCP_DB || join(homedir(), "Library", "Application Support", "stratomcp", "mail.db");

const SOURCE_BYTES = 256 * 1024;
const TEXT_PART_BYTES = 200 * 1024;
const MAX_BODY_CHARS = 20_000;
const FETCH_BATCH = 200; // Strato rejects command lines > ~20 KB
const SKIP_SPECIAL = ["\\Junk", "\\Trash"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
    message_id TEXT, date INTEGER, from_addr TEXT, to_addr TEXT, cc TEXT,
    subject TEXT, body TEXT, attachments TEXT,
    UNIQUE (account, folder, uid)
  );
  CREATE INDEX IF NOT EXISTS messages_date ON messages (account, date);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject, from_addr, to_addr, body, attachments,
    content = 'messages', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, subject, from_addr, to_addr, body, attachments)
    VALUES (new.id, new.subject, new.from_addr, new.to_addr, new.body, new.attachments);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, subject, from_addr, to_addr, body, attachments)
    VALUES ('delete', old.id, old.subject, old.from_addr, old.to_addr, old.body, old.attachments);
  END;
  CREATE TABLE IF NOT EXISTS sync_state (
    account TEXT NOT NULL, folder TEXT NOT NULL, uidvalidity TEXT, synced_at INTEGER,
    PRIMARY KEY (account, folder)
  );
`;

let db;
export function openDb() {
  if (db) return db;
  const fresh = !existsSync(DB_PATH);
  mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(DB_PATH);
  if (fresh) chmodSync(DB_PATH, 0o600);

  // Detect a pre-attachments FTS index so we know to rebuild it below.
  const ftsCols = fresh ? [] : db.prepare("PRAGMA table_info(messages_fts)").all().map((c) => c.name);
  const needsMigration = ftsCols.length > 0 && !ftsCols.includes("attachments");

  db.exec("PRAGMA journal_mode = WAL");
  if (!needsMigration) {
    db.exec(SCHEMA);
    return db;
  }
  // Old 4-column FTS: drop it, recreate with attachments and rebuild from messages, atomically.
  db.exec("BEGIN");
  try {
    db.exec("DROP TRIGGER IF EXISTS messages_ai; DROP TRIGGER IF EXISTS messages_ad; DROP TABLE messages_fts;");
    db.exec(SCHEMA);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return db;
}

const addr = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

// Tracking links bloat the index and snippets; keep only the host.
function stripUrls(text) {
  return text.replace(/https?:\/\/([^\/\s)\]>"']+)[^\s)\]>"']*/gi, "$1").replace(/[ \t]+/g, " ");
}

const inFlight = new Map(); // account name -> in-progress syncIndex promise

// Incremental sync of all folders (except Spam/Trash) for mail on/after `since`.
// Concurrent calls for the same account share one run instead of erroring.
export function syncIndex(acc, opts = {}) {
  if (inFlight.has(acc.name)) return inFlight.get(acc.name);
  const p = runSync(acc, opts).finally(() => inFlight.delete(acc.name));
  inFlight.set(acc.name, p);
  return p;
}

async function runSync(acc, { years = 3, log = () => {} } = {}) {
  const d = openDb();
  const since = new Date();
  since.setFullYear(since.getFullYear() - years);
  const insert = d.prepare(`INSERT OR IGNORE INTO messages
    (account, folder, uid, message_id, date, from_addr, to_addr, cc, subject, body, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const del = d.prepare("DELETE FROM messages WHERE account = ? AND folder = ? AND uid = ?");
  const stats = { added: 0, removed: 0, folders: {} };

  await withImap(acc, async (client) => {
    const folders = (await client.list()).filter((f) => !SKIP_SPECIAL.includes(f.specialUse));
    for (const f of folders) {
      const lock = await client.getMailboxLock(f.path);
      try {
        const uidvalidity = String(client.mailbox.uidValidity);
        const state = d.prepare("SELECT uidvalidity FROM sync_state WHERE account = ? AND folder = ?").get(acc.name, f.path);
        if (state && state.uidvalidity !== uidvalidity) {
          d.prepare("DELETE FROM messages WHERE account = ? AND folder = ?").run(acc.name, f.path);
        }

        const serverUids = new Set((await client.search({ since }, { uid: true })) || []);
        const localUids = new Set(
          d.prepare("SELECT uid FROM messages WHERE account = ? AND folder = ?").all(acc.name, f.path).map((r) => r.uid)
        );
        const gone = [...localUids].filter((u) => !serverUids.has(u));
        const missing = [...serverUids].filter((u) => !localUids.has(u)).sort((a, b) => b - a); // newest first

        d.exec("BEGIN");
        for (const u of gone) del.run(acc.name, f.path, u);
        d.exec("COMMIT");

        let added = 0;
        for (let i = 0; i < missing.length; i += FETCH_BATCH) {
          const batch = missing.slice(i, i + FETCH_BATCH);
          // Attachments are never downloaded: mail without attachments is fetched whole (batched),
          // mail with attachments only gets its text part fetched.
          const heads = await client.fetchAll(batch, { uid: true, envelope: true, bodyStructure: true }, { uid: true });
          const plain = [];
          const rows = [];
          const row = (m, p, body, atts) => {
            const date = p.date || m.envelope?.date;
            rows.push([
              acc.name, f.path, m.uid,
              p.messageId || m.envelope?.messageId || null,
              date ? new Date(date).getTime() : null,
              p.from?.text || addr(m.envelope?.from), p.to?.text || addr(m.envelope?.to), p.cc?.text || addr(m.envelope?.cc),
              p.subject || m.envelope?.subject || "",
              stripUrls(body).slice(0, MAX_BODY_CHARS),
              atts.map((a) => a.filename || a.contentType).join(", "),
            ]);
          };
          for (const m of heads) {
            const parts = describeParts(m.bodyStructure);
            if (!parts.attachments.length) { plain.push(m.uid); continue; }
            let body = "";
            try {
              body = parts.text
                ? await downloadText(client, m.uid, parts.text, TEXT_PART_BYTES)
                : parts.html ? htmlToText(await downloadText(client, m.uid, parts.html, TEXT_PART_BYTES)) : "";
            } catch {}
            row(m, {}, body, parts.attachments);
          }
          if (plain.length) {
            const msgs = await client.fetchAll(
              plain,
              { uid: true, envelope: true, source: { maxLength: SOURCE_BYTES } },
              { uid: true }
            );
            for (const m of msgs) {
              let p = {};
              try {
                p = await simpleParser(m.source, { skipImageLinks: true, skipTextToHtml: true });
              } catch {}
              row(m, p, p.text || (p.html ? htmlToText(p.html) : ""), []);
            }
          }
          d.exec("BEGIN");
          for (const r of rows) added += Number(insert.run(...r).changes);
          d.exec("COMMIT");
          log(`${f.path}: ${Math.min(i + FETCH_BATCH, missing.length)}/${missing.length}`);
        }

        d.prepare(`INSERT INTO sync_state (account, folder, uidvalidity, synced_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (account, folder) DO UPDATE SET uidvalidity = excluded.uidvalidity, synced_at = excluded.synced_at`)
          .run(acc.name, f.path, uidvalidity, Date.now());
        stats.added += added;
        stats.removed += gone.length;
        if (added || gone.length) stats.folders[f.path] = { added, removed: gone.length };
      } finally {
        lock.release();
      }
    }
  });
  return { ...stats, ...indexStats(acc) };
}

// Turn free text into a safe FTS5 query: each word becomes a quoted prefix term, implicitly ANDed.
function toFtsQuery(q) {
  return q
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(" ");
}

export function searchIndex(acc, { query, from, to, folder, since, before, sort = "relevance", limit = 20, raw = false }) {
  const d = openDb();
  const where = ["m.account = ?"];
  const params = [acc.name];
  if (from) { where.push("m.from_addr LIKE ?"); params.push(`%${from}%`); }
  if (to) { where.push("(m.to_addr LIKE ? OR m.cc LIKE ?)"); params.push(`%${to}%`, `%${to}%`); }
  if (folder) { where.push("m.folder = ?"); params.push(folder); }
  if (since) { where.push("m.date >= ?"); params.push(new Date(since).getTime()); }
  if (before) { where.push("m.date < ?"); params.push(new Date(before).getTime()); }

  const cols = "m.folder, m.uid, m.date, m.from_addr AS 'from', m.to_addr AS 'to', m.subject, m.attachments";
  let sql, args;
  if (query) {
    const order = sort === "date" ? "m.date DESC" : "bm25(messages_fts, 5.0, 3.0, 1.0, 1.0, 2.0)";
    sql = `SELECT ${cols}, snippet(messages_fts, 3, '[', ']', ' … ', 24) AS snippet
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ? AND ${where.join(" AND ")}
      ORDER BY ${order} LIMIT ?`;
    args = [raw ? query : toFtsQuery(query), ...params, limit];
  } else {
    sql = `SELECT ${cols}, substr(m.body, 1, 200) AS snippet FROM messages m
      WHERE ${where.join(" AND ")} ORDER BY m.date DESC LIMIT ?`;
    args = [...params, limit];
  }
  const rows = d.prepare(sql).all(...args);
  return rows.map(({ attachments, ...r }) => ({
    ...r,
    date: r.date ? new Date(r.date).toISOString() : null,
    ...(attachments ? { attachments } : {}),
  }));
}

export function indexStats(acc) {
  const d = openDb();
  const s = d.prepare("SELECT COUNT(*) AS messages, MIN(date) AS oldest, MAX(date) AS newest FROM messages WHERE account = ?").get(acc.name);
  const last = d.prepare("SELECT MAX(synced_at) AS t FROM sync_state WHERE account = ?").get(acc.name);
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  return { indexed: s.messages, oldest: iso(s.oldest), newest: iso(s.newest), lastSync: iso(last.t), dbPath: DB_PATH };
}

// Runs (or joins) an incremental sync if the account's index is stale. Does nothing on an empty
// index (the initial full sync is explicit only, via sync_index). Never throws.
export async function ensureFresh(acc, { maxAgeMs = 5 * 60 * 1000 } = {}) {
  try {
    const stats = indexStats(acc);
    if (!stats.indexed) return { synced: false };
    const lastSync = stats.lastSync ? new Date(stats.lastSync).getTime() : 0;
    if (Date.now() - lastSync < maxAgeMs) return { synced: false };
    await syncIndex(acc, {});
    return { synced: true };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

// Kicks off ensureFresh for every account now and then on an interval. Fire-and-forget; errors go
// to stderr only. Returns the interval timer (unref'd, so it never keeps the process alive).
export function startBackgroundSync(accounts, { intervalMs = 10 * 60 * 1000 } = {}) {
  const tick = () => {
    for (const acc of accounts) {
      ensureFresh(acc)
        .then((r) => { if (r.error) console.error(`[${acc.name}] background sync: ${r.error}`); })
        .catch((err) => console.error(`[${acc.name}] background sync: ${err.message}`));
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}
