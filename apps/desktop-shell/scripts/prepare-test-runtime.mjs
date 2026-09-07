// Windows tests exercise the same owned binary as the visible Windows app.
// Other-platform contract tests use their job-owned Node child; that does not
// claim a distributable desktop runtime for those platforms.
if (process.platform === "win32") await import("./prepare-owned-runtime.mjs");
