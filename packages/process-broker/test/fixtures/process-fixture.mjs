// Hostile-ish process fixture used by the process-broker tests.
//
// This is the "workload" the broker supervises. It deliberately misbehaves on
// request: floods output, refuses to exit, ignores polite termination, and
// spawns a child and a grandchild that do the same. Running it through the
// broker is how the contract suite proves the bounds are real.
//
// It is launched as `node <this file> <mode> [...]`, never through a shell.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const [mode, ...rest] = process.argv.slice(2);

function sleepForever() {
  // An interval keeps the event loop alive without busy-waiting.
  setInterval(() => {}, 1_000);
}

switch (mode) {
  case "--armed-marker": {
    writeFileSync(rest[0], "spawned", { encoding: "utf8", flag: "wx" });
    process.stdout.write("marker-written");
    break;
  }

  case "--print-env": {
    process.stdout.write(Object.keys(process.env).sort().join("\n"));
    break;
  }

  case "--print-env-value": {
    const name = rest[0];
    process.stdout.write(String(process.env[name] ?? ""));
    break;
  }

  case "--echo-stdin": {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      process.stdout.write(Buffer.concat(chunks));
    });
    break;
  }

  case "--split-streams": {
    process.stdout.write("to-stdout");
    process.stderr.write("to-stderr");
    break;
  }

  case "--duplex-lines": {
    process.stdout.write("ready\n");
    let buffered = "";
    let index = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const target = index++ % 2 === 0 ? process.stdout : process.stderr;
        target.write(`${line}\n`);
      }
    });
    process.stdin.on("end", () => {
      if (buffered.length > 0) process.stdout.write(buffered);
    });
    break;
  }

  case "--flood": {
    // Write as fast as the pipe accepts, for as long as we are allowed to.
    const line = `${"f".repeat(1_023)}\n`;
    const pump = () => {
      while (process.stdout.write(line)) {
        // Keep going until the stream asks us to wait.
      }
      process.stdout.once("drain", pump);
    };
    pump();
    break;
  }

  case "--sleep-forever": {
    process.stdout.write("started\n");
    sleepForever();
    break;
  }

  case "--ignore-signals": {
    // Refuse the polite request. Only a forced stop should end this.
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    process.on("SIGHUP", () => {});
    process.stdout.write("ignoring\n");
    sleepForever();
    break;
  }

  case "--spawn-tree": {
    // A child that spawns a grandchild. Both outlive us unless the whole
    // tree is terminated.
    const child = spawn(process.execPath, [SELF, "--spawn-child"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    process.stdout.write("parent\n");
    sleepForever();
    break;
  }

  case "--spawn-child": {
    const grandchild = spawn(process.execPath, [SELF, "--sleep-forever"], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      windowsHide: true,
    });
    process.stdout.write(`child ${grandchild.pid}\n`);
    sleepForever();
    break;
  }

  case "--exit-code": {
    process.exit(Number.parseInt(rest[0] ?? "0", 10));
    break;
  }

  case "--binary-output": {
    process.stdout.write(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f]));
    break;
  }

  case "--terminal-escapes": {
    process.stdout.write("\u001b[31mred\u001b[0m\u0007\u001b]0;title\u0007plain");
    break;
  }

  default: {
    // Default: echo the arguments verbatim, one per line. Any shell
    // interpretation anywhere in the chain shows up as a changed value here.
    process.stdout.write(process.argv.slice(2).join("\n"));
    break;
  }
}
