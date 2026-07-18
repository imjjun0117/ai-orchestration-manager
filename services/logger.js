const fs = require("fs");
const path = require("path");

const logDirectory = path.join(__dirname, "../logs");
const rawInstanceId = String(process.env.BOT_INSTANCE_ID || "").trim();
const instanceId = rawInstanceId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
const logFileName = instanceId ? `app.${instanceId}.log` : "app.log";
const logFilePath = process.env.LOG_FILE
  ? path.resolve(process.env.LOG_FILE)
  : path.join(logDirectory, logFileName);

// logs 디렉터리가 없으면 생성합니다.
const targetLogDirectory = path.dirname(logFilePath);
if (!fs.existsSync(targetLogDirectory)) {
  fs.mkdirSync(targetLogDirectory, { recursive: true });
}

function instancePrefix() {
  return instanceId ? ` [${instanceId}]` : "";
}

function info(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] [INFO]${instancePrefix()} ${message}\n`;
  console.log(formattedMessage.trim());
  fs.appendFileSync(logFilePath, formattedMessage);
}

function error(message, err) {
  const timestamp = new Date().toISOString();
  let formattedMessage = `[${timestamp}] [ERROR]${instancePrefix()} ${message}\n`;
  if (err) {
    formattedMessage += `${err.stack || err}\n`;
  }
  console.error(formattedMessage.trim());
  fs.appendFileSync(logFilePath, formattedMessage);
}

module.exports = {
  info,
  error,
  logFilePath,
};
