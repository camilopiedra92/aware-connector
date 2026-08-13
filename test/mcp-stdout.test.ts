import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// stdout is the MCP transport. Anything else written there — a debug console.log, a
// dependency's banner, a Node warning — lands mid-stream and the client drops the
// session. test/server.test.ts drives the server over an in-memory transport and so
// never observes the real file descriptor; this is the only test that does.

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO_ROOT, "src", "mcp.ts");

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdout-purity", version: "0" } },
});

/** Run one request against a real spawned server and return everything each stream got. */
function handshake(timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(() => { done(() => { reject(new Error(`No reply in ${timeoutMs}ms. stderr: ${stderr}`)); }); }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      // One framed message is enough: the reply is newline-delimited.
      if (stdout.includes("\n")) done(() => { resolve({ stdout, stderr }); });
    });
    child.on("error", (err) => { done(() => { reject(err); }); });

    child.stdin.write(INITIALIZE + "\n");
  });
}

test("the spawned MCP server writes nothing to stdout but JSON-RPC", async () => {
  const { stdout, stderr } = await handshake();
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");

  assert.ok(lines.length > 0, `server replied with nothing. stderr: ${stderr}`);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      assert.fail(`non-JSON on stdout, which corrupts the transport: ${JSON.stringify(line)}`);
    }
    assert.equal((parsed as { jsonrpc?: string }).jsonrpc, "2.0", `not a JSON-RPC message: ${line}`);
  }
});

test("the handshake reports this server's identity", async () => {
  const { stdout } = await handshake();
  const reply = JSON.parse(stdout.split("\n")[0]!) as {
    result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } };
  };
  assert.equal(reply.result?.serverInfo?.name, "aware");
  assert.ok(reply.result?.capabilities?.tools, "the server must advertise tool support");
});
