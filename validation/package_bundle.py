"""Build the direct-Playwright release and verify both installed core copies.

Run after setup.ps1 -Update has finished. The allowlist intentionally excludes
historical CLI/batch files and all runtime state, profiles, cookies and evidence.
"""

from pathlib import Path
import hashlib
import json
import re
import stat
import zipfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "AI信息素养-Playwright-Skills.zip"
SKILL = "ai-literacy-search"
# Keep aligned with scripts/install.ps1. New release files need an explicit entry.
FIXED_CORE_FILES = (
    "SKILL.md",
    "agents/openai.yaml",
    "references/answer.schema.json",
    "references/browser.md",
    "references/browser-api.md",
    "references/exam-scope.md",
    "references/retrieval.md",
    "references/rules.json",
    "references/question-bank.json",
    "references/question-bank.md",
    "references/rule-evidence/retrieval-metrics.json",
    "references/rule-evidence/retrieval-metrics.png",
    "references/rule-evidence/boolean-operators.json",
    "references/rule-evidence/boolean-operators.png",
    "references/rule-evidence/doi-basics.json",
    "references/rule-evidence/doi-basics-identity.png",
    "references/rule-evidence/doi-basics-persistence.png",
    "references/rule-evidence/doi-basics-resolution.png",
    "references/rule-evidence/isbn-basics.json",
    "references/rule-evidence/isbn-basics-identity.png",
    "references/rule-evidence/isbn-basics-product.png",
    "references/rule-evidence/isbn-basics-formats.png",
    "references/rule-evidence/issn-basics.json",
    "references/rule-evidence/issn-basics-identity.png",
    "references/rule-evidence/issn-basics-format.png",
    "references/rule-evidence/issn-basics-quality.png",
    "references/rule-evidence/inverted-index.json",
    "references/rule-evidence/inverted-index.png",
    "references/recipes.md",
    "references/search-index.json",
    "references/sources.json",
    "scripts/browser.cjs",
    "scripts/question-bank.cjs",
    "scripts/preparation.cjs",
    "scripts/asset-cache.cjs",
    "scripts/local-evidence.cjs",
    "scripts/evidence-reuse.cjs",
    "scripts/search-runner.cjs",
    "scripts/recipes.cjs",
    "scripts/transitions.cjs",
    "scripts/install.ps1",
    "runtime/package.json",
    "runtime/package-lock.json",
    "runtime/repl/README.md",
    "runtime/repl/snippets/bootstrap.js",
    "runtime/repl/snippets/prepare.js",
)
EXCLUDED_OLD_FILES = (
    "scripts/cli.py",
    "scripts/pwcli.ps1",
    "references/cli.md",
    "examples/questions.jsonl",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_file(root: Path, relative: str) -> Path:
    """Validate each path before reading: no traversal, symlinks or junctions."""
    if not relative or "\\" in relative or ":" in relative:
        raise RuntimeError(f"Unsafe release path: {relative}")
    parsed = Path(relative)
    if parsed.is_absolute() or any(part in (".", "..") for part in parsed.parts):
        raise RuntimeError(f"Unsafe release path: {relative}")
    candidate = root / parsed
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise RuntimeError(f"Release path escapes package: {relative}")
    for ancestor in (candidate, *candidate.parents):
        if not ancestor.exists():
            raise RuntimeError(f"Release path does not exist: {ancestor}")
        attributes = getattr(ancestor.lstat(), "st_file_attributes", 0)
        if ancestor.is_symlink() or attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise RuntimeError(f"Refusing release link or junction: {ancestor}")
    if not candidate.is_file():
        raise RuntimeError(f"Release path is not a file: {candidate}")
    return candidate


def core_files() -> tuple[str, ...]:
    """Use the same explicit index-based profile allowlist as install.ps1."""
    package = ROOT / SKILL
    index = json.loads(safe_file(package, "references/search-index.json").read_text(encoding="utf-8"))
    sources = index.get("sources")
    if not isinstance(sources, list) or not sources:
        raise RuntimeError("Search index must list at least one source profile")
    profiles = []
    for source in sources:
        relative = source.get("profile") if isinstance(source, dict) else None
        if not isinstance(relative, str) or not re.fullmatch(r"references/sites/[a-z0-9][a-z0-9-]*\.json", relative):
            raise RuntimeError(f"Unsafe source profile path in search index: {relative}")
        safe_file(package, relative)
        profiles.append(relative)
    if len(set(profiles)) != len(profiles):
        raise RuntimeError("Duplicate source profile path in search index")
    return FIXED_CORE_FILES + tuple(profiles)


def main() -> None:
    core = core_files()
    release = ("setup.ps1", "使用说明.md") + tuple(f"{SKILL}/{name}" for name in core)
    contents = {name: safe_file(ROOT, name).read_bytes() for name in release}
    if len(contents) != len(release):
        raise RuntimeError("Duplicate release archive paths")
    installed_checks = []
    for scope in (".agents/skills", ".codex/skills"):
        installed = Path.home() / scope / SKILL
        for name in core:
            if safe_file(installed, name).read_bytes() != contents[f"{SKILL}/{name}"]:
                raise RuntimeError(f"Installed file differs from release: {installed / name}")
        for name in EXCLUDED_OLD_FILES:
            if (installed / name).exists():
                raise RuntimeError(f"Historical CLI/batch file remains installed: {installed / name}")
        marker = json.loads((installed / ".ailiteracy-install.json").read_text(encoding="utf-8"))
        if {item["path"] for item in marker["files"]} != set(core):
            raise RuntimeError(f"Installed managed manifest differs from core allowlist: {installed}")
        installed_checks.append({"path": str(installed), "core_files": len(core), "matched": True})

    runtime_manifest = json.loads(contents[f"{SKILL}/runtime/package.json"])
    runtime_lock = json.loads(contents[f"{SKILL}/runtime/package-lock.json"])
    playwright_version = runtime_manifest["dependencies"]["playwright"]
    if runtime_lock["packages"]["node_modules/playwright"]["version"] != playwright_version:
        raise RuntimeError("Playwright dependency is not pinned consistently in the lockfile")
    if any("@playwright/cli" in name for name in runtime_lock["packages"]):
        raise RuntimeError("The runtime must not include Playwright CLI")

    temporary_output = OUTPUT.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary_output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            archive.writestr(name, data)
    with zipfile.ZipFile(temporary_output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("ZIP CRC integrity check failed")
        if len(archive.namelist()) != len(release) or set(archive.namelist()) != set(release):
            raise RuntimeError("ZIP entries differ from the release allowlist")
        for name, data in contents.items():
            if archive.read(name) != data:
                raise RuntimeError(f"ZIP entry differs from source: {name}")
    temporary_output.replace(OUTPUT)
    report = {
        "version": runtime_manifest["version"],
        "zip": str(OUTPUT),
        "file_count": len(release),
        "bytes": OUTPUT.stat().st_size,
        "sha256": sha256(OUTPUT.read_bytes()),
        "zip_integrity": "passed",
        "browser_backend": "Playwright JavaScript library",
        "playwright_version": playwright_version,
        "installed_copies": installed_checks,
        "skills_installed_and_matched": True,
        "includes_credentials": False,
        "site_profile_count": len(core) - len(FIXED_CORE_FILES),
        "exclusion_policy": "Fixed core allowlist plus only indexed site recipes; no browser profiles, credentials, node_modules, evidence, validation, or historical CLI/batch files",
        "core_sha256": {name: sha256(contents[f"{SKILL}/{name}"]) for name in core},
    }
    (ROOT / "validation/bundle-check.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({key: value for key, value in report.items() if key != "core_sha256"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
