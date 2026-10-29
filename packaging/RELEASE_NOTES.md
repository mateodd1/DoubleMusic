Install DoubleMusic using the Docker images or native DEB/RPM packages for x86-64 and ARM64.

- Docker: `ghcr.io/mateodd1/doublemusic`, with versioned and `latest` multi-architecture tags. Offline Docker archives are also attached.
- Linux packages include the Rust core, the private catalog worker and its pinned Node.js runtime. FFmpeg is a system dependency.
- Native packages install a dedicated system account, systemd service and preserved configuration under `/etc/doublemusic`. Initial installation does not start the server; configure it and create an account first.
- Package upgrades preserve configuration, accounts, sessions and personal libraries. Removing or purging the package retains music and application data.
- Release artifacts include SHA-256 checksums and build metadata.

See [Linux installation](https://github.com/mateodd1/DoubleMusic/blob/main/docs/INSTALL.md) for installation, account creation, upgrades and removal. Verify the download using `SHA256SUMS`. Advanced Connect controls require a client that implements and advertises `queueControl`.
