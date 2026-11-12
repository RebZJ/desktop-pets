#!/usr/bin/env python3
"""Build or --check the reproducible, importable Pace starter ZIP. Standard library only."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import wave
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/pets/pace'
OUTPUT = ROOT / 'artifacts/release/Pace-starter.zip'
PROJECT = 'https://github.com/RebZJ/desktop-pets'
STAMP = (2026, 11, 13, 0, 0, 0)
README = f'''# Pace Starter

A remixable starter pet for [Desktop Pets]({PROJECT}).

## Install

Open Desktop Pets, choose **Extensions → Pet packs**, import this ZIP, then
choose **Use pet**. This pack uses `pace-starter`; the built-in `pace` ID is reserved.

The pack includes the twelve original lossless sprite strips with their original
frame counts and timing, plus six original quiet procedural critter earcons.
Sounds play on direct interactions and remain muted during meetings.

## Remix

Unzip the pack, give your remix a unique `id` and `name` in `manifest.json`, and
edit the artwork or sounds. Preserve the horizontal frame geometry declared by
each action. Keep relative asset paths, include an `idle` action, and put
`manifest.json` at the root when re-zipping the contents.

Use PNG/WebP sprites and PCM16 WAV audio. Credit the original artwork and sounds,
link to CC BY 4.0, and identify your changes. See `docs/pet-packs.md` in the source
repository for the full format and limits.

## Attribution

Artwork: Outpaced / Desktop Pets; original source name Velo.
Earcons: Desktop Pets contributors, created with the deterministic original
generator in `scripts/generate-earcons.py`; no sampled or third-party audio.

The media are CC BY 4.0. See `LICENSE.txt` and `ATTRIBUTION.txt`.
'''
LICENSE = f'''Pace Starter media license

The original sprite artwork is credited to Outpaced / Desktop Pets. The six
original procedural earcons are credited to Desktop Pets contributors.

All media in this ZIP are licensed under Creative Commons Attribution 4.0
International (CC BY 4.0).

License: https://creativecommons.org/licenses/by/4.0/
Legal code: https://creativecommons.org/licenses/by/4.0/legalcode.en
Project: {PROJECT}

Retain attribution and the license link, and identify changes when remixing.
Application code is licensed separately; no executable code or model weights
are included in this pet pack.
'''


def assets():
    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    manifest.update(id='pace-starter', name='Pace Starter', attribution=f"{manifest['attribution']} {PROJECT}")
    files = {'manifest.json': (json.dumps(manifest, indent=2) + '\n').encode(),
             'README.md': README.encode(), 'LICENSE.txt': LICENSE.encode(),
             'ATTRIBUTION.txt': (SOURCE / 'ATTRIBUTION.txt').read_bytes()}
    for name in {action['src'] for action in manifest['actions']} | set(manifest['sounds'].values()):
        assert not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
        files[name] = (SOURCE / name).read_bytes()
    return files


def build(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, contents in sorted(files.items()):
            entry = zipfile.ZipInfo(name, STAMP)
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, contents, compresslevel=9)
    return stream.getvalue()


def validate(data, files):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(set(archive.namelist())) == 22
        assert set(archive.namelist()) == set(files)
        assert sum(entry.file_size for entry in archive.infolist()) < 64 * 1024 * 1024
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['version'] == 1 and manifest['id'] == 'pace-starter'
        assert manifest['license'] == 'CC-BY-4.0' and PROJECT in manifest['attribution']
        assert len(manifest['actions']) == 12 and any(action['id'] == 'idle' for action in manifest['actions'])
        for action in manifest['actions']:
            image = archive.read(action['src'])
            assert image[:4] == b'RIFF' and image[8:16] == b'WEBPVP8L'
            bits = int.from_bytes(image[21:25], 'little')
            assert ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1) == (action['frameWidth'] * action['frameCount'], action['frameHeight'])
            assert 1 <= action['fps'] <= 60 and 1 <= action['frameCount'] <= 512
        sounds = set(manifest['sounds'].values())
        assert len(sounds) == 6
        for name in sounds:
            with wave.open(io.BytesIO(archive.read(name)), 'rb') as sound:
                assert (sound.getnchannels(), sound.getsampwidth(), sound.getframerate()) == (1, 2, 24000)
                assert 0 < sound.getnframes() < 24000
        for name, contents in files.items():
            assert archive.read(name) == contents
    assert len(data) < 32 * 1024 * 1024


if __name__ == '__main__':
    if sys.argv[1:] not in ([], ['--check']):
        raise SystemExit('Usage: python3 scripts/package-pet.py [--check]')
    files = assets()
    expected = build(files)
    if sys.argv[1:]:
        actual = OUTPUT.read_bytes()
        assert actual == expected, 'Starter ZIP differs from the reproducible source package'
    else:
        validate(expected, files)
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        temporary = OUTPUT.with_suffix('.zip.tmp')
        temporary.write_bytes(expected)
        temporary.replace(OUTPUT)
    validate(OUTPUT.read_bytes(), files)
    print(f'Validated {OUTPUT.relative_to(ROOT)}: {len(expected):,} bytes, 22 files, 12 actions, 6 earcons.')
    print(f'SHA-256: {hashlib.sha256(expected).hexdigest()}')
