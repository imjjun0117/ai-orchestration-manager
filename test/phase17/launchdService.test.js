const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LABEL,
  PROFILE_NAMES,
  buildLaunchAgentPlist,
  defaultOptions,
  preflightLaunchAgent,
  verifyLaunchAgentPlist,
  xml,
} = require("../../scripts/phase17-launchd");

test("launchd plist starts the exact six-role supervisor without a shell", () => {
  const options = defaultOptions({
    repoRoot: "/tmp/AI Manager & Control",
    nodePath: "/usr/local/bin/node",
    homeDir: "/Users/operator",
  });
  const plist = buildLaunchAgentPlist(options);

  assert.match(plist, new RegExp(`<string>${LABEL.replaceAll(".", "\\.")}</string>`));
  assert.equal((plist.match(/\.env\.phase17\/\.env\./g) || []).length, 6);
  for (const name of PROFILE_NAMES) assert.match(plist, new RegExp(`\\.env\\.${name}</string>`));
  assert.match(plist, /<string>\/tmp\/AI Manager &amp; Control<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\n  <string>Background<\/string>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n  <integer>10<\/integer>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\n  <integer>15<\/integer>/);
  assert.match(plist, /<key>Umask<\/key>\n  <integer>63<\/integer>/);
  assert.match(plist, /<key>PHASE17_CONTROL_ENV_FILE<\/key>/);
  assert.doesNotMatch(plist, /(?:\/bin\/(?:ba|z|)sh| -c<\/string>)/);
});

test("launchd plist carries only paths and no credential material", () => {
  const plist = buildLaunchAgentPlist(defaultOptions({
    repoRoot: "/srv/ai-manager",
    nodePath: "/usr/bin/node",
    homeDir: "/Users/operator",
  }));
  assert.doesNotMatch(plist, /DISCORD_TOKEN|CHANNEL_TOKEN_MASTER_KEY|DATABASE_URL|postgres(?:ql)?:\/\//i);
  assert.match(plist, /PHASE17_CONTROL_ENV_FILE/);
  assert.match(plist, /phase17-supervisor\.stdout\.log/);
  assert.match(plist, /phase17-supervisor\.stderr\.log/);
});

test("launchd verifier fails closed on any rendered configuration drift", () => {
  const options = defaultOptions({
    repoRoot: "/srv/ai-manager",
    nodePath: "/usr/bin/node",
    homeDir: "/Users/operator",
  });
  const plist = buildLaunchAgentPlist(options);
  assert.equal(verifyLaunchAgentPlist(plist, options), true);
  assert.throws(
    () => verifyLaunchAgentPlist(plist.replace(".env.manager", ".env.manager-tampered"), options),
    /does not match/
  );
});

test("launchd preflight enforces six protected profiles without plaintext tokens", () => {
  const entries = new Map([
    ["/usr/bin/node", { contents: "", type: "file", mode: 0o100755 }],
    ["/srv/ai-manager/scripts/run-phase17-multibot.js", { contents: "", type: "file", mode: 0o100644 }],
    ["/srv/ai-manager/.env", { contents: "DATABASE_URL=protected", type: "file", mode: 0o100600 }],
    ["/srv/ai-manager/.env.phase17-runtime", { contents: "", type: "directory", mode: 0o40700 }],
    ...PROFILE_NAMES.map((name) => [
      `/srv/ai-manager/.env.phase17/.env.${name}`,
      { contents: `BOT_ROLE=${name}`, type: "file", mode: 0o100600 },
    ]),
  ]);
  const fileSystem = {
    readFileSync: (file) => entries.get(file).contents,
    statSync: (file) => {
      const entry = entries.get(file);
      if (!entry) throw new Error(`missing ${file}`);
      return {
        isDirectory: () => entry.type === "directory",
        isFile: () => entry.type === "file",
        mode: entry.mode,
      };
    },
  };
  const options = defaultOptions({ repoRoot: "/srv/ai-manager", nodePath: "/usr/bin/node", homeDir: "/Users/operator" });
  assert.equal(preflightLaunchAgent(options, { fileSystem }), true);

  entries.get(options.profilePaths[0]).contents = "BOT_ROLE=manager\nDISCORD_TOKEN=secret";
  assert.throws(() => preflightLaunchAgent(options, { fileSystem }), /plaintext Discord token/);

  entries.get(options.profilePaths[0]).contents = "BOT_ROLE=manager";
  entries.get(options.profilePaths[0]).mode = 0o100644;
  assert.throws(() => preflightLaunchAgent(options, { fileSystem }), /permissions must be 0600/);

  entries.get(options.profilePaths[0]).mode = 0o100600;
  entries.delete(options.runnerPath);
  assert.throws(() => preflightLaunchAgent(options, { fileSystem }), /missing/);
});

test("launchd preflight requires an existing 0700 log directory", () => {
  const options = defaultOptions({ repoRoot: "/srv/ai-manager", nodePath: "/usr/bin/node", homeDir: "/Users/operator" });
  const fileSystem = {
    readFileSync: () => "BOT_ROLE=safe",
    statSync: (file) => ({
      isDirectory: () => file === options.logDirectory,
      isFile: () => file !== options.logDirectory,
      mode: file === options.logDirectory ? 0o40755 : 0o100600,
    }),
  };
  assert.throws(() => preflightLaunchAgent(options, { fileSystem }), /logDirectory permissions must be 0700/);
});

test("XML escaping covers all launchd string metacharacters", () => {
  assert.equal(xml(`a&b<c>d\"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});
