/**
 * Minimal ambient declaration for the better-sqlite3 CommonJS module. The
 * driver is deliberately typed structurally in ./driver.ts so that no
 * driver type ever crosses this package's public API boundary.
 */
declare module "better-sqlite3" {
  const DatabaseConstructor: new (filename: string) => unknown;
  export = DatabaseConstructor;
}
