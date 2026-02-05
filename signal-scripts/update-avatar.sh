#!/bin/bash

# Signal Bot Avatar Update Script
# Updates the Signal profile picture for a registered bot
#
# Usage: ./update-avatar.sh <phone_number> <image_path>
# Example: ./update-avatar.sh +15734923844 /path/to/avatar.png

set -e

SIGNAL_API_URL="${SIGNAL_API_URL:-http://localhost:8080}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <phone_number> <image_path>"
    echo "Example: $0 +15734923844 /path/to/avatar.png"
    exit 1
fi

PHONE_NUMBER="$1"
IMAGE_PATH="$2"

echo -e "${YELLOW}=== Signal Bot Avatar Update ===${NC}"
echo "Phone Number: $PHONE_NUMBER"
echo "Image Path: $IMAGE_PATH"
echo "API URL: $SIGNAL_API_URL"
echo ""

# Validate image
echo -e "${YELLOW}Step 1: Validating image...${NC}"

if [ ! -f "$IMAGE_PATH" ]; then
    echo -e "${RED}Error: File not found: $IMAGE_PATH${NC}"
    exit 1
fi

FILE_TYPE=$(file -b --mime-type "$IMAGE_PATH")
if [[ ! "$FILE_TYPE" =~ ^image/ ]]; then
    echo -e "${RED}Error: Not an image file (type: $FILE_TYPE)${NC}"
    exit 1
fi

FILE_SIZE=$(stat -c%s "$IMAGE_PATH" 2>/dev/null || stat -f%z "$IMAGE_PATH" 2>/dev/null)
MAX_SIZE=$((5 * 1024 * 1024))

if [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
    echo -e "${RED}Error: Image too large ($(numfmt --to=iec-i --suffix=B $FILE_SIZE 2>/dev/null || echo "${FILE_SIZE} bytes"))${NC}"
    echo "Maximum: 5MB. Resize with: convert $IMAGE_PATH -resize 640x640^ -quality 85 output.jpg"
    exit 1
fi

echo -e "${GREEN}Image OK${NC} (${FILE_TYPE}, $(numfmt --to=iec-i --suffix=B $FILE_SIZE 2>/dev/null || echo "${FILE_SIZE} bytes"))"
echo ""

# Check registration
echo -e "${YELLOW}Step 2: Checking registration...${NC}"
ACCOUNTS=$(curl -s "${SIGNAL_API_URL}/v1/accounts")

if ! echo "$ACCOUNTS" | grep -q "$PHONE_NUMBER"; then
    echo -e "${RED}Error: $PHONE_NUMBER is not registered${NC}"
    echo "Registered accounts:"
    echo "$ACCOUNTS" | jq -r '.[]' 2>/dev/null || echo "$ACCOUNTS"
    exit 1
fi

echo -e "${GREEN}Account found${NC}"
echo ""

# Get current profile name to preserve it
echo -e "${YELLOW}Step 3: Getting current profile name...${NC}"

# Try config.json in parent directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config.json"
ENV_FILE="${SCRIPT_DIR}/../.env"
CURRENT_NAME=""

if [ -f "$ENV_FILE" ] && [ -f "$CONFIG_FILE" ]; then
    source "$ENV_FILE"
    IFS=',' read -ra PHONE_ARRAY <<< "$BOT_PHONE_NUMBERS"

    for i in "${!PHONE_ARRAY[@]}"; do
        CLEAN_PHONE=$(echo "${PHONE_ARRAY[$i]}" | tr -d ' "')
        if [ "$CLEAN_PHONE" = "$PHONE_NUMBER" ]; then
            CURRENT_NAME=$(jq -r ".bots[$i].name // empty" "$CONFIG_FILE" 2>/dev/null)
            break
        fi
    done
fi

if [ -z "$CURRENT_NAME" ]; then
    CURRENT_NAME="Bot"
    echo "Could not determine profile name, using: $CURRENT_NAME"
else
    echo "Profile name: $CURRENT_NAME"
fi
echo ""

# Encode and upload
echo -e "${YELLOW}Step 4: Uploading avatar...${NC}"

BASE64_IMAGE=$(base64 -w 0 "$IMAGE_PATH" 2>/dev/null || base64 "$IMAGE_PATH" | tr -d '\n')

TEMP_JSON=$(mktemp)
trap "rm -f $TEMP_JSON" EXIT

cat > "$TEMP_JSON" <<EOF
{
  "base64_avatar": "$BASE64_IMAGE",
  "name": "$CURRENT_NAME"
}
EOF

RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
    -H "Content-Type: application/json" \
    -d @"$TEMP_JSON" \
    "${SIGNAL_API_URL}/v1/profiles/${PHONE_NUMBER}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ] || [ -z "$BODY" ]; then
    echo -e "${GREEN}Avatar updated successfully${NC}"
else
    echo -e "${RED}Failed to update avatar${NC}"
    echo "HTTP Code: $HTTP_CODE"
    echo "Response: $BODY"
    exit 1
fi

echo ""
echo -e "${GREEN}=== Done ===${NC}"
echo "Phone: $PHONE_NUMBER"
echo "Image: $IMAGE_PATH"
echo "Profile: $CURRENT_NAME"
echo ""
echo "Note: Avatar changes may take a moment to propagate."
