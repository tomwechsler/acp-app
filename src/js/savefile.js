// Zwischenstand als Datei: Die Datei entsteht im Browser und wird dort wieder gelesen.
// Sie wird nie an einen Server übertragen. Sie enthält nur Firmendaten, gewählte Domänen
// und Antworten; das Resultat wird beim Laden immer neu berechnet.

import { NA } from './scoring.js';

export const FILE_FORMAT = 'acp-selbstbewertung';
export const FILE_FORMAT_VERSION = 1;
export const MAX_FILE_BYTES = 100000;
const MAX_TEXT = 120;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const FILE_NOTE =
  'Zwischenstand der ACP-Selbstbewertung (https://acp.videotrainer.ch/). ' +
  'Die Datei enthält Firmendaten und Antworten und zeigt damit auch Lücken: vertraulich behandeln. ' +
  'Sie beruht auf einer Selbsteinschätzung und ist kein Nachweis.';

// Gespeichert werden nur die Antworten der gewählten Domänen, also das, was im Resultat erscheint.
export function createSaveFile(data, state, savedAt) {
  const answers = {};
  for (const domain of data.domains) {
    if (!state.selected.includes(domain.id)) continue;
    for (const control of domain.controls) {
      const answer = state.answers[control.id];
      if (answer === 0 || answer === 1 || answer === 2 || answer === 3 || (answer === NA && !control.ko)) {
        answers[control.id] = answer;
      }
    }
  }
  const c = state.company;
  return {
    format: FILE_FORMAT,
    formatVersion: FILE_FORMAT_VERSION,
    note: FILE_NOTE,
    framework: data.version,
    savedAt,
    company: { name: c.name, industry: c.industry, size: c.size, contact: c.contact, date: c.date },
    domains: [...state.selected],
    answers,
  };
}

export function saveFileName(company, date) {
  const name = company.name
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `ACP-Selbstbewertung-${name ? `${name}-` : ''}${date}.json`;
}

const NOT_A_SAVE_FILE = 'Diese Datei ist kein gespeicherter Zwischenstand der ACP-Selbstbewertung.';

// Liest eine Datei streng: Übernommen wird nur, was zu dieser App und diesem Framework passt.
// Ergebnis: { ok: true, company, selected, answers, framework, savedAt, ignored } oder { ok: false, error }.
export function parseSaveFile(text, data, { industries, sizes }) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_A_SAVE_FILE };
  }
  if (!isObject(file) || file.format !== FILE_FORMAT || !Number.isInteger(file.formatVersion)) {
    return { ok: false, error: NOT_A_SAVE_FILE };
  }
  if (file.formatVersion > FILE_FORMAT_VERSION) {
    return { ok: false, error: 'Diese Datei wurde mit einer neueren Version der App erstellt. Bitte laden Sie die Seite neu und versuchen Sie es nochmals.' };
  }
  if (!Array.isArray(file.domains) || !isObject(file.answers)) {
    return { ok: false, error: NOT_A_SAVE_FILE };
  }

  let ignored = 0;
  const domainIds = new Set(data.domains.map((d) => d.id));
  const wanted = new Set();
  for (const id of file.domains) {
    if (domainIds.has(id)) wanted.add(id);
    else ignored += 1;
  }
  const selected = data.domains.map((d) => d.id).filter((id) => wanted.has(id));

  const controls = new Map(data.domains.flatMap((d) => d.controls.map((c) => [c.id, c])));
  const answers = {};
  for (const [id, answer] of Object.entries(file.answers)) {
    const control = controls.get(id);
    const valid = answer === 0 || answer === 1 || answer === 2 || answer === 3 || (answer === NA && control && !control.ko);
    if (control && valid) answers[id] = answer;
    else ignored += 1;
  }

  const company = isObject(file.company) ? file.company : {};
  const text120 = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '');
  const oneOf = (value, list) => (list.includes(value) ? value : '');
  const date = (value) => (typeof value === 'string' && ISO_DATE.test(value) ? value : '');

  return {
    ok: true,
    company: {
      name: text120(company.name),
      industry: oneOf(company.industry, industries),
      size: oneOf(company.size, sizes),
      contact: text120(company.contact),
      date: date(company.date),
    },
    selected,
    answers,
    framework: typeof file.framework === 'string' ? file.framework.slice(0, 20) : '',
    savedAt: date(file.savedAt),
    ignored,
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
