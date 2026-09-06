/** UTF-16 code-unit order. Canonical bytes must not depend on host collation. */
export function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
