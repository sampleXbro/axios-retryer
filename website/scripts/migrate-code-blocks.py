#!/usr/bin/env python3
"""One-time helper: replace <pre><code> with CodeBlock (Shiki) in Astro pages.

Do not re-run after migration (pages no longer contain raw <pre><code> blocks).
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ROOT / "src" / "pages"

BLOCK_RE = re.compile(
    r'<pre><code(?:\s+class="language-([^"]+)")?>([\s\S]*?)</code></pre>',
    re.MULTILINE,
)


def import_path(file_path: Path) -> str:
    rel = file_path.relative_to(PAGES)
    n_dirs = len(rel.parts) - 1
    ups = "../" * (n_dirs + 1)
    return f"{ups}components/CodeBlock.astro"


def default_lang(class_lang: str | None) -> str:
    if not class_lang:
        return "bash"
    return class_lang


def process_file(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if "<pre><code" not in text:
        return False

    if not text.startswith("---"):
        raise SystemExit(f"No frontmatter: {path}")
    end = text.index("---", 3)
    fm = text[3:end]
    body = text[end + 3 :]

    matches = list(BLOCK_RE.finditer(body))
    if not matches:
        return False

    imp = import_path(path)
    import_line = f"import CodeBlock from '{imp}';"

    fm_lines = fm.strip().split("\n")
    if not any(line.strip() == import_line for line in fm_lines):
        insert_at = 0
        for i, line in enumerate(fm_lines):
            if line.startswith("import "):
                insert_at = i + 1
        fm_lines.insert(insert_at, import_line)

    const_lines: list[str] = []
    for i, m in enumerate(matches):
        raw_lang = m.group(1)
        inner = html.unescape(m.group(2))
        var = f"_shikiCode{i}"
        const_lines.append(f"const {var} = {json.dumps(inner)};")

    last_import = -1
    for j, line in enumerate(fm_lines):
        if line.startswith("import "):
            last_import = j
    for c in const_lines:
        fm_lines.insert(last_import + 1, c)
        last_import += 1

    new_body = body
    for i in range(len(matches) - 1, -1, -1):
        m = matches[i]
        var = f"_shikiCode{i}"
        lang = default_lang(m.group(1))
        replacement = f'<CodeBlock code={{{var}}} lang="{lang}" />'
        new_body = new_body[: m.start()] + replacement + new_body[m.end() :]

    fm_new = "\n" + "\n".join(fm_lines) + "\n"
    path.write_text(f"---{fm_new}---{new_body}", encoding="utf-8")
    print(f"OK {path.relative_to(ROOT)} ({len(matches)} blocks)")
    return True


def main() -> None:
    count = 0
    for p in sorted(PAGES.rglob("*.astro")):
        if process_file(p):
            count += 1
    print(f"Updated {count} files")


if __name__ == "__main__":
    main()
