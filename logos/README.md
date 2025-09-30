# Logo Conversion Guide

## Converting SVG to PNG with ImageMagick

Use ImageMagick to convert SVG logos to PNG format while preserving transparency.

### Examples

Convert a single logo:

```bash
magick -background none logo-clear-background-with-text.svg logo-clear-background-with-text.png
```

### Batch Conversion

Convert all SVG files in the current directory:

```bash
for file in *.svg; do
  magick -background none "$file" "${file%.svg}.png"
done
```

### Background Options

- `-background none`: Preserves transparency (creates transparent PNG)
- `-background black`: Sets black background for non-transparent PNG

### Examples with Different Backgrounds

```bash
# Transparent background
magick -background none logo.svg logo-transparent.png

# Black background
magick -background black logo.svg logo-black.png
```

## Requirements

- ImageMagick must be installed (`brew install imagemagick` on macOS)
