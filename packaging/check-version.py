#!/usr/bin/env python3
"""Reject release metadata drift before publishing installable artifacts."""
import json
import re
import tomllib
from pathlib import Path

version = json.loads(Path('package.json').read_text())['version']
if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
    raise SystemExit('A stable semantic version is required for native releases.')
lock = json.loads(Path('package-lock.json').read_text())
cargo = tomllib.loads(Path('core-rust/Cargo.toml').read_text())
cargo_lock = tomllib.loads(Path('core-rust/Cargo.lock').read_text())
versions = {
    'package-lock': lock['version'],
    'package-lock root': lock['packages']['']['version'],
    'Cargo package': cargo['package']['version'],
    'Cargo lock': next(p['version'] for p in cargo_lock['package'] if p['name'] == 'doublemusic-core'),
    'OpenAPI': json.loads(Path('docs/openapi.json').read_text())['info']['version'],
    'Docker default': re.search(r'^ARG VERSION=(.+)$', Path('Dockerfile').read_text(), re.M)[1],
    'Compose default': re.search(r'doublemusic:([0-9.]+)', Path('compose.release.yml').read_text())[1],
}
for name, other in versions.items():
    if other != version:
        raise SystemExit(f'{name} version {other} does not match {version}')
print(version)
