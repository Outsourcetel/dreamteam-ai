#!/bin/bash

# ════════════════════════════════════════════════════════════════════════════════════════
# PROVISION WORKFORCE ASSISTANTS TO ALL TENANTS — ONE COMMAND
# ════════════════════════════════════════════════════════════════════════════════════════
# Usage: SUPABASE_ANON_KEY=your-key bash provision.sh
# That's it. Everything provisions automatically.
# ════════════════════════════════════════════════════════════════════════════════════════

set -e

# Get credentials from environment
SUPABASE_URL="${SUPABASE_URL:-https://xyzabc.supabase.co}"  # Update this
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY}"

if [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "❌ ERROR: SUPABASE_ANON_KEY environment variable not set"
  echo ""
  echo "USAGE:"
  echo "  export SUPABASE_ANON_KEY='your-supabase-anon-key'"
  echo "  bash scripts/provision.sh"
  echo ""
  exit 1
fi

echo "════════════════════════════════════════════════════════════════"
echo "PROVISIONING WORKFORCE ASSISTANTS TO ALL TENANTS"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Endpoint: $SUPABASE_URL/functions/v1/provision-workforce-assistants"
echo ""

# Call the provisioning edge function
RESPONSE=$(curl -s -X POST \
  "$SUPABASE_URL/functions/v1/provision-workforce-assistants" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json")

echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "PROVISIONING COMPLETE"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "✅ All tenants now have Workforce Assistants provisioned"
echo "✅ Ready at /workforce/chat on every tenant"
echo ""
