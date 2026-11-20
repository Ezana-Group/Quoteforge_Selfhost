# App Icons

Place your icon files here. These are required for:

| File | Used by | Size |
|---|---|---|
| `icon.icns` | macOS desktop app (Electron `.dmg`) | Multi-resolution bundle |
| `icon.ico` | Windows desktop app (Electron `.exe`) | Multi-resolution bundle |
| `icon-192.png` | PWA (Chrome "Install app" prompt) | 192 × 192 px |
| `icon-512.png` | PWA splash screen, app store listings | 512 × 512 px |
| `icon.png` | General fallback | 512 × 512 px |

## Generating the files

Start with a single high-resolution source (1024 × 1024 PNG, transparent background).

**macOS `.icns`** (run on a Mac):
```bash
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
cp icon.png            icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
```

**Windows `.ico`** (uses ImageMagick):
```bash
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

**PWA PNGs:**
```bash
sips -z 192 192 icon.png --out icon-192.png
sips -z 512 512 icon.png --out icon-512.png
```

## Enabling icons in the Electron build

Once you have the files, uncomment the `icon:` line in `electron/main.js`:

```js
icon: path.join(__dirname, '..', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.icns'),
```

And the `icon` fields in the `build` section of `package.json`:

```json
"mac": { "icon": "icons/icon.icns" },
"win": { "icon": "icons/icon.ico" }
```
