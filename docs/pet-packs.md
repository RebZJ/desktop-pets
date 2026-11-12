# Make a desktop pet

A pack is a ZIP with `manifest.json` at its root and horizontal PNG/WebP sprite strips. No executable code is loaded from a pack. Open **Extensions → Pet packs**, import the ZIP, then choose **Use pet**.

```json
{
  "version": 1,
  "id": "my-little-pet",
  "name": "My Little Pet",
  "license": "CC-BY-4.0",
  "attribution": "Artwork by your name",
  "sounds": { "happy": "sounds/chirp.wav" },
  "actions": [
    { "id": "idle", "src": "idle.webp", "frameWidth": 256, "frameHeight": 256, "frameCount": 8, "fps": 12 }
  ]
}
```

`idle` is required. Other supported action names are `wave`, `think`, `type`, `create`, `review`, `schedule`, `sprint`, `celebrate`, `sleep`, `happy` and `annoyed`. Missing actions fall back to idle. Frames run left to right and share dimensions within one strip. Preserve a consistent floor position so the pet does not jump between actions.

Use a unique id containing letters, numbers, hyphens or underscores. The built-in id `pace` is reserved. Each action supports 1–512 frames, 1–60 fps and frame dimensions up to 2048 px, with a 16-million-pixel decoded strip limit. Packs are limited to 128 files, 32 MB compressed and 64 MB extracted. Absolute paths, parent traversal, symbolic links, internally animated images and executable files are rejected. Packs can include JSON, PNG, WebP, WAV and plain text license/README files.

Optional sounds map action names to relative WAV paths. Use PCM16 mono/stereo, 8–48 kHz, up to three seconds per clip. Sounds play for direct pet interactions and stay muted during meetings. Plain text license and README files can also be included.

The included Pace manifest is a complete example, with six original quiet earcons. Credit Outpaced / Desktop Pets and CC BY 4.0 when remixing that artwork and sound pack.
