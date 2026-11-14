#!/usr/bin/env bash
# One-time Google Cloud setup for the "Chrome Web Store" job of .github/workflows/release.yml.
#
# It creates a service account that the Chrome Web Store API accepts, and lets the release workflow
# of one GitHub repository sign in as that account through workload identity federation. No key
# file, password or token is created, so there is nothing secret to store in GitHub.
#
#   scripts/setup-store-upload.sh <google-cloud-project-id> <github-owner/repository>
#
# Needs gcloud, signed in with a Google account that may create projects. The quickest place to
# run it is Cloud Shell (https://shell.cloud.google.com), where gcloud is already signed in.
# Safe to run again: everything that already exists is left as it is.
set -euo pipefail

PROJECT_ID=${1:?Usage: setup-store-upload.sh <google-cloud-project-id> <github-owner/repository>}
REPOSITORY=${2:?Usage: setup-store-upload.sh <google-cloud-project-id> <github-owner/repository>}

ACCOUNT_NAME=chrome-web-store-upload
ACCOUNT_EMAIL="$ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com"
POOL=github-actions
PROVIDER=release-workflow

# The numeric id stays the same when a repository is renamed, and a repository created later under
# the same name gets a different one, so access is tied to it and not to the name.
REPOSITORY_ID=$(curl -fsSL "https://api.github.com/repos/$REPOSITORY" | sed -n 's/^  "id": \([0-9]*\),$/\1/p' | head -n 1)
if [ -z "$REPOSITORY_ID" ]; then
  echo "Could not read the id of github.com/$REPOSITORY (is the name right, and the repository public?)" >&2
  exit 1
fi

exists() { "$@" >/dev/null 2>&1; }

# Rights on a project or account created a moment ago take up to a minute to reach every service,
# so a refused step is tried again before giving up.
retry() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    "$@" && return
    echo "Not ready yet, trying again in 10 seconds..." >&2
    sleep 10
  done
  "$@"
}

echo "1/5 Project $PROJECT_ID"
exists gcloud projects describe "$PROJECT_ID" ||
  gcloud projects create "$PROJECT_ID" --name="Perde - Store Upload"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo "2/5 APIs"
gcloud services enable --project="$PROJECT_ID" \
  chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

echo "3/5 Service account $ACCOUNT_EMAIL"
exists gcloud iam service-accounts describe "$ACCOUNT_EMAIL" --project="$PROJECT_ID" ||
  gcloud iam service-accounts create "$ACCOUNT_NAME" --project="$PROJECT_ID" \
    --display-name="Chrome Web Store - Upload" \
    --description="Uploads release packages of github.com/$REPOSITORY to the Chrome Web Store"

echo "4/5 Sign-in for GitHub Actions"
exists gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT_ID" --location=global ||
  retry gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" --location=global \
    --display-name="GitHub - Actions"
exists gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" ||
  retry gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
    --display-name="GitHub - Release Workflow" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id" \
    --attribute-condition="assertion.repository_id == '$REPOSITORY_ID'"

echo "5/5 Let that repository act as the service account"
MEMBER="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository_id/$REPOSITORY_ID"
retry gcloud iam service-accounts add-iam-policy-binding "$ACCOUNT_EMAIL" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser --member="$MEMBER" >/dev/null

cat <<EOF

Done. Two steps are left, both outside Google Cloud:

1. Chrome Web Store Developer Dashboard > Account: add this address as the service account.

     $ACCOUNT_EMAIL

2. GitHub repository > Settings > Secrets and variables > Actions > Variables (these are not
   secrets), or with the GitHub CLI:

     gh variable set CWS_SERVICE_ACCOUNT --repo $REPOSITORY --body "$ACCOUNT_EMAIL"
     gh variable set CWS_WORKLOAD_IDENTITY_PROVIDER --repo $REPOSITORY --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

   CWS_PUBLISHER_ID and CWS_EXTENSION_ID come from the Developer Dashboard (see the README).
EOF
