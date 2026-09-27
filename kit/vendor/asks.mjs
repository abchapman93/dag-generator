// Ask subjects — what a card is ABOUT, and which cards a newer one displaces.
//
// The bus targets a SURFACE, but a surface is rarely working on one thing. The
// practice room works one problem at a time; the voice workshop works one
// snippet at a time; an editor session works one span at a time. Two surfaces
// discovered this independently and each bolted its own key onto the payload
// (`payload.problem_id` in learning's practice router, `payload.snippet_id` in
// voice-workshop) with the filtering written outside the kit both times. This
// module names the concept once: `payload.subject`.
//
// WHY IT MATTERS, and it is not tidiness. On 2026-07-26 a voice-workshop
// session emitted a second revision card for a snippet whose first card was
// still live, and sent the correction to chat — the surface Alec was not
// looking at. Both cards had write authority over the same span. He answered
// the stale one and it wrote junk into a page he cares about. Retraction
// (outbound.retractAsk) gives a session the verb it lacked; `staleBySubject`
// gives every surface the same answer to "is this card still the live one?"
// without three more copies of the reasoning.
//
// Pure ESM, no node imports: a surface's server imports it directly and its
// frontend is served the same file, so the two halves cannot drift.

/**
 * What an ask is about, or null for a surface-wide one.
 *
 * Surface-wide is the honest default: a card with no subject is answerable
 * whatever the surface is currently showing, which is what an unscoped ask has
 * always meant. Never invent a subject for one — a guessed subject would hide
 * the card behind a filter its author never opted into.
 */
export function subjectOf(ask) {
  const s = ask && ask.payload && ask.payload.subject;
  return typeof s === 'string' && s ? s : null;
}

/**
 * The ask_ids displaced by a newer card on the same subject.
 *
 * `asks` is the live (unanswered, unretracted) list, newest first — the order
 * outbound.listAsks returns. For each subject the newest ask is live and every
 * older one is stale. Subject-less asks are never stale: nothing identifies
 * what would replace them.
 *
 * Stale is a WEAKER state than retracted, deliberately. Retraction is the
 * session's explicit withdrawal and removes the card; staleness is inferred, so
 * the card stays visible and merely loses its authority to act. A surface that
 * hid stale cards outright would silently swallow a card the session meant to
 * keep — the failure mode the ✕-on-every-card workaround exists to avoid.
 */
export function staleBySubject(asks) {
  const seen = new Set();
  const stale = new Set();
  for (const ask of asks || []) {
    const subject = subjectOf(ask);
    if (!subject) continue;
    if (seen.has(subject)) stale.add(ask.ask_id);
    else seen.add(subject);
  }
  return stale;
}
