#!/bin/bash
# Builds and runs the archon-agent-exec tests in a container, with real uids and sudo.
set -euo pipefail
cd "$(dirname "$0")/.."
tag=archon-agent-exec-test:local
docker build --quiet --target agent-exec-test -t "$tag" .
# A resolvable hostname keeps sudo's "unable to resolve host" warning out of captured output.
docker run --rm --network none --hostname localhost "$tag"
