---
title: stratomcp
description: Local MCP server for searching and managing a Strato mailbox with Claude
---

## Search your Strato mailbox with Claude

stratomcp connects Claude to your Strato mailbox. Ask questions about your email,
find messages, or get help writing replies. You choose whether Claude can only
read mail, organize it, or also send it.

It runs on your Mac as a [Model Context Protocol (MCP) server](https://modelcontextprotocol.io).
Your password stays in macOS Keychain.

> [!IMPORTANT]
> stratomcp is not affiliated with or endorsed by STRATO AG.

## What you can do

* Find emails by sender, date, topic, or invoice number
* Summarize conversations and read attachments you approve
* Check folders and unread messages
* Save drafts, organize mail, or send replies when you enable those permissions

## Quick setup

### What you need

* macOS
* A Strato mailbox and its mailbox password
* [Node.js](https://nodejs.org/) 22.13 or newer
* Claude Desktop, Claude Code, or both

### Install

1. Download and unzip this repository.
2. Double-click **`Setup.command`**.
3. Enter your mailbox details when prompted.
4. Choose a [permission mode](#choose-what-claude-can-do) and a folder for attachments.
5. Let setup connect to Claude Desktop, Claude Code, or both.
6. Restart Claude Desktop or open a new Claude Code session.

Not sure what to choose? Keep **Read-only mailbox** and the suggested download
folder. You can change both later.

Setup stores your password in Keychain, tests the connection, and offers to build
a local search index. The first index build can take several minutes; later
updates happen automatically. Claude Code users can also install optional mail
helper agents for searching and summarizing.

The application is installed in `~/Library/Application Support/stratomcp/app`.
No configuration-file editing is needed for a single mailbox.

> [!NOTE]
> If macOS blocks the first launch, Control-click `Setup.command`, select **Open**,
> then confirm **Open**. You only need to do this once.

## Try it

After setup, ask Claude:

* "Which mail folders do I have?"
* "Find the latest invoice from my internet provider."
* "Summarize the open points in the thread with the landlord."
* "Suggest a reply to the latest message, but do not send it."

In read-only mode, suggested replies stay in the conversation. Saving one in your
mailbox requires **Organize and draft** or **Full access**.

## Choose what Claude can do

Setup asks you to choose a mode for each mailbox:

| Mode | What it allows |
|---|---|
| **Read-only mailbox** (default for new accounts) | Search and read mail, without changing anything in your mailbox |
| **Organize and draft** | Also mark messages read, change flags, move mail, and save drafts; no sending |
| **Full access** | Everything above, plus sending email |

Local indexing and approved attachment downloads work in every mode. Enabling
sending requires typing `yes` during setup. The server enforces your choice; an
email or a tool call cannot grant extra permissions.

### Changing permissions

For the standard installation, open Terminal and run:

```bash
cd "$HOME/Library/Application Support/stratomcp/app"
npm run setup -- --permissions
```

If you installed from a clone, run the command in that folder instead.
Choose a new mode or press Return to keep the current one.

This changes only permissions, not your password, download folder, or client
setup. The next tool call uses the new mode; work already running is not cancelled.
Ask Claude to list your accounts to check the current modes.

> [!NOTE]
> Updating an existing installation keeps its current permissions. Use the command
> above if you want to switch an older installation to read-only.

## Attachments

Claude sees attachment names and sizes before downloading them. Review its request
before approving a download.

During setup, choose where downloads go. Press Return to keep the suggested folder
(`~/Downloads/stratomcp` for a new installation), or enter a full path. `~` means
your home folder, so you can enter a path such as `~/Documents/Mail attachments`.

Want downloads next to a cloned application? For an app at
`~/Claude/MCP/strato-mcp`, choose `~/Claude/MCP/strato-mcp-downloads`.
Setup rejects folders inside the application because updates replace those files.

To change the folder later, open Terminal and run:

```bash
cd "$HOME/Library/Application Support/stratomcp/app"
npm run setup
```

Keep your existing mailbox settings when prompted. Your choice applies to both
Claude clients. Existing downloads are not moved. For a clone, use its folder
instead of the installed path above.

* Claude cannot choose a different folder through a download tool call.
* Existing files are never overwritten.
* Text-like attachments can be returned directly to Claude.
* The default download limit is 25 MB; larger attachments remain supported.
* Downloading a file does not make it safe to open or run.

## Safety model

An email can contain instructions designed to trick an AI assistant. This is
called *prompt injection*. stratomcp labels email content, attachment names, and
external error details as untrusted data, not instructions.

These safeguards reduce risk; they do not make prompt injection impossible.
Keep Claude's approval prompts enabled. Check recipients and content before
sending, and never approve an action only because an email asks for it.

Read-only mode blocks mailbox changes, including marking messages as read.
The modes do not control other tools you give Claude, such as shell or browser
access.

See [SECURITY.md](./SECURITY.md) to report a security concern privately.

## Privacy

Your password stays in Keychain. Settings and the search index stay on your Mac.
stratomcp does not upload the whole index, but mail and attachment content returned
to Claude are shared with the AI provider as part of your conversation.

| Data | Default location |
|---|---|
| Account settings | `~/.config/stratomcp/accounts.json` |
| Local search index | `~/Library/Application Support/stratomcp/mail.db` |
| Attachments | The folder you choose during setup |

The index covers the last three years, excluding Spam and Trash. It contains
message text and attachment names, not attachment contents. Claude can search older
or excluded mail directly. The index refreshes automatically while the server runs.

Use FileVault if your Mac may store sensitive mail.

## Update

Download and unzip the new version, then run its `Setup.command`. Keep your
existing settings when prompted, then restart Claude. Account settings, Keychain
passwords, the index, and downloads outside the application folder are preserved.

## Troubleshooting

| Problem | What to do |
|---|---|
| Node.js is missing or too old | Install [Node.js](https://nodejs.org/) 22.13 or newer, then rerun setup |
| macOS blocks `Setup.command` | Control-click it, choose **Open**, and confirm |
| Claude cannot find stratomcp | Rerun setup, enable the client connection, then restart Claude |
| Sending or mailbox changes are disabled | Check your [permission mode](#changing-permissions) |
| `No password` or `AUTHENTICATIONFAILED` | Rerun setup with the mailbox password, not your Strato customer-login password |
| Keychain asks for access | Allow access for the `stratomcp` item if you trust this installation |
| Search says the index is empty | Run `npm run sync` from the application folder |
| `Cannot read config` | Check the [account settings](#account-settings-and-multiple-mailboxes) for missing or invalid JSON |

## Advanced configuration

Most users can use setup without editing files. The options below are for manual
configuration and development.

### Install from a clone

```bash
npm install
npm run setup
```

This uses the current checkout instead of copying the application elsewhere.

### Account settings and multiple mailboxes

The settings file is `~/.config/stratomcp/accounts.json`. A new account looks like:

```json
{
  "accounts": [
    {
      "name": "main",
      "email": "user@example.com",
      "displayName": "Example User",
      "accessMode": "read-only",
      "allowSend": false
    }
  ]
}
```

For another mailbox, add another object to `accounts` with a different `name` and
email, then rerun setup. Choose to keep the existing mailbox settings. Setup checks
each account and lets you choose its permissions.

* `accessMode` is `read-only`, `organize`, or `full`. Invalid values are rejected.
* It takes precedence over `allowSend`; setup keeps that older field in sync.
* Older accounts without `accessMode` retain their behavior: `allowSend: true`
  means full access; false or omitted means organize and draft.
* The top-level `attachmentDir` stores the download folder as an absolute path.

Tools remain listed for all accounts, but disallowed actions are rejected by the
server for the account used in each call.

### Environment variables

| Variable | Purpose |
|---|---|
| `STRATOMCP_CONFIG` | Override the account settings path |
| `STRATOMCP_PASSWORD_<NAME>` | Supply a password without Keychain |
| `STRATOMCP_DB` | Override the SQLite index path |
| `STRATOMCP_ATTACHMENT_DIR` | Override the folder chosen during setup; tool calls cannot override it |
| `STRATOMCP_MAX_ATTACHMENT_MB` | Change the default attachment size limit |

For example, the password variable for an account named `main` is
`STRATOMCP_PASSWORD_MAIN`.

Use an absolute path for `STRATOMCP_ATTACHMENT_DIR` and restart the server after
changing it. A literal `~` in an environment value is not expanded; relative paths
resolve against the server's working directory.

### Download and error-handling details

The download folder is selected in this order: `STRATOMCP_ATTACHMENT_DIR`, the
saved `attachmentDir`, then `~/Downloads/stratomcp`. The former `dir` tool argument
is rejected; remove it from old saved tool calls.

New download directories use `0700` permissions and files use `0600`. Existing
directory permissions are unchanged. Use a dedicated folder, not a startup or
application configuration folder. Symlinks in the configured path are followed;
this is not a sandbox against other local processes.

Tool-handler errors separate server messages from `untrustedDetails` and include
a security notice. Sender-provided filenames are preserved in those details.

### Index maintenance and connection defaults

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

### Available tools

| Tool | Purpose |
|---|---|
| `list_accounts` | List configured mailboxes and effective permission modes |
| `list_folders` | List folders with message and unread counts |
| `search_index` | Search the local full-text index |
| `search_messages` | Search the mailbox through live IMAP |
| `get_message` | Read one message or a batch of up to 20 |
| `download_attachments` | Download selected attachments after approval |
| `update_flags` | Mark messages read, unread, flagged, or unflagged in organize or full mode |
| `move_messages` | Move messages to another folder in organize or full mode |
| `save_draft` | Save a draft without sending in organize or full mode |
| `send_message` | Send mail in full mode |
| `sync_index` | Update the local index |
| `index_stats` | Show index size and synchronization status |

## Uninstall

Remove the Claude Code registration if it was installed:

```bash
claude mcp remove strato
```

Remove the installed application, settings, index, and Keychain password:

> [!WARNING]
> Back up any downloads you want to keep before deleting these folders.

```bash
rm -rf "$HOME/Library/Application Support/stratomcp"
rm -rf "$HOME/.config/stratomcp"
security delete-generic-password -s stratomcp -a user@example.com
```

Replace `user@example.com` with your mailbox address. For Claude Desktop, remove the
`strato` entry from `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the
app.
