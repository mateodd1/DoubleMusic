#!/bin/sh
set -eu
for format in deb rpm; do
    docker build -f packaging/Test.Dockerfile --target "$format" -t "doublemusic-package-test:$format" .
    docker run --rm --network none "doublemusic-package-test:$format"
done
