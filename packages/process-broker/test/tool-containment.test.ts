import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ProcessBrokerError,
  createTrustedToolDescriptor,
  resolveTrustedTool,
  type TrustedToolDescriptor,
} from "../src/index.js";

const roots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-tool-containment-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function descriptor(
  executablePath: string,
  containmentRoot: string,
  options: { readonly allowLinkIndirection?: boolean; readonly toolId?: string } = {},
): TrustedToolDescriptor {
  return createTrustedToolDescriptor({
    toolId: options.toolId ?? "containment-test",
    executablePath,
    containmentRoot,
    platform: process.platform as "win32" | "darwin" | "linux",
    architecture: process.arch as "x64" | "arm64",
    trustSource: "operator-pinned",
    allowLinkIndirection: options.allowLinkIndirection ?? false,
  });
}

async function refusal(tool: TrustedToolDescriptor): Promise<ProcessBrokerError> {
  const error = await resolveTrustedTool(tool).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProcessBrokerError);
  return error as ProcessBrokerError;
}

async function createDirectoryAlias(target: string, alias: string): Promise<void> {
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
}

async function pathContainsLink(path: string): Promise<boolean> {
  const { root } = parse(path);
  let current = root;
  for (const component of path.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function windowsSpellingKind(lexical: string, canonical: string): Promise<string> {
  if (lexical === canonical) return "already-canonical";
  if (lexical.toLocaleLowerCase("en-US") === canonical.toLocaleLowerCase("en-US")) {
    return "casing-only";
  }
  const lexicalComponents = lexical.split(/[\\/]+/);
  const canonicalComponents = canonical.split(/[\\/]+/);
  if (
    lexicalComponents.some(
      (component, index) =>
        /~\d+(?:\.|$)/i.test(component) &&
        component.toLocaleLowerCase("en-US") !==
          (canonicalComponents[index] ?? "").toLocaleLowerCase("en-US"),
    )
  ) {
    return "8.3-short-name-to-long-name";
  }
  if (await pathContainsLink(lexical)) return "junction-or-symlink-resolution";
  return "other-canonical-spelling";
}

describe("trusted-tool canonical containment", () => {
  it("accepts a canonical tool inside a canonical root", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const file = join(root, "tool.bin");
    await mkdir(root);
    await writeFile(file, "tool");

    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(file);
    await expect(resolveTrustedTool(descriptor(canonicalFile, canonicalRoot))).resolves.toMatchObject({
      toolId: "containment-test",
    });
  });

  it("accepts a nested canonical descendant", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const file = join(root, "nested", "deep", "tool.bin");
    await mkdir(join(root, "nested", "deep"), { recursive: true });
    await writeFile(file, "tool");

    await expect(resolveTrustedTool(descriptor(file, root))).resolves.toMatchObject({
      executablePath: file,
    });
  });

  it("accepts the ambient Windows temporary-root spelling without exposing either path", async () => {
    const root = await scratchRoot();
    const file = join(root, "tool.bin");
    await writeFile(file, "tool");
    const canonicalRoot = await realpath(root);

    if (
      process.platform === "win32" &&
      process.env["GITHUB_ACTIONS"] === "true" &&
      root !== canonicalRoot
    ) {
      // This classification is the only runner-specific diagnostic emitted.
      // The operands themselves remain private, including on a failed run.
      console.info(`L-03 Windows path spelling: ${await windowsSpellingKind(root, canonicalRoot)}`);
    }

    await expect(resolveTrustedTool(descriptor(file, root))).resolves.toMatchObject({
      toolId: "containment-test",
    });
  });

  if (process.platform === "win32") {
    it("accepts a case-variant Windows root spelling after both operands are canonicalized", async () => {
      const taskRoot = await scratchRoot();
      const root = join(taskRoot, "Canonical-Root");
      const alias = join(taskRoot, "cANONICAL-rOOT");
      const file = join(root, "tool.bin");
      await mkdir(root);
      await writeFile(file, "tool");

      expect(await windowsSpellingKind(alias, await realpath(alias))).toBe("casing-only");
      await expect(resolveTrustedTool(descriptor(file, alias))).resolves.toMatchObject({
        toolId: "containment-test",
      });
    });
  }

  it("accepts deliberate executable-link indirection when its target remains inside", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const targetDirectory = join(root, "target");
    const aliasDirectory = join(root, "alias");
    const target = join(targetDirectory, "tool.bin");
    const alias = join(aliasDirectory, "tool.bin");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(target, "tool");
    await createDirectoryAlias(targetDirectory, aliasDirectory);

    await expect(
      resolveTrustedTool(descriptor(alias, root, { allowLinkIndirection: true })),
    ).resolves.toMatchObject({ toolId: "containment-test" });
  });

  it("refuses a missing root when root canonicalization fails", async () => {
    const taskRoot = await scratchRoot();
    const file = join(taskRoot, "tool.bin");
    const missingRoot = join(taskRoot, "missing-root");
    await writeFile(file, "tool");

    const error = await refusal(descriptor(file, missingRoot, { toolId: "missing-root" }));
    expect(error.code).toBe("EXECUTABLE_UNAVAILABLE");
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain(file);
    expect(serialized).not.toContain(missingRoot);
  });

  it("refuses a missing executable", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const missingFile = join(root, "missing.bin");
    await mkdir(root);

    await expect(resolveTrustedTool(descriptor(missingFile, root))).rejects.toMatchObject({
      code: "EXECUTABLE_UNAVAILABLE",
    });
  });

  it("refuses an executable canonicalization failure after authorized link inspection", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const target = join(taskRoot, "removed-target");
    const danglingAlias = join(taskRoot, "dangling-tool");
    await mkdir(root);
    await mkdir(target);
    await createDirectoryAlias(target, danglingAlias);
    await rm(target, { recursive: true });

    await expect(
      resolveTrustedTool(
        descriptor(danglingAlias, root, {
          allowLinkIndirection: true,
          toolId: "unresolvable-tool",
        }),
      ),
    ).rejects.toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });
  });

  it("refuses an existing tool outside the canonical root without serializing either operand", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const outside = join(taskRoot, "outside");
    const file = join(outside, "tool.bin");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(file, "tool");

    const error = await refusal(descriptor(file, root, { toolId: "outside" }));
    expect(error.code).toBe("EXECUTABLE_UNSAFE");
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain(file);
    expect(serialized).not.toContain(root);
  });

  it("refuses a normalized dot-dot escape", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const outside = join(taskRoot, "outside");
    const file = join(outside, "tool.bin");
    await mkdir(join(root, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(file, "tool");

    const escapedSpelling = join(root, "nested", "..", "..", "outside", "tool.bin");
    await expect(resolveTrustedTool(descriptor(escapedSpelling, root))).rejects.toMatchObject({
      code: "EXECUTABLE_UNSAFE",
    });
  });

  it("refuses a sibling-prefix collision", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const sibling = join(taskRoot, "root-evil");
    const file = join(sibling, "tool.bin");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(file, "tool");

    await expect(resolveTrustedTool(descriptor(file, root))).rejects.toMatchObject({
      code: "EXECUTABLE_UNSAFE",
    });
  });

  it("refuses equality because the descriptor root must be a directory", async () => {
    const taskRoot = await scratchRoot();
    const file = join(taskRoot, "tool.bin");
    await writeFile(file, "tool");

    await expect(resolveTrustedTool(descriptor(file, file))).rejects.toMatchObject({
      code: "EXECUTABLE_UNSAFE",
    });
  });

  it("refuses a non-directory containment root", async () => {
    const taskRoot = await scratchRoot();
    const file = join(taskRoot, "tool.bin");
    const rootFile = join(taskRoot, "root.bin");
    await writeFile(file, "tool");
    await writeFile(rootFile, "not a directory");

    await expect(resolveTrustedTool(descriptor(file, rootFile))).rejects.toMatchObject({
      code: "EXECUTABLE_UNSAFE",
    });
  });

  it("refuses a linked root even when executable indirection is allowed", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const rootAlias = join(taskRoot, "root-alias");
    const file = join(root, "tool.bin");
    await mkdir(root);
    await writeFile(file, "tool");
    await createDirectoryAlias(root, rootAlias);

    await expect(
      resolveTrustedTool(descriptor(file, rootAlias, { allowLinkIndirection: true })),
    ).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
  });

  it("refuses an executable reached through a junction or symlink that escapes the root", async () => {
    const taskRoot = await scratchRoot();
    const root = join(taskRoot, "root");
    const outside = join(taskRoot, "outside");
    const alias = join(root, "escape-alias");
    const target = join(outside, "tool.bin");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(target, "tool");
    await createDirectoryAlias(outside, alias);

    await expect(resolveTrustedTool(descriptor(join(alias, "tool.bin"), root))).rejects.toMatchObject({
      code: "EXECUTABLE_UNSAFE",
    });
  });

  const hasDifferentWindowsVolume =
    process.platform === "win32" &&
    parse(tmpdir()).root.toLocaleLowerCase("en-US") !==
      parse(fileURLToPath(import.meta.url)).root.toLocaleLowerCase("en-US");

  it.skipIf(!hasDifferentWindowsVolume)(
    "refuses a Windows cross-volume result when the runner exposes two volumes",
    async () => {
      const root = await scratchRoot();
      await expect(
        resolveTrustedTool(descriptor(fileURLToPath(import.meta.url), root)),
      ).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
    },
  );

  if (process.platform !== "win32") {
    it("preserves the executable leaf-link indirection policy on POSIX", async () => {
      const taskRoot = await scratchRoot();
      const root = join(taskRoot, "root");
      const target = join(root, "target.bin");
      const alias = join(root, "alias.bin");
      await mkdir(root);
      await writeFile(target, "tool");
      await symlink(target, alias, "file");

      await expect(resolveTrustedTool(descriptor(alias, root))).rejects.toMatchObject({
        code: "EXECUTABLE_UNSAFE",
      });
      await expect(
        resolveTrustedTool(descriptor(alias, root, { allowLinkIndirection: true })),
      ).resolves.toMatchObject({ toolId: "containment-test" });
    });

    it("preserves POSIX case-sensitive component semantics", async () => {
      const taskRoot = await scratchRoot();
      const upperRoot = join(taskRoot, "Root");
      const lowerRoot = join(taskRoot, "root");
      const file = join(upperRoot, "tool.bin");
      await mkdir(upperRoot);
      await mkdir(lowerRoot);
      await writeFile(file, "tool");

      await expect(resolveTrustedTool(descriptor(file, lowerRoot))).rejects.toMatchObject({
        code: "EXECUTABLE_UNSAFE",
      });
    });
  }
});
