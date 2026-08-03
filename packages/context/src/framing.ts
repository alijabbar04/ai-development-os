/**
 * Serialization and the trust boundary.
 *
 * Retrieved material can contain anything, including text that looks exactly
 * like a frame delimiter, a role marker, or a system instruction. Two
 * mechanisms keep that harmless, and neither of them is "hope the delimiter is
 * unusual":
 *
 * 1. **Length prefixes are authoritative.** Every body is preceded by its
 *    exact UTF-8 byte count. A reader consumes that many bytes and stops. A
 *    body containing the end marker therefore cannot terminate its own block
 *    early, and a body containing a begin marker cannot start a new one.
 * 2. **Trust is structural, not prose.** Every item carries `trust:
 *    "untrusted"` as a field of the pack, alongside its source kind, digest,
 *    scope label, and provenance. A consumer that ignores those fields and
 *    reads only the rendered text is misusing the pack; the structured form is
 *    the contract.
 *
 * Bodies are additionally stripped of control characters, zero-width
 * characters, and bidirectional overrides, so rendered output cannot be made
 * to display as something other than what it is. Occurrences of the frame
 * markers are *counted and reported* rather than removed: the count is
 * evidence of a poisoning attempt that a later stage may want, and the length
 * prefix already makes the occurrence inert.
 *
 * This module renders a transport form. It is **not** a prompt compiler. It
 * emits no system message, no role, and no instruction — deciding what a model
 * is told belongs to Stage 16.
 */

export const CONTEXT_FRAME_VERSION = 1 as const;

export const FRAME_HEADER = "<<<ADOS-CONTEXT";
export const FRAME_ITEM = "<<<ADOS-ITEM";
export const FRAME_BODY = "<<<ADOS-BODY";
export const FRAME_END = "<<<ADOS-END>>>";

const FRAME_SENTINELS: readonly string[] = Object.freeze([
  FRAME_HEADER,
  FRAME_ITEM,
  FRAME_BODY,
  FRAME_END,
]);

export interface SanitizedText {
  readonly text: string;
  /** Number of code points removed. Reported, never silently absorbed. */
  readonly removed: number;
}

/**
 * Removes characters that could forge a boundary or misrepresent the rendered
 * text. Tab, newline, and carriage return survive: they are ordinary in source
 * code and cannot forge anything given a length prefix.
 */
export function sanitizeContextText(text: string): SanitizedText {
  let result = "";
  let removed = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += character;
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      removed += 1;
      continue;
    }
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      removed += 1;
      continue;
    }
    result += character;
  }
  return Object.freeze({ text: result, removed });
}

/** Counts frame markers appearing inside a body. Evidence, not an error. */
export function countFrameSentinels(text: string): number {
  let total = 0;
  for (const sentinel of FRAME_SENTINELS) {
    let index = text.indexOf(sentinel);
    while (index !== -1) {
      total += 1;
      index = text.indexOf(sentinel, index + sentinel.length);
    }
  }
  return total;
}

export interface RenderableItem {
  readonly ordinal: number;
  readonly sourceKind: string;
  readonly identity: string;
  readonly digest: string;
  readonly category: string;
  readonly classification: string;
  readonly disclosure: string;
  readonly trust: "untrusted";
  readonly observedAt: string;
  readonly truncated: boolean;
  readonly extractionRange: { readonly startLine: number; readonly endLine: number } | null;
  readonly byteContribution: number;
  readonly body: string;
}

export interface RenderablePack {
  readonly fingerprint: string;
  readonly items: readonly RenderableItem[];
}

/**
 * Deterministic transport rendering. Byte-identical for identical packs, with
 * no locale-sensitive formatting and no iteration over an unordered structure.
 */
export function renderContextPack(pack: RenderablePack): string {
  const lines: string[] = [
    `${FRAME_HEADER} v=${CONTEXT_FRAME_VERSION} items=${pack.items.length} fingerprint=${pack.fingerprint}>>>`,
  ];
  for (const item of pack.items) {
    const range =
      item.extractionRange === null
        ? "none"
        : `${item.extractionRange.startLine}-${item.extractionRange.endLine}`;
    lines.push(
      [
        `${FRAME_ITEM} n=${item.ordinal}`,
        `kind=${item.sourceKind}`,
        `category=${item.category}`,
        `id=${item.identity}`,
        `digest=${item.digest}`,
        `classification=${item.classification}`,
        `disclosure=${item.disclosure}`,
        `trust=${item.trust}`,
        `observed=${item.observedAt}`,
        `lines=${range}`,
        `truncated=${item.truncated ? "yes" : "no"}`,
        ">>>",
      ].join(" "),
    );
    // The byte count is the authority for where this body ends. Anything the
    // body itself contains is inert.
    lines.push(`${FRAME_BODY} bytes=${item.byteContribution}>>>`);
    lines.push(item.body);
    lines.push(FRAME_END);
  }
  return `${lines.join("\n")}\n`;
}
