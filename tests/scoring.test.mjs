// Tests der Rechenlogik gegen die Beispiele des ACP-Repositorys.
// Ausführen nach `python3 build/build_data.py`:
//   node tests/scoring.test.mjs
// Bei einem Fehler endet das Skript mit einer Exception (Exit-Code ungleich 0).

import data from '../src/data/acp-data.js';
import { NA, round2, maturityFor, domainResult, evaluate } from '../src/js/scoring.js';

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

const domain = (id) => data.domains.find((d) => d.id === id);

// Erzeugt Antworten, deren Mittelwert pro Domäne dem gewünschten Score entspricht.
function answersFor(scoresByDomain) {
  const answers = {};
  for (const [id, scores] of Object.entries(scoresByDomain)) {
    const controls = domain(Number(id)).controls;
    equal(scores.length, controls.length, `Anzahl Antworten Domäne ${id}`);
    controls.forEach((c, i) => {
      answers[c.id] = scores[i];
    });
  }
  return answers;
}

const S200 = [2, 2, 2, 2, 2, 2];
const S217 = [2, 2, 2, 2, 2, 3];
const S233 = [2, 2, 2, 2, 3, 3];
const S225 = [2, 2, 2, 2, 2, 2, 3, 3];
const ALL = data.domains.map((d) => d.id);
const WITHOUT_AI = ALL.filter((id) => id !== 11);

test('Datenbasis: 11 Domänen, 68 Controls, 6 KO-Controls', () => {
  equal(data.domains.length, 11, 'Domänen');
  equal(data.domains.reduce((s, d) => s + d.controls.length, 0), 68, 'Controls');
  equal(data.domains.flatMap((d) => d.controls).filter((c) => c.ko).length, 6, 'KO-Controls');
});

test('Rundung half up auf zwei Stellen', () => {
  equal(round2(13 / 6), 2.17, '13/6');
  equal(round2(2.125), 2.13, '2.125');
  equal(round2(2.005), 2.01, '2.005');
  equal(round2(23.59 / 11), 2.14, '23.59/11');
});

test('Reifegrad-Grenzen gemäss Scoring-Modell', () => {
  const level = (s) => maturityFor(s, data.maturity).level;
  equal(level(0), 1, '0.00');
  equal(level(0.99), 1, '0.99');
  equal(level(1.0), 2, '1.00');
  equal(level(1.99), 2, '1.99');
  equal(level(2.0), 3, '2.00');
  equal(level(2.49), 3, '2.49');
  equal(level(2.5), 4, '2.50');
  equal(level(2.79), 4, '2.79');
  equal(level(2.8), 5, '2.80');
  equal(level(3.0), 5, '3.00');
});

test('Beispiel Scoring-Modell: Domänenscore 2.17 aus 2,2,3,1,2,3', () => {
  const answers = answersFor({ 4: [2, 2, 3, 1, 2, 3] });
  equal(domainResult(domain(4), answers).score, 2.17, 'Domäne 4');
});

test('Beispiel-Assessment (examples/example-assessment.md): Gesamtscore 2.14', () => {
  const answers = answersFor({
    1: S217, 2: S200, 3: S233, 4: S233, 5: S217, 6: S200, 7: S217, 8: S225, 9: S200, 10: S217, 11: S200,
  });
  const r = evaluate(data, ALL, answers);
  equal(r.overall, 2.14, 'Gesamtscore');
  equal(r.maturity.level, 3, 'Reifegrad');
  equal(r.full, true, 'vollständig');
  equal(r.allChecksMet, true, 'Zertifizierungsbedingungen');
});

test('Beispiel Scoring-Modell ohne KI-Sicherheit: Gesamtscore 2.13', () => {
  const answers = answersFor({
    1: S217, 2: S200, 3: S200, 4: S217, 5: S217, 6: S200, 7: S233, 8: S225, 9: S217, 10: S200,
  });
  const r = evaluate(data, WITHOUT_AI, answers);
  equal(r.overall, 2.13, 'Gesamtscore');
  equal(r.full, true, 'ohne Domäne 11 trotzdem vollständig');
});

test('N/A zählt nicht zum Domänenscore', () => {
  const answers = answersFor({ 7: [3, NA, NA, NA, NA, NA] });
  const r = domainResult(domain(7), answers);
  equal(r.score, 3, 'Score');
  equal(r.na, 5, 'N/A');
  equal(r.open, 0, 'offen');
});

test('Domäne nur mit N/A wird vom Gesamtscore ausgeschlossen', () => {
  const answers = answersFor({ 6: [3, 3, 3, 3, 3, 3], 7: [NA, NA, NA, NA, NA, NA] });
  const r = evaluate(data, [6, 7], answers);
  equal(r.domains.find((d) => d.id === 7).score, null, 'Domäne 7');
  equal(r.overall, 3, 'Gesamtscore');
});

test('N/A bei KO-Control gilt als offen', () => {
  const answers = answersFor({ 4: [2, 2, NA, 2, 2, 2] });
  equal(domainResult(domain(4), answers).open, 1, 'offen');
});

test('KO-Control mit 0 verhindert die Zertifizierung trotz hohem Score', () => {
  const answers = answersFor({
    1: S233, 2: S233, 3: S233, 4: S233, 5: [3, 3, 0, 3, 3, 3], 6: S233, 7: S233, 8: S225, 9: S233, 10: S233,
  });
  const r = evaluate(data, WITHOUT_AI, answers);
  equal(r.checks.find((c) => c.id === 'overall').met, true, 'Gesamtscore erfüllt');
  equal(r.checks.find((c) => c.id === 'ko').met, false, 'KO');
  equal(r.allChecksMet, false, 'gesamt');
  equal(r.improvements[0].id, '5.3', 'KO-Control steht zuoberst bei den Handlungsfeldern');
});

test('Kritische Domäne unter 2.00 verhindert die Zertifizierung', () => {
  const answers = answersFor({
    1: S233, 2: S233, 3: S233, 4: S233, 5: S233, 6: S233, 7: S233, 8: S225, 9: [1, 1, 2, 1, 2, 2], 10: S233,
  });
  const r = evaluate(data, WITHOUT_AI, answers);
  const critical = r.checks.find((c) => c.id === 'critical');
  equal(critical.met, false, 'kritische Domänen');
  equal(critical.detail.length, 1, 'eine Domäne betroffen');
});

test('Abgewählte Pflichtdomäne ergibt eine Teilbewertung', () => {
  const r = evaluate(data, [1, 4], answersFor({ 1: S200, 4: S200 }));
  equal(r.full, false, 'Teilbewertung');
  equal(r.domains.length, 2, 'nur gewählte Domänen');
});

log(`${passed} Tests bestanden`);
