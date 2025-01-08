#!/bin/zsh

# Exit on error
set -e

echo "🚀 Starting RSM VS Code extension publishing process..."

# Check if AZURE_PAT is set
if [[ -z "${AZURE_PAT}" ]]; then
    echo "❌ AZURE_PAT environment variable is not set!"
    echo "Please set it with: export AZURE_PAT=your_pat_here"
    exit 1
fi

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "❌ vsce is not installed. Installing globally..."
    npm install -g @vscode/vsce
fi

rm -f rsm-vscode-*.vsix
rm -rf package-lock.json
rm -rf .vscode
npm run package

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
VSIX_FILE="rsm-vscode-${VERSION}.vsix"

# Check if already logged in by attempting a no-op command
if ! vsce ls-publishers 2>/dev/null | grep -q "vnijs"; then
    echo "🔑 Logging in to Azure DevOps..."
    # Create a temporary file for the PAT
    PAT_FILE=$(mktemp)
    echo "${AZURE_PAT}" > "${PAT_FILE}"
    vsce login vnijs < "${PAT_FILE}"
    rm "${PAT_FILE}"
else
    echo "✅ Already logged in as vnijs"
fi

echo "📦 Creating package..."
vsce package

echo "🔍 Verifying package..."
if [[ ! -f "${VSIX_FILE}" ]]; then
    echo "❌ Package creation failed! Could not find ${VSIX_FILE}"
    exit 1
fi

echo "📤 Publishing to marketplace..."
vsce publish

echo "✅ Publishing process completed!"
echo "� VSIX package is available at: ${VSIX_FILE}"
echo "ℹ️  You can install it directly in VS Code or distribute it manually"
echo "ℹ️  To clean up the VSIX file later, run: rm -f ${VSIX_FILE}"

# No automatic cleanup - keep the VSIX file for verification
echo "🎉 Done! Extension has been published to the marketplace!" 