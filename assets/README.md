# Assets

Place your app icons here before building:

| File | Used for |
|------|----------|
| `icon.icns` | macOS DMG / app bundle |
| `icon.ico` | Windows NSIS installer |
| `icon.png` | Linux AppImage / .deb (512×512 recommended) |

electron-builder looks for `assets/icon` (no extension) and picks
the right format per platform automatically.

## Quick icon generation

If you have a 1024×1024 PNG source image, you can generate all formats with:

```bash
# macOS (requires Xcode command-line tools)
iconutil -c icns icon.iconset   # after generating the iconset folder

# Cross-platform via electron-icon-builder
npx electron-icon-builder --input=icon-source.png --output=assets/
```
