#!/usr/bin/env python3
"""DEPRECATED (2026-09-06): retired in favor of scripts/sync-descriptions.js.

The orchestrator (sync-all-updates.js) only ever ran the .js writer, and both
writers target content/database.json + content/perk-description-report.json
with different schemas. Kept on disk for reference only — do not run.
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATABASE_PATH = ROOT / "content" / "database.json"
REPORT_PATH = ROOT / "content" / "perk-description-report.json"
MANIFEST_GLOB = "perk-description-manifest-part*.json"
VALID_STATUSES = {"different", "same_as_legacy", "unresolved"}
STATUS_EXPLANATION_RE = re.compile(
    r"^(?:Blindness|Broken|Exhausted|Exposed|Haste|Hindered|Oblivious|Undetectable)\b.*(?:prevents|increases|reduces|hides|downed)",
    re.IGNORECASE,
)
UNRESOLVED_TEMPLATE_RE = re.compile(r"\{(?:Tunable|Keyword|Input)\.[^}]+\}")


def fail(message):
    print(f"sync-perk-descriptions: {message}", file=sys.stderr)
    sys.exit(1)


def strip_html(text):
    text = re.sub(r"<[^>]*>", " ", str(text or ""))
    text = text.replace("\xa0", " ")
    return text


def clean_text(text):
    text = strip_html(text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\s*/\s*", "/", text)
    text = re.sub(r"([0-9])\s*%", r"\1%", text)
    text = re.sub(r"([+\-][0-9]+)\s*%", r"\1%", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+\)", ")", text)
    return text.strip()


def normalise_multiline_text(text):
    if not text:
        return ""

    lines = []
    prev_blank = False
    for raw_line in str(text).replace("\r\n", "\n").split("\n"):
        match = re.match(r"^(\s*)(-\s+)?(.*)$", raw_line)
        indent = match.group(1) or ""
        bullet = "- " if match.group(2) else ""
        body = clean_text(match.group(3) or "")
        if not body:
            if lines and not prev_blank:
                lines.append("")
            prev_blank = True
            continue
        lines.append(f"{indent}{bullet}{body}")
        prev_blank = False

    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()

    return "\n".join(lines)


def semantic_normalise(text):
    normalised = normalise_multiline_text(text)
    normalised = re.sub(r"^\s*-\s+", "", normalised, flags=re.MULTILINE)
    normalised = re.sub(r"\s+", " ", normalised)
    return normalised.strip()


def is_flavour_or_help_line(line):
    stripped = clean_text(line)
    if not stripped:
        return False
    if re.match(r'^[\"“].*[\"”]\s*(?:[-—–].+)?$', stripped):
        return True
    if STATUS_EXPLANATION_RE.match(stripped):
        return True
    return False


def sanitise_description_block(text):
    lines = []
    for raw_line in str(text or "").replace("\r\n", "\n").split("\n"):
        if is_flavour_or_help_line(raw_line):
            break
        lines.append(raw_line)
    return normalise_multiline_text("\n".join(lines))


def load_database():
    if not DATABASE_PATH.exists():
        fail(f"Missing {DATABASE_PATH}")
    database = json.loads(DATABASE_PATH.read_text(encoding="utf-8"))
    perks = database.get("perks")
    if not isinstance(perks, list):
        fail("content/database.json is missing a perks array")
    return database


def load_manifest_entries():
    manifest_paths = sorted((ROOT / "scripts").glob(MANIFEST_GLOB))
    if not manifest_paths:
        fail(f"No manifest files found matching scripts/{MANIFEST_GLOB}")

    entries = {}
    for manifest_path in manifest_paths:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            fail(f"{manifest_path} must contain a JSON object")
        for perk_name, payload in manifest.items():
            if perk_name in entries:
                fail(f"Duplicate manifest entry for {perk_name}")
            if not isinstance(payload, dict):
                fail(f"{manifest_path} entry for {perk_name} must be an object")
            status = payload.get("status")
            if status not in VALID_STATUSES:
                fail(f"{manifest_path} entry for {perk_name} has invalid status {status!r}")
            source_url = payload.get("sourceUrl")
            if not isinstance(source_url, str) or not source_url.startswith("https://nightlight.gg/perks/"):
                fail(f"{manifest_path} entry for {perk_name} is missing a valid NightLight sourceUrl")
            if status == "different":
                description = payload.get("descriptionPost95")
                if not isinstance(description, str) or not description.strip():
                    fail(f"{manifest_path} entry for {perk_name} is missing descriptionPost95")
                match = UNRESOLVED_TEMPLATE_RE.search(description)
                if match:
                    fail(f"{manifest_path} entry for {perk_name} has unresolved template token {match.group(0)}")
            if status != "different" and "descriptionPost95" in payload and payload["descriptionPost95"]:
                fail(f"{manifest_path} entry for {perk_name} should not include descriptionPost95 for status={status}")
            entries[perk_name] = {
                "status": status,
                "sourceUrl": source_url,
                "descriptionPost95": sanitise_description_block(payload.get("descriptionPost95", "")),
                "note": payload.get("note", ""),
                "manifestFile": manifest_path.name,
            }
    return entries


def main():
    database = load_database()
    manifest_entries = load_manifest_entries()
    perks = database["perks"]
    perks_by_name = {perk["name"]: perk for perk in perks}

    missing = [perk["name"] for perk in perks if perk["name"] not in manifest_entries]
    extra = [name for name in manifest_entries if name not in perks_by_name]
    if extra:
        fail("Manifest contains unknown perk names:\n  - " + "\n  - ".join(extra))
    if missing:
        fail("Manifest is missing perk entries:\n  - " + "\n  - ".join(missing))

    report_entries = []
    status_counter = Counter()
    unresolved = []

    for perk in perks:
        entry = manifest_entries[perk["name"]]
        legacy = normalise_multiline_text(perk.get("description", ""))
        status = entry["status"]
        status_counter[status] += 1

        if status == "different":
            modern = entry["descriptionPost95"]
            if semantic_normalise(modern) == semantic_normalise(legacy):
                status = "same_as_legacy"
                status_counter["different"] -= 1
                status_counter["same_as_legacy"] += 1
                perk.pop("descriptionPost95", None)
            else:
                perk["descriptionPost95"] = modern
        elif status == "same_as_legacy":
            perk.pop("descriptionPost95", None)
        else:
            perk.pop("descriptionPost95", None)
            unresolved.append(perk["name"])

        report_entries.append({
            "id": perk["id"],
            "name": perk["name"],
            "status": status,
            "sourceUrl": entry["sourceUrl"],
            "manifestFile": entry["manifestFile"],
            "note": entry["note"],
        })

    if unresolved:
        fail("Manifest still has unresolved perks:\n  - " + "\n  - ".join(unresolved))

    DATABASE_PATH.write_text(json.dumps(database, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    REPORT_PATH.write_text(
        json.dumps(
            {
                "totalPerks": len(perks),
                "counts": dict(status_counter),
                "entries": report_entries,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"sync-perk-descriptions: processed {len(perks)} perks")
    print(
        "sync-perk-descriptions: counts "
        + ", ".join(f"{status}={status_counter.get(status, 0)}" for status in ["different", "same_as_legacy", "unresolved"])
    )
    print(f"sync-perk-descriptions: wrote {REPORT_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
