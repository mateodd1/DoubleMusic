#!/usr/bin/env python3
"""Build Debian and RPM artifacts from the tested native Linux payload."""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output', default='/out')
args = parser.parse_args()
source = Path('/build/app')
version = json.loads((source / 'package.json').read_text())['version']
assert all(part.isdigit() for part in version.split('.')) and len(version.split('.')) == 3
architecture = {'x86_64': ('amd64', 'x86_64'), 'aarch64': ('arm64', 'aarch64')}[platform.machine()]
deb_arch, rpm_arch = architecture
root = Path('/tmp/doublemusic-root')
root.mkdir(parents=True, exist_ok=True)
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
linux = Path('/build/packaging/linux')

def install(file, destination, mode=0o644):
    target = root / destination.lstrip('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(file, target)
    target.chmod(mode)
    return target

app = root / 'usr/lib/doublemusic/app'
shutil.copytree(source, app)
install('/doublemusic-core', '/usr/lib/doublemusic/bin/doublemusic-core', 0o755)
install('/build/node/node', '/usr/lib/doublemusic/runtime/node', 0o755)
for file in ['run', 'doublemusic-server', 'doublemusic-user']:
    install(linux / file, '/usr/lib/doublemusic/run' if file == 'run' else '/usr/bin/' + file, 0o755)
install(linux / 'doublemusic.service', '/usr/lib/systemd/system/doublemusic.service')
for file in ['doublemusic.env', 'settings.json']:
    install(linux / file, '/etc/doublemusic/' + file, 0o640)
for directory in ['etc/doublemusic', 'var/lib/doublemusic', 'srv/doublemusic/music']:
    (root / directory).mkdir(parents=True, exist_ok=True)
    (root / directory).chmod(0o750)
doc = root / 'usr/share/doc/doublemusic'
doc.mkdir(parents=True, exist_ok=True)
for file in ['README.md', 'README-es.md']:
    install('/build/' + file, '/usr/share/doc/doublemusic/' + file)
shutil.copytree('/build/docs', doc / 'docs')
shutil.copytree('/rust-licenses', doc / 'licenses/rust')
install('/build/node/LICENSE', '/usr/share/doc/doublemusic/licenses/NODE-LICENSE')
install(source / 'node_modules/ws/LICENSE', '/usr/share/doc/doublemusic/licenses/WS-LICENSE')
(doc / 'copyright').write_text('DoubleMusic\nProject: https://github.com/mateodd1/DoubleMusic\n'
    'The project has not declared a standalone redistribution license.\n'
    'Bundled third-party licenses are retained in licenses/.\n')
# Normalize payload permissions; application code is immutable to the service user.
for file in app.rglob('*'):
    if file.is_file():
        file.chmod(0o644)

create_user = (linux / 'create-user').read_text().split('set -eu\n', 1)[1]
setup = '''install -d -o doublemusic -g doublemusic -m 0750 /var/lib/doublemusic
install -d -o root -g doublemusic -m 0750 /etc/doublemusic /srv/doublemusic/music
chgrp doublemusic /etc/doublemusic/doublemusic.env /etc/doublemusic/settings.json
'''
control = root / 'DEBIAN'
control.mkdir()
(control / 'control').write_text(f'''Package: doublemusic
Version: {version}-1
Section: sound
Priority: optional
Architecture: {deb_arch}
Maintainer: DoubleMusic maintainers <matvps4@gmail.com>
Homepage: https://github.com/mateodd1/DoubleMusic
Depends: libc6 (>= 2.28), libstdc++6 (>= 8), libgcc-s1, ca-certificates, ffmpeg, adduser, init-system-helpers, systemd
Description: Local music library and streaming API server
 Rust account and Connect core with a private catalog worker. Includes its
 Node.js runtime, systemd service, local catalog, and optional extension API.
''')
(control / 'conffiles').write_text('/etc/doublemusic/doublemusic.env\n/etc/doublemusic/settings.json\n')
(control / 'postinst').write_text('''#!/bin/sh
set -eu
if [ "$1" = configure ]; then
''' + create_user + setup + '''    if [ -d /run/systemd/system ]; then
        systemctl --system daemon-reload || true
        if [ -n "${2:-}" ]; then deb-systemd-invoke try-restart doublemusic.service || true; fi
    fi
fi
exit 0
''')
(control / 'prerm').write_text('''#!/bin/sh
set -eu
if [ "$1" = remove ] && [ -d /run/systemd/system ]; then
    deb-systemd-invoke stop doublemusic.service || true
fi
exit 0
''')
(control / 'postrm').write_text('''#!/bin/sh
set -eu
if [ "$1" = purge ]; then deb-systemd-helper purge doublemusic.service || true; fi
if [ -d /run/systemd/system ]; then systemctl --system daemon-reload || true; fi
# Keep music, application state and the system account, even on purge.
exit 0
''')
for file in ['postinst', 'prerm', 'postrm']:
    (control / file).chmod(0o755)
# Ship Debian's own file checksums, in addition to the release artifact hashes.
md5 = []
for file in sorted(root.rglob('*')):
    if file.is_file() and 'DEBIAN' not in file.relative_to(root).parts:
        md5.append(hashlib.md5(file.read_bytes()).hexdigest() + '  ' + str(file.relative_to(root)))
(control / 'md5sums').write_text('\n'.join(md5) + '\n')
deb_file = output / f'doublemusic_{version}-1_{deb_arch}.deb'
subprocess.run(['dpkg-deb', '--build', '--root-owner-group', '-Zxz', '-z3', str(root), str(deb_file)], check=True)
shutil.rmtree(control)

rpmbuild = Path('/tmp/doublemusic-rpmbuild')
for directory in ['BUILD', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS', 'BUILDROOT']:
    (rpmbuild / directory).mkdir(parents=True, exist_ok=True)
files = []
for file in sorted(root.rglob('*')):
    path = '/' + str(file.relative_to(root))
    if file.is_file():
        if path.startswith('/etc/doublemusic/'):
            files.append('%config(noreplace) %attr(0640,root,doublemusic) ' + path)
        else:
            files.append(path)
    elif path in ['/var/lib/doublemusic', '/srv/doublemusic/music']:
        files.append('%dir %attr(0750,doublemusic,doublemusic) ' + path)
    elif path == '/etc/doublemusic':
        files.append('%dir %attr(0750,root,doublemusic) ' + path)
    elif path.startswith(('/usr/lib/doublemusic', '/usr/share/doc/doublemusic')):
        files.append('%dir ' + path)
spec = rpmbuild / 'SPECS/doublemusic.spec'
spec.write_text(f'''Name: doublemusic
Version: {version}
Release: 1
Summary: Local music library and streaming API server
License: LicenseRef-DoubleMusic
URL: https://github.com/mateodd1/DoubleMusic
BuildArch: {rpm_arch}
AutoReqProv: no
Requires: glibc >= 2.28, libstdc++, libgcc, ca-certificates, systemd, shadow-utils
Requires: /usr/bin/ffmpeg, /usr/bin/ffprobe
Requires(pre): shadow-utils

%description
Rust account and Connect core with a private catalog worker. Includes its
Node.js runtime, systemd service, local catalog, and optional extension API.

%prep
%build
%install
mkdir -p %{{buildroot}}
cp -a /tmp/doublemusic-root/. %{{buildroot}}/

%pre
''' + create_user + '''
%post
''' + setup + '''if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
    if [ "$1" -gt 1 ]; then systemctl try-restart doublemusic.service || true; fi
fi

%preun
if [ "$1" -eq 0 ] && [ -d /run/systemd/system ]; then
    systemctl disable --now doublemusic.service || true
fi

%postun
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
# Keep music, application state and the system account after removal.

%files
%defattr(-,root,root,-)
''' + '\n'.join(files) + '\n')
subprocess.run(['rpmbuild', '-bb', '--target', rpm_arch,
    '--define', '_topdir ' + str(rpmbuild), '--define', '_build_id_links none',
    '--define', '__os_install_post %{nil}', '--define', '_binary_payload w3.xzdio', str(spec)], check=True)
for file in (rpmbuild / 'RPMS').rglob('*.rpm'):
    shutil.copy2(file, output / file.name)
manifest = {'version': version, 'architecture': deb_arch,
    'nodeVersion': subprocess.check_output(['/build/node/node', '--version'], text=True).strip(),
    'coreSha256': hashlib.sha256(Path('/doublemusic-core').read_bytes()).hexdigest(),
    'sourceRevision': os.environ.get('SOURCE_REVISION', 'local-build')}
(output / f'doublemusic-build-{deb_arch}.json').write_text(json.dumps(manifest, indent=2) + '\n')
hashes = []
for file in sorted(output.iterdir()):
    if not file.name.startswith('SHA256SUMS'):
        hashes.append(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name)
(output / ('SHA256SUMS-' + deb_arch)).write_text('\n'.join(hashes) + '\n')
print(f'Linux packages built: {version} {deb_arch}')
