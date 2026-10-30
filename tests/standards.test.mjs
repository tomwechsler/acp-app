// Tests der Ansicht «Bezug zu Standards» (Daten aus framework/control-mapping.md).
// Ausführen nach `python3 build/build_data.py`:
//   node tests/standards.test.mjs
// Bei einem Fehler endet das Skript mit einer Exception (Exit-Code ungleich 0).

import data from '../src/data/acp-data.js';
import { NA } from '../src/js/scoring.js';
import { evaluateStandards } from '../src/js/standards.js';

const log = globalThis.console?.log ?? globalThis.print;
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  log(`ok - ${name}`);
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: erwartet ${JSON.stringify(expected)}, erhalten ${JSON.stringify(actual)}`);
  }
}

const controls = data.domains.flatMap((d) => d.controls);
const ALL = data.domains.map((d) => d.id);
const WITHOUT_AI = ALL.filter((id) => id !== 11);

function answersAll(score) {
  return Object.fromEntries(controls.map((c) => [c.id, score]));
}

const view = (views, id) => views.find((v) => v.id === id);
const row = (views, id, ref) => view(views, id).rows.find((r) => r.ref === ref);

test('Datenbasis: vier Ansichten mit den erwarteten Zeilen', () => {
  equal(data.standards.map((v) => v.id).join(','), 'iso27001,nis2,csf,owasp-llm', 'Ansichten');
  equal(data.standards.map((v) => v.rows.length).join(','), '5,13,6,10', 'Zeilen pro Ansicht');
  equal(data.standards.find((v) => v.id === 'owasp-llm').requiresDomain, 11, 'KI-Ansicht nur mit Domäne 11');
});

test('Jedes Control hat Referenzen und erscheint in mindestens einer Ansicht', () => {
  const used = new Set(data.standards.flatMap((v) => v.rows.flatMap((r) => r.controls)));
  for (const d of data.domains) {
    equal(typeof d.mappingUrl === 'string' && d.mappingUrl.includes('#domain-'), true, `Link zum Mapping Domäne ${d.id}`);
    for (const c of d.controls) {
      equal(c.refs.map((r) => r.name).slice(0, 3).join(','), 'NIS2,ISO/IEC 27001:2022,NIST CSF 2.0', `Referenzen ${c.id}`);
      equal(c.refs.length, d.id === 11 ? 5 : 3, `Anzahl Referenzen ${c.id}`);
      equal(used.has(c.id), true, `Control ${c.id} in einer Ansicht`);
    }
  }
});

test('Referenzen werden für die Anzeige übernommen', () => {
  const mfa = controls.find((c) => c.id === '4.3');
  equal(mfa.refs[0].text, 'Art. 21(2)(j)', 'NIS2 bei 4.3');
  const review = controls.find((c) => c.id === '11.9');
  equal(review.refs[0].text, null, 'kein NIS2-Bezug bei 11.9');
  equal(controls.find((c) => c.id === '11.2').refs[1].text, 'Kap. 6.1.2, 8.2', 'Kapitel statt Cl.');
});

test('Abdeckung durch ACP wird ehrlich ausgewiesen', () => {
  const views = evaluateStandards(data, ALL, answersAll(2));
  equal(row(views, 'iso27001', 'A.7').note, 'ACP bezieht sich auf 2 von 14 Controls.', 'A.7');
  equal(row(views, 'iso27001', 'Kap. 4–10').status, 'partial', 'Managementsystem teilweise');
  equal(row(views, 'nis2', 'Art. 21(2)(e)').status, 'partial', 'NIS2 (e) teilweise');
  equal(row(views, 'nis2', 'Art. 21(2)(b)').status, null, 'NIS2 (b) abgedeckt');
  equal(row(views, 'owasp-llm', 'LLM04').status, 'limited', 'LLM04 nur Risikobeurteilung');
  const csf = view(views, 'csf').rows.map((r) => Number(r.note.match(/(\d+) von (\d+)/)[2]));
  equal(csf.reduce((a, b) => a + b, 0), 106, 'NIST CSF 2.0 hat 106 Unterkategorien');
});

test('Alle Controls mit Score 2: jede Zeile vollständig umgesetzt', () => {
  const views = evaluateStandards(data, ALL, answersAll(2));
  for (const v of views) {
    for (const r of v.rows) {
      equal(r.scored, r.controls.length, `${v.id} ${r.ref} bewertet`);
      equal(r.implemented, r.scored, `${v.id} ${r.ref} umgesetzt`);
      equal(r.notSelected, 0, `${v.id} ${r.ref} nicht gewählt`);
    }
  }
});

test('Score 1 gilt nicht als umgesetzt, Score 3 schon', () => {
  const answers = answersAll(3);
  answers['8.5'] = 1;
  const r = row(evaluateStandards(data, ALL, answers), 'nis2', 'Art. 21(2)(c)');
  equal(r.scored, 5, 'bewertet');
  equal(r.implemented, 4, 'umgesetzt');
});

test('N/A zählt weder als bewertet noch als umgesetzt', () => {
  const answers = answersAll(2);
  for (const c of data.domains.find((d) => d.id === 7).controls) answers[c.id] = NA;
  const r = row(evaluateStandards(data, ALL, answers), 'nis2', 'Art. 21(2)(j)');
  equal(r.items.length, 3, 'zugeordnet');
  equal(r.scored, 2, 'bewertet ohne 7.3');
  equal(r.implemented, 2, 'umgesetzt');
});

test('Ohne Domäne 11 keine KI-Ansicht und keine KI-Controls', () => {
  const views = evaluateStandards(data, WITHOUT_AI, answersAll(2));
  equal(views.map((v) => v.id).join(','), 'iso27001,nis2,csf', 'Ansichten');
  const r = row(views, 'nis2', 'Art. 21(2)(i)');
  equal(r.items.some((c) => c.id.startsWith('11.')), false, 'keine KI-Controls');
  equal(r.notSelected, 3, '11.1, 11.3 und 11.7 nicht gewählt');
});

test('Teilbewertung zählt nur die gewählten Domänen', () => {
  const views = evaluateStandards(data, [4], answersAll(2));
  const r = row(views, 'csf', 'PR');
  equal(r.items.every((c) => c.id.startsWith('4.')), true, 'nur Domäne 4');
  equal(r.items.length + r.notSelected, r.controls.length, 'Summe');
  equal(row(views, 'nis2', 'Art. 23').items.length, 0, 'Art. 23 nicht bewertet');
});

log(`${passed} Tests bestanden`);
