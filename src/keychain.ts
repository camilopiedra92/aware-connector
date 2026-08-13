import { spawn } from "node:child_process";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "./config.ts";

// Thin wrapper over macOS `security`. The refresh token is a ~30-day credential to
// the user's corporate identity, so it lives in the login keychain, never on disk
// in plain text and never in the repo.

function runSecurity(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Store (or replace) the refresh token in the login keychain.
 *
 * The value goes through `-w <token>` in argv. `security` has no non-interactive
 * stdin mode (bare `-w` prompts on the TTY and asks to retype), and on a
 * single-user Mac the argv is only visible to this user and root — and root can
 * read the keychain directly anyway, so this leaks nothing new.
 */
export async function saveRefreshToken(token: string): Promise<void> {
  const { code, stderr } = await runSecurity([
    "add-generic-password",
    "-U", // update if it already exists
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w", token,
  ]);
  if (code !== 0) {
    throw new Error(`Failed to store token in keychain: ${stderr.trim()}`);
  }
}

/** Read the stored refresh token, or null if the user has not run `aware login`. */
export async function readRefreshToken(): Promise<string | null> {
  const { code, stdout } = await runSecurity([
    "find-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  if (code !== 0) return null;
  const token = stdout.trim();
  return token.length > 0 ? token : null;
}

/** Remove the stored refresh token (for `aware logout`). */
export async function deleteRefreshToken(): Promise<void> {
  await runSecurity([
    "delete-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
  ]);
}
