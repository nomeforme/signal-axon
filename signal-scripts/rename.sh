#!/bin/bash

# Signal Bot Profile Rename Script
# Updates the Signal profile name for a registered bot
#
# Usage: ./rename.sh <phone_number> <new_name>
# Example: ./rename.sh +15734923844 "claude-opus-4-6"

set -e

SIGNAL_API_URL="${SIGNAL_API_URL:-http://localhost:8080}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <phone_number> <new_name>"
    echo "Example: $0 +15734923844 \"claude-opus-4-6\""
    exit 1
fi

PHONE_NUMBER="$1"
NEW_NAME="$2"

echo -e "${YELLOW}=== Signal Bot Rename ===${NC}"
echo "Phone Number: $PHONE_NUMBER"
echo "New Name: $NEW_NAME"
echo "API URL: $SIGNAL_API_URL"
echo ""

# Check if registered
echo -e "${YELLOW}Checking registration...${NC}"
ACCOUNTS=$(curl -s "${SIGNAL_API_URL}/v1/accounts")

if ! echo "$ACCOUNTS" | grep -q "$PHONE_NUMBER"; then
    echo -e "${RED}Error: $PHONE_NUMBER is not registered${NC}"
    echo "Registered accounts:"
    echo "$ACCOUNTS" | jq -r '.[]' 2>/dev/null || echo "$ACCOUNTS"
    exit 1
fi

echo -e "${GREEN}Account found${NC}"
echo ""

# Update profile name
echo -e "${YELLOW}Updating profile name...${NC}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$NEW_NAME\"}" \
    "${SIGNAL_API_URL}/v1/profiles/${PHONE_NUMBER}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ] || [ -z "$BODY" ]; then
    echo -e "${GREEN}Profile name updated to: $NEW_NAME${NC}"
else
    echo -e "${RED}Failed to update profile${NC}"
    echo "HTTP Code: $HTTP_CODE"
    echo "Response: $BODY"
    exit 1
fi

echo ""
echo -e "${GREEN}=== Done ===${NC}"
echo "Note: Changes may take a moment to propagate to other Signal clients."
