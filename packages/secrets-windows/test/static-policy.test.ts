import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WINDOWS_CREDENTIAL_MAX_SECRET_BYTES } from "../src/contracts.js";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function exportedSymbols(text: string): { values: string[]; types: string[] } {
  const values: string[] = [];
  const types: string[] = [];
  for (const match of text.matchAll(/export\s*\{([\s\S]*?)\}\s*(?:from\s+"[^"]+")?;/g)) {
    for (const raw of match[1]!.split(",")) {
      const item = raw.trim();
      if (item.length === 0) continue;
      if (item.startsWith("type ")) types.push(item.slice(5).trim());
      else values.push(item.split(/\s+as\s+/u)[1] ?? item.split(/\s+as\s+/u)[0]!);
    }
  }
  for (const match of text.matchAll(/^\s*export function\s+([A-Za-z0-9_]+)/gm)) values.push(match[1]!);
  return { values: values.sort(), types: types.sort() };
}

function assertClosedExportSyntax(text: string): void {
  for (const match of text.matchAll(/^\s*export\b/gm)) {
    expect(text.slice(match.index)).toMatch(/^\s*export\s*(?:\{|function\b)/);
  }
}

describe("Windows credential package authority", () => {
  it("keeps the native source exact-read only with a closed two-function export", () => {
    const native = source("../native/credential-reader.c");
    const initializer = native.slice(native.indexOf("static napi_value initialize"), native.indexOf("NAPI_MODULE"));
    expect(native).toContain("CredReadW(");
    expect([...native.matchAll(/\b(Cred[A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1])).toEqual(["CredReadW", "CredFree"]);
    expect([...new Set([...native.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]).filter((name) => !["if", "for", "while", "switch", "sizeof", "return"].includes(name)))].sort()).toEqual([
      "CopyMemory", "CredFree", "CredReadW", "GetLastError", "GetProcessHeap", "HeapAlloc", "HeapFree", "NAPI_MODULE", "SecureZeroMemory",
      "availability", "complete_credential_work", "execute_credential_work", "initialize", "is_lower_hex", "map_windows_error",
      "napi_create_async_work", "napi_create_buffer_copy", "napi_create_object", "napi_create_promise", "napi_create_string_utf8",
      "napi_define_properties", "napi_delete_async_work", "napi_get_cb_info", "napi_get_value_string_utf16", "napi_queue_async_work",
      "napi_reject_deferred", "napi_resolve_deferred", "napi_set_named_property", "napi_throw_error", "napi_throw_range_error",
      "napi_throw_type_error", "napi_typeof", "read_credential", "secure_free", "set_named_string", "start_operation", "status_text",
      "target_is_canonical",
    ].sort());
    expect(native).toContain(`#define SECRET_MAX_BYTES ${WINDOWS_CREDENTIAL_MAX_SECRET_BYTES}U`);
    expect(native).toContain("if (length - index != 64U) return 0;");
    const secureFree = native.slice(native.indexOf("static void secure_free"), native.indexOf("static int is_lower_hex")).replaceAll("\r\n", "\n");
    expect(secureFree).toContain([
      "static void secure_free(void *value, size_t byte_count) {",
      "  if (value != NULL) {",
      "    if (byte_count > 0U) {",
      "      SecureZeroMemory(value, byte_count);",
      "    }",
      "    HeapFree(GetProcessHeap(), 0U, value);",
      "  }",
      "}",
    ].join("\n"));
    expect(initializer.match(/\{ "[^"]+", NULL, [^,]+,/g)).toEqual([
      '{ "availability", NULL, availability,',
      '{ "read", NULL, read_credential,',
    ]);
    expect(initializer).toContain("sizeof(properties) / sizeof(properties[0])");
    const mapping = native.slice(native.indexOf("static result_status map_windows_error"), native.indexOf("static void execute_credential_work")).replaceAll("\r\n", "\n");
    expect(mapping).toContain([
      "static result_status map_windows_error(DWORD code) {",
      "  if (code == ERROR_NOT_FOUND) return RESULT_NOT_FOUND;",
      "  if (code == ERROR_ACCESS_DENIED) return RESULT_ACCESS_DENIED;",
      "  if (code == ERROR_NO_SUCH_LOGON_SESSION || code == ERROR_NOT_SUPPORTED || code == ERROR_SERVICE_DISABLED) return RESULT_UNAVAILABLE;",
      "  return RESULT_FAILURE;",
      "}",
    ].join("\n"));
    const statusText = native.slice(native.indexOf("static const char *status_text"), native.indexOf("static napi_status set_named_string")).replaceAll("\r\n", "\n");
    expect(statusText).toContain([
      "static const char *status_text(result_status status) {",
      "  switch (status) {",
      "    case RESULT_OK: return \"ok\";",
      "    case RESULT_NOT_FOUND: return \"not-found\";",
      "    case RESULT_ACCESS_DENIED: return \"access-denied\";",
      "    case RESULT_UNAVAILABLE: return \"unavailable\";",
      "    case RESULT_MALFORMED: return \"malformed\";",
      "    default: return \"failure\";",
      "  }",
      "}",
    ].join("\n"));
    for (const forbidden of ["CredEnumerate", "CredWrite", "CredDelete", "CredRename", "CryptProtectData", "CryptUnprotectData", "ShellExecute", "CreateProcess", "WinHttp", "WinInet", "WSAStartup", "RegOpenKey", "OpenSCManager", "CreateFile", "GetEnvironmentVariable"]) {
      expect(native).not.toContain(forbidden);
    }
    const completion = native.slice(native.indexOf("static void complete_credential_work"), native.indexOf("static napi_value start_operation"));
    expect(completion).toContain("if (status == napi_ok && request->status == RESULT_OK && request->mode == MODE_READ) {");
    const createNodeCopy = "napi_create_buffer_copy(env, request->byte_count, request->bytes, &node_bytes, &bytes)";
    const setNodeCopy = 'napi_set_named_property(env, result, "bytes", bytes)';
    const freeNative = "secure_free(request->bytes, request->byte_count);";
    const freeTarget = "secure_free(request->target, (TARGET_MAX_CHARS + 1U) * sizeof(wchar_t));";
    const resolve = "napi_resolve_deferred(env, request->deferred, result)";
    const failureGuard = "if (status != napi_ok) {";
    const nodeGuard = "if (node_bytes != NULL && request->byte_count > 0U)";
    const zeroNodeCopy = "SecureZeroMemory(node_bytes, request->byte_count);";
    expect(completion.indexOf(createNodeCopy)).toBeGreaterThan(-1);
    expect(completion.indexOf(setNodeCopy)).toBeGreaterThan(completion.indexOf(createNodeCopy));
    expect(completion.indexOf(freeNative)).toBeGreaterThan(completion.indexOf(setNodeCopy));
    expect(completion.indexOf(freeTarget)).toBeGreaterThan(completion.indexOf(freeNative));
    expect(completion.indexOf(resolve)).toBeGreaterThan(completion.indexOf(freeTarget));
    expect(completion.indexOf(failureGuard)).toBeGreaterThan(completion.indexOf(resolve));
    expect(completion.indexOf(nodeGuard)).toBeGreaterThan(completion.indexOf(failureGuard));
    expect(completion.indexOf(zeroNodeCopy)).toBeGreaterThan(completion.indexOf(nodeGuard));
    const execute = native.slice(native.indexOf("static void execute_credential_work"), native.indexOf("static const char *status_text"));
    expect(execute).toContain("if (!CredReadW(request->target, CRED_TYPE_GENERIC, 0U, &credential)) {");
    expect(execute).toContain("credential->CredentialBlobSize < 1U || credential->CredentialBlobSize > SECRET_MAX_BYTES");
    expect(execute).toContain("} else if (request->mode == MODE_READ) {");
    const copy = "CopyMemory(request->bytes, credential->CredentialBlob, credential->CredentialBlobSize);";
    const count = "request->byte_count = credential->CredentialBlobSize;";
    const success = "request->status = RESULT_OK;";
    expect(execute.indexOf(copy)).toBeGreaterThan(-1);
    expect(execute.indexOf(count)).toBeGreaterThan(execute.indexOf(copy));
    expect(execute.indexOf(success, execute.indexOf(count))).toBeGreaterThan(execute.indexOf(count));
    const zeroBlob = "SecureZeroMemory(credential->CredentialBlob, credential->CredentialBlobSize);";
    expect(execute.indexOf(zeroBlob)).toBeGreaterThan(execute.indexOf(success, execute.indexOf(count)));
    expect(execute.indexOf("CredFree(credential);")).toBeGreaterThan(execute.indexOf(zeroBlob));
  });

  it("keeps native/test internals out of the production export and package scripts free of install hooks", async () => {
    const index = source("../src/index.ts");
    const testing = source("../src/testing/index.ts");
    const manifest = JSON.parse(source("../package.json")) as { name: string; version: string; private: boolean; gypfile: boolean; scripts: Record<string, string>; exports: Record<string, unknown>; dependencies: Record<string, string>; files: readonly string[]; bundledDependencies?: unknown };
    assertClosedExportSyntax(index);
    assertClosedExportSyntax(testing);
    expect(index.match(/\bexport\b/g)).toHaveLength(2);
    expect(testing.match(/\bexport\b/g)).toHaveLength(2);
    const productionRuntime = await import("../src/index.js");
    const testingRuntime = await import("../src/testing/index.js");
    expect(Object.keys(productionRuntime).sort()).toEqual(["WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION", "WINDOWS_CREDENTIAL_MAX_SECRET_BYTES", "WINDOWS_CREDENTIAL_TARGET_PREFIX", "createWindowsCredentialSecretBroker"].sort());
    expect(Object.keys(testingRuntime).sort()).toEqual(["createWindowsCredentialSecretBrokerForTesting"]);
    expect(exportedSymbols(index)).toEqual({
      values: ["WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION", "WINDOWS_CREDENTIAL_MAX_SECRET_BYTES", "WINDOWS_CREDENTIAL_TARGET_PREFIX", "createWindowsCredentialSecretBroker"].sort(),
      types: ["WindowsCredentialBrokerOptions", "WindowsCredentialSecretBroker", "WindowsCredentialTargetBinding"].sort(),
    });
    expect(exportedSymbols(testing)).toEqual({
      values: ["createWindowsCredentialSecretBrokerForTesting"],
      types: ["WindowsCredentialNativeAvailability", "WindowsCredentialNativePort", "WindowsCredentialNativeReadResult", "WindowsCredentialNativeStatus", "WindowsCredentialTestingOptions"].sort(),
    });
    expect(manifest.name).toBe("@ai-dev-os/secrets-windows");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.private).toBe(true);
    expect(manifest.gypfile).toBe(false);
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.scripts).toEqual({
      prebuild: "npm --prefix ../domain run build && npm --prefix ../secrets run build",
      build: "tsc -p tsconfig.json",
      "build:native": "node-gyp rebuild",
      "test:native-smoke": "node scripts/native-smoke.mjs",
      pretest: "npm --prefix ../domain run build && npm --prefix ../secrets run build",
      test: "vitest run",
      "pretest:coverage": "npm --prefix ../domain run build && npm --prefix ../secrets run build",
      "test:coverage": "vitest run --coverage",
      pretypecheck: "npm --prefix ../domain run build && npm --prefix ../secrets run build",
      typecheck: "tsc -p tsconfig.json --noEmit",
    });
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) expect(manifest.scripts[hook]).toBeUndefined();
    expect(Object.keys(manifest.exports)).toEqual([".", "./testing"]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@ai-dev-os/domain", "@ai-dev-os/secrets"]);
    expect(manifest.files).toEqual(["dist", "native/credential-reader.c", "binding.gyp", "README.md"]);
    const coverage = source("../vitest.config.ts");
    expect(coverage).not.toContain('"src/real-native.ts"');
    const loader = source("../src/real-native.ts");
    expect(loader).toContain('require("../build/Release/ai_dev_os_windows_credential.node")');
    expect(loader.indexOf("createRequire(import.meta.url)")).toBeGreaterThan(loader.indexOf("createRealWindowsCredentialNativePort"));
  });

  it("keeps production TypeScript free of ambient credential and fallback authority except the fixed lazy addon load", () => {
    const productionFiles = ["broker.ts", "contracts.ts", "index.ts", "real-native.ts", "target.ts"] as const;
    const combined = productionFiles.map((name) => source(`../src/${name}`)).join("\n");
    expect([...combined.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]).filter((value, index, all) => all.indexOf(value) === index).sort()).toEqual([
      "./broker.js",
      "./contracts.js",
      "./real-native.js",
      "./target.js",
      "@ai-dev-os/domain",
      "@ai-dev-os/secrets",
      "node:async_hooks",
      "node:crypto",
      "node:module",
      "node:util",
    ]);
    const fixedLoad = '() => require("../build/Release/ai_dev_os_windows_credential.node")';
    expect(combined.match(/createRequire\(import\.meta\.url\)/g)).toHaveLength(1);
    expect(combined.match(/\.\.\/build\/Release\/ai_dev_os_windows_credential\.node/g)).toHaveLength(1);
    const withoutFixedLoad = combined.replace(fixedLoad, "fixed-native-addon-load");
    for (const forbidden of [
      '"node:fs"', '"node:child_process"', '"node:http"', '"node:https"', '"node:net"', '"node:tls"', '"node:dns"',
      "process.env", "Deno.", "Bun.", "fetch(", "import(", "require(", "exec(", "spawn(", "registry", "browser", "keytar",
    ]) expect(withoutFixedLoad).not.toContain(forbidden);
  });

  it("pins warnings-as-errors and the one required Win32 library", () => {
    const binding = source("../binding.gyp");
    expect(binding).toContain('"WarnAsError": "true"');
    expect(binding).toContain('"WarningLevel": 4');
    expect(binding).toContain('"Advapi32.lib"');
    expect(binding).toContain('"/guard:cf"');
    const root = JSON.parse(source("../../../package.json")) as { devDependencies: Record<string, string>; engines: { node: string } };
    expect(root.devDependencies["node-gyp"]).toBe("12.3.0");
    expect(root.engines.node).toBe(">=22.9.0");
    expect(binding).toContain('"NAPI_VERSION=9"');
    const workflow = source("../../../.github/workflows/ci.yml");
    expect(workflow).toContain("npm run build:native --workspace @ai-dev-os/secrets-windows");
    expect(workflow).toContain("npm run test:native-smoke --workspace @ai-dev-os/secrets-windows");
  });
});
