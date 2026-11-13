"""Read-only checks for the prepared Pace hole animation strips."""

import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(__file__).resolve().parent
reference = Image.open(ROOT / 'artifacts/sprite-review-20261113/idle-reference.png').convert('RGBA')
palette = {pixel[:3] for pixel in reference.get_flattened_data() if pixel[3]}
summary = {'referenceRgbColors': len(palette), 'actions': []}

for name, anchor in [('summon', 7), ('burrow', 0)]:
    source = ROOT / f'public/pets/pace/{name}-v1.webp'
    strip = Image.open(source).convert('RGBA')
    assert strip.size == (2048, 256), (name, strip.size)
    frames = []
    for i in range(8):
        frame = strip.crop((i * 256, 0, (i + 1) * 256, 256))
        prepared = Image.open(WORK / f'frames/{name}-v1-{i}.png').convert('RGBA')
        pixels = list(frame.get_flattened_data())
        assert pixels == list(prepared.get_flattened_data()), (name, i, 'RGBA mismatch')
        assert all(p[3] in (0, 255) for p in pixels), (name, i, 'partial alpha')
        assert all(p[:3] in palette for p in pixels if p[3]), (name, i, 'palette mismatch')
        for y in range(0, 256, 2):
            for x in range(0, 256, 2):
                assert len({frame.getpixel((x + dx, y + dy)) for dy in (0, 1) for dx in (0, 1)}) == 1, (name, i, 'grid')
        bounds = frame.getchannel('A').getbbox()
        assert bounds and bounds[0] > 0 and bounds[1] > 0 and bounds[2] < 256 and bounds[3] < 256, (name, i, 'clipping')
        if i == anchor:
            assert pixels == list(reference.get_flattened_data()), (name, 'idle anchor mismatch')
        frames.append({'index': i, 'bounds': bounds, 'colors': len({p[:3] for p in pixels if p[3]})})
    gif = Image.open(WORK / f'previews/{name}-native-160-8fps.gif')
    durations = []
    for i in range(gif.n_frames):
        gif.seek(i)
        durations.append(gif.info['duration'])
    assert gif.size == (160, 160) and gif.n_frames == 8 and sum(durations) == 1000, (name, 'preview timing')
    summary['actions'].append({'id': name, 'src': source.name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'frameWidth': 256, 'frameHeight': 256, 'frameCount': 8, 'fps': 8, 'decodedRgbaMatchesFrames': True, 'binaryAlpha': True, 'canonicalPaletteOnly': True, 'exactTwoPixelGrid': True, 'noClipping': True, 'canonicalIdleAnchor': anchor, 'previewCycleMilliseconds': sum(durations), 'frames': frames})

summary['review'] = {'imageCalls': 3, 'viewed': ['all 16 final frames at native 160px on cream and dark backgrounds', 'canonical idle and generated standing pose comparison at 256px'], 'limitations': ['Generated in-between facial pixels and head proportions are close derivatives, not pixel-identical to the original.', 'Hole rim varies by one logical pixel in height; its authored motion and the hop were preserved.', 'The GIFs repeat for review; production actions are one-shot.', 'In-app continuous playback and runtime integration are owned by the parent task.']}
(WORK / 'qa-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('Verified 16 frames: exact RGBA, canonical palette, binary alpha, 2px grid, no clipping, exact idle anchors, 8-frame/1-second previews.')
