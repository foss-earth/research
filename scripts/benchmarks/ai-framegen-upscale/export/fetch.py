"""Verify the pinned upstream code and weights in <work>/sources, importing them from local copies.

Contains no download code. Each item of export/sources.json is checked in <work>/sources; when it is
missing or wrong it is imported from an --import-from root (a folder holding upstream/<repo> git
clones and weights/<candidate>/ files, e.g. build/ai-framegen-upscale) and verified again. Anything
still missing prints the manual retrieval instructions recorded in sources.json, and the script
exits 1.

  code    git archive of the pinned commit (tree id checked) from a clone, else the listed files
          from a plain folder; __pycache__ and .DS_Store are never copied
  weights RIFE archive copied and its pinned members extracted (only those, hash-checked);
          RT4KSR checkpoint copied
  corpus  with --corpus-root, the six panoramas are hash-checked in place (never copied)

A replaced item is moved to <work>/superseded/<stamp>/, never deleted. Writes
<work>/sources/fetch-receipt.json.

Run:
  <work>/venv/bin/python -I -B scripts/benchmarks/ai-framegen-upscale/export/fetch.py \
    --import-from=build/ai-framegen-upscale [--corpus-root=<panoramas>] [--work=<dir>] [--check]
"""
from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SKIPPED_NAMES = {"__pycache__", ".DS_Store", "__MACOSX"}


def _skipped(relative: str) -> bool:
    return any(part in SKIPPED_NAMES or part.startswith("._") for part in Path(relative).parts)


def verify_files(root: Path, files: list[dict]) -> list[str]:
    """Problems (empty when every listed file exists with the pinned sha256 and size)."""
    problems = []
    for entry in files:
        path = root / entry["path"]
        if not path.is_file() or path.is_symlink():
            problems.append(f"missing {path}")
            continue
        if path.stat().st_size != entry["bytes"] or common.sha256_file(path) != entry["sha256"]:
            problems.append(f"hash mismatch {path}")
    return problems


def tree_digest(root: Path) -> dict:
    """sha256 over sorted 'sha256  relative-path' lines of every file under root (no symlinks)."""
    lines, count, total = [], 0, 0
    for path in sorted(p for p in root.rglob("*") if p.is_file() or p.is_symlink()):
        if path.is_symlink():
            raise SystemExit(f"symlink in verified sources: {path}")
        relative = path.relative_to(root).as_posix()
        lines.append(f"{common.sha256_file(path)}  {relative}")
        count += 1
        total += path.stat().st_size
    return {"files": count, "bytes": total, "sha256": common.sha256_bytes(("\n".join(lines) + "\n").encode())}


def supersede(path: Path, work: Path, stamp: str) -> Path | None:
    if not path.exists() and not path.is_symlink():
        return None
    target = common.ensure_build_directory(work / "superseded" / stamp) / path.name
    shutil.move(str(path), str(target))
    return target


def find_import(roots: list[Path], candidates: list[str]) -> Path | None:
    for root in roots:
        for relative in candidates:
            path = root / relative
            if path.exists():
                return path
    return None


def git(clone: Path, *args: str, binary: bool = False):
    result = subprocess.run(["git", "-C", str(clone), *args], check=True, capture_output=True)
    return result.stdout if binary else result.stdout.decode().strip()


def import_code(spec: dict, source: Path, staging: Path) -> str:
    """Populate staging from a clone (git archive of the pinned commit) or a plain folder."""
    if (source / ".git").exists():
        try:
            tree = git(source, "rev-parse", f"{spec['commit']}^{{tree}}")
        except subprocess.CalledProcessError:
            raise SystemExit(f"{source}: pinned commit {spec['commit']} not present in the clone")
        if tree != spec["tree"]:
            raise SystemExit(f"{source}: tree {tree} != pinned {spec['tree']}")
        data = git(source, "archive", "--format=tar", spec["commit"], binary=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive.getmembers():
                if member.isfile() and not _skipped(member.name):
                    archive.extract(member, staging, filter="data")
        return f"git archive {spec['commit']} (tree {tree})"
    for entry in spec["files"]:
        target = staging / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / entry["path"], target)
    return "copied listed files from a plain folder"


def extract_members(archive_path: Path, members: list[dict], target: Path) -> None:
    """Extract only the pinned members, by exact name, after checking each member's bytes."""
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        for entry in members:
            if entry["path"] not in names or Path(entry["path"]).is_absolute() or ".." in Path(entry["path"]).parts:
                raise SystemExit(f"{archive_path}: member {entry['path']} missing or unsafe")
            data = archive.read(entry["path"])
            if len(data) != entry["bytes"] or common.sha256_bytes(data) != entry["sha256"]:
                raise SystemExit(f"{archive_path}: member {entry['path']} does not match its pin")
            common.write_bytes(target / entry["path"], data)


def manual(spec: dict) -> str:
    return f"  manual retrieval: {spec['retrieval']}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", help="work folder (default build/benchmarks/ai-framegen-upscale/work)")
    parser.add_argument("--import-from", action="append", default=[], help="import root; repeatable")
    parser.add_argument("--corpus-root", help="also hash-check the corpus panoramas in this folder")
    parser.add_argument("--check", action="store_true", help="verify only; never import")
    args = parser.parse_args()

    work = common.work_dir(args.work)
    common.apply_scratch_env(work)
    sources_dir = common.ensure_build_directory(work / "sources")
    roots = [Path(root).resolve() for root in args.import_from]
    sources = common.load_sources()
    stamp = common.new_output_directory("export").name  # also the run's log folder
    receipt = {"schema": 1, "createdAt": common.now_iso(), "script": common.script_receipt(__file__),
               "importFrom": [common.repo_relative(root) for root in roots], "items": {}, "corpus": None}
    failures = 0

    def record(key: str, status: str, **extra) -> None:
        receipt["items"][key] = {"status": status, **extra}
        print(f"{key}: {status}" + (f" ({extra.get('how')})" if extra.get("how") else ""), flush=True)

    for key, spec in sources["code"].items():
        target = work / spec["workPath"]
        problems = verify_files(target, spec["files"])
        if not problems:
            record(key, "verified", how="already present", tree=tree_digest(target))
            continue
        source = None if args.check else find_import(roots, spec["importFrom"])
        if source is None:
            failures += 1
            record(key, "missing", problems=problems[:5])
            print(manual(spec), file=sys.stderr)
            continue
        staging = common.ensure_build_directory(sources_dir / f".staging-{key}")
        if any(staging.iterdir()):
            supersede(staging, work, stamp)
            staging = common.ensure_build_directory(sources_dir / f".staging-{key}")
        how = import_code(spec, source, staging)
        problems = verify_files(staging, spec["files"])
        if problems:
            failures += 1
            record(key, "mismatch", problems=problems[:5], importedFrom=common.repo_relative(source))
            print(manual(spec), file=sys.stderr)
            continue
        moved = supersede(target, work, stamp)
        staging.rename(target)
        record(key, "imported", how=how, importedFrom=common.repo_relative(source), tree=tree_digest(target),
               superseded=common.repo_relative(moved) if moved else None)

    for key, spec in sources["weights"].items():
        if "extracted" in spec:  # archive: <workPath>/<file> plus pinned members under extractTo
            folder = work / spec["workPath"]
            archive = folder / spec["file"]
            extracted = work / spec["extractTo"]
            listed = [{"path": spec["file"], "sha256": spec["sha256"], "bytes": spec["bytes"]}]
            ok = not verify_files(folder, listed) and not verify_files(extracted, spec["extracted"])
            if ok and {p.relative_to(extracted).as_posix() for p in extracted.rglob("*") if p.is_file()} \
                    == {e["path"] for e in spec["extracted"]}:
                record(key, "verified", how="already present", tree=tree_digest(folder))
                continue
            source = None if args.check else find_import(roots, spec["importFrom"])
            if source is None or common.sha256_file(source) != spec["sha256"]:
                failures += 1
                record(key, "missing" if source is None else "mismatch",
                       importedFrom=common.repo_relative(source) if source else None)
                print(manual(spec), file=sys.stderr)
                continue
            moved = supersede(folder, work, stamp)
            common.ensure_build_directory(folder)
            shutil.copyfile(source, archive)
            extract_members(archive, spec["extracted"], extracted)
            problems = verify_files(folder, listed) + verify_files(extracted, spec["extracted"])
            if problems:
                raise SystemExit(f"{key}: verification failed after import: {problems}")
            record(key, "imported", how="archive copied; pinned members extracted",
                   importedFrom=common.repo_relative(source), tree=tree_digest(folder),
                   superseded=common.repo_relative(moved) if moved else None)
        else:  # single file at <workPath>
            target = work / spec["workPath"]
            listed = [{"path": target.name, "sha256": spec["sha256"], "bytes": spec["bytes"]}]
            if not verify_files(target.parent, listed):
                record(key, "verified", how="already present", sha256=spec["sha256"])
                continue
            source = None if args.check else find_import(roots, spec["importFrom"])
            if source is None or common.sha256_file(source) != spec["sha256"]:
                failures += 1
                record(key, "missing" if source is None else "mismatch",
                       importedFrom=common.repo_relative(source) if source else None)
                print(manual(spec), file=sys.stderr)
                continue
            moved = supersede(target, work, stamp)
            common.ensure_build_directory(target.parent)
            shutil.copyfile(source, target)
            if verify_files(target.parent, listed):
                raise SystemExit(f"{key}: verification failed after import")
            record(key, "imported", how="file copied", importedFrom=common.repo_relative(source),
                   sha256=spec["sha256"], superseded=common.repo_relative(moved) if moved else None)

    if args.corpus_root:
        root = Path(args.corpus_root)
        corpus = {}
        for name, entry in sources["corpus"].items():
            path = root / entry["panorama"] / entry["file"]
            ok = path.is_file() and common.sha256_file(path) == entry["sha256"]
            corpus[name] = "verified" if ok else "missing or mismatch"
            failures += 0 if ok else 1
            print(f"corpus {name}: {corpus[name]}", flush=True)
        receipt["corpus"] = {"root": common.repo_relative(root), "panoramas": corpus}

    receipt["ok"] = failures == 0
    common.write_json(sources_dir / "fetch-receipt.json", receipt)
    common.write_json(common.BUILD.joinpath(*common.AREA, "export", stamp, "fetch-receipt.json"), receipt)
    print(f"{'ok' if failures == 0 else f'{failures} item(s) missing or wrong'}; receipt: "
          f"{common.repo_relative(sources_dir / 'fetch-receipt.json')}", flush=True)
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
