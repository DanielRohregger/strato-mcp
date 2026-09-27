---
title: stratomcp
description: Local MCP server for searching and managing a Strato mailbox with Claude
---

## Search your Strato mailbox with Claude

stratomcp is a local [Model Context Protocol (MCP) server](https://modelcontextprotocol.io)
for Strato email. It lets Claude search, read, organize, and draft messages while
keeping your password in macOS Keychain and the searchable mail index on your Mac.

> [!IMPORTANT]
> stratomcp is not affiliated with or endorsed by STRATO AG.

## Features

| Feature | What it does | MCP tools |
|---|---|---|
| Local mail index | Builds and automatically refreshes a private SQLite full-text index for fast searches across the last three years | `sync_index`, `search_index`, `index_stats` |
| Live mailbox search | Searches current messages directly through Strato IMAP, including mail outside the local index | `search_messages` |
| Message reading | Reads one message or batches up to 20 messages, with long-body paging and quoted-reply cleanup | `get_message` |
| Mailbox overview | Lists configured accounts, folders, message counts, and unread counts | `list_accounts`, `list_folders` |
| Attachment control | Lists attachments without downloading them, then downloads only the files you approve | `get_message`, `download_attachments` |
| Mail organization | Marks messages read, unread, flagged, or unflagged and moves messages between folders | `update_flags`, `move_messages` |
| Safe composing | Saves drafts by default and sends mail only when sending is explicitly enabled | `save_draft`, `send_message` |

## Quick setup

### What you need

* macOS
* A Strato mailbox and its mailbox password
* [Node.js](https://nodejs.org/) 22.13 or newer
* Claude Desktop, Claude Code, or both

### Install with one click

1. Download and unzip this repository.
2. Double-click **`Setup.command`**.
3. Follow the prompts in Terminal.

The setup assistant:

* Installs stratomcp in
  `~/Library/Application Support/stratomcp/app`
* Stores your account settings in `~/.config/stratomcp/accounts.json`
* Stores your mailbox password in macOS Keychain
* Tests the mailbox connection
* Offers to build the local search index
* Adds stratomcp to Claude Desktop
* Adds stratomcp to Claude Code when the `claude` command is installed
* Offers to install the optional Claude Code mail helper agents

Sending email remains disabled. The setup assistant never writes your password to a
file.

> [!NOTE]
> If macOS blocks the first launch, Control-click `Setup.command`, select **Open**,
> then confirm **Open**. You only need to do this once.

### Terminal alternative

Developers working from a clone can run:

```bash
npm install
npm run setup
```

The Terminal alternative uses the current checkout as the installed server path.

## Try it

Restart Claude Desktop after setup, or start a new Claude Code session. Then ask:

* "Which mail folders do I have?"
* "Find the latest invoice from my internet provider."
* "Summarize the open points in the thread with the landlord."
* "Draft a reply to the latest message, but do not send it."

The first index build can take several minutes for a large mailbox. Later updates run
automatically while the MCP server is active.

## Safety model

### Read-only by default

The generated account configuration sets `allowSend` to `false`. Claude can save a
draft, but the server refuses to send it. Enable sending only after reviewing the
security implications in [Sending email](#sending-email).

Reading a message does not mark it as read unless a tool call explicitly requests
that change. Attachments are listed but not downloaded until you approve a download.

### Email is untrusted content

Email bodies, headers, attachment names, and attachment contents can contain
malicious instructions. stratomcp labels returned mail as untrusted and tells the
assistant not to treat mail content as authorization.

You should still review every proposed action. Do not approve moving, flagging,
downloading, drafting, or sending merely because an email asks for it.

### What stays on your Mac

* The password stays in macOS Keychain.
* Account settings stay in `~/.config/stratomcp/accounts.json`.
* The local index stays in
  `~/Library/Application Support/stratomcp/mail.db`.
* Downloaded attachments go to `~/Downloads/stratomcp` by default.
* Files containing account or indexed mail data are created with user-only
  permissions.

The index contains message text, senders, recipients, subjects, and attachment
names from the last three years. It does not contain attachment contents. Enable
FileVault if the Mac may store sensitive mail.

### What the AI provider receives

stratomcp does not upload the index. Claude receives only the search results,
messages, or approved attachment contents used in the current conversation, in the
same way it receives text pasted into a chat.

## Everyday use

### Search

The local SQLite index covers the last three years and excludes Spam and Trash.
Searches return matching snippets in milliseconds. Older mail and excluded folders
remain available through a slower live IMAP search.

The server refreshes a populated index:

* When the MCP server starts
* Every 10 minutes while it runs
* Before a search when the index is more than 5 minutes old

### Attachments

Claude sees attachment names, types, and sizes before downloading anything. When you
approve a download, stratomcp:

* Fetches only the selected attachments
* Refuses downloads above 25 MB unless you approve a higher limit
* Writes files without overwriting existing files
* Returns text-like files inline and saves other files locally

### Sending email

Drafting is enabled by default. Sending is not.

To enable sending, edit `~/.config/stratomcp/accounts.json`, change `allowSend` to
`true`, and restart Claude. Keep sending disabled unless you need it, and inspect
recipients and content before approving any send action.

## Configuration

The setup assistant creates:

```json
{
  "accounts": [
    {
      "name": "main",
      "email": "user@example.com",
      "displayName": "Example User",
      "allowSend": false
    }
  ]
}
```

### Multiple mailboxes

Add another object to `accounts`, then rerun `npm run setup` from the installed app
directory. The assistant prompts for any missing Keychain password and tests every
account. Each account name must be unique.

```json
{
  "accounts": [
    {
      "name": "main",
      "email": "user@example.com",
      "displayName": "Example User",
      "allowSend": false
    },
    {
      "name": "work",
      "email": "user@example.org",
      "displayName": "Example User",
      "allowSend": false
    }
  ]
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `STRATOMCP_CONFIG` | Override the account settings path |
| `STRATOMCP_PASSWORD_<NAME>` | Supply a password without Keychain |
| `STRATOMCP_DB` | Override the SQLite index path |
| `STRATOMCP_ATTACHMENT_DIR` | Override the attachment download directory |
| `STRATOMCP_MAX_ATTACHMENT_MB` | Change the default attachment size limit |

For example, the password variable for an account named `main` is
`STRATOMCP_PASSWORD_MAIN`.

## Available tools

| Tool | Purpose |
|---|---|
| `list_accounts` | List configured mailboxes |
| `list_folders` | List folders with message and unread counts |
| `search_index` | Search the local full-text index |
| `search_messages` | Search the mailbox through live IMAP |
| `get_message` | Read one message or a batch of up to 20 |
| `download_attachments` | Download selected attachments after approval |
| `update_flags` | Mark messages read, unread, flagged, or unflagged |
| `move_messages` | Move messages to another folder |
| `save_draft` | Save a draft without sending |
| `send_message` | Send mail when `allowSend` is enabled |
| `sync_index` | Update the local index |
| `index_stats` | Show index size and synchronization status |

## Update

Download and unzip the new version, then double-click its `Setup.command`. The
launcher replaces only the installed application files. It preserves your account
settings, Keychain password, index, and downloaded attachments.

## Uninstall

Remove the Claude Code registration if it was installed:

```bash
claude mcp remove strato
```

Remove the installed application, settings, index, and Keychain password:

```bash
rm -rf "$HOME/Library/Application Support/stratomcp"
rm -rf "$HOME/.config/stratomcp"
security delete-generic-password -s stratomcp -a user@example.com
```

Replace `user@example.com` with your mailbox address. For Claude Desktop, remove the
`strato` entry from `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the
app.

## Troubleshooting

| Message or symptom | Resolution |
|---|---|
| `Node.js 22.13 or newer is required` | Install the current Node.js LTS release, close Terminal, and rerun `Setup.command` |
| macOS will not open `Setup.command` | Control-click the file, choose **Open**, then confirm **Open** |
| `Cannot read config` | Rerun setup and replace the existing mailbox settings |
| `No password` | Rerun setup to update the Keychain entry |
| `AUTHENTICATIONFAILED` | Rerun setup and enter the mailbox password, not the Strato customer-login password |
| A Keychain access dialog appears | Choose **Always Allow** for the `stratomcp` item |
| stratomcp is missing in Claude Desktop | Confirm setup updated the Desktop config, then quit Claude Desktop completely and reopen it |
| Search says the index is empty | Run `npm run sync` in `~/Library/Application Support/stratomcp/app` |

## Advanced commands

Run an index refresh manually:

```bash
cd "$HOME/Library/Application Support/stratomcp/app"
npm run sync
```

Index a different time window:

```bash
node src/sync.js --years 5
```

The server uses Strato's secure defaults:

* IMAP at `imap.strato.de:993`
* SMTP at `smtp.strato.de:465`
* IMAP4rev2 disabled because Strato can return empty search results when it is enabled
* Sent messages appended to the Sent folder because SMTP does not store a copy

Other providers may work when the host settings are overridden, but they are not
tested.
