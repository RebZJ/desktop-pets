#!/usr/bin/env python3
"""Check that the native iSTFT optimization preserves seeded model waveforms."""
from array import array
import json
import math
from pathlib import Path
import struct
import sys


def samples(path):
    data = path.read_bytes()
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE', path
    cursor = 12
    chunks = {}
    while cursor + 8 <= len(data):
        name, size = struct.unpack_from('<4sI', data, cursor)
        chunks[name] = data[cursor + 8:cursor + 8 + size]
        cursor += 8 + size + size % 2
    fmt = chunks[b'fmt ']
    encoding, channels, rate = struct.unpack_from('<HHI', fmt)
    assert channels == 1 and rate == 24000 and struct.unpack_from('<H', fmt, 14)[0] == 32
    assert encoding == 3 or (encoding == 65534 and struct.unpack_from('<H', fmt, 24)[0] == 3)
    result = array('f')
    result.frombytes(chunks[b'data'])
    if sys.byteorder != 'little':
        result.byteswap()
    assert result and all(math.isfinite(value) for value in result)
    return result


def main():
    baseline, optimized = map(Path, sys.argv[1:])
    results = []
    for index in range(2):
        left = samples(baseline / f'greeting-{index}.wav')
        right = samples(optimized / f'greeting-{index}.wav')
        assert len(left) == len(right), (len(left), len(right))
        differences = [abs(a - b) for a, b in zip(left, right)]
        maximum = max(differences)
        rmse = math.sqrt(sum(value * value for value in differences) / len(differences))
        assert maximum <= 1e-6, (index, maximum, rmse)
        results.append({'round': index, 'frames': len(left), 'maxAbsoluteSampleError': maximum, 'rmse': rmse})
    print(json.dumps(results, indent=2))
    (optimized.parent / 'waveform-comparison.json').write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
