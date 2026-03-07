#!/usr/bin/env python3
"""Guardrail for key registry-managed UI literals in Admin2.html."""
from pathlib import Path
import sys

text = Path('Admin2.html').read_text(encoding='utf-8')

# Raw snippets that should no longer appear inline at call-sites.
forbidden_snippets = [
    "confirm('確認儲存更改？\\nConfirm save changes?')",
    "alert('已複製連結，請貼到 Safari/Chrome 開啟。\\nLink copied. Open in Safari/Chrome.')",
    'placeholder="例如 CCF0001 / Alex / abc@x.com"',
    'placeholder="例如：CCF0001 / Alex"',
    "'<div class=\"small\">載入中… / Loading…</div>'",
    "'<div class=\"small\">搜尋中… / Searching…</div>'",
    "<div class=\"big\">📊 聚會統計 / Service stats</div><div class=\"small\">載入中… / Loading…</div>",
    "showErr('msg', {code:'E500', zh:'掃描器出現問題', en:'Scanner error'",
]

hits = [snippet for snippet in forbidden_snippets if snippet in text]
if hits:
    print('Found raw UI literals that should use ADMIN_UI_TEXT registry:')
    for h in hits:
        print(' -', h)
    sys.exit(1)

print('OK: key raw UI literals are registry-backed in Admin2.html')
