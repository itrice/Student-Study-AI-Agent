#!/usr/bin/env bash
set -euo pipefail

contract_file="${1:-.platform-ci.json}"
manifests_path="${2:-}"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || {
  echo "kubectl is required" >&2
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
  (.deploy.smokeTestCommand | type == "string" and length > 0) and
  (.deploy.timeoutSeconds | type == "number" and . >= 30) and
  (.deploy.rollbackOnFailure | type == "boolean") and
  (.deploy.environments.dev.branch == "dev") and
  (.deploy.environments.dev.namespace | type == "string" and length > 0) and
  (.deploy.environments.dev.deployment | type == "string" and length > 0) and
  (.deploy.environments.dev.manifestsPath | type == "string" and length > 0) and
  (.deploy.environments.qa.branch == "qa") and
  (.deploy.environments.qa.namespace | type == "string" and length > 0) and
  (.deploy.environments.qa.deployment | type == "string" and length > 0) and
  (.deploy.environments.qa.manifestsPath | type == "string" and length > 0) and
  (.deploy.environments.production.branch == "main") and
  (.deploy.environments.production.namespace | type == "string" and length > 0) and
  (.deploy.environments.production.deployment | type == "string" and length > 0) and
  (.deploy.environments.production.manifestsPath | type == "string" and length > 0)
' "${contract_file}" >/dev/null

if [[ -n "${manifests_path}" ]]; then
  test -d "${manifests_path}" || {
    echo "Missing manifests directory: ${manifests_path}" >&2
    exit 1
  }

  test -f "${manifests_path}/kustomization.yaml" || {
    echo "Missing kustomization.yaml: ${manifests_path}" >&2
    exit 1
  }

  rendered_manifests="$(kubectl kustomize "${manifests_path}")" || {
    echo "Unable to render manifests: ${manifests_path}" >&2
    exit 1
  }

  if ! grep -Fq "__PLATFORM_IMAGE__" <<< "${rendered_manifests}"; then
    echo "Manifest path must contain __PLATFORM_IMAGE__: ${manifests_path}" >&2
    exit 1
  fi
fi

echo "Platform contract is valid: ${contract_file}"
