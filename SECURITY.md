---
title: Security policy
description: How to report security vulnerabilities in stratomcp
---

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or include mailbox data,
credentials, or exploit details in a public discussion.

Use GitHub private vulnerability reporting from the repository's **Security** tab.
Include:

* The affected version or commit
* Reproduction steps using synthetic data
* The expected and observed behavior
* The potential impact

Remove personal mail, addresses, passwords, tokens, and local file paths before
submitting the report.

## Supported versions

Security fixes are applied to the latest release. Update to the newest release before
reporting an issue that may already be resolved.

## Security defaults

stratomcp stores passwords in macOS Keychain, defaults new accounts to enforced
read-only mailbox access, and marks mail content and external error details as
untrusted data. Existing accounts retain their legacy permissions until changed
through setup. Local indexing and approved downloads remain available in read-only
mode. Permission modes do not replace client-side approval of consequential actions.
See the
[README safety model](./README.md#safety-model) for operational guidance.
