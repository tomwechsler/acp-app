# ACP Selbstbewertung

Statische Web App, mit der Firmen eine Selbstbewertung nach dem [Active Cyber Program (ACP)](https://github.com/tomwechsler/active-cyber-program) durchführen. Gehostet auf Azure Static Web Apps.

**Die App speichert keine Daten.** Alle Eingaben bleiben im Arbeitsspeicher des Browsers. Es gibt kein Backend, keine Cookies, keinen Local Storage, keine Analyse-Tools und keine externen Ressourcen. Eine Content Security Policy (`connect-src 'none'`) blockiert zusätzlich jede Datenübertragung.

## Ablauf in der App

1. Start mit Datenschutzhinweis
2. Firmendaten (freiwillig, nur für die Kopfzeile des Resultats)
3. Auswahl der Control Domains (Abwahl von Pflichtdomänen ergibt eine «Teilbewertung»)
4. Bewertung jedes Controls mit 0–3 oder N/A (N/A bei KO-Controls gesperrt), mit Leitfragen, Bewertungshilfe («Zeigen lassen», typisch für 2 und 3) und Glossar («Begriffe erklärt»); pro Control aufklappbar der «Bezug zu Standards» (NIS2, ISO/IEC 27001, NIST CSF, bei KI zusätzlich NIST AI RMF und ISO/IEC 42001)
5. Resultat: Gesamtscore, Reifegrad, wichtigste nächste Schritte, Scores pro Domäne, KO-Controls, Zertifizierungsreife (Indikation), «Ihr Resultat im Bezug zu Standards» (ISO/IEC 27001, NIS2, NIST CSF 2.0 und, falls Domäne 11 bewertet wurde, OWASP Top 10 for LLM); «Drucken / als PDF speichern» sichert das Resultat inkl. aller Antworten lokal im Browser

## Projektstruktur

```text
acp-app/
├─ active-cyber-program/        ACP-Repository als Git-Submodule (nur lesen)
├─ build/
│  ├─ build_data.py             liest Fragenkatalog inkl. Bewertungshilfe, Glossar und Control-Mapping, prüft sie, schreibt src/data/acp-data.js
│  └─ scoring-model.sha256      geprüfte Fassung von scoring-model.md
├─ src/                         wird veröffentlicht
│  ├─ index.html
│  ├─ datenschutz.html
│  ├─ js/app.js                 Oberfläche und Ablauf
│  ├─ js/scoring.js             Rechenregeln nach scoring-model.md
│  ├─ js/standards.js           Auswertung «Bezug zu Standards» nach control-mapping.md
│  ├─ css/styles.css
│  ├─ assets/                   Logo, Favicon
│  ├─ data/acp-data.js          generiert, nicht im Git
│  └─ staticwebapp.config.json  Sicherheits-Header
├─ tests/scoring.test.mjs       Tests der Rechenlogik
├─ tests/standards.test.mjs     Tests der Auswertung «Bezug zu Standards»
└─ .github/                     Workflow und Dependabot
```

## Lokal arbeiten

```bash
git submodule update --init          # einmalig nach dem Klonen
python3 build/build_data.py          # Daten erzeugen und prüfen
python3 -m http.server 8080 --directory src
```

Dann <http://localhost:8080> öffnen. In VS Code gibt es dafür die Tasks «ACP: Daten bauen», «ACP: Tests (macOS)» und «ACP: Lokal starten» (Terminal → Run Task).

Tests: `node tests/scoring.test.mjs` und `node tests/standards.test.mjs`, auf macOS ohne Node.js mit `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m` statt `node`.

## Wie Änderungen im ACP-Repository in die App kommen

1. Dependabot prüft jeden Montag, ob das ACP-Repository neue Commits hat, und öffnet einen Pull Request mit dem neuen Submodule-Stand.
2. Der Workflow baut die Daten neu und prüft sie: 11 Domänen, Control-IDs identisch mit der Checkliste, Bewertungshilfe bei jedem Control vollständig, KO-Controls und kritische Domänen konsistent, Version stimmt, Übersetzung aktuell, Control-Mapping vollständig und widerspruchsfrei, Tests grün.
3. Nach dem Merge veröffentlicht der Workflow die neue Version automatisch.

Sofort aktualisieren statt auf Dependabot zu warten:

```bash
git submodule update --remote active-cyber-program
python3 build/build_data.py
git commit -am "ACP-Framework aktualisiert" && git push
```

### Wenn sich die Anzahl Controls ändert

Die Tests in `tests/scoring.test.mjs` prüfen die Anzahl Controls pro Domäne und rechnen die Beispiele des ACP-Repositorys nach. Kommen Controls dazu, schlägt der Workflow im Dependabot-Pull-Request fehl, bis die Tests angepasst sind. Die bisherige Version bleibt solange online.

### Wenn sich das Scoring-Modell ändert

Die Rechenregeln stehen in `src/js/scoring.js`. Ändert sich `assessment/scoring-model.md`, stoppt der Build mit «Scoring-Modell geändert – Logik prüfen». Dann:

1. Änderungen im Scoring-Modell lesen und `src/js/scoring.js` sowie die Tests anpassen.
2. `python3 build/build_data.py --accept-scoring-model` ausführen.
3. `build/scoring-model.sha256` mitcommitten.

KO-Controls, Reifegrad-Grenzen und Zertifizierungsschwellen liest der Build direkt aus dem Scoring-Modell; dafür ist keine Code-Änderung nötig.

### Wenn sich das Control-Mapping ändert

Die Referenzen pro Control und die Zeilen der Ansicht «Bezug zu Standards» liest der Build aus `framework/control-mapping.md`. Er bricht ab, wenn eine Tabelle defekt ist, ein Control fehlt oder doppelt vorkommt, ein Control-Text von der Checkliste abweicht, eine Referenz ungültig ist oder die Zahlen der NIST-CSF-Übersicht nicht zu den Domänentabellen passen.

Die deutschen Bezeichnungen der NIS2-Zeilen stehen in `build/build_data.py` (`NIS2_LABELS`). Kommt in der NIS2-Übersicht des Mappings eine Zeile dazu oder ändert sich ihre erste Spalte, stoppt der Build, bis die Bezeichnung dort ergänzt ist.

## Veröffentlichung

Der Workflow `.github/workflows/deploy.yml` veröffentlicht bei jedem Push auf `main`. Er braucht das GitHub-Secret `AZURE_STATIC_WEB_APPS_API_TOKEN_ICY_TREE_0C0564203` (Deployment-Token der Static Web App, von VS Code beim Erstellen angelegt).
