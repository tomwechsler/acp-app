"""Erzeugt die Daten der ACP-Selbstbewertungs-App aus dem ACP-Repository.

Liest aus dem ACP-Repository (Git-Submodule `active-cyber-program/`):

  * assessment/assessment-questionnaire.de.md  Domänen, Controls, Leitfragen (Deutsch)
  * assessment/assessment-checklist.md         massgebliche Liste der Control-IDs (Englisch)
  * assessment/scoring-model.md                KO-Controls, Schwellenwerte, Reifegrade
  * VERSION                                    Framework-Version

und schreibt `src/data/acp-data.js`. Die Datei wird nie von Hand bearbeitet.

Der Build bricht ab (Exit-Code 1), wenn der Inhalt nicht zu den erwarteten Regeln
passt. So bleibt bei einem fehlerhaften Repository-Stand die bisherige Version online.

Aufruf (aus dem Verzeichnis acp-app):

    python3 build/build_data.py
    python3 build/build_data.py --source ../active-cyber-program
    python3 build/build_data.py --accept-scoring-model   # nach Prüfung der Rechenlogik

Die Rechenregeln (Mittelwerte, Rundung, Zertifizierungsbedingungen) sind in
`src/js/scoring.js` programmiert. Ändert sich `scoring-model.md`, stoppt der Build,
bis die Logik geprüft und die neue Prüfsumme mit --accept-scoring-model bestätigt wurde.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = APP_ROOT / "src" / "data" / "acp-data.js"
SCORING_HASH_FILE = APP_ROOT / "build" / "scoring-model.sha256"

QUESTIONNAIRE = Path("assessment/assessment-questionnaire.de.md")
CHECKLIST = Path("assessment/assessment-checklist.md")
SCORING_MODEL = Path("assessment/scoring-model.md")
VERSION_FILE = Path("VERSION")
TRANSLATION_CHECK = Path("tools/check-translations.py")

EXPECTED_DOMAINS = 11

DOMAIN_DE = re.compile(r"^# Domäne (\d+) – (.+?)\s*$")
DOMAIN_EN = re.compile(r"^# Domain (\d+) – (.+?)\s*$")
ENGLISH_NAME = re.compile(r"^\*Englisch: (.+)\*\s*$")
CONTROL_ROW = re.compile(r"^\|\s*(\d+\.\d+)\s*\|(.*)$")
CHECKLIST_LINE = re.compile(r"^(\d+\.\d+)\s+(.+?)\s*$")
KO_MARK = re.compile(r"\s*\*\*\[KO\]\*\*|\s*\[KO\]")
SCALE_ROW = re.compile(r"^\|\s*([0-3])\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$")
KO_TABLE_ROW = re.compile(r"^\|\s*(\d+\.\d+)\s*\|")
MATURITY_ROW = re.compile(r"^\|\s*(\d\.\d\d)\s*–\s*(\d\.\d\d)\s*\|\s*Level (\d) – (\w+)\s*\|")
OVERALL_THRESHOLD = re.compile(r"Overall ACP Score ≥ \*\*(\d\.\d\d)\*\*")
CRITICAL_THRESHOLD = re.compile(r"critical domain score ≥ \*\*(\d\.\d\d)\*\*")
FRAMEWORK_VERSION_DE = re.compile(r"Framework-Version: \*\*ACP (\d+\.\d+(?:\.\d+)?)\*\*")


class BuildError(Exception):
    pass


def fail_if(condition, message):
    if condition:
        raise BuildError(message)


def find_source(explicit):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    if os.environ.get("ACP_SOURCE"):
        candidates.append(Path(os.environ["ACP_SOURCE"]))
    candidates += [APP_ROOT / "active-cyber-program", APP_ROOT.parent / "active-cyber-program"]
    for candidate in candidates:
        if (candidate / VERSION_FILE).is_file() and (candidate / QUESTIONNAIRE).is_file():
            return candidate.resolve()
    raise BuildError(
        "ACP-Repository nicht gefunden. Submodule laden mit "
        "'git submodule update --init' oder Pfad mit --source angeben."
    )


def strip_markdown(text):
    return re.sub(r"\*\*(.+?)\*\*", r"\1", text).strip()


def parse_questionnaire(text):
    domains = []
    current = None
    for line in text.splitlines():
        heading = DOMAIN_DE.match(line)
        if heading:
            title = heading.group(2)
            qualifier = ""
            paren = re.match(r"^(.*?)\s*\((.+)\)$", title)
            if paren:
                title, qualifier = paren.group(1), paren.group(2)
            current = {
                "id": int(heading.group(1)),
                "name": title.strip(),
                "nameEn": "",
                "critical": "kritisch" in qualifier,
                "conditional": "falls anwendbar" in qualifier,
                "controls": [],
            }
            domains.append(current)
            continue
        if current is None:
            continue
        english = ENGLISH_NAME.match(line)
        if english:
            current["nameEn"] = english.group(1).strip()
            continue
        row = CONTROL_ROW.match(line)
        if row:
            cells = [cell.strip() for cell in row.group(2).split("|")]
            fail_if(len(cells) < 2, "Tabellenzeile von Control {} ist unvollständig.".format(row.group(1)))
            control_text, questions = cells[0], cells[1]
            is_ko = bool(KO_MARK.search(control_text))
            questions = [strip_markdown(q.lstrip("•").strip()) for q in questions.split("<br>")]
            current["controls"].append({
                "id": row.group(1),
                "text": strip_markdown(KO_MARK.sub("", control_text)),
                "questions": [q for q in questions if q],
                "ko": is_ko,
            })
        elif line.startswith("# ") and not line.startswith("# Domäne"):
            current = None
    return domains


def parse_scale(text):
    scale = []
    for line in text.splitlines():
        row = SCALE_ROW.match(line)
        if row:
            scale.append({"score": int(row.group(1)), "label": row.group(2), "description": row.group(3)})
    return scale


def parse_checklist(text):
    controls, ko, critical_domains = [], set(), set()
    domain = None
    for line in text.splitlines():
        heading = DOMAIN_EN.match(line)
        if heading:
            domain = int(heading.group(1))
            if "critical" in heading.group(2):
                critical_domains.add(domain)
            continue
        if domain is None:
            continue
        item = CHECKLIST_LINE.match(line)
        if item and item.group(1).split(".")[0] == str(domain):
            controls.append(item.group(1))
            if "[KO]" in item.group(2):
                ko.add(item.group(1))
    return controls, ko, critical_domains


def parse_scoring_model(text):
    ko, maturity = [], []
    section = None
    for line in text.splitlines():
        if line.startswith("# "):
            section = line[2:].strip()
            continue
        if section == "Knock-out Controls":
            row = KO_TABLE_ROW.match(line)
            if row:
                ko.append(row.group(1))
        elif section == "Maturity Level Mapping":
            row = MATURITY_ROW.match(line)
            if row:
                maturity.append({
                    "level": int(row.group(3)),
                    "name": row.group(4),
                    "min": float(row.group(1)),
                    "max": float(row.group(2)),
                })
    overall = OVERALL_THRESHOLD.search(text)
    critical = CRITICAL_THRESHOLD.search(text)
    fail_if(not overall or not critical, "Zertifizierungsschwellen im Scoring-Modell nicht gefunden.")
    return {
        "ko": ko,
        "maturity": maturity,
        "overallThreshold": float(overall.group(1)),
        "criticalThreshold": float(critical.group(1)),
    }


def validate(domains, scale, checklist, scoring, version, questionnaire_text):
    checklist_ids, checklist_ko, checklist_critical = checklist

    ids = [d["id"] for d in domains]
    fail_if(ids != list(range(1, EXPECTED_DOMAINS + 1)),
            "Erwartet werden die Domänen 1 bis {}, gefunden: {}.".format(EXPECTED_DOMAINS, ids))

    control_ids = [c["id"] for d in domains for c in d["controls"]]
    fail_if(len(control_ids) != len(set(control_ids)), "Doppelte Control-IDs im Fragenkatalog.")
    missing = [i for i in checklist_ids if i not in control_ids]
    extra = [i for i in control_ids if i not in checklist_ids]
    fail_if(missing or extra,
            "Control-IDs weichen von der Checkliste ab. Fehlend: {} Zusätzlich: {}".format(missing, extra))

    for domain in domains:
        fail_if(not domain["controls"], "Domäne {} enthält keine Controls.".format(domain["id"]))
        fail_if(not domain["nameEn"], "Domäne {}: englischer Name fehlt.".format(domain["id"]))
        for control in domain["controls"]:
            fail_if(not control["id"].startswith("{}.".format(domain["id"])),
                    "Control {} steht in Domäne {}.".format(control["id"], domain["id"]))
            fail_if(not control["questions"], "Control {} hat keine Leitfragen.".format(control["id"]))

    ko_de = {c["id"] for d in domains for c in d["controls"] if c["ko"]}
    fail_if(ko_de != checklist_ko or ko_de != set(scoring["ko"]),
            "KO-Controls stimmen nicht überein. Fragenkatalog: {} Checkliste: {} Scoring-Modell: {}".format(
                sorted(ko_de), sorted(checklist_ko), sorted(scoring["ko"])))

    critical_de = {d["id"] for d in domains if d["critical"]}
    fail_if(critical_de != checklist_critical,
            "Kritische Domänen stimmen nicht überein. Fragenkatalog: {} Checkliste: {}".format(
                sorted(critical_de), sorted(checklist_critical)))

    fail_if([s["score"] for s in scale] != [0, 1, 2, 3], "Bewertungsskala 0 bis 3 im Fragenkatalog nicht gefunden.")

    levels = scoring["maturity"]
    fail_if([m["level"] for m in levels] != [1, 2, 3, 4, 5], "Reifegrade 1 bis 5 im Scoring-Modell nicht gefunden.")
    fail_if(levels[0]["min"] != 0.0 or levels[-1]["max"] != 3.0, "Reifegrade decken 0.00 bis 3.00 nicht ab.")
    for lower, upper in zip(levels, levels[1:]):
        fail_if(round(upper["min"] - lower["max"], 2) != 0.01,
                "Lücke oder Überschneidung zwischen Level {} und {}.".format(lower["level"], upper["level"]))

    stated = FRAMEWORK_VERSION_DE.search(questionnaire_text)
    fail_if(not stated or stated.group(1) != version,
            "Version im Fragenkatalog ({}) passt nicht zu VERSION ({}).".format(
                stated.group(1) if stated else "fehlt", version))


def check_translations(source):
    script = source / TRANSLATION_CHECK
    if not script.is_file():
        print("Hinweis: {} nicht vorhanden, Übersetzungsprüfung übersprungen.".format(TRANSLATION_CHECK))
        return
    result = subprocess.run([sys.executable, str(script)], cwd=str(source), capture_output=True, text=True)
    fail_if(result.returncode != 0,
            "Übersetzungsprüfung fehlgeschlagen:\n{}{}".format(result.stdout, result.stderr))


def check_scoring_model_hash(source, accept):
    digest = hashlib.sha256((source / SCORING_MODEL).read_bytes()).hexdigest()
    if accept:
        SCORING_HASH_FILE.write_text(digest + "\n", encoding="utf-8")
        print("Prüfsumme des Scoring-Modells bestätigt: {}".format(digest[:16]))
        return
    expected = SCORING_HASH_FILE.read_text(encoding="utf-8").strip() if SCORING_HASH_FILE.is_file() else ""
    fail_if(digest != expected,
            "Scoring-Modell geändert – Logik prüfen.\n"
            "  assessment/scoring-model.md hat sich seit der letzten Prüfung verändert.\n"
            "  Prüfen Sie src/js/scoring.js gegen die neuen Regeln und bestätigen Sie danach mit:\n"
            "  python3 build/build_data.py --accept-scoring-model")


def source_commit(source):
    try:
        out = subprocess.run(["git", "-C", str(source), "log", "-1", "--format=%h|%cs"],
                             capture_output=True, text=True, check=True).stdout.strip()
        commit, date = out.split("|")
        return commit, date
    except (OSError, subprocess.CalledProcessError, ValueError):
        return "unbekannt", ""


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", help="Pfad zum ACP-Repository (Standard: Submodule active-cyber-program)")
    parser.add_argument("--accept-scoring-model", action="store_true",
                        help="aktuelle Prüfsumme von scoring-model.md als geprüft bestätigen")
    args = parser.parse_args()

    try:
        source = find_source(args.source)
        print("ACP-Repository: {}".format(source))
        read = lambda p: (source / p).read_text(encoding="utf-8")

        version = read(VERSION_FILE).strip()
        questionnaire_text = read(QUESTIONNAIRE)
        domains = parse_questionnaire(questionnaire_text)
        scale = parse_scale(questionnaire_text)
        checklist = parse_checklist(read(CHECKLIST))
        scoring = parse_scoring_model(read(SCORING_MODEL))

        validate(domains, scale, checklist, scoring, version, questionnaire_text)
        check_translations(source)
        check_scoring_model_hash(source, args.accept_scoring_model)

        commit, commit_date = source_commit(source)
        data = {
            "version": version,
            "sourceCommit": commit,
            "sourceDate": commit_date,
            "scale": scale,
            "maturity": scoring["maturity"],
            "overallThreshold": scoring["overallThreshold"],
            "criticalThreshold": scoring["criticalThreshold"],
            "domains": domains,
        }
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(
            "// Automatisch erzeugt von build/build_data.py – nicht von Hand bearbeiten.\n"
            "// Quelle: active-cyber-program {} (Commit {})\n"
            "export default {};\n".format(version, commit, json.dumps(data, ensure_ascii=False, indent=2)),
            encoding="utf-8",
        )
    except BuildError as error:
        print("FEHLER: {}".format(error), file=sys.stderr)
        return 1

    controls = sum(len(d["controls"]) for d in domains)
    print("OK: ACP {}, {} Domänen, {} Controls, Commit {} -> {}".format(
        version, len(domains), controls, commit, OUTPUT.relative_to(APP_ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
