#!/bin/bash

# Signal Bot Registration Script
# Registers a Twilio phone number with Signal via signal-cli REST API
#
# Usage: ./register.sh <phone_number>
# Example: ./register.sh +15734923844

set -e

SIGNAL_API_URL="${SIGNAL_API_URL:-http://localhost:8080}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <phone_number>"
    echo "Example: $0 +15734923844"
    exit 1
fi

PHONE_NUMBER="$1"

echo -e "${YELLOW}=== Signal Bot Registration ===${NC}"
echo "Phone Number: $PHONE_NUMBER"
echo "API URL: $SIGNAL_API_URL"
echo ""

# Check if signal-cli API is running
echo -e "${YELLOW}Step 1: Checking signal-cli API...${NC}"
if ! curl -s "${SIGNAL_API_URL}/v1/about" > /dev/null 2>&1; then
    echo -e "${RED}Error: signal-cli API is not reachable at ${SIGNAL_API_URL}${NC}"
    exit 1
fi
echo -e "${GREEN}API is running${NC}"
echo ""

# Check if already registered
echo -e "${YELLOW}Step 2: Checking registration status...${NC}"
ACCOUNTS=$(curl -s "${SIGNAL_API_URL}/v1/accounts")

if echo "$ACCOUNTS" | grep -q "$PHONE_NUMBER"; then
    echo -e "${GREEN}This number is already registered!${NC}"
    echo ""
    echo "Registered accounts:"
    echo "$ACCOUNTS" | jq -r '.[]' 2>/dev/null || echo "$ACCOUNTS"
    exit 0
fi

echo "Number is not yet registered."
echo ""

# Get captcha
echo -e "${YELLOW}Step 3: Captcha required${NC}"
echo ""
echo "1. Open: https://signalcaptchas.org/registration/generate.html"
echo "2. Complete the captcha"
echo "3. Right-click 'Open Signal' -> 'Copy Link Address'"
echo "4. Paste the full signalcaptcha:// link below"
echo ""
read -p "Captcha link: " CAPTCHA_LINK

CAPTCHA_TOKEN=$(echo "$CAPTCHA_LINK" | sed 's|signalcaptcha://||')

if [ -z "$CAPTCHA_TOKEN" ]; then
    echo -e "${RED}Error: Invalid captcha link${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}Step 4: Registering...${NC}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"number\":\"$PHONE_NUMBER\", \"use_voice\":false, \"captcha\":\"$CAPTCHA_TOKEN\"}" \
    "${SIGNAL_API_URL}/v1/register/${PHONE_NUMBER}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if echo "$BODY" | grep -q "error"; then
    echo -e "${RED}Registration failed!${NC}"
    echo "Response: $BODY"
    echo ""
    echo "Common issues:"
    echo "  - Captcha expired (they expire quickly)"
    echo "  - Missing signalcaptcha:// prefix"
    exit 1
fi

echo -e "${GREEN}Registration request sent${NC}"
echo ""

# Verification
echo -e "${YELLOW}Step 5: SMS Verification${NC}"
echo ""
echo "Check Twilio SMS logs: https://console.twilio.com/us1/monitor/logs/sms"
echo ""
read -p "Enter 6-digit verification code: " VERIFICATION_CODE

echo ""
echo -e "${YELLOW}Verifying...${NC}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${SIGNAL_API_URL}/v1/register/${PHONE_NUMBER}/verify/${VERIFICATION_CODE}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if echo "$BODY" | grep -q "error"; then
    echo -e "${RED}Verification failed!${NC}"
    echo "Response: $BODY"
    exit 1
fi

echo -e "${GREEN}Verification successful${NC}"
echo ""

# Set profile name
read -p "Enter display name for the bot (or press Enter to skip): " BOT_NAME

if [ -n "$BOT_NAME" ]; then
    curl -s -X PUT -H "Content-Type: application/json" \
        -d "{\"name\":\"$BOT_NAME\"}" \
        "${SIGNAL_API_URL}/v1/profiles/${PHONE_NUMBER}" > /dev/null
    echo -e "${GREEN}Profile name set to: $BOT_NAME${NC}"
fi

echo ""
echo -e "${GREEN}=== Registration complete! ===${NC}"
echo "Phone: $PHONE_NUMBER"
echo ""
echo "Restart signal-axon to pick up the new account."
