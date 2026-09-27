import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountConfig,
  isSupportedNodeVersion,
  isValidEmail,
  mergeClaudeDesktopConfig,
} from "../src/setup-helpers.js";

test("accepts the minimum supported Node.js version", () => {
  assert.equal(isSupportedNodeVersion("22.13.0"), true);
  assert.equal(isSupportedNodeVersion("22.12.0"), false);
  assert.equal(isSupportedNodeVersion("24.0.0"), true);
});

test("validates mailbox addresses", () => {
  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("missing-domain@"), false);
  assert.equal(isValidEmail("not an email"), false);
});

test("creates a read-only account configuration", () => {
  assert.deepEqual(createAccountConfig("user@example.com", "Example User"), {
    accounts: [
      {
        name: "main",
        email: "user@example.com",
        displayName: "Example User",
        allowSend: false,
      },
    ],
  });
});

test("adds the server without changing other Claude Desktop settings", () => {
  const original = {
    theme: "dark",
    mcpServers: {
      existing: { command: "existing-server" },
    },
  };
  const result = mergeClaudeDesktopConfig(original, {
    command: "/usr/local/bin/node",
    args: ["/path/to/src/index.js"],
  });

  assert.deepEqual(result, {
    theme: "dark",
    mcpServers: {
      existing: { command: "existing-server" },
      strato: {
        command: "/usr/local/bin/node",
        args: ["/path/to/src/index.js"],
      },
    },
  });
  assert.equal(original.mcpServers.strato, undefined);
});

test("rejects a malformed Claude Desktop server collection", () => {
  assert.throws(
    () => mergeClaudeDesktopConfig({ mcpServers: [] }, { command: "node", args: [] }),
    /mcpServers/
  );
});
