#!/usr/bin/env python3
"""Validate the non-secret private-extension migration manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "private-extension-manifest.json"


def validate(path: Path = MANIFEST) -> list[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [f"missing manifest: {path}"]
    except json.JSONDecodeError as exc:
        return [f"invalid JSON: {exc}"]

    errors: list[str] = []
    if payload.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    if payload.get("public_repository") != "jackojacko05/manage_health":
        errors.append("public_repository must remain jackojacko05/manage_health")
    if not isinstance(payload.get("private_target_repository"), str) or not payload["private_target_repository"]:
        errors.append("private_target_repository must be a non-empty string")
    if payload.get("migration_status") != "prepare_only":
        errors.append("migration_status must remain prepare_only until cutover approval")

    entries = payload.get("entries")
    if not isinstance(entries, list) or not entries:
        errors.append("entries must be a non-empty list")
        entries = []
    ids: set[str] = set()
    for index, entry in enumerate(entries):
        prefix = f"entries[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix} must be an object")
            continue
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            errors.append(f"{prefix}.id must be a non-empty string")
        elif entry_id in ids:
            errors.append(f"duplicate entry id: {entry_id}")
        else:
            ids.add(entry_id)
        for key in ("source_repo", "destination", "action", "verification"):
            if not isinstance(entry.get(key), str) or not entry[key]:
                errors.append(f"{prefix}.{key} must be a non-empty string")
        if not isinstance(entry.get("source_paths"), list) or not all(
            isinstance(item, str) for item in entry["source_paths"]
        ):
            errors.append(f"{prefix}.source_paths must be a string list")
        if not isinstance(entry.get("private_symbols"), list) or not all(
            isinstance(item, str) for item in entry["private_symbols"]
        ):
            errors.append(f"{prefix}.private_symbols must be a string list")

    serialized = json.dumps(payload, ensure_ascii=False).lower()
    for marker in ("-----begin", "sk-", "ghp_", "xoxb-", "password="):
        if marker in serialized:
            errors.append(f"credential-like marker found: {marker}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()
    errors = validate(args.manifest)
    if errors:
        for error in errors:
            print(f"ERROR\t{error}")
        return 1
    print(f"OK\tprivate extension manifest: {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
