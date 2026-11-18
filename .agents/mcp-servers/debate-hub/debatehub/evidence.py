"""Evidence anchoring, path confinement, artifact hashing and JSON extraction."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

MAX_VERIFY_FILE_BYTES = 2 * 1024 * 1024  # 2 MiB safety cap per file read


class PathViolationError(ValueError):
    pass


def _is_within(path: Path, roots: Iterable[Path]) -> bool:
    for root in roots:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def resolve_allowed_path(raw_path: str, allowed_roots: List[str], base_dir: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise PathViolationError("artifact path must be a non-empty string")
    candidate = Path(raw_path)
    resolved = (candidate if candidate.is_absolute() else Path(base_dir) / candidate).resolve()
    roots = [Path(r).resolve() for r in allowed_roots]
    if not _is_within(resolved, roots):
        raise PathViolationError(f"path escapes allowedRoots: {raw_path}")
    return resolved


def sha256_file(path: Path) -> Tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def snapshot_artifacts(paths: List[str], allowed_roots: List[str], base_dir: str) -> List[Dict[str, Any]]:
    """Validate, resolve and SHA-256 hash primary artifact files."""
    seen: set[str] = set()
    records: List[Dict[str, Any]] = []
    base = Path(base_dir).resolve()
    for raw in paths:
        resolved = resolve_allowed_path(raw, allowed_roots, base_dir)
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        if not resolved.exists():
            raise FileNotFoundError(f"artifact not found: {raw}")
        if resolved.is_dir():
            raise IsADirectoryError(f"artifact must be a file, not a directory: {raw}")
        digest, size = sha256_file(resolved)
        try:
            rel = str(resolved.relative_to(base))
        except ValueError:
            rel = key
        records.append({
            "inputPath": raw,
            "path": key,
            "displayPath": rel,
            "sha256": digest,
            "bytes": size,
        })
    return records


def check_artifact_staleness(artifacts: List[Dict[str, Any]]) -> Dict[str, Any]:
    changed: List[Dict[str, Any]] = []
    missing: List[str] = []
    for art in artifacts:
        p = Path(art["path"])
        if not p.is_file():
            missing.append(art.get("displayPath") or art["path"])
            continue
        digest, size = sha256_file(p)
        if digest != art.get("sha256"):
            changed.append({
                "path": art.get("displayPath") or art["path"],
                "expectedSha256": art.get("sha256"),
                "currentSha256": digest,
                "currentBytes": size,
            })
    return {"stale": bool(changed or missing), "changed": changed, "missing": missing}


def _normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _line_number_at(content: str, index: int) -> int:
    return content.count("\n", 0, index) + 1


def verify_quote(entry: Any, allowed_roots: List[str], base_dir: str,
                 registered_paths: Optional[set[str]] = None) -> Dict[str, Any]:
    """Verify that a claimed quote actually appears verbatim in an allowed file."""
    if not isinstance(entry, dict):
        return {"verified": False, "matchKind": "invalid", "path": "", "quote": "",
                "reason": "quote entry must be an object with path and quote"}
    raw_path = str(entry.get("path") or "").strip()
    quote = str(entry.get("quote") or "").strip()
    declared_line = entry.get("line")
    out: Dict[str, Any] = {
        "path": raw_path,
        "quote": quote[:1000],
        "declaredLine": declared_line,
        "verified": False,
        "matchKind": "missing",
        "registered": False,
    }
    if not raw_path or not quote:
        out["matchKind"] = "empty"
        out["reason"] = "both path and quote are required for evidence anchoring"
        return out
    try:
        resolved = resolve_allowed_path(raw_path, allowed_roots, base_dir)
    except PathViolationError as exc:
        out["matchKind"] = "outside_roots"
        out["reason"] = str(exc)
        return out
    out["resolvedPath"] = str(resolved)
    if registered_paths is not None:
        out["registered"] = str(resolved) in registered_paths
    if not resolved.is_file():
        out["matchKind"] = "unreadable"
        out["reason"] = "file does not exist"
        return out
    try:
        size = resolved.stat().st_size
        if size > MAX_VERIFY_FILE_BYTES:
            with resolved.open("rb") as fh:
                raw_bytes = fh.read(MAX_VERIFY_FILE_BYTES)
            truncated = True
        else:
            raw_bytes = resolved.read_bytes()
            truncated = False
        content = raw_bytes.decode("utf-8", errors="replace")
    except OSError as exc:
        out["matchKind"] = "unreadable"
        out["reason"] = f"could not read file: {exc}"
        return out

    idx = content.find(quote)
    if idx != -1:
        out["verified"] = True
        out["matchKind"] = "exact"
        out["matchedLine"] = _line_number_at(content, idx)
        return out

    norm_quote = _normalize_ws(quote)
    if len(norm_quote) >= 8:
        pattern = re.escape(norm_quote).replace(r"\ ", r"\s+")
        m = re.search(pattern, content)
        if m:
            out["verified"] = True
            out["matchKind"] = "whitespace"
            out["matchedLine"] = _line_number_at(content, m.start())
            return out

    out["matchKind"] = "missing"
    out["reason"] = ("quote not found in first 2 MiB of file" if truncated
                     else "quote not found verbatim in file")
    return out


def verify_quotes_list(quotes: Any, allowed_roots: List[str], base_dir: str,
                       registered_paths: Optional[set[str]] = None) -> Dict[str, Any]:
    items = quotes if isinstance(quotes, list) else []
    checked = [verify_quote(q, allowed_roots, base_dir, registered_paths) for q in items]
    verified = sum(1 for c in checked if c["verified"])
    unverified = len(checked) - verified
    return {
        "quotes": checked,
        "totalCount": len(checked),
        "verifiedCount": verified,
        "unverifiedCount": unverified,
        "hasVerifiedAnchor": verified > 0,
    }


def build_inline_materials(artifacts: List[Dict[str, Any]], max_bytes: int) -> str:
    """Render bounded inline excerpts for non-filesystem agents (e.g. HTTP chat APIs)."""
    if not artifacts:
        return "(No primary artifact files were attached.)"
    remaining = max(1024, int(max_bytes))
    blocks: List[str] = []
    for art in artifacts:
        p = Path(art["path"])
        label = art.get("displayPath") or art["path"]
        header = f"--- ARTIFACT: {label} (sha256: {art.get('sha256', '')[:12]}) ---\n"
        if remaining <= len(header) + 64:
            blocks.append(f"--- ARTIFACT OMITTED (byte cap reached): {label} ---\n"
                          "[UNREAD CONTENT: do not claim anything about this file.]")
            continue
        remaining -= len(header)
        try:
            raw = p.read_bytes()
        except OSError:
            blocks.append(header + "[UNREADABLE FILE]")
            continue
        truncated = len(raw) > remaining
        snippet = raw[:remaining].decode("utf-8", errors="replace")
        remaining -= len(raw[:remaining])
        if truncated:
            snippet += (f"\n[TRUNCATED at {len(raw[:len(snippet.encode('utf-8'))])} of {len(raw)} bytes; "
                        "unread portion is NOT verified.]")
        blocks.append(header + snippet)
    return "\n\n".join(blocks)


def extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    """Extract a JSON object from raw text or fenced ```json blocks."""
    if not isinstance(text, str) or not text.strip():
        return None
    stripped = text.strip()
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass

    # Look for fenced ```json ... ``` blocks (prefer the last valid object)
    fenced = re.findall(r"```(?:json)?\s*\n(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    for block in reversed(fenced):
        try:
            parsed = json.loads(block.strip())
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue

    # Fallback: scan balanced braces from the end
    decoder = json.JSONDecoder()
    for m in reversed(list(re.finditer(r"\{", text))):
        try:
            parsed, _ = decoder.raw_decode(text[m.start():])
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue
    return None
