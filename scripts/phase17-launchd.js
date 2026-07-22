#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LABEL = "com.ai-manager.phase17";
const PROFILE_NAMES = Object.freeze([
  "manager",
  "planner",
  "coder",
  "reviewer",
  "qa",
  "summarizer",
]);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function defaultOptions({
  repoRoot = path.resolve(__dirname, ".."),
  nodePath = process.execPath,
  homeDir = os.homedir(),
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedNode = path.resolve(nodePath);
  const resolvedHome = path.resolve(homeDir);
  return {
    label: LABEL,
    repoRoot: resolvedRoot,
    nodePath: resolvedNode,
    homeDir: resolvedHome,
    runnerPath: path.join(resolvedRoot, "scripts/run-phase17-multibot.js"),
    controlEnvPath: path.join(resolvedRoot, ".env"),
    profilePaths: PROFILE_NAMES.map((name) => path.join(resolvedRoot, `.env.phase17/.env.${name}`)),
    logDirectory: path.join(resolvedRoot, ".env.phase17-runtime"),
    installPath: path.join(resolvedHome, `Library/LaunchAgents/${LABEL}.plist`),
    pathValue: unique([
      path.dirname(resolvedNode),
      path.join(resolvedHome, ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]).join(":"),
  };
}

function assertAbsoluteFile(file, label, { fileSystem = fs } = {}) {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be an absolute path`);
  const stat = fileSystem.statSync(file);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
}

function assertProtectedDirectory(directory, label, { fileSystem = fs } = {}) {
  if (!path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path`);
  const stat = fileSystem.statSync(directory);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${label} permissions must be 0700`);
}

function preflightLaunchAgent(options = defaultOptions(), { fileSystem = fs } = {}) {
  if (!/^[A-Za-z0-9.-]+$/.test(options.label)) throw new Error("launchd label contains unsupported characters");
  assertAbsoluteFile(options.nodePath, "nodePath", { fileSystem });
  assertAbsoluteFile(options.runnerPath, "runnerPath", { fileSystem });
  assertAbsoluteFile(options.controlEnvPath, "controlEnvPath", { fileSystem });
  for (const profile of options.profilePaths) {
    assertAbsoluteFile(profile, "profilePath", { fileSystem });
    const contents = fileSystem.readFileSync(profile, "utf8");
    if (/^(?:DISCORD_TOKEN|CHANNEL_TOKEN)\s*=/m.test(contents)) {
      throw new Error(`${profile} contains a plaintext Discord token`);
    }
    const mode = fileSystem.statSync(profile).mode & 0o777;
    if (mode !== 0o600) throw new Error(`${profile} permissions must be 0600`);
  }
  if (options.profilePaths.length !== PROFILE_NAMES.length) {
    throw new Error("launchd service requires exactly six role profiles");
  }
  assertProtectedDirectory(options.logDirectory, "logDirectory", { fileSystem });
  return true;
}

function stringNode(value, indent = "    ") {
  return `${indent}<string>${xml(value)}</string>`;
}

function buildLaunchAgentPlist(input = {}) {
  const options = { ...defaultOptions(input), ...input };
  const programArguments = [options.nodePath, options.runnerPath, ...options.profilePaths]
    .map((value) => stringNode(value, "      "))
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    stringNode(options.label, "  "),
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    stringNode(options.repoRoot, "  "),
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    stringNode(options.homeDir, "    "),
    "    <key>PATH</key>",
    stringNode(options.pathValue, "    "),
    "    <key>PHASE17_CONTROL_ENV_FILE</key>",
    stringNode(options.controlEnvPath, "    "),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ExitTimeOut</key>",
    "  <integer>15</integer>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    stringNode(path.join(options.logDirectory, "phase17-supervisor.stdout.log"), "  "),
    "  <key>StandardErrorPath</key>",
    stringNode(path.join(options.logDirectory, "phase17-supervisor.stderr.log"), "  "),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function verifyLaunchAgentPlist(contents, input = {}) {
  const expected = buildLaunchAgentPlist(input);
  if (String(contents) !== expected) throw new Error("launchd plist does not match the current repository configuration");
  if (/(?:DISCORD_TOKEN|CHANNEL_TOKEN_MASTER_KEY|DATABASE_URL)/.test(contents)) {
    throw new Error("launchd plist must not contain credentials or connection strings");
  }
  return true;
}

function safePaths(options) {
  return {
    label: options.label,
    installPath: options.installPath,
    logDirectory: options.logDirectory,
    runnerPath: options.runnerPath,
    profiles: options.profilePaths,
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "paths";
  const options = defaultOptions();
  if (command === "paths") {
    process.stdout.write(`${JSON.stringify(safePaths(options), null, 2)}\n`);
    return;
  }
  if (command === "render") {
    preflightLaunchAgent(options);
    process.stdout.write(buildLaunchAgentPlist(options));
    return;
  }
  if (command === "verify") {
    const plistPath = path.resolve(argv[1] || options.installPath);
    preflightLaunchAgent(options);
    verifyLaunchAgentPlist(fs.readFileSync(plistPath, "utf8"), options);
    process.stdout.write(`${JSON.stringify({ verified: true, ...safePaths(options) }, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: npm run launchd:phase17 -- paths|render|verify [plist-path]");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[phase17-launchd] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  LABEL,
  PROFILE_NAMES,
  buildLaunchAgentPlist,
  defaultOptions,
  preflightLaunchAgent,
  verifyLaunchAgentPlist,
  xml,
};
