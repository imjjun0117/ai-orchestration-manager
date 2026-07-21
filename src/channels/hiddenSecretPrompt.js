const readline = require("node:readline");
const { Writable } = require("node:stream");

function promptSecret(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive credential enrollment requires a TTY so the token can be entered without echo");
  }
  let muted = false;
  const hiddenOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({ input, output: hiddenOutput, terminal: true });
  output.write(label);
  muted = true;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      muted = false;
      output.write("\n");
      rl.close();
      callback();
    };
    rl.question("", (answer) => finish(() => resolve(String(answer || "").trim())));
    rl.on("SIGINT", () => finish(() => reject(new Error("Interactive credential enrollment cancelled"))));
    rl.on("close", () => {
      if (settled) return;
      settled = true;
      muted = false;
      output.write("\n");
      reject(new Error("Interactive credential enrollment input ended unexpectedly"));
    });
  });
}

module.exports = { promptSecret };
