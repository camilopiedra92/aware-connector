import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Type-aware linting only. The value here is the rules the compiler cannot express
// — floating promises, misused async, unnecessary conditions — not style policing:
// tsconfig.json already runs strict, noUncheckedIndexedAccess and
// exactOptionalPropertyTypes, which covers most of what an untyped preset would add.
export default tseslint.config(
  { ignores: ["node_modules/"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // stdout is the MCP protocol channel: one stray write corrupts the JSON-RPC
    // stream and the client drops the session. src/cli.ts is the sole exception —
    // printing to a terminal is its entire job.
    files: ["src/**/*.ts"],
    ignores: ["src/cli.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // `node:test` returns a promise from test() that the runner awaits itself;
      // awaiting it at the call site is not how the API is used.
      "@typescript-eslint/no-floating-promises": "off",
      // Test doubles implement async interfaces by returning fixtures, so their
      // bodies have nothing to await. That is the point of a stub.
      "@typescript-eslint/require-await": "off",
      // Fixtures deliberately model malformed API payloads, which have no type.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
