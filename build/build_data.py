"""Erzeugt die Daten der ACP-Selbstbewertungs-App aus dem ACP-Repository.

Liest aus dem ACP-Repository (Git-Submodule `active-cyber-program/`):

  * assessment/assessment-questionnaire.de.md  Domänen, Controls, Leitfragen, Bewertungshilfe (Deutsch)
  * assessment/assessment-checklist.md         massgebliche Liste der Control-IDs (Englisch)
  * assessment/scoring-model.md                KO-Controls, Schwellenwerte, Reifegrade
  * docs/glossary.de.md                         Glossar (Deutsch)
  * framework/control-mapping.md               Bezüge zu NIS2, ISO/IEC 27001, NIST CSF, OWASP (Englisch)
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
GLOSSARY = Path("docs/glossary.de.md")
MIN_GLOSSARY_ENTRIES = 20
MAPPING = Path("framework/control-mapping.md")
MAPPING_URL = "https://github.com/tomwechsler/active-cyber-program/blob/main/framework/control-mapping.md"
VERSION_FILE = Path("VERSION")
TRANSLATION_CHECK = Path("tools/check-translations.py")

EXPECTED_DOMAINS = 11

DOMAIN_DE = re.compile(r"^# Domäne (\d+) – (.+?)\s*$")
DOMAIN_EN = re.compile(r"^# Domain (\d+) – (.+?)\s*$")
ENGLISH_NAME = re.compile(r"^\*Englisch: (.+)\*\s*$")
CONTROL_ROW = re.compile(r"^\|\s*(\d+\.\d+)\s*\|(.*)$")
HEADER_ROW = re.compile(r"^\|\s*ID\s*\|(.*)$")
GUIDANCE_COLUMN = "Bewertungshilfe"
GUIDANCE_PARTS = {"Zeigen lassen": "show", "2": "level2", "3": "level3"}
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


def parse_guidance(text):
    """Zerlegt «Zeigen lassen: …<br>2: …<br>3: …» in show, level2 und level3."""
    guidance = {}
    for part in text.split("<br>"):
        label, _, value = part.partition(":")
        key = GUIDANCE_PARTS.get(label.strip())
        if key and value.strip():
            guidance[key] = strip_markdown(value)
    return guidance if len(guidance) == len(GUIDANCE_PARTS) else None


def parse_questionnaire(text):
    domains = []
    current = None
    columns = []
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
        header = HEADER_ROW.match(line)
        if header:
            columns = [cell.strip() for cell in header.group(1).split("|")]
            continue
        row = CONTROL_ROW.match(line)
        if row:
            cells = [cell.strip() for cell in row.group(2).split("|")]
            fail_if(len(cells) < 2, "Tabellenzeile von Control {} ist unvollständig.".format(row.group(1)))
            control_text, questions = cells[0], cells[1]
            is_ko = bool(KO_MARK.search(control_text))
            questions = [strip_markdown(q.lstrip("•").strip()) for q in questions.split("<br>")]
            guidance_index = columns.index(GUIDANCE_COLUMN) if GUIDANCE_COLUMN in columns else None
            guidance_text = cells[guidance_index] if guidance_index is not None and guidance_index < len(cells) else ""
            current["controls"].append({
                "id": row.group(1),
                "text": strip_markdown(KO_MARK.sub("", control_text)),
                "questions": [q for q in questions if q],
                "guidance": parse_guidance(guidance_text),
                "ko": is_ko,
            })
        elif line.startswith("# ") and not line.startswith("# Domäne"):
            current = None
    return domains


def parse_glossary(text):
    """Liest die Tabelle «| Begriff | Erklärung |» aus dem deutschen Glossar."""
    entries = []
    in_table = False
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")] if line.startswith("|") else None
        if cells and cells[:2] == ["Begriff", "Erklärung"]:
            in_table = True
            continue
        if not in_table or cells is None:
            in_table = in_table and cells is not None
            continue
        if set(cells[0]) <= {"-", " "}:
            continue
        fail_if(len(cells) != 2 or not cells[0] or not cells[1], "Glossar: unvollständige Zeile «{}».".format(line.strip()))
        entries.append({"term": strip_markdown(cells[0]), "text": strip_markdown(cells[1])})
    fail_if(len(entries) < MIN_GLOSSARY_ENTRIES,
            "Glossar: nur {} Begriffe gefunden (erwartet mindestens {}).".format(len(entries), MIN_GLOSSARY_ENTRIES))
    return entries


def parse_scale(text):
    scale = []
    for line in text.splitlines():
        row = SCALE_ROW.match(line)
        if row:
            scale.append({"score": int(row.group(1)), "label": row.group(2), "description": row.group(3)})
    return scale


def parse_checklist(text):
    controls, ko, critical_domains, texts = [], set(), set(), {}
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
            texts[item.group(1)] = strip_markdown(KO_MARK.sub("", item.group(2)))
            if "[KO]" in item.group(2):
                ko.add(item.group(1))
    return controls, ko, critical_domains, texts


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


# ---------------------------------------------------------------------------
# Control-Mapping (framework/control-mapping.md, Englisch)
#
# Die Referenzen wie Art. 21(2)(a), A.5.15 oder PR.AA-01 sind sprachneutral und werden
# übernommen. Deutsch sind nur die Bezeichnungen der Zeilen in der Resultatansicht.
# Der Build prüft, dass sie zu den Übersichten im Mapping passen.

MAPPING_COLUMNS = ["NIS2", "ISO/IEC 27001:2022", "NIST CSF 2.0"]
MAPPING_AI_COLUMNS = ["NIST AI RMF 1.0", "ISO/IEC 42001:2023"]
NONE_MARK = "–"
NIS2_REF = re.compile(r"^Art\. \d+(\(\d+\))?(\([a-j]\))?$")
ISO_CLAUSE = re.compile(r"^(\d+)(\.\d+){1,2}$")
ISO_ANNEX = re.compile(r"^A\.([5-8])\.(\d+)$")
ISO42001_GROUP = re.compile(r"^A\.(\d+)$")
CSF_REF = re.compile(r"^(GV|ID|PR|DE|RS|RC)\.[A-Z]{2}-\d\d$")
AI_RMF_REF = re.compile(r"^(GOVERN|MAP|MEASURE|MANAGE) \d+(\.\d+)?$")
SEPARATOR_CELL = re.compile(r"^:?-+:?$")
CSF_TOTAL = re.compile(r"references \*\*(\d+) of (\d+)\*\* NIST CSF 2\.0 subcategories")

# ISO/IEC 27001:2022, Anhang A: Themen mit der Anzahl ihrer Controls (insgesamt 93).
ISO_THEMES = [
    ("A.5", "Organisatorische Controls", 37),
    ("A.6", "Personenbezogene Controls", 8),
    ("A.7", "Physische Controls", 14),
    ("A.8", "Technologische Controls", 34),
]
CSF_FUNCTIONS = [
    ("GV", "Govern – Steuern"),
    ("ID", "Identify – Identifizieren"),
    ("PR", "Protect – Schützen"),
    ("DE", "Detect – Erkennen"),
    ("RS", "Respond – Reagieren"),
    ("RC", "Recover – Wiederherstellen"),
]
# Schlüssel = erste Spalte der «NIS2 Coverage Overview» im Mapping.
NIS2_LABELS = {
    "Art. 20(1)": "Billigung und Überwachung durch die Geschäftsleitung",
    "Art. 20(2)": "Schulung der Geschäftsleitung",
    "Art. 21(2)(a)": "Risikoanalyse und Sicherheit der Informationssysteme",
    "Art. 21(2)(b)": "Bewältigung von Sicherheitsvorfällen",
    "Art. 21(2)(c)": "Betriebskontinuität, Backup, Wiederherstellung und Krisenmanagement",
    "Art. 21(2)(d), Art. 21(3)": "Sicherheit der Lieferkette",
    "Art. 21(2)(e)": "Sicherheit bei Erwerb, Entwicklung und Wartung, Umgang mit Schwachstellen",
    "Art. 21(2)(f)": "Bewertung der Wirksamkeit der Massnahmen",
    "Art. 21(2)(g)": "Cyberhygiene und Schulungen",
    "Art. 21(2)(h)": "Kryptografie und Verschlüsselung",
    "Art. 21(2)(i)": "Personalsicherheit, Zugriffskontrolle und Management der Anlagen",
    "Art. 21(2)(j)": "Multi-Faktor-Authentifizierung, gesicherte Kommunikation und Notfallkommunikation",
    "Art. 23": "Meldung erheblicher Sicherheitsvorfälle",
}
# Allgemeine Pflicht zu Risikomanagementmassnahmen; die NIS2-Übersicht führt sie nicht als eigene Zeile.
NIS2_NOT_IN_OVERVIEW = {"Art. 21(1)"}
COVERAGE_NOTES = {
    "partial": "Von ACP nur teilweise abgedeckt.",
    "limited": "Von ACP nur in der Risikobeurteilung berücksichtigt.",
    "none": "Von ACP nicht abgedeckt.",
}


def control_key(control_id):
    return tuple(int(part) for part in control_id.split("."))


def github_anchor(heading):
    """Anker, den GitHub für eine Markdown-Überschrift erzeugt."""
    return re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")


def parse_tables(text):
    """Liest alle Tabellen mit den Überschriften (# und ##), unter denen sie stehen.

    Jede Zeile muss gleich viele Spalten haben wie die Kopfzeile. So fallen auch
    Reste alter Tabellen auf, die GitHub nur noch als Text darstellen würde."""
    tables, block, h1, h2 = [], None, "", ""
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith("# "):
            h1, h2 = line[2:].strip(), ""
        elif line.startswith("## "):
            h2 = line[3:].strip()
        if not line.startswith("|"):
            block = None
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if block is None:
            fail_if(all(SEPARATOR_CELL.match(cell) for cell in cells),
                    "Control-Mapping Zeile {}: Tabelle ohne Kopfzeile.".format(number))
            block = {"h1": h1, "h2": h2, "line": number, "header": cells, "rows": []}
            tables.append(block)
            continue
        fail_if(len(cells) != len(block["header"]),
                "Control-Mapping Zeile {}: {} Spalten statt {} wie in der Kopfzeile.".format(
                    number, len(cells), len(block["header"])))
        if block["rows"] or "separator" in block:
            block["rows"].append(cells)
        else:
            fail_if(not all(SEPARATOR_CELL.match(cell) for cell in cells),
                    "Control-Mapping Zeile {}: Trennzeile der Tabelle fehlt.".format(number))
            block["separator"] = True
    return tables


def find_table(tables, h1, h2, header):
    found = [t for t in tables if t["h1"] == h1 and t["h2"] == h2]
    fail_if(len(found) != 1, "Control-Mapping: Tabelle «{}{}» nicht eindeutig gefunden.".format(
        h1, " / " + h2 if h2 else ""))
    fail_if(found[0]["header"] != header, "Control-Mapping: Spalten von «{}» geändert: {}".format(
        h2 or h1, found[0]["header"]))
    return found[0]["rows"]


def split_refs(cell):
    return [] if cell == NONE_MARK else [part.strip() for part in re.split(r"[,;]", cell)]


def parse_iso_refs(cell, where, annex):
    """«Cl. 5.1, 5.2; A.5.2» -> ["Cl. 5.1", "Cl. 5.2", "A.5.2"]. Zahlen ohne Präfix gehören zum Kapitel davor."""
    refs, clause_mode = [], False
    for ref in split_refs(cell):
        if ref.startswith("Cl. "):
            clause_mode, ref = True, ref[4:]
        elif ref.startswith("A."):
            clause_mode = False
            fail_if(not annex(ref), "{}: ungültige Referenz «{}».".format(where, ref))
            refs.append(ref)
            continue
        clause = ISO_CLAUSE.match(ref)
        fail_if(not clause_mode or not clause or not 4 <= int(clause.group(1)) <= 10,
                "{}: ungültige Referenz «{}».".format(where, ref))
        refs.append("Cl. " + ref)
    return refs


def iso27001_annex(ref):
    match = ISO_ANNEX.match(ref)
    totals = {theme[2:]: total for theme, _, total in ISO_THEMES}
    return bool(match) and 1 <= int(match.group(2)) <= totals[match.group(1)]


def iso42001_group(ref):
    match = ISO42001_GROUP.match(ref)
    return bool(match) and 2 <= int(match.group(1)) <= 10


def parse_refs(column, cell, where):
    if column == "ISO/IEC 27001:2022":
        return parse_iso_refs(cell, where, iso27001_annex)
    if column == "ISO/IEC 42001:2023":
        return parse_iso_refs(cell, where, iso42001_group)
    pattern = {"NIS2": NIS2_REF, "NIST CSF 2.0": CSF_REF, "NIST AI RMF 1.0": AI_RMF_REF}[column]
    refs = split_refs(cell)
    for ref in refs:
        fail_if(not pattern.match(ref), "{}: ungültige Referenz «{}».".format(where, ref))
    return refs


def coverage_status(text, where):
    if text.startswith("Covered"):
        return None
    if text.startswith("Partial"):
        return "partial"
    if text.startswith("Not covered beyond the risk assessment"):
        return "limited"
    if text.startswith("Not covered"):
        return "none"
    raise BuildError("{}: unbekannte Angabe zur Abdeckung «{}».".format(where, text))


def parse_control_ids(cell, all_ids, where):
    ids = [] if cell == NONE_MARK else [part.strip() for part in cell.split(",")]
    unknown = [i for i in ids if i not in all_ids]
    fail_if(unknown, "{}: unbekannte Controls {}.".format(where, unknown))
    return sorted(ids, key=control_key)


def standards_row(ref, label, controls, status=None, note=None):
    return {
        "ref": ref,
        "label": label,
        "controls": sorted(set(controls), key=control_key),
        "status": status,
        "note": note or COVERAGE_NOTES.get(status),
    }


def parse_mapping(text, domains, checklist_texts):
    """Ergänzt jedes Control um seine Referenzen und erzeugt die Ansichten pro Standard."""
    tables = parse_tables(text)
    all_ids = {c["id"] for d in domains for c in d["controls"]}
    parsed = {}

    for domain in domains:
        title = next((t["h1"] for t in tables if DOMAIN_EN.match("# " + t["h1"])
                      and int(DOMAIN_EN.match("# " + t["h1"]).group(1)) == domain["id"]), None)
        fail_if(title is None, "Control-Mapping: Tabelle für Domäne {} fehlt.".format(domain["id"]))
        domain_tables = [t for t in tables if t["h1"] == title]
        fail_if(len(domain_tables) != 1, "Control-Mapping: Domäne {} hat {} Tabellen.".format(
            domain["id"], len(domain_tables)))
        header = domain_tables[0]["header"]
        columns = header[2:]
        fail_if(header[:2] != ["ACP", "Control"] or columns not in (MAPPING_COLUMNS, MAPPING_COLUMNS + MAPPING_AI_COLUMNS),
                "Control-Mapping: unerwartete Spalten in Domäne {}: {}".format(domain["id"], header))
        domain["mappingUrl"] = "{}#{}".format(MAPPING_URL, github_anchor(title))

        rows = {row[0]: row for row in domain_tables[0]["rows"]}
        fail_if(len(rows) != len(domain_tables[0]["rows"]), "Control-Mapping: doppelte Controls in Domäne {}.".format(domain["id"]))
        expected = [c["id"] for c in domain["controls"]]
        fail_if(sorted(rows, key=control_key) != expected,
                "Control-Mapping: Controls von Domäne {} weichen ab. Mapping: {} Fragenkatalog: {}".format(
                    domain["id"], sorted(rows, key=control_key), expected))
        for control in domain["controls"]:
            row = rows[control["id"]]
            where = "Control-Mapping, Control {}".format(control["id"])
            fail_if(strip_markdown(KO_MARK.sub("", row[1])) != checklist_texts[control["id"]],
                    "{}: Text weicht von der Checkliste ab.".format(where))
            parsed[control["id"]] = {}
            control["refs"] = []
            for column, cell in zip(columns, row[2:]):
                parsed[control["id"]][column] = parse_refs(column, cell, where)
                control["refs"].append({
                    "name": column,
                    "text": None if cell == NONE_MARK else cell.replace("Cl. ", "Kap. "),
                })

    def controls_with(column, predicate):
        return [cid for cid, refs in parsed.items() if any(predicate(r) for r in refs[column])]

    def distinct_refs(column, predicate):
        return {r for refs in parsed.values() for r in refs[column] if predicate(r)}

    # ISO/IEC 27001:2022: Managementsystem und Anhang A nach Themen
    not_covered = find_table(tables, "Topics Not Covered by ACP", "", ["Topic", "NIS2", "ISO/IEC 27001:2022", "NIST CSF 2.0"])
    missing_clauses = [ref[4:] for row in not_covered if row[2].startswith("Cl. ")
                       for ref in parse_iso_refs(row[2], "Control-Mapping, Topics Not Covered", iso27001_annex)]
    iso_rows = [standards_row(
        "Kap. 4–10", "Managementsystem",
        controls_with("ISO/IEC 27001:2022", lambda r: r.startswith("Cl. ")),
        "partial" if missing_clauses else None,
        "Von ACP nur teilweise abgedeckt, nicht enthalten: Kap. {}.".format(", ".join(missing_clauses)) if missing_clauses else None,
    )]
    for theme, label, total in ISO_THEMES:
        in_theme = lambda r, theme=theme: r.startswith(theme + ".")
        iso_rows.append(standards_row(
            theme, label, controls_with("ISO/IEC 27001:2022", in_theme),
            note="ACP bezieht sich auf {} von {} Controls.".format(len(distinct_refs("ISO/IEC 27001:2022", in_theme)), total),
        ))

    # NIS2: Zeilen und Abdeckung aus der «NIS2 Coverage Overview»
    overview = find_table(tables, "NIS2 Coverage Overview", "", ["NIS2 requirement", "Topic", "ACP controls", "Coverage"])
    keys = [row[0] for row in overview]
    fail_if(sorted(keys) != sorted(NIS2_LABELS),
            "NIS2-Übersicht und deutsche Bezeichnungen passen nicht zusammen. Mapping: {} App: {}".format(
                sorted(keys), sorted(NIS2_LABELS)))
    nis2_rows, in_overview = [], set()
    for row in overview:
        refs = [ref.strip() for ref in row[0].split(",")]
        in_overview.update(refs)
        nis2_rows.append(standards_row(
            row[0].replace(", Art. ", ", "), NIS2_LABELS[row[0]],
            controls_with("NIS2", lambda r, refs=refs: r in refs),
            coverage_status(row[3], "NIS2-Übersicht, " + row[0]),
        ))
    outside = distinct_refs("NIS2", lambda r: r not in in_overview) - NIS2_NOT_IN_OVERVIEW
    fail_if(outside, "NIS2-Referenzen ohne Zeile in der NIS2-Übersicht: {}".format(sorted(outside)))

    # NIST CSF 2.0: sechs Funktionen; Anzahl Unterkategorien aus der «NIST CSF 2.0 Coverage Overview»
    csf = find_table(tables, "NIST CSF 2.0 Coverage Overview", "",
                     ["Function", "Category", "ACP controls", "Subcategories referenced", "Not addressed by ACP (examples)"])
    totals, referenced = {}, {}
    for row in csf:
        category = row[1].split(" ")[0]
        count = re.match(r"^(\d+) of (\d+)$", row[3])
        fail_if(not count, "NIST-CSF-Übersicht, {}: Anzahl Unterkategorien nicht lesbar.".format(category))
        actual = len(distinct_refs("NIST CSF 2.0", lambda r: r.startswith(category + "-")))
        fail_if(actual != int(count.group(1)),
                "NIST-CSF-Übersicht, {}: {} Unterkategorien angegeben, in den Domänentabellen {}.".format(
                    category, count.group(1), actual))
        function = category[:2]
        totals[function] = totals.get(function, 0) + int(count.group(2))
        referenced[function] = referenced.get(function, 0) + actual
    stated = CSF_TOTAL.search(text)
    fail_if(not stated or (int(stated.group(1)), int(stated.group(2))) != (sum(referenced.values()), sum(totals.values())),
            "NIST-CSF-Übersicht: Gesamtzahl der Unterkategorien stimmt nicht.")
    fail_if(sorted(totals) != sorted(f for f, _ in CSF_FUNCTIONS), "NIST-CSF-Übersicht: Funktionen fehlen.")
    csf_rows = [standards_row(
        function, label, controls_with("NIST CSF 2.0", lambda r, function=function: r.startswith(function + ".")),
        note="ACP bezieht sich auf {} von {} Unterkategorien.".format(referenced[function], totals[function]),
    ) for function, label in CSF_FUNCTIONS]

    # OWASP Top 10 for LLM Applications 2025 aus der «AI Security Overview»
    owasp = find_table(tables, "AI Security Overview", "OWASP Top 10 for LLM Applications 2025",
                       ["OWASP", "Risk", "ACP controls", "Coverage"])
    fail_if([row[0] for row in owasp] != ["LLM{:02d}".format(i) for i in range(1, 11)],
            "OWASP-Übersicht: LLM01 bis LLM10 erwartet.")
    owasp_rows = [standards_row(
        row[0], row[1], parse_control_ids(row[2], all_ids, "OWASP-Übersicht, " + row[0]),
        coverage_status(row[3], "OWASP-Übersicht, " + row[0]),
    ) for row in owasp]

    views = [
        {
            "id": "iso27001",
            "tab": "ISO/IEC 27001",
            "name": "ISO/IEC 27001:2022",
            "intro": "Managementsystem (Kapitel 4–10) und die vier Themen von Anhang A.",
            "rows": iso_rows,
        },
        {
            "id": "nis2",
            "tab": "NIS2",
            "name": "NIS2 – Richtlinie (EU) 2022/2555",
            "intro": "Pflichten der Geschäftsleitung (Art. 20), Risikomanagementmassnahmen (Art. 21) und Meldepflicht (Art. 23). "
                     "In der Schweiz gilt NIS2 nicht direkt; Schweizer Organisationen, die Dienstleistungen in der EU erbringen, "
                     "können darunter fallen.",
            "rows": nis2_rows,
        },
        {
            "id": "csf",
            "tab": "NIST CSF 2.0",
            "name": "NIST Cybersecurity Framework 2.0",
            "intro": "Die sechs Funktionen des NIST CSF. Auch der IKT-Minimalstandard des Bundes baut auf dem NIST CSF auf.",
            "rows": csf_rows,
        },
        {
            "id": "owasp-llm",
            "tab": "KI · OWASP",
            "name": "OWASP Top 10 for LLM Applications 2025",
            "intro": "Die zehn wichtigsten Sicherheitsrisiken beim Einsatz von KI-Sprachmodellen, etwa in KI-Assistenten und Chat-Tools.",
            "requiresDomain": 11,
            "rows": owasp_rows,
        },
    ]
    for view in views:
        for row in view["rows"]:
            fail_if(not row["controls"] and row["status"] != "none",
                    "Ansicht {}, {}: keine ACP-Controls zugeordnet.".format(view["tab"], row["ref"]))
    return views


def validate(domains, scale, checklist, scoring, version, questionnaire_text):
    checklist_ids, checklist_ko, checklist_critical, _ = checklist

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
            fail_if(not control["guidance"],
                    "Control {}: Bewertungshilfe fehlt oder ist unvollständig (Zeigen lassen, 2, 3).".format(control["id"]))

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
        glossary = parse_glossary(read(GLOSSARY))

        validate(domains, scale, checklist, scoring, version, questionnaire_text)
        standards = parse_mapping(read(MAPPING), domains, checklist[3])
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
            "glossary": glossary,
            "mappingUrl": MAPPING_URL,
            "standards": standards,
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
    print("OK: ACP {}, {} Domänen, {} Controls, Ansichten {}, Commit {} -> {}".format(
        version, len(domains), controls, ", ".join(v["tab"] for v in standards), commit, OUTPUT.relative_to(APP_ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
