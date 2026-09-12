#!/bin/bash
echo "Building Compelem DevTools..."

# Clean dist
rm -rf dist
mkdir -p dist

# Build with vite
npx vite build

# Copy static files
echo "Copying static files..."
cp manifest.json dist/manifest.json
cp -r public dist/public
cp -r src/panel/styles dist/panel/styles
cp src/panel/index.html dist/panel/index.html
cp src/devtools/index.html dist/devtools/index.html

echo "Build complete!"
