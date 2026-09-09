/** Presentation memory only. Durable drafts are saved by the application;
 * background status and native confirmations cannot discard later typing. */
export class PlanningEditBuffer {
  readonly #drafts = new Map<string, Map<string, string>>();

  read(subject: string, field: string, saved: string): string {
    const fields = this.#drafts.get(subject), local = fields?.get(field);
    if (local === undefined) return saved;
    // A confirmed save acknowledges only the exact value it contains. Edits
    // made while that save was pending remain in the presentation buffer.
    if (local === saved) {
      fields!.delete(field);
      if (fields!.size === 0) this.#drafts.delete(subject);
      return saved;
    }
    return local;
  }

  edit(subject: string, field: string, value: string): void {
    let fields = this.#drafts.get(subject);
    if (fields === undefined) { fields = new Map(); this.#drafts.set(subject, fields); }
    fields.set(field, value);
  }

  hasUnsaved(subject: string): boolean { return (this.#drafts.get(subject)?.size ?? 0) > 0; }
}

/** The durable codec can reorder object fields. That must not create phantom
 * unsaved edits or prevent exact acceptance after reopening. */
export function planningDraftContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(planningDraftContent).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${planningDraftContent(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export interface PlanningFocus {
  readonly id: string;
  readonly start: number | null;
  readonly end: number | null;
}

export function capturePlanningFocus(root: HTMLElement): PlanningFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active) || active.id.length === 0) return null;
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  return { id: active.id, start: selection ? active.selectionStart : null, end: selection ? active.selectionEnd : null };
}

export function restorePlanningFocus(root: HTMLElement, focus: PlanningFocus | null): boolean {
  if (focus === null) return false;
  const target = [...root.querySelectorAll<HTMLElement>("[id]")].find(element => element.id === focus.id);
  if (target === undefined || ("disabled" in target && target.disabled === true)) return false;
  target.focus({ preventScroll: true });
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && focus.start !== null && focus.end !== null) {
    target.setSelectionRange(focus.start, focus.end);
  }
  return document.activeElement === target;
}
