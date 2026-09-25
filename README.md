# Darc

A chrome-less Chromium browser for recording websites. No tabs, no toolbar, sharp corners. Every scroll is eased with a spring, so footage looks keyframed rather than hand-scrolled.

```sh
npm install
npm start        # run from source
npm run dist     # build dist/Darc-<version>.dmg (universal: Apple Silicon + Intel)
```

## Installing

Download `Darc-<version>.dmg` from [Releases](https://github.com/rahulzmiah/Narc/releases), open it, and drag Darc into Applications.

The app is ad-hoc signed, not notarized, so the first launch is blocked. Open **System Settings → Privacy & Security** and click **Open Anyway**. You can also run `xattr -dr com.apple.quarantine /Applications/Darc.app` once.

## Releasing

Bump `version` in `package.json`, commit, then:

```sh
git tag v<version> && git push origin main --tags
gh release create v<version> dist/Darc-<version>.dmg --generate-notes
```

| Shortcut | Action |
| --- | --- |
| ⌘L | URL bar (paste a URL or search terms) |
| ⌘, | Scroll settings |
| ⌘. | Animation panel |
| ⌘↩ | Play the page's scroll animation (Esc or scrolling stops it) |
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

## Scroll animations

⌘. opens the animation panel in its own window, showing a full-length capture of the current page.

- Click the preview to drop a numbered line. Each line is the top of the frame the page scrolls to. Drag lines to move them, or type exact pixel values.
- Playback starts from wherever the page currently is and eases to each line in order. Drag the ⋮⋮ handle on a line's card to reorder.
- Each move has its own duration, easing (presets or a custom cubic-bezier), and a hold before the next move, all in seconds.
- **Play** (or space in the panel, or ⌘↩ anywhere) runs it in the main window immediately. **Refresh** recaptures the page after it changes.

Animations are saved per page (origin + path).
