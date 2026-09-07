import { randomBytes } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopPreferences } from "../shared/contracts.js";

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = Object.freeze({
  schemaVersion: 1,
  presentationMode: "normal",
  textScale: "standard",
  welcomeDismissed: false,
});

export function parseDesktopPreferences(value: unknown): DesktopPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("PREFERENCES_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "presentationMode,schemaVersion,textScale,welcomeDismissed") throw new Error("PREFERENCES_INVALID");
  if (record["schemaVersion"] !== 1) throw new Error("PREFERENCES_INVALID");
  if (record["presentationMode"] !== "normal" && record["presentationMode"] !== "developer") throw new Error("PREFERENCES_INVALID");
  if (record["textScale"] !== "standard" && record["textScale"] !== "large") throw new Error("PREFERENCES_INVALID");
  if (typeof record["welcomeDismissed"] !== "boolean") throw new Error("PREFERENCES_INVALID");
  return Object.freeze({
    schemaVersion: 1,
    presentationMode: record["presentationMode"],
    textScale: record["textScale"],
    welcomeDismissed: record["welcomeDismissed"],
  });
}

export async function readDesktopPreferences(root: string): Promise<DesktopPreferences> {
  try {
    const text = await readFile(join(root, "preferences.json"), "utf8");
    if (Buffer.byteLength(text, "utf8") > 4_096) throw new Error("PREFERENCES_INVALID");
    return parseDesktopPreferences(JSON.parse(text) as unknown);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    if (code === "ENOENT") return DEFAULT_DESKTOP_PREFERENCES;
    return DEFAULT_DESKTOP_PREFERENCES;
  }
}

export async function writeDesktopPreferences(root: string, value: unknown): Promise<DesktopPreferences> {
  const preferences = parseDesktopPreferences(value);
  await mkdir(root, { recursive: true });
  const target = join(root, "preferences.json");
  const temporary = join(root, `preferences-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(preferences)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return preferences;
}
