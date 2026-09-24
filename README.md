# Narc

A chrome-less Chromium browser for recording websites. No tabs, no toolbar, sharp corners. Every scroll is eased with a spring, so footage looks keyframed rather than hand-scrolled.

```sh
npm install
npm start
```

| Shortcut | Action |
| --- | --- |
| ⌘L | URL bar (paste a URL or search terms) |
| ⌘, | Scroll settings |
| Esc | Close the overlay |
| ⌘R / ⇧⌘R | Reload / hard reload |
| ⌘[ / ⌘] | Back / forward |
| ⌘1 / ⌘2 / ⌘3 | Resize to 16:9: 1280×720 / 1600×900 / 1920×1080 (centered) |
| ⌘4 / ⌘5 / ⌘6 / ⌘7 | Resize to 16:10: 1280×800 / 1440×900 / 1680×1050 / 1920×1200 (centered) |
| ⌘= / ⌘- / ⌘0 | Page zoom |
| ⌃⌘F | Fullscreen |

To move the window, open an overlay and drag along the top edge.

## Scrolling

Wheel, trackpad, arrow, space, PageUp/PageDown, and Home/End scrolling all run through one animator (`src/page-preload.js`):

- **Ease in-out** uses a critically damped spring. Motion starts gently, glides, and settles, and it never jolts when new input arrives mid-scroll.
- **Ease out** uses exponential decay. It responds instantly and eases to a stop.
- **Smoothness** sets roughly how long a scroll takes to settle.
- **Speed limit** caps the velocity so fast flicks still read cleanly on video.

Mouse wheel and trackpad have separate speed multipliers. Pages that already use their own smooth-scroll library (Lenis, Locomotive) are left alone, as are wheel events the page itself handles (maps, carousels).
