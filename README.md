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
| ⌘↩ | Play the page's cursor path, or its scroll animation (Esc or scrolling stops it) |
| ⌘K | Set a marker at the current scroll position |
| ⇧⌘E | Capture a cursor path / stop capturing |
| ⌘P | Edit the page's cursor path |
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

## Cursor paths

A cursor path is a mouse movement you perform once, tidy up, and then replay exactly while recording.

- **⇧⌘E** starts capturing. Move, scroll and click through the page, then press ⇧⌘E again. Capturing also stops by itself when the page changes (a link, a reload, or a single-page app changing its path), so each page gets its own path. The click that leaves the page is kept as the path's last point.
- The path is fitted into Bézier curves with a few anchor points, like a pen-tool path. It sits in the viewport, the fixed box the recording sees. Scrolling is a separate track on the same clock, so editing the path never changes the scroll.
- **⌘P** opens the path over the page. Clicking or dragging along the path (or the timeline at the bottom, or the scroll wheel) scrubs it, and the page scrolls to where it was at that moment, with the pointer hovering where it was.
  - Drag an anchor to move it, or drag its handles to bend the curve. The opposite handle stays in line unless you hold ⌥. ⌥-drag an anchor to pull out new handles.
  - Double-click the path to add an anchor. ⌫ removes the selected one. Tab steps through the anchors.
  - Numbered red rings are clicks. **Click** (or C) adds or removes a click at the selected anchor.
  - **Pause** adds a wait at the selected anchor, and the scroll waits too. **Move** sets how long the move to the next anchor takes. The ease can stay **As recorded**, or be set to ease in-out, ease out or linear.
  - Space previews from the playhead. ⌘Z / ⇧⌘Z undo and redo. **Delete** (pressed twice) removes the path. Esc or **Done** closes the editor.
- **Starts** sets when the path plays. With **Right away**, it plays as soon as play is pressed. With **At line N**, the page's scroll animation (⌘.) plays first, and when its move to that line ends, it waits while the path plays. Then it carries on from wherever the path left the page: the rest of the line's hold, then the next move. Use this for a path deep in the page: let a line bring the page there, then the path takes over. If the page isn't where the path begins when it starts, it glides there first instead of jumping.
- A page with a path plays it with its scroll animation as above, instead of the animation alone: ⌘↩, space, ▶ Animation, and **Play animation** when recording starts. While a path plays, the page gets its pointer, clicks and scroll, and the real mouse is kept out. If the path's last click leads to another page that has a path, that page's path plays once it loads, so one recording can click through a whole flow.
- Paths are saved per page (origin + path), along with the viewport size they were captured at. You'll get a warning if the window is a different size now.

## Cursor

Tab capture has no pointer in it, so Darc draws one into the footage from where the mouse is over the page. It's added when a recording is saved from the editor (see below), which can change it per video; the **Cursor** section of the animation panel sets the defaults each recording starts with:

- **Page's cursor** follows the CSS `cursor` under the mouse: arrow, pointing hand over links, I-beam over text, and image cursors (`cursor: url(...)`) as the page defines them. Pages that hide the cursor to draw their own (`cursor: none`) are left to it, since theirs is already in the capture. **Arrow** always draws the arrow, and **Custom image** draws a PNG/SVG of your own with the hotspot at its top-left corner or center.
- **Smoothing** is how long the drawn pointer takes to settle on the real one, so hand movement reads as deliberate; **Damping** below 1 lets it overshoot a little, above 1 makes it trail. The box under the sliders lets you try the feel.
- **Live** smooths the real pointer, not just the drawn one. A transparent layer over the page takes the mouse, hides the system pointer and draws the smoothed one, and the page is fed that smoothed position as its mouse, so hover effects and animations happen right under the drawn pointer instead of ahead of it. Clicks wait for the pointer to glide to where you clicked, then land there; scrolling goes straight through. It never appears in recordings. With Live on, `[` and `]` step the smoothing down and up (outside text fields), and 0 brings the real pointer back.
- The pointer uses the macOS 26 cursor set (arrow, pointing hand, I-beam over text, resize, zoom, grab and the rest), picked from the page's CSS `cursor`. **Size** 22 is macOS's own size.
- With no spans on the Cursor track, the pointer shows whenever the mouse is over the page. With spans, it shows only inside them while the animation plays, fading in and out at each edge, so it can appear for a hover during a hold and disappear for the scrolls.

## Recording

⌘E starts recording and opens the recording window docked under the browser (it also opens with the animation panel, so output settings can be set first). Press it again (or Stop) to finish.

- Footage is the page only: the window chrome, toasts and the recording window never appear. It's a constant 60 fps at the resolution picked in the dropdown: **native** is the viewport's physical size (2× on Retina, so a 1920×1080 window records 3840×2160), and the other options downscale it in the viewport's aspect ratio. 1× is the sharpest choice for a matching-size video; native above 4K can drop frames while scrolling, and the recording window counts any drops.
- The pointer isn't in the recording itself: Darc logs where the mouse was, and the editor draws it on after motion blur, so it stays sharp and can still be changed (see Cursor above).
- **Motion blur** (off by default) smears the footage along the direction of scrolling like a camera shutter would, with subtle / normal / strong (45° / 90° / 180°) settings. It's applied only to the recording, never to the live page, and pixels that don't move (sticky headers, fixed UI) stay sharp.
- Encoded in hardware as H.264, or HEVC when the viewport is too large for H.264. Recordings are written to disk as they record (to `~/Movies/Darc/Unsaved/` until they're saved from the editor), so length is only limited by disk space.
- **Reload page** (on by default) reloads from the top as recording starts, so the page's load animations play again on camera.
- **Play animation** plays the page's scroll animation as recording starts: 0.25 s after the reloaded page loads, or straight away without a reload. Pressing space (or ⌘↩) while the reload is still under way also waits for the page to load before playing.
- Recording keeps going while you scroll, follow links and navigate. The timeline marks reloads, navigations, page loads and scroll-animation playback.
- **▶ Animation** plays the page's scroll animation from the recording window; the ● Rec button in the animation panel starts a recording.
- **Discard** throws a take away: while recording it stops without keeping anything, and while saving it cancels the save and deletes the file.
- Closing the browser mid-recording finishes writing the file first and keeps it in Unsaved.

## Editor

Stopping a recording opens it in the editor instead of saving it straight away. Nothing lands in `~/Movies/Darc/` until you press **Save** (⌘S).

- The video plays with the cursor drawn over it, exactly as it will be saved. Space plays the kept part, ← / → step a frame (⇧ for a second), and clicking or dragging the ruler or Video track scrubs.
- **Cursor**: change its style (page's cursor, arrow, custom image or off), size, smoothing and damping for this video. The Cursor track shows when it's visible, starting out as when it would have shown while recording; drag on the track to add a span, drag a span to move it or its edges to resize it, ⌫ to remove one. **As recorded / Always / Never** reset the spans.
- **Trim**: drag the yellow handles on the Video track, type the start and end, or press I and O to start or end at the playhead.
- ⌘Z / ⇧⌘Z undo and redo any edit. Edits are kept with the recording, so one kept for later reopens as it was left.
- **Save** re-encodes the kept part with the cursor drawn on, to `~/Movies/Darc/` under the recording's name (saving again replaces it). With the cursor hidden throughout and nothing trimmed, the recording is copied as it is instead. **Discard** throws the recording away (press it twice).
- Closing the editor without saving asks whether to discard the recording or keep it in Unsaved; **Record › Open Recording…** (⌘O) opens it again later, and also opens other MP4s for trimming. **Record › Edit Last Recording** brings back the last one.

`DARC_SMOKE=<url> npm start` records the page for a few seconds and prints the result, for checking the pipeline. Add `DARC_SMOKE_EDIT=1` to carry on into the editor, with `DARC_SMOKE_EDIT_JS` (run in it), `DARC_SMOKE_EDIT_SHOT=<png>` (screenshot it) and `DARC_SMOKE_EXPORT=1` (save the video).
