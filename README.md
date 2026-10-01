# Darc

A chrome-less Chromium browser for recording websites, with a built-in 60 fps screen recorder. No tabs, no toolbar, sharp corners. Every scroll is eased with a spring, so footage looks keyframed rather than hand-scrolled.

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
| ⌘E | Record / stop recording |
| ⌥⌘E | Recording window |
| ⌘↩ | Play the page's scroll animation (Esc or scrolling stops it) |
| ⌘K | Set a marker at the current scroll position |
| [ / ] | Less / more cursor smoothing (with Live cursor on) |
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
- The timeline at the top of the right panel lays the moves and holds out in time. The **Cursor** track under it is where you drag out spans for when the recorded pointer is shown (see below); drag a span to move it, its edges to resize, ✕ or ⌫ to remove.
- The options below sit in collapsible sections: **Lines** (each line's position, duration and hold), **Easing** (presets or a custom cubic-bezier, shared by every line) and **Cursor**.
- ⌘Z undoes any edit (new lines, moves, reorders, deletions, timing, easing and cursor spans); ⇧⌘Z redoes.

Animations are saved per page (origin + path).

## Cursor

Tab capture has no pointer in it, so Darc draws one into the footage from where the mouse is over the page. The **Cursor** section of the animation panel has the settings (they apply to every recording):

- **Page's cursor** follows the CSS `cursor` under the mouse: arrow, pointing hand over links, I-beam over text, and image cursors (`cursor: url(...)`) as the page defines them. Pages that hide the cursor to draw their own (`cursor: none`) are left to it, since theirs is already in the capture. **Arrow** always draws the arrow, and **Custom image** draws a PNG/SVG of your own with the hotspot at its top-left corner or center.
- **Smoothing** is how long the drawn pointer takes to settle on the real one, so hand movement reads as deliberate; **Damping** below 1 lets it overshoot a little, above 1 makes it trail. The box under the sliders lets you try the feel.
- **Live** smooths the real pointer, not just the drawn one. A transparent layer over the page takes the mouse, hides the system pointer and draws the smoothed one, and the page is fed that smoothed position as its mouse, so hover effects and animations happen right under the drawn pointer instead of ahead of it. Clicks wait for the pointer to glide to where you clicked, then land there; scrolling goes straight through. It never appears in recordings. With Live on, `[` and `]` step the smoothing down and up (outside text fields), and 0 brings the real pointer back.
- The pointer uses the macOS 26 cursor set (arrow, pointing hand, I-beam over text, resize, zoom, grab and the rest), picked from the page's CSS `cursor`. **Size** 22 is macOS's own size.
- With no spans on the Cursor track, the pointer shows whenever the mouse is over the page. With spans, it shows only inside them while the animation plays, fading in and out at each edge, so it can appear for a hover during a hold and disappear for the scrolls.

## Recording

⌘E starts recording and opens the recording window docked under the browser (it also opens with the animation panel, so output settings can be set first). Press it again (or Stop) to finish.

- Footage is the page only: the window chrome, toasts and the recording window never appear. It's a constant 60 fps at the resolution picked in the dropdown: **native** is the viewport's physical size (2× on Retina, so a 1920×1080 window records 3840×2160), and the other options downscale it in the viewport's aspect ratio. 1× is the sharpest choice for a matching-size video; native above 4K can drop frames while scrolling, and the recording window counts any drops.
- The pointer, if it's on, is drawn on after motion blur so it stays sharp (see Cursor above).
- **Motion blur** (off by default) smears the footage along the direction of scrolling like a camera shutter would, with subtle / normal / strong (45° / 90° / 180°) settings. It's applied only to the recording, never to the live page, and pixels that don't move (sticky headers, fixed UI) stay sharp.
- Encoded in hardware as H.264, or HEVC when the viewport is too large for H.264. Files are standard MP4s, saved to `~/Movies/Darc/` and written to disk as they record, so length is only limited by disk space.
- **Reload page** (on by default) reloads from the top as recording starts, so the page's load animations play again on camera.
- Recording keeps going while you scroll, follow links and navigate. The timeline marks reloads, navigations, page loads and scroll-animation playback.
- **▶ Animation** plays the page's scroll animation from the recording window; the ● Rec button in the animation panel starts a recording.
- Closing the browser mid-recording finishes writing the file first.

`DARC_SMOKE=<url> npm start` records the page for a few seconds and prints the result, for checking the pipeline.
