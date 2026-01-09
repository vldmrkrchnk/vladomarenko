#!/bin/bash

# Fetch logs from GCS to local project
# Reads GCP_STORAGE_BUCKET from .env

set -e

# Load .env variables
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "$GCP_STORAGE_BUCKET" ]; then
  echo "❌ Error: GCP_STORAGE_BUCKET is not set in .env"
  exit 1
fi

echo "📥 Fetching logs from gs://$GCP_STORAGE_BUCKET/logs/..."

# Check if gsutil is available
if ! command -v gsutil &> /dev/null; then
  echo "❌ Error: gsutil not found. Please install Google Cloud SDK."
  exit 1
fi

# Ensure log files exist locally to avoid errors if they are new
touch grok_requests.log openai_requests.log

# Fetch logs
# Note: This will overwrite local files with the content from GCS. 
# If you want to merge, you'd need a more complex logic, but for "fetching remote logs" 
# overwriting local state with remote state is usually what is expected for a "sync" operation.
# However, to be safe, we will download to a temp dir and append/cat.

TEMP_DIR=$(mktemp -d)
gsutil -m cp "gs://$GCP_STORAGE_BUCKET/logs/*.log" "$TEMP_DIR/" 2>/dev/null || echo "⚠️  No logs found in bucket yet."

# Append remote logs to local files? Or just replace? 
# Current requirement: "get logs file from cloud google to reflect in our file here"
# Let's replace the local content with remote content to ensure they are identical.

if [ -f "$TEMP_DIR/grok_requests.log" ]; then
    cp "$TEMP_DIR/grok_requests.log" ./grok_requests.log
    echo "✅ Updated grok_requests.log"
fi

if [ -f "$TEMP_DIR/openai_requests.log" ]; then
    cp "$TEMP_DIR/openai_requests.log" ./openai_requests.log
    echo "✅ Updated openai_requests.log"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo "🎉 Done."
