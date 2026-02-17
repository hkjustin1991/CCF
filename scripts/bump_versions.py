#!/usr/bin/env python3
from pathlib import Path
import re, subprocess, datetime

root = Path(__file__).resolve().parents[1]
count = subprocess.check_output(['git','rev-list','--count','HEAD'], cwd=root, text=True).strip()
date = datetime.date.today().isoformat()

repls = {
    'Code.gs': [(r"const APP_VERSION = '[^']+';", f"const APP_VERSION = '{date}.staff{count}';")],
    'Admin.gs': [(r"const ADMIN_VERSION = '[^']+';", f"const ADMIN_VERSION = '{date}.admin{count}';")],
    'Reg.gs': [(r"const REG_VERSION = '[^']+';", f"const REG_VERSION = '{date}.reg{count}';")],
    'Reg2.html': [(r"ui reg2-ui-[^<]+", f"ui reg2-ui-{date}.reg{count}")]
}

for rel, rules in repls.items():
    p = root / rel
    s = p.read_text()
    for pat, rep in rules:
        s = re.sub(pat, rep, s)
    p.write_text(s)
    print(f'updated {rel}')
print(f'Versions set using date={date}, commit_count={count}')
