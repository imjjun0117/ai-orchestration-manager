const os = require("os");

function sanitizeHostId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 128) || "unknown-host";
}

function getHostId() {
  return sanitizeHostId(
    process.env.HOST_INSTANCE_ID ||
    process.env.HOST_ID ||
    os.hostname()
  );
}

module.exports = {
  getHostId,
  sanitizeHostId,
};
