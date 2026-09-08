/** Closing a confirmed native modal can discard the automation script's reply.
 * Only its separate main-owned decision proves the result; a successful click
 * alone never grants authority. Callers retain their existing decision deadline. */
export async function nativeConfirmationResult<T>(decision: Promise<T>, click: Promise<boolean>): Promise<T> {
  return await Promise.race([decision, click.then((clicked) => {
    if (!clicked) throw new Error("SMOKE_CONFIRMATION_CONTROL_UNAVAILABLE");
    return decision;
  })]);
}
