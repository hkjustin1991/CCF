#!/usr/bin/env python3
"""Admin warn/err message policy scanner.

Checks Admin2.html for:
1) direct showBox(..., 'warn'/'err', ...) with inline literal zh/en strings
2) missing bilingual pair (zh and en) in warn/err catalog entries
3) missing/invalid code (E### or S###) for warn/err catalog entries

By default exits non-zero when violations are found.
Use --report-only for checklist usage where you only want visibility.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

SHOWBOX_RE = re.compile(r"showBox\s*\(", re.MULTILINE)
CATALOG_RE = re.compile(r"\b(?:const|let|var)\s+ADMIN_MESSAGE_CATALOG\s*=\s*\{", re.MULTILINE)
ENTRY_RE = re.compile(r"([A-Za-z0-9_]+)\s*:\s*\{", re.MULTILINE)
KIND_RE = re.compile(r"\bkind\s*:\s*['\"](warn|err)['\"]")
ZH_RE = re.compile(r"\bzh\s*:\s*['\"]([^'\"]*)['\"]")
EN_RE = re.compile(r"\ben\s*:\s*['\"]([^'\"]*)['\"]")
CODE_RE = re.compile(r"\bcode\s*:\s*['\"]([A-Za-z0-9]+)['\"]")
VALID_CODE_RE = re.compile(r"^[ES]\d{3}$")


@dataclass
class Violation:
    line: int
    category: str
    detail: str


def line_no(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def extract_balanced_segment(text: str, open_idx: int, opener: str, closer: str) -> Optional[str]:
    depth = 0
    in_single = False
    in_double = False
    in_template = False
    escaped = False
    start = open_idx

    for i in range(open_idx, len(text)):
        ch = text[i]
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue

        if in_single:
            if ch == "'":
                in_single = False
            continue
        if in_double:
            if ch == '"':
                in_double = False
            continue
        if in_template:
            if ch == "`":
                in_template = False
            continue

        if ch == "'":
            in_single = True
            continue
        if ch == '"':
            in_double = True
            continue
        if ch == "`":
            in_template = True
            continue

        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]

    return None


def split_top_level_args(call_body: str) -> List[str]:
    inner = call_body[1:-1]
    args: List[str] = []
    cur: List[str] = []
    depth_paren = depth_brace = depth_brack = 0
    in_single = in_double = in_template = False
    escaped = False

    for ch in inner:
        if escaped:
            cur.append(ch)
            escaped = False
            continue
        if ch == "\\":
            cur.append(ch)
            escaped = True
            continue

        if in_single:
            cur.append(ch)
            if ch == "'":
                in_single = False
            continue
        if in_double:
            cur.append(ch)
            if ch == '"':
                in_double = False
            continue
        if in_template:
            cur.append(ch)
            if ch == "`":
                in_template = False
            continue

        if ch == "'":
            in_single = True
            cur.append(ch)
            continue
        if ch == '"':
            in_double = True
            cur.append(ch)
            continue
        if ch == "`":
            in_template = True
            cur.append(ch)
            continue

        if ch == "(":
            depth_paren += 1
        elif ch == ")":
            depth_paren -= 1
        elif ch == "{":
            depth_brace += 1
        elif ch == "}":
            depth_brace -= 1
        elif ch == "[":
            depth_brack += 1
        elif ch == "]":
            depth_brack -= 1

        if ch == "," and depth_paren == 0 and depth_brace == 0 and depth_brack == 0:
            args.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)

    if cur:
        args.append("".join(cur).strip())
    return args


def is_string_literal(expr: str) -> bool:
    s = expr.strip()
    return (len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'))


def scan_showbox_literals(text: str) -> Iterable[Violation]:
    for match in SHOWBOX_RE.finditer(text):
        open_paren = text.find("(", match.start())
        call = extract_balanced_segment(text, open_paren, "(", ")")
        if not call:
            continue
        args = split_top_level_args(call)
        if len(args) < 4:
            continue
        kind = args[1].strip()
        if kind not in ("'warn'", '"warn"', "'err'", '"err"'):
            continue
        zh = args[2]
        en = args[3]
        if is_string_literal(zh) or is_string_literal(en):
            kind_label = kind.strip("\"'")
            yield Violation(
                line_no(text, match.start()),
                "inline-showBox-literal",
                f"showBox kind={kind_label} should use catalog message object/key, not inline literals (zh={zh}, en={en})",
            )


def find_catalog_object(text: str) -> Optional[tuple[int, str]]:
    m = CATALOG_RE.search(text)
    if not m:
        return None
    brace_start = text.find("{", m.end() - 1)
    obj = extract_balanced_segment(text, brace_start, "{", "}")
    if not obj:
        return None
    return brace_start, obj


def scan_catalog_entries(text: str) -> Iterable[Violation]:
    found = find_catalog_object(text)
    if not found:
        yield Violation(1, "missing-catalog", "ADMIN_MESSAGE_CATALOG object not found")
        return

    start_idx, obj = found
    pos = 0
    while True:
        m = ENTRY_RE.search(obj, pos)
        if not m:
            break
        key = m.group(1)
        entry_open = obj.find("{", m.start())
        entry_obj = extract_balanced_segment(obj, entry_open, "{", "}")
        if not entry_obj:
            break
        kind_m = KIND_RE.search(entry_obj)
        if kind_m and kind_m.group(1) in {"warn", "err"}:
            kind = kind_m.group(1)
            abs_idx = start_idx + m.start()
            zh_m = ZH_RE.search(entry_obj)
            en_m = EN_RE.search(entry_obj)
            code_m = CODE_RE.search(entry_obj)
            if not zh_m or not zh_m.group(1).strip() or not en_m or not en_m.group(1).strip():
                yield Violation(
                    line_no(text, abs_idx),
                    "missing-bilingual-pair",
                    f"catalog entry '{key}' (kind={kind}) must define both zh and en",
                )
            if not code_m:
                yield Violation(
                    line_no(text, abs_idx),
                    "missing-code",
                    f"catalog entry '{key}' (kind={kind}) must define code",
                )
            elif not VALID_CODE_RE.match(code_m.group(1).strip()):
                yield Violation(
                    line_no(text, abs_idx),
                    "invalid-code",
                    f"catalog entry '{key}' has invalid code '{code_m.group(1)}' (expected E### or S###)",
                )
        pos = m.start() + len(entry_obj)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="Admin2.html", help="Path to Admin2.html")
    parser.add_argument("--report-only", action="store_true", help="Always exit 0 after reporting violations")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 2

    text = path.read_text(encoding="utf-8")
    violations = list(scan_showbox_literals(text)) + list(scan_catalog_entries(text))

    if not violations:
        print(f"PASS: {path} has no warn/err bilingual/catalog policy violations.")
        return 0

    print(f"FAIL: found {len(violations)} violation(s) in {path}:")
    for v in sorted(violations, key=lambda x: x.line):
        print(f"  L{v.line:>4} [{v.category}] {v.detail}")

    if args.report_only:
        print("NOTE: --report-only enabled; exiting 0.")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
