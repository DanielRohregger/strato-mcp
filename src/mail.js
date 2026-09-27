import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { getPassword } from "./config.js";

const DEFAULT_MAX_ATTACHMENT_MB = Number(process.env.STRATOMCP_MAX_ATTACHMENT_MB) || 25;
const DEFAULT_ATTACHMENT_DIR = process.env.STRATOMCP_ATTACHMENT_DIR || join(homedir(), "Downloads", "stratomcp");

export async function withImap(acc, fn) {
  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: true,
    auth: { user: acc.email, pass: getPassword(acc) },
    logger: false,
    // Strato returns empty ESEARCH results for every query once IMAP4rev2 is enabled.
    disableIMAP4rev2: true,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function withMailbox(acc, folder, fn) {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

const addr = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

export async function listFolders(acc) {
  return withImap(acc, async (client) => {
    const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
    return folders.map((f) => ({
      path: f.path,
      specialUse: f.specialUse || null,
      messages: f.status?.messages ?? null,
      unseen: f.status?.unseen ?? null,
    }));
  });
}

async function findSpecialFolder(client, specialUse, fallbacks) {
  const folders = await client.list();
  const hit = folders.find((f) => f.specialUse === specialUse) ||
    folders.find((f) => fallbacks.some((n) => f.path.toLowerCase() === n.toLowerCase()));
  if (!hit) throw new Error(`No ${specialUse} folder found`);
  return hit.path;
}

export async function searchMessages(acc, { folder = "INBOX", from, to, subject, text, since, before, unseen, flagged, limit = 20 }) {
  return withMailbox(acc, folder, async (client) => {
    const query = {};
    if (from) query.from = from;
    if (to) query.to = to;
    if (subject) query.subject = subject;
    if (text) query.text = text;
    if (since) query.since = new Date(since);
    if (before) query.before = new Date(before);
    if (unseen) query.seen = false;
    if (flagged) query.flagged = true;
    if (!Object.keys(query).length) query.all = true;

    const uids = (await client.search(query, { uid: true })) || [];
    const latest = uids.sort((a, b) => b - a).slice(0, limit);
    if (!latest.length) return { folder, total: 0, messages: [] };

    const msgs = await client.fetchAll(latest, { uid: true, envelope: true, flags: true, size: true }, { uid: true });
    return {
      folder,
      total: uids.length,
      messages: msgs
        .sort((a, b) => b.uid - a.uid)
        .map((m) => ({
          uid: m.uid,
          date: m.envelope.date,
          from: addr(m.envelope.from),
          to: addr(m.envelope.to),
          subject: m.envelope.subject,
          seen: m.flags.has("\\Seen"),
          flagged: m.flags.has("\\Flagged"),
          size: m.size,
        })),
    };
  });
}

// Walk an IMAP BODYSTRUCTURE: pick the text body parts and list attachments without downloading them.
export function describeParts(node) {
  const out = { text: null, html: null, attachments: [] };
  const leaves = [];
  const walk = (n) => {
    if (n.childNodes?.length && n.type !== "message/rfc822") return n.childNodes.forEach(walk);
    leaves.push(n);
  };
  if (node) walk(node);
  const isText = (n) => /^text\/(plain|html)$/.test(n.type) && n.disposition !== "attachment";
  const filename = (n) => n.dispositionParameters?.filename || n.parameters?.name || null;
  // Body = text parts without a filename; if there are none, fall back to a named but non-attachment
  // text part (some senders label the HTML body "message.htm").
  const bodies = leaves.filter((n) => isText(n) && !filename(n));
  if (!bodies.length) {
    const fallback = leaves.find(isText);
    if (fallback) bodies.push(fallback);
  }
  for (const n of leaves) {
    const part = n.part || "1";
    if (bodies.includes(n)) {
      if (n.type === "text/plain") out.text ??= part;
      else out.html ??= part;
      continue;
    }
    // BODYSTRUCTURE size is the encoded size; base64 is ~4/3 of the decoded file.
    const size = n.encoding === "base64" ? Math.round((n.size * 3) / 4) : n.size;
    out.attachments.push({ index: out.attachments.length, part, filename: filename(n), contentType: n.type, size, inline: n.disposition === "inline" || undefined });
  }
  return out;
}

export async function downloadText(client, uid, part, maxBytes) {
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
  const chunks = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Same converter mailparser uses; images are skipped (inline data: URIs would dump base64 into the text).
export const htmlToText = (html) =>
  convert(html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Reply-header lines that mark the start of quoted history. "Am ... schrieb ...:" and "On ... wrote:"
// may wrap onto a second line, so each is also tested against the current+next line joined.
const REPLY_HEADER_RES = [
  /^am\s.+schrieb\s.+:\s*$/i,
  /^on\s.+wrote:\s*$/i,
  /^-{2,}\s*original message\s*-{2,}\s*$/i,
  /^-{2,}\s*urspr[uü]ngliche nachricht\s*-{2,}\s*$/i,
];

// Cuts quoted reply history from plain text. Pure function: takes text, returns { text, removed }.
// In a forward the quoted part is the content, so forwards are never stripped.
const FORWARD_RE = /(begin forwarded message|anfang der weitergeleiteten nachricht|-{3,}\s*(forwarded message|weitergeleitete nachricht|original-nachricht)|^\s*(fwd?|wg|weitergeleitet)\s*:)/im;

export function stripQuotedText(text) {
  if (FORWARD_RE.test(text)) return { text, removed: 0 };
  const lines = text.split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    if (REPLY_HEADER_RES.some((re) => re.test(line) || re.test(joined))) { cut = i; break; }
    if (/^(von|from):/i.test(line)) {
      for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
        if (/^(gesendet|sent):/i.test(lines[j].trim())) { cut = i; break; }
      }
      if (cut >= 0) break;
    }
  }
  const kept = cut >= 0 ? lines.slice(0, cut) : lines;
  const body = kept.filter((l) => !l.trimStart().startsWith(">")).join("\n");
  if (!body.trim()) return { text, removed: 0 };
  const removed = text.length - body.length;
  return removed > 0 ? { text: body, removed } : { text, removed: 0 };
}

// Per-message read, given an already-locked mailbox client. Returns { uid, error } if the uid doesn't exist.
async function fetchMessage(client, folder, uid, { markSeen, maxChars, offset, stripQuotes: doStrip }) {
  const msg = await client.fetchOne(
    String(uid),
    { uid: true, flags: true, envelope: true, bodyStructure: true, headers: ["references"] },
    { uid: true }
  );
  if (!msg) return { uid, error: "not found" };
  if (markSeen) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
  const parts = describeParts(msg.bodyStructure);
  const maxBytes = Math.min((offset + maxChars) * 4 + 4096, 2 * 1024 * 1024);
  let text = parts.text
    ? await downloadText(client, msg.uid, parts.text, maxBytes)
    : parts.html
      ? htmlToText(await downloadText(client, msg.uid, parts.html, maxBytes))
      : "";
  text = text.replace(/\r\n?/g, "\n");
  let quotedCharsRemoved;
  if (doStrip) {
    const stripped = stripQuotedText(text);
    if (stripped.removed > 0) { text = stripped.text; quotedCharsRemoved = stripped.removed; }
  }
  const bodyChars = text.length;
  const truncated = offset + maxChars < bodyChars;
  const body = text.slice(offset, offset + maxChars);
  const headers = await simpleParser(msg.headers || "");
  const e = msg.envelope;
  const attachments = parts.attachments.map(({ part, ...a }) => a);
  const result = {
    uid: msg.uid,
    folder,
    messageId: e.messageId,
    date: e.date,
    from: addr(e.from),
    to: addr(e.to),
    cc: addr(e.cc),
    replyTo: addr(e.replyTo),
    subject: e.subject,
    inReplyTo: e.inReplyTo,
    references: headers.references,
    flags: [...msg.flags],
    attachments,
    body,
    bodyChars,
    truncated,
  };
  if (truncated) result.nextOffset = offset + maxChars;
  if (quotedCharsRemoved) result.quotedCharsRemoved = quotedCharsRemoved;
  if (attachments.length) {
    const total = attachments.reduce((n, a) => n + (a.size || 0), 0);
    result.attachmentNote =
      `${attachments.length} attachment(s), ~${mb(total)}, not downloaded. ` +
      "If their content could matter, ask the user whether to fetch them with download_attachments (do not fetch without consent).";
  }
  return result;
}

// Only the text body is downloaded; attachments are listed from BODYSTRUCTURE and fetched on demand via downloadAttachments.
// Either uid (single message, thrown error if missing) or uids (1..20, one connection/lock, missing ones reported per-slot).
export async function getMessage(acc, { folder = "INBOX", uid, uids, markSeen = false, maxChars = 8000, offset = 0, stripQuotes = true }) {
  if ((uid == null) === (uids == null)) throw new Error("Provide exactly one of uid or uids");
  const opts = { markSeen, maxChars, offset, stripQuotes };
  if (uids) {
    if (uids.length < 1 || uids.length > 20) throw new Error("uids must contain 1 to 20 entries");
    return withMailbox(acc, folder, async (client) => {
      const messages = [];
      for (const u of uids) messages.push(await fetchMessage(client, folder, u, opts));
      return { folder, messages };
    });
  }
  return withMailbox(acc, folder, async (client) => {
    const result = await fetchMessage(client, folder, uid, opts);
    if (result.error) throw new Error(`Message uid ${uid} not found in ${folder}`);
    return result;
  });
}

const safeName = (name, index) =>
  basename(name || "").replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/^\.+/, "").trim() || `attachment-${index}`;

// Write without overwriting: "a.pdf" -> "a (1).pdf", "a (2).pdf", ...
function writeUnique(dir, name, content) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const path = join(dir, n ? `${stem} (${n})${ext}` : name);
    try {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return path;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

const TEXTUAL = /^(text\/|application\/(json|xml|csv|x-csv|ics))|\+xml$|\+json$/;
const INLINE_TEXT_CHARS = 30_000;

// Fetches only the selected MIME parts, never the whole message.
export async function downloadAttachments(acc, { folder = "INBOX", uid, indexes, filenames, dir, maxSizeMB = DEFAULT_MAX_ATTACHMENT_MB }) {
  return withMailbox(acc, folder, async (client) => {
    const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) throw new Error(`Message uid ${uid} not found in ${folder}`);
    const all = describeParts(msg.bodyStructure).attachments;
    const wanted = all.filter(
      (a) =>
        (!indexes?.length && !filenames?.length) ||
        indexes?.includes(a.index) ||
        filenames?.some((f) => f.toLowerCase() === (a.filename || "").toLowerCase())
    );
    if (!wanted.length) throw new Error(`No matching attachments (message has ${all.length})`);
    const total = wanted.reduce((n, a) => n + (a.size || 0), 0);
    if (total > maxSizeMB * 1024 * 1024) {
      throw new Error(
        `Selected attachments total ~${mb(total)}, above the ${maxSizeMB} MB limit. ` +
          `Confirm with the user, then retry with a higher maxSizeMB or fewer attachments: ` +
          wanted.map((a) => `#${a.index} ${a.filename} (${mb(a.size)})`).join(", ")
      );
    }
    const target = resolve(dir || DEFAULT_ATTACHMENT_DIR);
    mkdirSync(target, { recursive: true });
    const saved = [];
    for (const a of wanted) {
      const { content } = await client.download(String(msg.uid), a.part, { uid: true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const entry = {
        index: a.index,
        filename: a.filename,
        contentType: a.contentType,
        size: buf.length,
        path: writeUnique(target, safeName(a.filename, a.index), buf),
      };
      if (TEXTUAL.test(a.contentType) || /\.(txt|csv|json|xml|ics|md|log)$/i.test(a.filename || "")) {
        const text = buf.toString("utf8");
        entry.text = text.slice(0, INLINE_TEXT_CHARS);
        if (text.length > INLINE_TEXT_CHARS) entry.textTruncated = true;
      }
      saved.push(entry);
    }
    return { folder, uid: msg.uid, dir: target, saved };
  });
}

export async function updateFlags(acc, { folder = "INBOX", uids, seen, flagged }) {
  return withMailbox(acc, folder, async (client) => {
    const range = uids.join(",");
    const set = (on, flag) =>
      on === undefined ? null : on
        ? client.messageFlagsAdd(range, [flag], { uid: true })
        : client.messageFlagsRemove(range, [flag], { uid: true });
    await set(seen, "\\Seen");
    await set(flagged, "\\Flagged");
    return { folder, uids, seen, flagged };
  });
}

export async function moveMessages(acc, { folder = "INBOX", uids, destination }) {
  return withMailbox(acc, folder, async (client) => {
    const res = await client.messageMove(uids.join(","), destination, { uid: true });
    if (!res) throw new Error("Move failed");
    return { from: folder, to: destination, uidMap: Object.fromEntries(res.uidMap || []) };
  });
}

function composeMessage(acc, { to, cc, bcc, subject, text, html, inReplyTo, references }) {
  return {
    from: acc.displayName ? `${acc.displayName} <${acc.email}>` : acc.email,
    to, cc, bcc, subject, text, html, inReplyTo,
    references: references || inReplyTo,
  };
}

export async function saveDraft(acc, draft) {
  const raw = await new MailComposer(composeMessage(acc, draft)).compile().build();
  return withImap(acc, async (client) => {
    const drafts = await findSpecialFolder(client, "\\Drafts", ["Drafts", "Entwürfe", "Entwuerfe"]);
    const res = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
    return { folder: drafts, uid: res?.uid ?? null };
  });
}

export async function sendMessage(acc, mail) {
  if (!acc.allowSend) throw new Error(`Sending is disabled for account "${acc.name}" (set "allowSend": true in config). Use save_draft instead.`);
  const transport = nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: true,
    auth: { user: acc.email, pass: getPassword(acc) },
  });
  const message = composeMessage(acc, mail);
  const info = await transport.sendMail(message);
  // Strato does not auto-store SMTP mail in Sent; append a copy.
  const raw = await new MailComposer({ ...message, messageId: info.messageId }).compile().build();
  const sentFolder = await withImap(acc, async (client) => {
    const sent = await findSpecialFolder(client, "\\Sent", ["Sent", "Gesendet", "Gesendete Objekte"]);
    await client.append(sent, raw, ["\\Seen"]);
    return sent;
  }).catch(() => null);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, savedTo: sentFolder };
}
