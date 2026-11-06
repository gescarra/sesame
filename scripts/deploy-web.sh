#!/usr/bin/env bash
# Builds the SPA and publishes it to the site bucket behind CloudFront.
# Usage: scripts/deploy-web.sh [terraform-dir]   (default: infra/examples/single-domain)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tf_dir="${1:-$root/infra/examples/single-domain}"

bucket="$(terraform -chdir="$tf_dir" output -raw site_bucket)"
distribution="$(terraform -chdir="$tf_dir" output -raw distribution_id)"
url="$(terraform -chdir="$tf_dir" output -raw url)"

pnpm --dir "$root" --filter @sesame/web run build
dist="$root/packages/web/dist"

# Hashed assets never change, so browsers and CloudFront may keep them for a year.
# Upload them before index.html so a new shell never points at missing files.
aws s3 sync "$dist/assets" "s3://$bucket/assets" \
  --cache-control "public, max-age=31536000, immutable" --only-show-errors
aws s3 sync "$dist" "s3://$bucket" --exclude "assets/*" \
  --cache-control "no-cache" --only-show-errors

# Old hashed assets are left in place: an edge may serve the previous index.html until the
# invalidation below finishes, and they're small.

aws cloudfront create-invalidation --distribution-id "$distribution" \
  --paths "/index.html" "/" --query 'Invalidation.Id' --output text >/dev/null

echo "Deployed to $url"
