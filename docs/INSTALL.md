# Installing DoubleMusic on Linux

Prebuilt releases provide Docker images and native DEB/RPM packages for x86-64 (`amd64`/`x86_64`) and ARM64 (`arm64`/`aarch64`). Download packages and offline images from [GitHub Releases](https://github.com/mateodd1/DoubleMusic/releases). Each release includes `SHA256SUMS` and architecture-specific build metadata.

The packages include the Rust core, catalog worker and a private, pinned Node.js runtime. They do not replace or require a system Node installation. FFmpeg/FFprobe remain system dependencies. The core is statically linked with musl; the bundled Node runtime requires glibc 2.28 or later and libstdc++. These packages target glibc-based distributions, not Alpine. The systemd service requires a Linux installation running systemd.

## Docker images

The registry image is `ghcr.io/mateodd1/doublemusic`, with multi-architecture tags `1.4.1`, `1.4`, `1` and `latest`. Prefer an exact version for controlled upgrades. Docker selects the host architecture. Architecture-specific tags such as `1.4.1-amd64` and `1.4.1-arm64` are also available.

From the repository directory:

```bash
cp .env.example .env
mkdir -p music
# Set MUSIC_DIR and PUBLIC_URL in .env.
docker compose -f compose.release.yml pull
docker compose -f compose.release.yml up -d
```

`compose.release.yml` uses a prebuilt image. The existing `docker-compose.yml` builds from source. Both use the same data volume, read-only music mount and environment settings; use one Compose configuration for the installation.

To load a downloaded image archive instead:

```bash
sha256sum --check SHA256SUMS --ignore-missing
docker load -i doublemusic_1.4.1_linux_amd64.docker.tar.gz
DOUBLEMUSIC_IMAGE=doublemusic:1.4.1 docker compose -f compose.release.yml up -d --pull never
```

Choose `arm64` in the filename on ARM64 machines. The archive contains the `doublemusic:1.4.1` tag. It provides an installation path when the registry is unavailable or requires authentication. Registry package visibility is managed separately in GitHub's package settings; public release archives can be downloaded without a registry login.

Create the first Docker account as described in the main README:

```bash
read -r -s -p 'Password: ' MUSIC_PASSWORD; printf '\n'
printf '%s\n' "$MUSIC_PASSWORD" | docker compose -f compose.release.yml exec -T doublemusic node cli.js add admin --admin --password-stdin
unset MUSIC_PASSWORD
```

## Debian and Ubuntu

Download the DEB for your architecture. The installation is exercised on Ubuntu 22.04; Debian 12/13 and newer Ubuntu releases satisfy the runtime requirements when their FFmpeg package is available.

```bash
sha256sum --check SHA256SUMS --ignore-missing
sudo apt install ./doublemusic_1.4.1-1_amd64.deb
```

Use `arm64` in place of `amd64` on ARM64. Install with `apt` so that FFmpeg, service helpers and runtime libraries are resolved automatically.

## Fedora and compatible RPM distributions

Download the RPM for `x86_64` or `aarch64`:

```bash
sha256sum --check SHA256SUMS --ignore-missing
sudo dnf install ./doublemusic-1.4.1-1.x86_64.rpm
```

Installation is exercised on Fedora 44. The RPM requires the `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` file capabilities, rather than one distribution-specific FFmpeg package name. Fedora supplies these through `ffmpeg-free`. Other RPM distributions, including Enterprise Linux derivatives, need compatible FFmpeg providers in their enabled repositories; an RPM download alone does not add such repositories. Packages are unsigned; verify the release's checksums before installation. No APT or YUM repository is configured by these downloads.

## Configure and start a native installation

Initial installation creates a `doublemusic` system account and installs `doublemusic.service`, but does not enable or start it. Configure the server and create an account first.

| Location | Purpose |
| --- | --- |
| `/etc/doublemusic/doublemusic.env` | Environment settings, preserved on upgrade. |
| `/etc/doublemusic/settings.json` | Local library/external connection switches, preserved on upgrade. |
| `/srv/doublemusic/music` | Default music folder; add your files or configure another readable folder. |
| `/var/lib/doublemusic` | Accounts, SQLite, catalog and conversion cache. |
| `/usr/lib/doublemusic` | Immutable application files, core and private Node runtime. |
| `/usr/bin/doublemusic-server` | Configuration-aware server launcher and healthcheck. |
| `/usr/bin/doublemusic-user` | Configuration-aware account administration CLI. |
| `/usr/share/doc/doublemusic` | Documentation and bundled dependency license texts. |

Edit `/etc/doublemusic/doublemusic.env` with simple shell-compatible `KEY=value` entries. The environment file is used by systemd and the launchers; only administrators should modify it. The initial listener is `127.0.0.1:3000`. Set `PUBLIC_URL` to the origin your clients reach. Configure an HTTPS reverse proxy for public access, or set `HOST=0.0.0.0` when deliberately exposing the listener on your network.

The default `settings.json` enables local files and sets `external.enabled` to `false`. Enable extensions only when you have configured them; see [MODULES.md](MODULES.md). Give the `doublemusic` group read access to private configuration/token files without making them world-readable.

The service needs read and directory traversal permission for the music folder. Keep your files owned as appropriate and grant the service account read access. The systemd unit makes the filesystem read-only except for its state directory and temporary files. `ProtectHome=yes` hides home directories; place music under `/srv`, `/mnt`, or a dedicated mount instead. If you change `DATA_DIR`, add a systemd override permitting writes to the new directory and arrange its ownership.

Create an administrator without placing the password on the command line:

```bash
read -r -s -p 'Password: ' MUSIC_PASSWORD; printf '\n'
printf '%s\n' "$MUSIC_PASSWORD" | sudo -u doublemusic doublemusic-user add admin --admin --password-stdin
unset MUSIC_PASSWORD
sudo systemctl enable --now doublemusic.service
sudo systemctl status doublemusic.service
```

Account passwords are never supplied by the package. Configure your mobile client's server URL as `PUBLIC_URL`, without `/api/v1`.

```bash
sudo -u doublemusic doublemusic-user list
sudo -u doublemusic doublemusic-user revoke username
sudo -u doublemusic doublemusic-server --healthcheck
sudo journalctl -u doublemusic.service -n 100 --no-pager
```

For password changes, use `doublemusic-user passwd username --password-stdin` with the same stdin pattern. Run account administration as the `doublemusic` account so SQLite and cache files retain the correct ownership.

## Upgrades, backups and removal

Back up the complete state directory while the service is stopped, and back up your music separately. Install the next package using the same `apt install ./file.deb` or `dnf install ./file.rpm` command. Modified environment/source configuration is preserved. An active systemd service is restarted on upgrade; a disabled or inactive installation is not started. Accounts, current session tokens and personal libraries use the same SQLite schema as Docker/source installations.

For Docker, change the pinned image tag, pull it, then recreate the service with the existing mounts and volume. Do not restore an older database merely to switch runtime or package versions; retain current data for a code rollback.

Remove a native package with `sudo apt remove doublemusic` or `sudo dnf remove doublemusic`. Debian configuration remains until `sudo apt purge doublemusic`; RPM can preserve modified files as `.rpmsave`. Music, `/var/lib/doublemusic` and the system account are retained even after purge/removal. Delete these separately only when you intend to destroy the installation's data.

## Building and publishing

Build locally with Docker; compilation tools are not required on the destination server:

```bash
docker build -t doublemusic:1.4.1 .
docker build --target packages --output type=local,dest=dist .
scripts/test-packages.sh
```

The build uses its native architecture. Build on an ARM64 host or a configured cross-platform Buildx builder for ARM64. The release workflow uses separate native x86-64 and ARM64 GitHub runners, validates the tag against application metadata, tests both API runtimes and container lifecycle, installs/upgrades/removes both package formats, and only then publishes registry images and release downloads. Create a new semantic version across package/Cargo/OpenAPI metadata before pushing its `vX.Y.Z` tag.

The bundled Node version is pinned in `Dockerfile` and receives updates through new DoubleMusic releases. License texts for Node, ws and Rust dependencies are shipped with the artifacts. `doublemusic-build-ARCH.json` records the source revision, Node version, architecture and core SHA-256.
