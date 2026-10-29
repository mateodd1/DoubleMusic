#!/usr/bin/env python3
"""Retain license texts and dependency metadata for the bundled Rust code."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--locked', '--format-version', '1']))
manifest = []
for package in metadata['packages']:
    if package['source'] is None:
        continue
    source = Path(package['manifest_path']).parent
    destination = output / (package['name'] + '-' + package['version'])
    files = [p for p in source.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'UNLICENSE'))]
    if package.get('license_file'):
        files.append(source / package['license_file'])
    destination.mkdir(exist_ok=True)
    for file in set(files):
        if file.is_file():
            shutil.copy2(file, destination / file.name)
    manifest.append({key: package.get(key) for key in ['name', 'version', 'license', 'repository']})
(output / 'dependencies.json').write_text(json.dumps(manifest, indent=2) + '\n')
