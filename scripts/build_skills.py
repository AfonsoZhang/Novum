#!/usr/bin/env python3
"""Build the shared project skill tree used by Codex and Antigravity."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
EXPLICIT = 'policy:\n  allow_implicit_invocation: false\n'


@contextmanager
def build_lock(path):
    with path.open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            if path.stat().st_size == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def skill_entry(text):
    match = re.match(r'---\n(.*?)\n---\n', text, re.S)
    if not match:
        raise ValueError('Skill entry lacks YAML frontmatter')
    front = match[1]
    explicit = 'disable-model-invocation: true' in front
    front = re.sub(r'^(allowed-tools|disable-model-invocation|argument-hint):.*\n?', '', front, flags=re.M)
    extra = re.findall(r'^(author|version|tags|dependencies):[ \t]*(.*)$', front, re.M)
    if extra:
        front = re.sub(r'^(author|version|tags|dependencies):.*\n?', '', front, flags=re.M)
        front += '\nmetadata:\n' + '\n'.join(f'  {k}: {json.dumps(v.strip())}' for k, v in extra)
    body = text[match.end():]
    if '(../shared-references/writing-host.md)' not in body:
        body = '\nFollow the [active host rules](../shared-references/host-routing.md).\n' + body
    return '---\n' + front.rstrip() + '\n---\n' + body, explicit


def outputs(root):
    source = root / '.claude/skills'
    if not source.is_dir():
        raise FileNotFoundError(source)
    for src in sorted(source.rglob('*')):
        if not src.is_file() or '__pycache__' in src.parts or src.suffix == '.pyc':
            continue
        rel = src.relative_to(source)
        if src.suffix != '.md':
            yield rel, src
            continue
        body = src.read_text().replace('.claude/skills/', '.agents/skills/')
        if src.name == 'SKILL.md':
            body, explicit = skill_entry(body)
            if explicit:
                yield rel.parent / 'agents/openai.yaml', EXPLICIT
        yield rel, body
    for host in ('codex', 'antigravity'):
        if (root / 'config' / host / 'host.md').is_file():
            yield Path(f'shared-references/{host}-host.md'), (
                f'Follow the [{host} host contract](../../../config/{host}/host.md).\n'
            )
    for name, description, instruction in (
        ('research-auto', 'Explicitly activate automatic research for this task.', 'Follow the authorized endpoint and stop for explicit topic approval.'),
        ('research-autopilot', 'Explicitly activate post-topic autopilot for this task.', 'Follow the post-topic autopilot rules. Wait for explicit topic approval before making later research decisions.'),
    ):
        yield Path(name) / 'SKILL.md', (
            f'---\nname: {name}\ndescription: {description}\n---\n\n'
            f'Read [the controller](../research-agent-team/SKILL.md). {instruction}\n'
        )
        yield Path(name) / 'agents/openai.yaml', EXPLICIT


def build(root):
    root = root.resolve()
    dest = root / '.agents/skills'
    dest.mkdir(parents=True, exist_ok=True)
    manifest = dest.parent / 'generated-files.json'
    legacy = root / '.codex/generated-files.json'
    with build_lock(dest.parent / '.skills-build.lock'), TemporaryDirectory(dir=dest.parent) as tmp:
        staged = Path(tmp)
        planned = {dest / rel: content for rel, content in outputs(root)}
        owned = set()
        for record in (manifest, legacy):
            if record.exists():
                owned.update(root / rel for rel in json.loads(record.read_text()))
        for path in owned | planned.keys():
            if not path.is_relative_to(dest) or not path.parent.resolve().is_relative_to(dest):
                raise ValueError(f'Invalid generated path: {path}')
            if path.exists() or path.is_symlink():
                if path not in owned or (not path.is_symlink() and not path.is_file()):
                    raise RuntimeError(f'Refusing to overwrite unowned file or directory: {path}')

        def save_manifest(paths):
            scratch = staged / 'manifest'
            scratch.write_text(json.dumps(sorted(str(p.relative_to(root)) for p in paths), indent=2) + '\n')
            scratch.replace(manifest)

        # Record ownership before publishing files so an interrupted upgrade can resume.
        save_manifest(owned | planned.keys())
        for path, content in planned.items():
            scratch = staged / 'output'
            if isinstance(content, Path):
                target = os.path.relpath(content, path.parent)
                if path.is_symlink() and os.readlink(path) == target:
                    continue
                scratch.symlink_to(target)
            else:
                if path.is_file() and not path.is_symlink() and path.read_bytes() == content.encode():
                    continue
                scratch.write_text(content, encoding='utf-8')
            path.parent.mkdir(parents=True, exist_ok=True)
            scratch.replace(path)
        for path in owned - planned.keys():
            path.unlink(missing_ok=True)
        save_manifest(planned)
        legacy.unlink(missing_ok=True)
    print(f'Generated {len(list(dest.glob("*/SKILL.md")))} shared skills in {dest}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    build(parser.parse_args().root)


if __name__ == '__main__':
    main()
