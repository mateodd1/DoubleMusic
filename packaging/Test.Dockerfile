FROM ubuntu:22.04 AS deb
ENV DEBIAN_FRONTEND=noninteractive PACKAGE_MANAGER=deb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg adduser init-system-helpers systemd libstdc++6 libgcc-s1 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY dist/*.deb /tmp/packages/
RUN apt-get install -y --no-install-recommends /tmp/packages/*.deb
COPY packaging/test-install.sh /test-install.sh
CMD ["sh", "/test-install.sh"]

FROM fedora:44 AS rpm
ENV PACKAGE_MANAGER=rpm
RUN dnf install -y ffmpeg-free systemd shadow-utils util-linux ca-certificates libstdc++ libgcc && dnf clean all
COPY dist/*.rpm /tmp/packages/
RUN rpm -ivh /tmp/packages/*.rpm
COPY packaging/test-install.sh /test-install.sh
CMD ["sh", "/test-install.sh"]
