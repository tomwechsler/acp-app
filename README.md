# ACP Selbstbewertung

Statische Web App, mit der Firmen eine Selbstbewertung nach dem [Active Cyber Program (ACP)](https://github.com/tomwechsler/active-cyber-program) durchführen. Gehostet auf Azure Static Web Apps.

**Die App speichert keine Daten.** Alle Eingaben bleiben im Arbeitsspeicher des Browsers. Es gibt kein Backend, keine Cookies, keinen Local Storage, keine Analyse-Tools und keine externen Ressourcen. Eine Content Security Policy (`connect-src 'none'`) blockiert zusätzlich jede Datenübertragung.

## Ablauf in der App

1. Start mit Datenschutzhinweis
2. Firmendaten (freiwillig, nur für die Kopfzeile des Resultats)
3. Auswahl der Control Domains (Abwahl von Pflichtdomänen ergibt eine «Teilbewertung»)
4. Bewertung jedes Controls mit 0–3 oder N/A (N/A bei KO-Controls gesperrt)
5. Resultat: Gesamtscore, Reifegrad, Zertifizierungsreife (Indikation), Scores pro Domäne, KO-Controls, Handlungsfelder

## Projektstruktur

```text
acp-app/
├─ active-cyber-program/        ACP-Repository als Git-Submodule (nur lesen)
├─ build/
│  ├─ build_data.py             liest den Fragenkatalog, prüft ihn, schreibt src/data/acp-data.js
│  └─ scoring-model.sha256      geprüfte Fassung von scoring-model.md
├─ src/                         wird veröffentlicht
│  ├─ index.html
│  ├─ datenschutz.html
│  ├─ js/app.js                 Oberfläche und Ablauf
│  ├─ js/scoring.js             Rechenregeln nach scoring-model.md
│  ├─ css/styles.css
│  ├─ assets/                   Logo, Favicon
│  ├─ data/acp-data.js          generiert, nicht im Git
│  └─ staticwebapp.config.json  Sicherheits-Header
├─ tests/scoring.test.mjs       Tests der Rechenlogik
└─ .github/                     Workflow und Dependabot
```

## Lokal arbeiten

```bash
git submodule update --init          # einmalig nach dem Klonen
python3 build/build_data.py          # Daten erzeugen und prüfen
python3 -m http.server 8080 --directory src
```

Dann <http://localhost:8080> öffnen. In VS Code gibt es dafür die Tasks «ACP: Daten bauen», «ACP: Tests (macOS)» und «ACP: Lokal starten» (Terminal → Run Task).

Tests: `node tests/scoring.test.mjs` oder auf macOS ohne Node.js `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/scoring.test.mjs`.

## Wie Änderungen im ACP-Repository in die App kommen

1. Dependabot prüft jeden Montag, ob das ACP-Repository neue Commits hat, und öffnet einen Pull Request mit dem neuen Submodule-Stand.
2. Der Workflow baut die Daten neu und prüft sie: 11 Domänen, Control-IDs identisch mit der Checkliste, KO-Controls und kritische Domänen konsistent, Version stimmt, Übersetzung aktuell, Tests grün.
3. Nach dem Merge veröffentlicht der Workflow die neue Version automatisch.

Sofort aktualisieren statt auf Dependabot zu warten:

```bash
git submodule update --remote active-cyber-program
python3 build/build_data.py
git commit -am "ACP-Framework aktualisiert" && git push
```

### Wenn sich das Scoring-Modell ändert

Die Rechenregeln stehen in `src/js/scoring.js`. Ändert sich `assessment/scoring-model.md`, stoppt der Build mit «Scoring-Modell geändert – Logik prüfen». Dann:

1. Änderungen im Scoring-Modell lesen und `src/js/scoring.js` sowie die Tests anpassen.
2. `python3 build/build_data.py --accept-scoring-model` ausführen.
3. `build/scoring-model.sha256` mitcommitten.

KO-Controls, Reifegrad-Grenzen und Zertifizierungsschwellen liest der Build direkt aus dem Scoring-Modell; dafür ist keine Code-Änderung nötig.

## Veröffentlichung

Der Workflow `.github/workflows/deploy.yml` veröffentlicht bei jedem Push auf `main`. Er braucht das GitHub-Secret `AZURE_STATIC_WEB_APPS_API_TOKEN_ICY_TREE_0C0564203` (Deployment-Token der Static Web App, von VS Code beim Erstellen angelegt).
