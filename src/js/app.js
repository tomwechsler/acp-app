// ACP-Selbstbewertung – läuft vollständig im Browser.
// Alle Eingaben leben nur in der Variablen `state` im Arbeitsspeicher.
// Kein localStorage, keine Cookies, keine Netzwerkanfragen.

import data from '../data/acp-data.js';
import { NA, evaluate, domainResult } from './scoring.js';

const STEPS = [
  { id: 'start', label: 'Start' },
  { id: 'company', label: 'Firmendaten' },
  { id: 'domains', label: 'Domänen' },
  { id: 'questions', label: 'Bewertung' },
  { id: 'result', label: 'Resultat' },
];

const INDUSTRIES = [
  'Bau und Immobilien',
  'Bildung',
  'Dienstleistungen',
  'Energie und Versorgung',
  'Finanzdienstleistungen',
  'Gesundheitswesen',
  'Handel',
  'Industrie und Produktion',
  'IT und Telekommunikation',
  'Öffentliche Verwaltung',
  'Transport und Logistik',
  'Versicherungen',
  'Andere',
];

const SIZES = ['1–9', '10–49', '50–249', '250–999', '1000 und mehr'];

const MAX_IMPROVEMENTS = 10;
const CONTACT_EMAIL = 'training@videotrainer.ch';

const totalControls = data.domains.reduce((sum, d) => sum + d.controls.length, 0);
const requiredDomains = data.domains.filter((d) => !d.conditional);

const state = initialState();

function initialState() {
  return {
    step: 'start',
    company: { name: '', industry: '', size: '', contact: '', date: today() },
    selected: requiredDomains.map((d) => d.id),
    answers: {},
    domainIndex: 0,
    dirty: false,
  };
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const fmt = (score) => (score === null ? '–' : score.toFixed(2));

// ---------------------------------------------------------------------------
// DOM-Hilfsfunktion: erzeugt Elemente ohne innerHTML (CSP-tauglich, kein XSS).

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function button(label, onClick, variant = 'secondary', extra = {}) {
  return h('button', { type: 'button', class: `btn btn-${variant}`, onClick, ...extra }, label);
}

function badge(text, kind) {
  return h('span', { class: `badge badge-${kind}` }, text);
}

function domainBadges(domain) {
  return [
    domain.critical && !domain.conditional ? badge('kritisch', 'critical') : null,
    domain.conditional ? badge('falls anwendbar, dann kritisch', 'conditional') : null,
  ];
}

// ---------------------------------------------------------------------------
// Ablauf

const app = document.getElementById('app');
const stepper = document.getElementById('stepper');

function goTo(step, { focus = true } = {}) {
  state.step = step;
  render();
  window.scrollTo(0, 0);
  if (focus) app.querySelector('h1')?.focus();
}

function render() {
  const view = {
    start: renderStart,
    company: renderCompany,
    domains: renderDomains,
    questions: renderQuestions,
    result: renderResult,
  }[state.step];
  app.replaceChildren(view());
  renderStepper();
  const current = STEPS.find((s) => s.id === state.step);
  document.title = state.step === 'start' ? 'ACP Selbstbewertung' : `${current.label} – ACP Selbstbewertung`;
}

function renderStepper() {
  const index = STEPS.findIndex((s) => s.id === state.step);
  stepper.replaceChildren(
    ...STEPS.map((s, i) =>
      h(
        'li',
        { class: i < index ? 'done' : i === index ? 'current' : '', 'aria-current': i === index ? 'step' : null },
        h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('span', { class: 'step-label' }, s.label),
      ),
    ),
  );
}

function privacyNotice(variant = 'full') {
  if (variant === 'result') {
    return h(
      'aside',
      { class: 'privacy privacy-compact', 'aria-label': 'Datenschutzhinweis' },
      h('strong', {}, 'Dieses Resultat wird nirgends gespeichert. '),
      'Sobald Sie die Seite schliessen oder neu laden, ist es gelöscht. Mit «Drucken / als PDF speichern» sichern Sie es lokal auf Ihrem Gerät.',
    );
  }
  return h(
    'aside',
    { class: 'privacy', 'aria-labelledby': 'privacy-title' },
    h('h2', { id: 'privacy-title' }, 'Ihre Daten bleiben bei Ihnen'),
    h(
      'ul',
      {},
      h('li', {}, h('strong', {}, 'Diese App speichert keine Daten.')),
      h('li', {}, 'Firmenname, Antworten und Resultat bleiben nur im Arbeitsspeicher Ihres Browsers und werden an keinen Server übertragen.'),
      h('li', {}, 'Es werden keine Cookies gesetzt und keine Analyse- oder Tracking-Tools verwendet.'),
      h('li', {}, 'Beim Schliessen oder Neuladen der Seite werden alle Eingaben gelöscht.'),
    ),
    h('a', { href: 'datenschutz.html', target: '_blank', rel: 'noopener' }, 'Datenschutzerklärung (öffnet in neuem Tab)'),
  );
}

// ---------------------------------------------------------------------------
// Schritt 1: Start

function renderStart() {
  return h(
    'section',
    { class: 'view view-start' },
    h('p', { class: 'eyebrow' }, `Active Cyber Program · Framework ${data.version}`),
    h('h1', { tabindex: '-1' }, 'Wie aktiv ist Ihre Cybersecurity?'),
    h(
      'p',
      { class: 'lead' },
      `Mit dieser kostenlosen Selbstbewertung prüfen Sie Ihre Organisation anhand von ${totalControls} Controls in ${data.domains.length} Domänen. ` +
        'Am Ende erhalten Sie sofort eine Zusammenfassung mit Score, Reifegrad und den wichtigsten Handlungsfeldern. ' +
        'Für alle Domänen rechnen Sie je nach Erfahrung mit rund 45–60 Minuten; einzelne Domänen sind in wenigen Minuten bewertet.',
    ),
    privacyNotice(),
    h(
      'ol',
      { class: 'how' },
      h('li', {}, h('strong', {}, 'Firmendaten'), h('span', {}, 'freiwillig, nur für die Kopfzeile Ihres Resultats')),
      h('li', {}, h('strong', {}, 'Domänen wählen'), h('span', {}, 'alle oder nur die Bereiche, die Sie interessieren')),
      h('li', {}, h('strong', {}, 'Controls bewerten'), h('span', {}, 'je Control eine Einschätzung von 0 bis 3')),
      h('li', {}, h('strong', {}, 'Resultat ansehen'), h('span', {}, 'Score, Reifegrad, kritische Punkte, Handlungsfelder')),
    ),
    h('div', { class: 'actions' }, button('Selbstbewertung starten', () => goTo('company'), 'primary')),
    h(
      'p',
      { class: 'note' },
      'Die Selbstbewertung ersetzt kein ACP-Assessment. Eine ACP-Zertifizierung kann ausschliesslich durch Wechsler Information Solution erteilt werden.',
    ),
  );
}

// ---------------------------------------------------------------------------
// Schritt 2: Firmendaten

function renderCompany() {
  const c = state.company;
  const update = (field) => (event) => {
    c[field] = event.target.value;
    state.dirty = true;
  };
  const field = (id, label, control, hint) =>
    h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null);
  const select = (id, field, options) =>
    h(
      'select',
      { id, onChange: update(field) },
      h('option', { value: '' }, 'Bitte wählen'),
      options.map((o) => h('option', { value: o, selected: c[field] === o }, o)),
    );

  const form = h(
    'form',
    {
      class: 'card form',
      autocomplete: 'off',
      onSubmit: (e) => {
        e.preventDefault();
        goTo('domains');
      },
    },
    field('company-name', 'Firmenname', h('input', { id: 'company-name', type: 'text', maxlength: '120', value: c.name, autocomplete: 'off', onInput: update('name') })),
    h(
      'div',
      { class: 'field-row' },
      field('company-industry', 'Branche', select('company-industry', 'industry', INDUSTRIES)),
      field('company-size', 'Anzahl Mitarbeitende', select('company-size', 'size', SIZES)),
    ),
    h(
      'div',
      { class: 'field-row' },
      field('company-contact', 'Ansprechperson', h('input', { id: 'company-contact', type: 'text', maxlength: '120', value: c.contact, autocomplete: 'off', onInput: update('contact') })),
      field('company-date', 'Datum der Selbstbewertung', h('input', { id: 'company-date', type: 'date', value: c.date, onInput: update('date') })),
    ),
    h(
      'div',
      { class: 'actions' },
      button('Zurück', () => goTo('start')),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Weiter zu den Domänen'),
    ),
  );

  return h(
    'section',
    { class: 'view' },
    h('h1', { tabindex: '-1' }, 'Firmendaten'),
    h(
      'p',
      { class: 'lead' },
      'Alle Angaben sind freiwillig. Sie erscheinen nur in der Kopfzeile Ihres Resultats und werden nicht gespeichert oder übertragen.',
    ),
    form,
  );
}

// ---------------------------------------------------------------------------
// Schritt 3: Domänen auswählen

function renderDomains() {
  const summary = h('p', { class: 'selection-summary', 'aria-live': 'polite' });
  const notice = h('div', { 'aria-live': 'polite' });
  const next = button('Weiter zur Bewertung', () => {
    state.domainIndex = 0;
    goTo('questions');
  }, 'primary');

  const cards = data.domains.map((domain) => {
    const checkbox = h('input', {
      type: 'checkbox',
      id: `domain-${domain.id}`,
      checked: state.selected.includes(domain.id),
      onChange: (e) => {
        toggleDomain(domain.id, e.target.checked);
        card.classList.toggle('selected', e.target.checked);
        refresh();
      },
    });
    const card = h(
      'label',
      { class: `domain-card${state.selected.includes(domain.id) ? ' selected' : ''}`, for: `domain-${domain.id}` },
      checkbox,
      h(
        'span',
        { class: 'domain-card-body' },
        h('span', { class: 'domain-num' }, `Domäne ${domain.id}`),
        h('span', { class: 'domain-name' }, domain.name),
        h('span', { class: 'domain-meta' }, `${domain.controls.length} Controls`, ...domainBadges(domain)),
        domain.conditional
          ? h('span', { class: 'domain-hint' }, 'Nur auswählen, wenn Ihre Organisation KI-Systeme entwickelt, betreibt oder nutzt.')
          : null,
      ),
    );
    return { card, checkbox, domain };
  });

  function refresh() {
    const selected = data.domains.filter((d) => state.selected.includes(d.id));
    const controls = selected.reduce((sum, d) => sum + d.controls.length, 0);
    summary.textContent = `${selected.length} von ${data.domains.length} Domänen ausgewählt · ${controls} Controls`;
    next.disabled = selected.length === 0;
    const missing = requiredDomains.filter((d) => !state.selected.includes(d.id));
    const message =
      selected.length === 0
        ? h('p', { class: 'alert alert-warning' }, 'Bitte wählen Sie mindestens eine Domäne aus.')
        : missing.length
          ? h(
              'p',
              { class: 'alert alert-info' },
              h('strong', {}, 'Teilbewertung: '),
              `Sie haben ${missing.length} ${missing.length === 1 ? 'Domäne' : 'Domänen'} abgewählt, die im ACP immer bewertet werden. ` +
                'Ihr Resultat zeigt Scores für die gewählten Domänen, aber keine Aussage zur Zertifizierungsreife.',
            )
          : null;
    // replaceChildren(null) würde den Text «null» einfügen, deshalb ohne Argument leeren.
    notice.replaceChildren(...(message ? [message] : []));
  }

  function setAll(checked) {
    for (const { card, checkbox, domain } of cards) {
      checkbox.checked = checked;
      card.classList.toggle('selected', checked);
      toggleDomain(domain.id, checked);
    }
    refresh();
  }

  refresh();

  return h(
    'section',
    { class: 'view' },
    h('h1', { tabindex: '-1' }, 'Control Domains auswählen'),
    h(
      'p',
      { class: 'lead' },
      'Für eine vollständige Selbstbewertung nach ACP wählen Sie die Domänen 1 bis 10. Domäne 11 (KI-Sicherheit) kommt dazu, sobald Sie KI-Systeme oder KI-Dienste nutzen, auch KI-Assistenten oder Chat-Tools Ihrer Mitarbeitenden.',
    ),
    h(
      'div',
      { class: 'toolbar' },
      summary,
      h('div', { class: 'toolbar-buttons' }, button('Alle auswählen', () => setAll(true), 'ghost'), button('Auswahl aufheben', () => setAll(false), 'ghost')),
    ),
    h('div', { class: 'domain-grid' }, cards.map((c) => c.card)),
    notice,
    h('div', { class: 'actions' }, button('Zurück', () => goTo('company')), next),
  );
}

function toggleDomain(id, on) {
  const set = new Set(state.selected);
  if (on) set.add(id);
  else set.delete(id);
  state.selected = data.domains.map((d) => d.id).filter((d) => set.has(d));
  state.dirty = true;
}

// ---------------------------------------------------------------------------
// Schritt 4: Controls bewerten

function selectedDomains() {
  return data.domains.filter((d) => state.selected.includes(d.id));
}

function renderQuestions() {
  const domains = selectedDomains();
  state.domainIndex = Math.min(state.domainIndex, domains.length - 1);
  const domain = domains[state.domainIndex];
  const isLast = state.domainIndex === domains.length - 1;

  const progress = h('div', { class: 'progress', 'aria-live': 'polite' });
  const nav = h('nav', { class: 'domain-nav', 'aria-label': 'Domänen' });
  const openNotice = h('div', { 'aria-live': 'assertive' });

  function refreshProgress() {
    const results = domains.map((d) => ({ d, r: domainResult(d, state.answers) }));
    const total = results.reduce((s, x) => s + x.r.total, 0);
    const done = results.reduce((s, x) => s + x.r.total - x.r.open, 0);
    const bar = h('span', { class: 'progress-fill' });
    bar.style.width = `${total ? (done / total) * 100 : 0}%`;
    progress.replaceChildren(
      h('span', { class: 'progress-text' }, `${done} von ${total} Controls bewertet`),
      h('span', { class: 'progress-track', role: 'presentation' }, bar),
    );
    nav.replaceChildren(
      h(
        'ol',
        {},
        results.map(({ d, r }, i) =>
          h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: `domain-nav-item${i === state.domainIndex ? ' active' : ''}${r.open === 0 ? ' complete' : ''}`,
                'aria-current': i === state.domainIndex ? 'true' : null,
                onClick: () => {
                  state.domainIndex = i;
                  goTo('questions');
                },
              },
              h('span', { class: 'domain-nav-name' }, `${d.id}. ${d.name}`),
              h('span', { class: 'domain-nav-count' }, `${r.total - r.open}/${r.total}`),
            ),
          ),
        ),
      ),
    );
  }

  function showResult() {
    const open = domains
      .map((d, i) => ({ d, i, r: domainResult(d, state.answers) }))
      .filter((x) => x.r.open > 0);
    if (!open.length) {
      goTo('result');
      return;
    }
    const first = open[0];
    const openTotal = open.reduce((s, x) => s + x.r.open, 0);
    openNotice.replaceChildren(
      h(
        'div',
        { class: 'alert alert-warning' },
        h('p', {}, h('strong', {}, `Noch ${openTotal} ${openTotal === 1 ? 'Control' : 'Controls'} offen. `), 'Bitte bewerten Sie alle Controls, damit das Resultat aussagekräftig ist.'),
        h('ul', {}, open.map((x) => h('li', {}, `${x.d.id}. ${x.d.name}: ${x.r.open} offen`))),
        button('Zum ersten offenen Control', () => {
          state.domainIndex = first.i;
          goTo('questions', { focus: false });
          const id = first.d.controls.find((c) => isOpen(c)).id;
          const card = document.getElementById(controlDomId(id));
          card?.scrollIntoView({ block: 'center' });
          card?.querySelector('input:not([disabled])')?.focus();
        }),
      ),
    );
    openNotice.querySelector('button').focus();
  }

  refreshProgress();

  return h(
    'section',
    { class: 'view view-questions' },
    progress,
    h(
      'div',
      { class: 'questions-layout' },
      nav,
      h(
        'div',
        { class: 'questions-main' },
        h('p', { class: 'eyebrow' }, `Domäne ${domain.id} von ${data.domains.length} · ${domain.nameEn}`),
        h('h1', { tabindex: '-1' }, domain.name, ' ', ...domainBadges(domain)),
        domain.critical
          ? h('p', { class: 'note' }, `Kritische Domäne: Für eine Zertifizierung muss der Domänenscore mindestens ${data.criticalThreshold.toFixed(2)} betragen.`)
          : null,
        scaleLegend(),
        glossaryLegend(),
        domain.controls.map((control) => controlCard(control, refreshProgress)),
        openNotice,
        h(
          'div',
          { class: 'actions' },
          button('Zurück', () => {
            if (state.domainIndex === 0) goTo('domains');
            else {
              state.domainIndex -= 1;
              goTo('questions');
            }
          }),
          isLast
            ? button('Resultat anzeigen', showResult, 'primary')
            : button(`Weiter: ${domains[state.domainIndex + 1].name}`, () => {
                state.domainIndex += 1;
                goTo('questions');
              }, 'primary'),
        ),
      ),
    ),
  );
}

function isOpen(control) {
  const a = state.answers[control.id];
  return !(a === 0 || a === 1 || a === 2 || a === 3 || (a === NA && !control.ko));
}

const controlDomId = (id) => `control-${id.replace('.', '-')}`;

function scaleLegend() {
  return h(
    'details',
    { class: 'scale-legend' },
    h('summary', {}, 'Bewertungsskala anzeigen'),
    h(
      'dl',
      {},
      data.scale.map((s) => [h('dt', {}, `${s.score} – ${s.label}`), h('dd', {}, s.description)]),
      h('dt', {}, 'N/A – Nicht anwendbar'),
      h('dd', {}, 'Das Thema existiert in Ihrer Organisation nicht (z. B. kein WLAN). Nicht anwendbare Controls zählen nicht zum Domänenscore. Bei Knock-out-Controls ist N/A nicht möglich.'),
    ),
    h('p', { class: 'hint' }, 'Umfasst ein Control mehrere Aspekte, bestimmt der schwächste wesentliche Aspekt den Score. Kleine Organisationen brauchen keine umfangreiche Dokumentation: Kurze, klare Regeln genügen, wenn sie gelebt werden.'),
    h('p', { class: 'hint' }, 'Bei einem echten ACP-Assessment muss jede Bewertung mit Nachweisen belegt sein; ohne Nachweis gilt ein Control als 0.'),
  );
}

function glossaryLegend() {
  if (!data.glossary?.length) return null;
  return h(
    'details',
    { class: 'scale-legend glossary' },
    h('summary', {}, 'Begriffe erklärt (A–Z)'),
    h('dl', {}, data.glossary.map((g) => [h('dt', {}, g.term), h('dd', {}, g.text)])),
  );
}

function guidanceDetails(control) {
  if (!control.guidance) return null;
  const label = (score) => data.scale.find((s) => s.score === score)?.label ?? '';
  return h(
    'details',
    { class: 'guidance' },
    h('summary', {}, 'Bewertungshilfe'),
    h(
      'dl',
      {},
      h('dt', {}, 'Zeigen lassen'),
      h('dd', {}, control.guidance.show),
      h('dt', {}, `Typisch für 2 – ${label(2)}`),
      h('dd', {}, control.guidance.level2),
      h('dt', {}, `Typisch für 3 – ${label(3)}`),
      h('dd', {}, control.guidance.level3),
    ),
  );
}

function controlCard(control, onChange) {
  const name = `answer-${control.id}`;
  const options = [
    ...data.scale.map((s) => ({ value: s.score, short: String(s.score), label: s.label, title: s.description })),
    { value: NA, short: 'N/A', label: 'Nicht anwendbar', title: 'Das Thema existiert in Ihrer Organisation nicht.' },
  ];
  const card = h(
    'article',
    { class: `control${isOpen(control) ? '' : ' answered'}`, id: controlDomId(control.id), 'aria-labelledby': `${controlDomId(control.id)}-title` },
    h(
      'header',
      { class: 'control-head' },
      h('span', { class: 'control-id' }, control.id),
      h('h2', { id: `${controlDomId(control.id)}-title` }, control.text),
      control.ko ? badge('Knock-out', 'ko') : null,
    ),
    h('ul', { class: 'questions' }, control.questions.map((q) => h('li', {}, q))),
    guidanceDetails(control),
    h(
      'fieldset',
      { class: 'rating' },
      h('legend', { class: 'visually-hidden' }, `Bewertung für Control ${control.id}`),
      options.map((o) => {
        const disabled = o.value === NA && control.ko;
        return h(
          'label',
          { class: `rating-option${disabled ? ' disabled' : ''}`, title: disabled ? 'Knock-out-Controls können nicht als N/A markiert werden.' : o.title },
          h('input', {
            type: 'radio',
            name,
            value: String(o.value),
            checked: state.answers[control.id] === o.value,
            disabled,
            onChange: () => {
              state.answers[control.id] = o.value;
              state.dirty = true;
              card.classList.add('answered');
              onChange();
            },
          }),
          h('span', { class: 'rating-score' }, o.short),
          h('span', { class: 'rating-label' }, o.label),
        );
      }),
    ),
    control.ko ? h('p', { class: 'hint' }, 'Knock-out-Control: Ein Score von 0 schliesst eine Zertifizierung aus. N/A ist nicht möglich.') : null,
  );
  return card;
}

// ---------------------------------------------------------------------------
// Schritt 5: Resultat

function renderResult() {
  const result = evaluate(data, state.selected, state.answers);
  const c = state.company;
  const companyLine = [c.name, c.industry, c.size ? `${c.size} Mitarbeitende` : '', c.contact ? `Ansprechperson: ${c.contact}` : '']
    .filter(Boolean)
    .join(' · ');
  const missing = requiredDomains.filter((d) => !state.selected.includes(d.id));

  return h(
    'section',
    { class: 'view view-result' },
    h('p', { class: 'eyebrow' }, `Selbstbewertung vom ${formatDate(c.date) || formatDate(today())} · ACP-Framework ${data.version}`),
    h('h1', { tabindex: '-1' }, c.name ? `Resultat für ${c.name}` : 'Ihr Resultat'),
    companyLine ? h('p', { class: 'company-line' }, companyLine) : null,
    privacyNotice('result'),
    result.full
      ? null
      : h(
          'div',
          { class: 'alert alert-info' },
          h('strong', {}, 'Teilbewertung. '),
          `Nicht bewertet: ${missing.map((d) => `${d.id}. ${d.name}`).join(', ')}. ` +
            'Der Score bezieht sich nur auf die gewählten Domänen und ist nicht mit einem vollständigen ACP-Assessment vergleichbar.',
        ),
    scoreHero(result),
    improvementSection(result),
    domainChart(result),
    koSection(result),
    distributionSection(result),
    result.full ? readiness(result) : null,
    h(
      'p',
      { class: 'note' },
      'Diese Selbstbewertung beruht auf Ihrer eigenen Einschätzung ohne Prüfung von Nachweisen. Sie ist eine Momentaufnahme und keine ACP-Zertifizierung. ' +
        'Offizielle ACP-Assessments und -Zertifizierungen führt ausschliesslich Wechsler Information Solution durch.',
    ),
    h(
      'p',
      { class: 'contact-line' },
      'Fragen zu Ihrem Resultat oder zum ACP? ',
      h('a', { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
    ),
    h(
      'div',
      { class: 'actions' },
      button('Drucken / als PDF speichern', () => window.print(), 'primary'),
      button('Antworten bearbeiten', () => goTo('questions')),
      button('Neue Selbstbewertung', () => {
        if (window.confirm('Alle Eingaben und das Resultat werden gelöscht. Fortfahren?')) {
          Object.assign(state, initialState());
          goTo('start');
        }
      }, 'ghost'),
    ),
    answersAppendix(result),
  );
}

// Nur im Ausdruck sichtbar: alle Antworten, damit das gesicherte PDF vollständig ist.
function answersAppendix(result) {
  const label = (answer) => {
    if (answer === NA) return 'N/A – Nicht anwendbar';
    const step = data.scale.find((s) => s.score === answer);
    return step ? `${step.score} – ${step.label}` : 'offen';
  };
  return h(
    'section',
    { class: 'print-only answers', 'aria-hidden': 'true' },
    h('h2', {}, 'Ihre Antworten'),
    result.domains.map((d) => [
      h('h3', {}, `${d.id}. ${d.name}`),
      h(
        'table',
        { class: 'answers-table' },
        h('tbody', {}, d.controls.map((c) => h('tr', {}, h('td', {}, c.id), h('td', {}, c.text), h('td', {}, label(state.answers[c.id]))))),
      ),
    ]),
  );
}

function scoreHero(result) {
  const marker = h('span', { class: 'scale-marker', 'aria-hidden': 'true' });
  marker.style.left = `${((result.overall ?? 0) / 3) * 100}%`;
  const segments = data.maturity.map((m) => {
    const seg = h('span', { class: `scale-seg${result.maturity && m.level === result.maturity.level ? ' current' : ''}` }, h('span', {}, `L${m.level}`));
    seg.style.flexBasis = `${((m.max - m.min + 0.01) / 3) * 100}%`;
    return seg;
  });
  return h(
    'div',
    { class: 'card score-hero' },
    h(
      'div',
      { class: 'score-main' },
      h('p', { class: 'score-label' }, result.full ? 'ACP-Gesamtscore' : 'Score der gewählten Domänen'),
      h('p', { class: 'score-value' }, fmt(result.overall), h('span', { class: 'score-max' }, ' / 3.00')),
    ),
    h(
      'div',
      { class: 'score-maturity' },
      h('p', { class: 'score-label' }, 'Reifegrad'),
      h('p', { class: 'maturity-value' }, result.maturity ? `Level ${result.maturity.level} – ${result.maturity.name}` : '–'),
      h('div', { class: 'maturity-scale' }, h('div', { class: 'scale-track' }, segments, marker)),
      h(
        'p',
        { class: 'hint' },
        data.maturity.map((m) => `L${m.level} ${m.name} ab ${m.min.toFixed(2)}`).join(' · '),
      ),
    ),
  );
}

function readiness(result) {
  return h(
    'section',
    { class: 'card readiness', 'aria-labelledby': 'readiness-title' },
    h('h2', { id: 'readiness-title' }, 'Zertifizierungsreife (Indikation)'),
    h(
      'p',
      { class: result.allChecksMet ? 'verdict verdict-good' : 'verdict verdict-bad' },
      result.allChecksMet
        ? 'Nach Ihrer Selbsteinschätzung erfüllen Sie die Mindestanforderungen für eine ACP-Zertifizierung.'
        : 'Nach Ihrer Selbsteinschätzung sind noch nicht alle Mindestanforderungen für eine ACP-Zertifizierung erfüllt.',
    ),
    h(
      'ul',
      { class: 'checks' },
      result.checks.map((check) =>
        h(
          'li',
          { class: check.met ? 'met' : 'unmet' },
          h('span', { class: 'check-icon', 'aria-hidden': 'true' }, check.met ? '✓' : '✗'),
          h('span', { class: 'visually-hidden' }, check.met ? 'Erfüllt: ' : 'Nicht erfüllt: '),
          h('span', {}, check.label, check.detail?.length ? h('span', { class: 'check-detail' }, check.detail.join(' · ')) : null),
        ),
      ),
    ),
    h('p', { class: 'hint' }, 'Zusätzlich verlangt eine Zertifizierung, dass jede Bewertung mit dokumentierten Nachweisen belegt ist.'),
  );
}

function domainChart(result) {
  const threshold = data.criticalThreshold;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'domains-title' },
    h('h2', { id: 'domains-title' }, 'Scores pro Domäne'),
    h(
      'p',
      { class: 'hint legend' },
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch good' }), `ab ${threshold.toFixed(2)}`),
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch warn' }), `unter ${threshold.toFixed(2)}`),
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch bad' }), `kritische Domäne unter ${threshold.toFixed(2)}`),
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch-line' }), `Schwelle ${threshold.toFixed(2)}`),
    ),
    h(
      'ul',
      { class: 'bars' },
      result.domains.map((d) => {
        const status = d.score === null ? 'none' : d.score >= threshold ? 'good' : d.critical ? 'bad' : 'warn';
        const fill = h('span', { class: `bar-fill ${status}` });
        fill.style.width = `${((d.score ?? 0) / 3) * 100}%`;
        const tick = h('span', { class: 'bar-threshold', 'aria-hidden': 'true' });
        tick.style.left = `${(threshold / 3) * 100}%`;
        return h(
          'li',
          { class: 'bar-row' },
          h('span', { class: 'bar-label' }, `${d.id}. ${d.name}`, d.critical ? h('span', { class: 'critical-mark', title: 'kritische Domäne' }, ' · kritisch') : null),
          h('span', { class: 'bar-track' }, fill, tick),
          h('span', { class: 'bar-value' }, d.score === null ? 'N/A' : fmt(d.score)),
          h('span', { class: 'bar-level' }, d.maturity ? `L${d.maturity.level} ${d.maturity.name}` : 'alle Controls N/A'),
        );
      }),
    ),
  );
}

function scoreChip(answer) {
  if (answer === NA) return h('span', { class: 'chip chip-na' }, 'N/A');
  return h('span', { class: `chip chip-${answer}` }, String(answer));
}

function koSection(result) {
  if (!result.koControls.length) return null;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'ko-title' },
    h('h2', { id: 'ko-title' }, 'Knock-out-Controls'),
    h('p', { class: 'hint' }, 'Ein Score von 0 bei einem dieser Controls schliesst eine Zertifizierung aus, unabhängig vom Gesamtscore.'),
    h(
      'ul',
      { class: 'control-list' },
      result.koControls.map((c) =>
        h('li', { class: c.answer === 0 ? 'flag' : '' }, scoreChip(c.answer), h('span', { class: 'control-id' }, c.id), h('span', {}, c.text)),
      ),
    ),
  );
}

function improvementSection(result) {
  const top = result.improvements.slice(0, MAX_IMPROVEMENTS);
  const rest = result.improvements.length - top.length;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'improve-title' },
    h('h2', { id: 'improve-title' }, 'Ihre wichtigsten nächsten Schritte'),
    top.length
      ? [
          h('p', { class: 'hint' }, 'Controls mit Score 0 oder 1, sortiert nach Dringlichkeit: Knock-out-Controls mit 0 zuerst, dann tiefster Score, kritische Domänen vor den übrigen.'),
          h(
            'ol',
            { class: 'control-list' },
            top.map((c) =>
              h(
                'li',
                {},
                scoreChip(c.answer),
                h('span', { class: 'control-id' }, c.id),
                h('span', {}, c.text, h('span', { class: 'control-domain' }, `${c.domainId}. ${c.domainName}`)),
                c.ko ? badge('Knock-out', 'ko') : null,
              ),
            ),
          ),
          rest > 0 ? h('p', { class: 'hint' }, `Dazu ${rest} weitere ${rest === 1 ? 'Control' : 'Controls'} mit Score 0 oder 1.`) : null,
        ]
      : h('p', {}, 'Kein Control mit Score 0 oder 1. Konzentrieren Sie sich darauf, umgesetzte Controls aktiv zu steuern (Score 3).'),
  );
}

function distributionSection(result) {
  const labels = [...data.scale.map((s) => ({ key: s.score, label: s.label })), { key: NA, label: 'Nicht anwendbar' }];
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'dist-title' },
    h('h2', { id: 'dist-title' }, 'Verteilung Ihrer Bewertungen'),
    h(
      'ul',
      { class: 'stats' },
      labels.map((l) =>
        h('li', { class: `stat stat-${l.key}` }, h('span', { class: 'stat-value' }, String(result.distribution[l.key])), h('span', { class: 'stat-label' }, `${l.key === NA ? 'N/A' : l.key} – ${l.label}`)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Start

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

document.getElementById('framework-version').textContent =
  `ACP-Framework ${data.version} · Stand ${data.sourceCommit}${data.sourceDate ? ` (${formatDate(data.sourceDate)})` : ''}`;

render();
