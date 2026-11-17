# Brand assets

The Partita logo is a Baroque letter P in gold on dark walnut.

- `source-logo.webp`: the original artwork everything below is made from.
- `icon-1024.png`: the app icon at full size.
- `mark-gold.png`, `mark-walnut.png`, `mark-parchment.png`: the letter alone on a transparent background, for dark, light and walnut backgrounds.

Colours: ink `#2B2118`, walnut `#6B4226`, parchment `#F4ECDD`, gold `#F1D49A` to `#C8954A`.

`make-icons.mjs` rebuilds the marks, the app icons and the Windows `.ico` (16 to 256 px) from the source artwork. It needs [sharp](https://sharp.pixelplumbing.com/), so run it from a folder where sharp is installed (for example the website's):

```
node make-icons.mjs source-logo.webp out
```

Then copy `out/32x32.png`, `out/128x128.png`, `out/icon.png` and `out/icon.ico` to `src-tauri/icons/`, and `out/128x128.png` to `src/app-icon.png`.
