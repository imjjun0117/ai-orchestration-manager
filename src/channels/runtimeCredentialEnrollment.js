const { getInstanceBoundToken, storeInstanceBoundToken } = require("./channelCredentialService");
const { promptSecret } = require("./hiddenSecretPrompt");

async function resolveRuntimeCredential(config, {
  db,
  input = process.stdin,
  output = process.stdout,
  prompt = promptSecret,
} = {}) {
  const existing = await getInstanceBoundToken({ botInstanceId: config.instanceId }, { db });
  if (existing) return { token: existing, enrolled: false };
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`ACTIVE Discord credential is missing for ${config.instanceId}; run this role node directly in a TTY to enroll it`);
  }
  const token = await prompt(`Discord token for ${config.instanceId} (hidden): `, { input, output });
  if (!token) throw new Error("Discord token cannot be empty");
  await storeInstanceBoundToken({
    botInstanceId: config.instanceId,
    token,
    metadata: { role: config.role },
  }, { db });
  output.write(`Credential encrypted and stored in DB for ${config.instanceId}.\n`);
  return { token, enrolled: true };
}

module.exports = { resolveRuntimeCredential };
