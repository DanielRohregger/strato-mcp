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
