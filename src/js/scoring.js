// Rechenregeln nach assessment/scoring-model.md des ACP-Repositorys.
// Bei Änderungen am Scoring-Modell stoppt der Build, bis diese Datei geprüft wurde.

export const NA = 'na';

// Kaufmännische Rundung auf zwei Stellen (half up).
export function round2(value) {
  return Math.round(value * 100 + 1e-9) / 100;
}

export function maturityFor(score, maturity) {
  if (score === null) return null;
  let found = maturity[0];
  for (const level of maturity) {
    if (score >= level.min) found = level;
  }
  return found;
}

export function isScored(answer) {
  return answer === 0 || answer === 1 || answer === 2 || answer === 3;
}

// Eine Bewertung ist «vollständig», wenn alle immer anwendbaren Domänen ausgewählt sind.
// Nur Domänen mit «falls anwendbar» (KI-Sicherheit) dürfen fehlen.
export function isFullAssessment(data, selectedIds) {
  return data.domains.every((d) => d.conditional || selectedIds.includes(d.id));
}

export function domainResult(domain, answers) {
  const scores = [];
  let na = 0;
  let open = 0;
  for (const control of domain.controls) {
    const answer = answers[control.id];
    if (isScored(answer)) scores.push(answer);
    else if (answer === NA && !control.ko) na += 1;
    else open += 1;
  }
  const score = scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return { score, scored: scores.length, na, open, total: domain.controls.length };
}

export function evaluate(data, selectedIds, answers) {
  const domains = data.domains
    .filter((d) => selectedIds.includes(d.id))
    .map((d) => {
      const result = domainResult(d, answers);
      return { ...d, ...result, maturity: maturityFor(result.score, data.maturity) };
    });

  const scoredDomains = domains.filter((d) => d.score !== null);
  const overall = scoredDomains.length
    ? round2(scoredDomains.reduce((sum, d) => sum + d.score, 0) / scoredDomains.length)
    : null;

  const controls = domains.flatMap((d) =>
    d.controls.map((c) => ({ ...c, domainId: d.id, domainName: d.name, critical: d.critical, answer: answers[c.id] })),
  );
  const koControls = controls.filter((c) => c.ko);
  const koFailed = koControls.filter((c) => c.answer === 0);
  const criticalDomains = scoredDomains.filter((d) => d.critical);
  const criticalFailed = criticalDomains.filter((d) => d.score < data.criticalThreshold);

  const checks = [
    {
      id: 'overall',
      label: `ACP-Gesamtscore mindestens ${data.overallThreshold.toFixed(2)}`,
      met: overall !== null && overall >= data.overallThreshold,
    },
    {
      id: 'critical',
      label: `Jede kritische Domäne mindestens ${data.criticalThreshold.toFixed(2)}`,
      met: criticalFailed.length === 0,
      detail: criticalFailed.map((d) => `${d.id}. ${d.name}`),
    },
    {
      id: 'ko',
      label: 'Kein Knock-out-Control mit Score 0',
      met: koFailed.length === 0,
      detail: koFailed.map((c) => `${c.id} ${c.text}`),
    },
  ];

  const order = (c) => (c.ko && c.answer === 0 ? 0 : 1);
  const improvements = controls
    .filter((c) => c.answer === 0 || c.answer === 1)
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        a.answer - b.answer ||
        Number(b.critical) - Number(a.critical) ||
        compareIds(a.id, b.id),
    );

  const distribution = { 0: 0, 1: 0, 2: 0, 3: 0, [NA]: 0 };
  for (const c of controls) {
    if (isScored(c.answer)) distribution[c.answer] += 1;
    else if (c.answer === NA) distribution[NA] += 1;
  }

  return {
    domains,
    overall,
    maturity: maturityFor(overall, data.maturity),
    full: isFullAssessment(data, selectedIds),
    checks,
    allChecksMet: checks.every((c) => c.met),
    koControls,
    improvements,
    distribution,
  };
}

export function compareIds(a, b) {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2;
}
