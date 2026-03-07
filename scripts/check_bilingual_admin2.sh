#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path
import sys

text = Path('Admin2.html').read_text(encoding='utf-8')
issues = []

forbidden_snippets = [
    '<div class="big">🔐 登入 / Login</div>',
    '<div class="small">請掃描你自己的同工 QR 登入。<br/>Please scan your own staff QR to login.</div>',
    '<button id="btnScanLogin" class="btnMain">📷 掃描 QR / Scan QR</button>',
    '<button id="btnUploadLoginQr" class="btnSub">🖼️ 上傳 QR 圖片 / Upload QR image</button>',
    '<div class="label">授權登入 / Authorised login</div>',
    '<div class="big">📷 掃描 QR / Scan QR</div>',
    '<div class="small">請掃描你自己的同工 QR。<br/>Please scan your own staff QR.</div>',
    '<button id="btnStartCam" class="btnMain" type="button">▶️ 啟動相機 / Start camera</button>',
    '<button id="btnExtScan" class="btnSub">🌐 外置掃描器 / External scanner</button>',
    '<button id="btnCancel" class="btnDanger">取消 / Cancel</button>',
    '<div class="big">🔐 最後確認 / Final confirm</div>',
    '<div class="small">請掃描你本人同工 QR 作確認。<br/>Please scan your own staff QR to confirm.</div>',
    '<button id="btnOpenExternal" class="btnBack" type="button">🌐 使用外部掃描器 / Open external scanner</button>',
    "confirm('確認儲存更改？\\nConfirm save changes?')",
    "alert('已複製連結，請貼到 Safari/Chrome 開啟。\\nLink copied. Open in Safari/Chrome.')",
]

for snippet in forbidden_snippets:
    if snippet in text:
        issues.append(snippet)

if issues:
    print('Bilingual guard failed: found raw literals that should be dictionary-backed:')
    for item in issues:
        print(' -', item)
    sys.exit(1)

print('OK: bilingual guard passed for targeted high-impact Admin2.html UI literals')
PY
