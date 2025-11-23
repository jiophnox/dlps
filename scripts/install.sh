#!/bin/bash

set -e

echo "🚀 Starting installation..."

# Create bin directory
mkdir -p bin

# Install yt-dlp binary
echo "📥 Downloading yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp

echo "✅ yt-dlp installed at: $(pwd)/bin/yt-dlp"

# Verify yt-dlp
if [ -f "bin/yt-dlp" ]; then
    echo "✅ yt-dlp binary found"
    ./bin/yt-dlp --version || echo "⚠️ yt-dlp version check failed"
else
    echo "❌ yt-dlp binary not found!"
    exit 1
fi

# Install Node dependencies
echo "📦 Installing npm packages..."
npm ci --only=production

echo "✅ Installation complete!"
