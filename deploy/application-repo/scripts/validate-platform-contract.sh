#!/usr/bin/env bash
set -euo pipefail

contract_file="${1:-.platform-ci.json}"
manifests_path="${2:-}"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}

test -f "${contract_file}" || {
  echo "Missing contract: ${contract_file}" >&2
  exit 1
}

jq -e '
  .schemaVersion == 1 and
  (.app.name | type == "string" and length > 0) and
  (.app.namespace | type == "string" and length > 0) and
  (.app.deployment | type == "string" and length > 0) and
  (.app.container | type == "string" and length > 0) and
  (.ci.workingDirectory | type == "string" and length > 0) and
  (.ci.installCommand | type == "string" and length > 0) and
  (.ci.testCommand | type == "string" and length > 0) and
  (.image.name | type == "string" and test("^[a-z0-9./_-]+$")) and
  (.image.context | type == "string" and length > 0) and
  (.image.dockerfile | type == "string" and length > 0) and
  (.image.pullSecret | type == "string" and length > 0) and
  (.deploy.manifestsPath | type == "string" and length > 0) and
  (.deploy.smokeTestCommand | type == "string" and length > 0) and
  (.deploy.timeoutSeconds | type == "number" and . >= 30) and
  (.deploy.rollbackOnFailure | type == "boolean")
' "${contract_file}" >/dev/null

if [[ -n "${manifests_path}" && -d "${manifests_path}" ]]; then
  grep -Rqs "__PLATFORM_IMAGE__" "${manifests_path}" || {
    echo "Manifest path must contain __PLATFORM_IMAGE__: ${manifests_path}" >&2
    exit 1
  }
fi

echo "Platform contract is valid: ${contract_file}"
