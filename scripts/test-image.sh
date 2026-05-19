#!/usr/bin/env bash
# scripts/test-image.sh — interactive test harness for a pre-release
# freeagent-mcp Docker image.
#
# Spins up a fresh temp directory containing:
#   - .mcp.json   (project-scoped MCP config pointing at the image)
#   - CLAUDE.md   (auto-loaded by Claude Code; contains a smoke checklist)
#   - evidence/   (pre-created staging dir with the right ownership)
#
# Then prints `cd <dir> && claude` for you to run. The temp dir is
# self-contained and does not touch your global ~/.claude config.
#
# Credentials are passed through from your shell at launch time
# (bare `-e VAR` flags inherit from Claude Code's environment, which
# inherits from your shell). Nothing is written to disk.
#
# Usage:
#   scripts/test-image.sh                       # latest from Docker Hub
#   scripts/test-image.sh pr-42                 # specific PR build
#   scripts/test-image.sh sha-abc1234           # specific commit
#   scripts/test-image.sh --image fa-dev        # local image (skip Docker Hub prefix)
#   scripts/test-image.sh --image fa-dev --no-staging
#
# Requires the FREEAGENT_* env vars to be exported in your shell.

set -euo pipefail

DEFAULT_REPO="eddgrant/freeagent-mcp"
TAG=""
FULL_IMAGE=""
ENABLE_STAGING=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --image)
            FULL_IMAGE="${2:-}"
            [[ -z "$FULL_IMAGE" ]] && { echo "error: --image requires a value" >&2; exit 2; }
            shift 2
            ;;
        --no-staging)
            ENABLE_STAGING=0
            shift
            ;;
        --help|-h)
            sed -n 's/^# \{0,1\}//p' "$0" | head -30
            exit 0
            ;;
        --*)
            echo "error: unknown flag: $1" >&2
            exit 2
            ;;
        *)
            if [[ -n "$TAG" ]]; then
                echo "error: unexpected argument: $1 (tag already set to $TAG)" >&2
                exit 2
            fi
            TAG="$1"
            shift
            ;;
    esac
done

if [[ -n "$FULL_IMAGE" && -n "$TAG" ]]; then
    echo "error: pass either a tag or --image, not both" >&2
    exit 2
fi

if [[ -n "$FULL_IMAGE" ]]; then
    IMAGE="$FULL_IMAGE"
elif [[ -n "$TAG" ]]; then
    IMAGE="${DEFAULT_REPO}:${TAG}"
else
    IMAGE="${DEFAULT_REPO}:latest"
fi

# ----- env validation -----

missing=()
for var in FREEAGENT_CLIENT_ID FREEAGENT_CLIENT_SECRET FREEAGENT_ACCESS_TOKEN FREEAGENT_REFRESH_TOKEN; do
    [[ -z "${!var:-}" ]] && missing+=("$var")
done

if [[ ${#missing[@]} -gt 0 ]]; then
    cat >&2 <<EOF
error: missing required environment variables:
  ${missing[*]}

Export them in this shell before running, e.g.:
  export FREEAGENT_CLIENT_ID="..."
  export FREEAGENT_CLIENT_SECRET="..."
  export FREEAGENT_ACCESS_TOKEN="..."
  export FREEAGENT_REFRESH_TOKEN="..."

Then re-run this script. Credentials are passed through to the
container via bare \`-e VAR\` flags — they are not written to disk.
EOF
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker not found in PATH" >&2
    exit 1
fi

# ----- workspace -----

WORKDIR="$(mktemp -d -t freeagent-mcp-test.XXXXXX)"
EVIDENCE="$WORKDIR/evidence"
UID_GID="$(id -u):$(id -g)"

if [[ "$ENABLE_STAGING" -eq 1 ]]; then
    mkdir -p "$EVIDENCE"
fi

# ----- .mcp.json -----

# Build the args array as JSON. Two branches: with vs without staging.
# Bare `-e VAR` (no value) means Docker reads the value from Claude
# Code's environment at launch — credentials never touch the filesystem.
if [[ "$ENABLE_STAGING" -eq 1 ]]; then
    ARGS_JSON=$(cat <<JSON
[
        "run", "-i", "--rm",
        "--user", "${UID_GID}",
        "-v", "${EVIDENCE}:${EVIDENCE}",
        "-e", "FREEAGENT_EVIDENCE_BASE=${EVIDENCE}",
        "-e", "FREEAGENT_CLIENT_ID",
        "-e", "FREEAGENT_CLIENT_SECRET",
        "-e", "FREEAGENT_ACCESS_TOKEN",
        "-e", "FREEAGENT_REFRESH_TOKEN",
        "${IMAGE}"
      ]
JSON
)
else
    ARGS_JSON=$(cat <<JSON
[
        "run", "-i", "--rm",
        "--user", "${UID_GID}",
        "-e", "FREEAGENT_CLIENT_ID",
        "-e", "FREEAGENT_CLIENT_SECRET",
        "-e", "FREEAGENT_ACCESS_TOKEN",
        "-e", "FREEAGENT_REFRESH_TOKEN",
        "${IMAGE}"
      ]
JSON
)
fi

cat > "$WORKDIR/.mcp.json" <<JSON
{
  "mcpServers": {
    "freeagent_test": {
      "command": "docker",
      "args": ${ARGS_JSON}
    }
  }
}
JSON

# ----- CLAUDE.md (auto-loaded by Claude Code in this directory) -----

STAGING_LINE=""
if [[ "$ENABLE_STAGING" -eq 1 ]]; then
    STAGING_LINE="The shared evidence volume is mounted at \`${EVIDENCE}\` (same path on host and container). Confirm \`propose_reconciliations\` returns \`staging.ready: true\` when called."
else
    STAGING_LINE="The shared evidence volume is **not** mounted (\`--no-staging\` was passed). \`propose_reconciliations\` should report \`staging.ready: false\`, and \`stage_evidence\` should refuse with \`staging_volume_not_mounted\`. Use this mode to verify the graceful-degradation path."
fi

cat > "$WORKDIR/CLAUDE.md" <<MD
# FreeAgent MCP — Interactive Test

You are testing a pre-release build of the FreeAgent MCP server.

- **Image:** \`${IMAGE}\`
- **Server name in this session:** \`freeagent_test\`
- **Slash command for the reconcile prompt:** \`/mcp__freeagent_test__reconcile\`
- **Staging:** ${STAGING_LINE}

## Try first

- "List my bank accounts and show balances." — basic connectivity check.
- \`/mcp__freeagent_test__reconcile\` — invoke the reconciliation orchestration prompt.
- "Propose reconciliations for the Starling business account for the last 14 days. **Do not apply.**" — read-only exercise.

## Smoke checklist (DO NOT apply to production data)

- [ ] \`tools/list\` shows the new tools: \`propose_reconciliations\`, \`stage_evidence\`, \`apply_reconciliations\`
- [ ] \`/mcp__freeagent_test__reconcile\` prompt body renders and reflects the current staging state
- [ ] \`propose_reconciliations\` on a real account returns proposals with history-seeded categories
- [ ] Recurring proposals (e.g. monthly subscriptions) come back at \`overall_confidence: 1.0\` with a \`recurring\` block
- [ ] \`propose_reconciliations\` response's \`staging\` field matches expectations (ready=$([[ "$ENABLE_STAGING" -eq 1 ]] && echo true || echo false))
$([[ "$ENABLE_STAGING" -eq 1 ]] && echo "- [ ] \`stage_evidence\` with a small valid PDF returns \`ok: true\` and a path under the staging dir
- [ ] \`stage_evidence\` with a content-type/byte mismatch returns \`ok: false, error.code: magic_byte_mismatch\`")
- [ ] If a sandbox account is available: end-to-end \`apply_reconciliations\` with one explanation, then re-apply the same payload and confirm \`duplicate_of_existing_explanation\`

## Cleanup

This directory is at \`${WORKDIR}\`. The Docker container is \`--rm\`, so nothing persists outside this directory.

\`\`\`
rm -rf "${WORKDIR}"
\`\`\`
MD

# ----- summary -----

cat <<EOF

✓ Created test directory: ${WORKDIR}
✓ MCP config:             ${WORKDIR}/.mcp.json
✓ Server name in session: freeagent_test
✓ Slash command:          /mcp__freeagent_test__reconcile
EOF

if [[ "$ENABLE_STAGING" -eq 1 ]]; then
    echo "✓ Evidence staging:       ${EVIDENCE}"
else
    echo "✓ Evidence staging:       disabled (--no-staging)"
fi

cat <<EOF
✓ Image:                  ${IMAGE}

To start testing:
  cd "${WORKDIR}" && claude

To clean up afterwards:
  rm -rf "${WORKDIR}"
EOF
