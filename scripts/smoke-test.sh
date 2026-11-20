#!/usr/bin/env bash
set -euo pipefail

: "${NAMESPACE:?NAMESPACE must be set}"
: "${DEPLOYMENT:?DEPLOYMENT must be set}"

kubectl -n "${NAMESPACE}" exec "deployment/${DEPLOYMENT}" -- \
  node -e '
    fetch("http://127.0.0.1:3000/api/health")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || body.ok !== true) {
          console.error(JSON.stringify({ status: response.status, body }));
          process.exit(1);
        }
        console.log(JSON.stringify({
          ok: body.ok,
          schemaVersion: body.schemaVersion,
          toolCount: body.toolCount
        }));
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  '
