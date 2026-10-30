// Bezug der Selbstbewertung zu ISO/IEC 27001, NIS2, NIST CSF und OWASP.
// Welche Controls zu welcher Anforderung gehören, legt framework/control-mapping.md fest
// (übernommen von build/build_data.py). Hier wird nur gezählt, es gibt keinen Score pro Standard.

import { isScored } from './scoring.js';

// Ab diesem Score gilt ein Control als umgesetzt (2 – Umgesetzt, 3 – Aktiv gesteuert).
export const IMPLEMENTED_FROM = 2;

export function evaluateStandards(data, selectedIds, answers) {
  const selected = new Map();
  for (const domain of data.domains) {
    if (!selectedIds.includes(domain.id)) continue;
    for (const control of domain.controls) selected.set(control.id, control);
  }
  return data.standards
    .filter((view) => !view.requiresDomain || selectedIds.includes(view.requiresDomain))
    .map((view) => ({
      ...view,
      rows: view.rows.map((row) => {
        const items = row.controls
          .filter((id) => selected.has(id))
          .map((id) => ({ id, text: selected.get(id).text, answer: answers[id] }));
        const scored = items.filter((c) => isScored(c.answer));
        return {
          ...row,
          items,
          scored: scored.length,
          implemented: scored.filter((c) => c.answer >= IMPLEMENTED_FROM).length,
          notSelected: row.controls.length - items.length,
        };
      }),
    }));
}
