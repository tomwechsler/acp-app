// Tests für «Zwischenstand speichern» und «Gespeicherte Bewertung laden» (src/js/savefile.js).
// Ausführen nach `python3 build/build_data.py`:
//   node tests/savefile.test.mjs
// Bei einem Fehler endet das Skript mit einer Exception (Exit-Code ungleich 0).

import data from '../src/data/acp-data.js';
import { NA } from '../src/js/scoring.js';
import { FILE_FORMAT, FILE_FORMAT_VERSION, createSaveFile, parseSaveFile, saveFileName } from '../src/js/savefile.js';

const log = globalThis.console?.log ?? globalThis.print;
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  log(`ok - ${name}`);
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: erwartet ${e}, erhalten ${a}`);
}

const LISTS = { industries: ['Handel', 'Andere'], sizes: ['1–9', '10–49'] };
const controls = data.domains.flatMap((d) => d.controls);
const ko = controls.find((c) => c.ko);
const ALL = data.domains.map((d) => d.id);

function sampleState() {
  const answers = {};
  controls.forEach((c, i) => {
    answers[c.id] = c.ko ? i % 4 : [0, 1, 2, 3, NA][i % 5];
  });
  return {
    company: { name: 'Muster AG', industry: 'Handel', size: '10–49', contact: 'Erika Muster', date: '2026-11-09' },
    selected: [...ALL],
    answers,
  };
}

const roundTrip = (state) => parseSaveFile(JSON.stringify(createSaveFile(data, state, '2026-11-09')), data, LISTS);
const parseObject = (object) => parseSaveFile(JSON.stringify(object), data, LISTS);

test('Speichern und Laden ergibt denselben Stand', () => {
  const state = sampleState();
  const loaded = roundTrip(state);
  equal(loaded.ok, true, 'ok');
  equal(loaded.company, state.company, 'Firmendaten');
  equal(loaded.selected, state.selected, 'Domänen');
  equal(loaded.answers, state.answers, 'Antworten');
  equal(loaded.framework, data.version, 'Framework-Version');
  equal(loaded.savedAt, '2026-11-09', 'Speicherdatum');
  equal(loaded.ignored, 0, 'nichts verworfen');
});

test('Die Datei enthält nur, was nötig ist, und einen Hinweis zur Vertraulichkeit', () => {
  const file = createSaveFile(data, sampleState(), '2026-11-09');
  equal(Object.keys(file), ['format', 'formatVersion', 'note', 'framework', 'savedAt', 'company', 'domains', 'answers'], 'Felder');
  equal([file.format, file.formatVersion], [FILE_FORMAT, FILE_FORMAT_VERSION], 'Format');
  equal(file.note.includes('vertraulich') && file.note.includes('kein Nachweis'), true, 'Hinweis');
  equal(JSON.stringify(file).includes('score'), false, 'kein gespeichertes Resultat');
});

test('Gespeichert werden nur Antworten der gewählten Domänen, offene Controls fehlen', () => {
  const state = sampleState();
  state.selected = [1, 4];
  delete state.answers['1.1'];
  const file = createSaveFile(data, state, '2026-11-09');
  const ids = Object.keys(file.answers);
  equal(ids.every((id) => id.startsWith('1.') || id.startsWith('4.')), true, 'nur Domänen 1 und 4');
  equal(ids.includes('1.1'), false, 'offenes Control fehlt');
  equal(file.domains, [1, 4], 'Domänen');
});

test('Ungültige Dateien werden mit einer verständlichen Meldung abgelehnt', () => {
  for (const text of ['', 'kein JSON', '[]', 'null', '42', '{"format":"anderes","formatVersion":1,"domains":[],"answers":{}}']) {
    const r = parseSaveFile(text, data, LISTS);
    equal(r.ok, false, `abgelehnt: ${text}`);
    equal(r.error.startsWith('Diese Datei ist kein gespeicherter Zwischenstand'), true, `Meldung: ${text}`);
  }
  const file = createSaveFile(data, sampleState(), '2026-11-09');
  equal(parseObject({ ...file, answers: [] }).ok, false, 'Antworten als Liste');
  equal(parseObject({ ...file, domains: '1,2' }).ok, false, 'Domänen als Text');
  const newer = parseObject({ ...file, formatVersion: FILE_FORMAT_VERSION + 1 });
  equal([newer.ok, newer.error.includes('neueren Version')], [false, true], 'neueres Format');
});

test('Unbekannte oder ungültige Angaben werden verworfen und gezählt', () => {
  const file = createSaveFile(data, sampleState(), '2026-11-09');
  file.domains = [...file.domains, 99, '3', 3];
  file.answers = {
    '1.1': 2,
    '1.2': '2',
    '1.3': 4,
    '1.4': -1,
    '1.5': 1.5,
    '1.6': null,
    '99.1': 3,
    ['__proto__']: 3,
    [ko.id]: NA,
  };
  const r = parseSaveFile(JSON.stringify(file), data, LISTS);
  equal(r.ok, true, 'ok');
  equal(r.selected, ALL, 'gültige Domänen in fester Reihenfolge, ohne Duplikate');
  equal(r.answers, { '1.1': 2 }, 'nur gültige Antwort');
  equal(r.ignored, 2 + 8, 'verworfen: 2 Domänen, 8 Antworten (inkl. N/A bei KO)');
  equal(Object.getPrototypeOf(r.answers), Object.prototype, 'kein verändertes Prototyp-Objekt');
});

test('Firmendaten werden geprüft und gekürzt', () => {
  const file = createSaveFile(data, sampleState(), '2026-11-09');
  file.company = { name: `  ${'x'.repeat(300)}  `, industry: 'Erfunden', size: 7, contact: { a: 1 }, date: '9.11.2026' };
  file.savedAt = 'gestern';
  const r = parseObject(file);
  equal(r.company.name.length, 120, 'Name gekürzt');
  equal([r.company.industry, r.company.size, r.company.contact, r.company.date], ['', '', '', ''], 'ungültige Felder leer');
  equal(r.savedAt, '', 'ungültiges Speicherdatum');
  const missing = parseObject({ format: FILE_FORMAT, formatVersion: 1, domains: [1], answers: {} });
  equal([missing.ok, missing.company.name, missing.framework], [true, '', ''], 'ohne Firmendaten und Version');
});

test('Datei aus einer anderen Framework-Version: passende Antworten bleiben, der Rest wird gezählt', () => {
  const file = createSaveFile(data, sampleState(), '2026-11-09');
  file.framework = '2.1';
  file.answers['4.7'] = 2;
  const r = parseObject(file);
  equal(r.framework, '2.1', 'Version der Datei');
  equal(r.ignored, 1, 'nicht mehr vorhandenes Control');
  equal(Object.keys(r.answers).length, Object.keys(file.answers).length - 1, 'übrige Antworten übernommen');
});

test('Dateiname ohne Sonderzeichen', () => {
  equal(saveFileName({ name: 'Müller & Söhne AG' }, '2026-11-09'), 'ACP-Selbstbewertung-Mueller-Soehne-AG-2026-11-09.json', 'mit Firmenname');
  equal(saveFileName({ name: '' }, '2026-11-09'), 'ACP-Selbstbewertung-2026-11-09.json', 'ohne Firmenname');
  equal(saveFileName({ name: '../../etc/passwd' }, '2026-11-09'), 'ACP-Selbstbewertung-etc-passwd-2026-11-09.json', 'ohne Pfad');
  equal(saveFileName({ name: 'Crème Brûlée GmbH' }, '2026-11-09'), 'ACP-Selbstbewertung-Creme-Brulee-GmbH-2026-11-09.json', 'Akzente');
  equal(saveFileName({ name: 'A'.repeat(39) + ' B' }, '2026-11-09').includes('--'), false, 'kein doppelter Bindestrich');
});

log(`${passed} Tests bestanden`);
