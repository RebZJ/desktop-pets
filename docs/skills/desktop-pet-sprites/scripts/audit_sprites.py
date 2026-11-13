#!/usr/bin/env python3
"""Read-only sprite-strip geometry and style audit. Requires Pillow."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from PIL import Image


def metrics(pixels, width, height, grid, palette):
    colors = Counter(pixels)
    visible = sum(n for rgba, n in colors.items() if rgba[3])
    partial = sum(n for rgba, n in colors.items() if 0 < rgba[3] < 255)
    foreground = [(i % width, i // width) for i, rgba in enumerate(pixels) if rgba[3] >= 128]
    bounds = None
    if foreground:
        xs, ys = zip(*foreground)
        bounds = [min(xs), min(ys), max(xs) + 1, max(ys) + 1]
    edge_count = [Counter(), Counter()]
    for y in range(height):
        for x in range(width):
            p = pixels[y * width + x]
            for axis, prior, coordinate in ((0, y * width + x - 1, x), (1, (y - 1) * width + x, y)):
                if coordinate and p != pixels[prior] and max(p[3], pixels[prior][3]) >= 128:
                    edge_count[axis][coordinate % grid] += 1
    foreground_colors = Counter()
    for rgba, count in colors.items():
        if rgba[3] >= 128:
            foreground_colors[rgba[:3]] += count
    nearest_distance = 0
    foreground_count = sum(foreground_colors.values())
    if palette and foreground_count:
        nearest_distance = sum(
            count * min(sum(abs(c[i] - p[i]) for i in range(3)) / 3 for p in palette)
            for c, count in foreground_colors.items()
        ) / foreground_count
    return {
        "bboxAlpha128": bounds,
        "floorRatio": bounds[3] / height if bounds else None,
        "visiblePixels": visible,
        "partialAlphaPixels": partial,
        "partialAlphaPercent": round(100 * partial / visible, 5) if visible else 0,
        "foregroundRgbColors": len(foreground_colors),
        "dominantColors": [{"rgb": list(c), "pixels": n} for c, n in foreground_colors.most_common(6)],
        "paletteMeanChannelDistance": round(nearest_distance, 4) if palette else None,
        "gridPixels": grid,
        "gridAlignment": [
            {"bestPhase": counts.most_common(1)[0][0] if counts else 0,
             "alignedFraction": round(max(counts.values(), default=0) / sum(counts.values()), 6) if counts else 1,
             "edgeCountByPhase": dict(counts)}
            for counts in edge_count
        ],
    }


def self_test():
    clear = (0, 0, 0, 0)
    gold = (249, 168, 12, 255)
    pixels = [clear] * 16
    for index in (10, 11, 14, 15):
        pixels[index] = gold
    report = metrics(pixels, 4, 4, 2, [gold[:3]])
    assert report["bboxAlpha128"] == [2, 2, 4, 4]
    assert report["partialAlphaPixels"] == 0
    assert report["paletteMeanChannelDistance"] == 0
    assert all(axis["alignedFraction"] == 1 and axis["bestPhase"] == 0 for axis in report["gridAlignment"])
    pixels[10] = (249, 168, 12, 150)
    report = metrics(pixels, 4, 4, 2, [gold[:3]])
    assert report["partialAlphaPixels"] == 1
    assert any(axis["alignedFraction"] < 1 for axis in report["gridAlignment"])
    assert metrics([clear] * 4, 2, 2, 2, [])['bboxAlpha128'] is None
    with TemporaryDirectory() as directory:
        root = Path(directory)
        fixture = Image.new("RGBA", (4, 2), clear)
        fixture.putpixel((2, 0), (249, 168, 12, 20))
        fixture.save(root / "fixture.png")
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"actions": [{"id": "test", "src": "fixture.png",
                            "frameWidth": 2, "frameHeight": 2, "frameCount": 2, "fps": 1}]}))
        report = audit(manifest, None, 1, 2)
        assert report["geometryErrors"] == ["test: frame 0 is fully transparent"]


def audit(manifest_path, reference_path, grid, nominal_size, asset_root=None):
    manifest_path = manifest_path.resolve()
    root = asset_root.resolve() if asset_root else manifest_path.parent
    manifest = json.loads(manifest_path.read_text())
    if not isinstance(manifest.get("actions"), list) or not manifest["actions"]:
        raise ValueError("manifest.actions must be a non-empty list")
    palette = []
    if reference_path:
        with Image.open(reference_path) as reference:
            palette = list({p[:3] for p in reference.convert("RGBA").get_flattened_data() if p[3] >= 128})
    report = {"manifest": str(manifest_path), "reference": str(reference_path) if reference_path else None,
              "referenceRgbColors": len(palette), "nominalSize": nominal_size, "actions": [], "geometryErrors": []}
    seen = set()
    for action in manifest["actions"]:
        name = action["id"]
        if not isinstance(name, str) or not name or name in seen:
            raise ValueError("action IDs must be unique non-empty strings")
        seen.add(name)
        width, height, count = (action[key] for key in ("frameWidth", "frameHeight", "frameCount"))
        if any(type(n) is not int or n <= 0 for n in (width, height, count)):
            raise ValueError(f"{name}: positive integer frame dimensions/count required")
        fps = action.get("fps")
        if not isinstance(fps, (int, float)) or isinstance(fps, bool) or fps <= 0:
            raise ValueError(f"{name}: positive fps required")
        source = (root / action["src"]).resolve()
        if not source.is_relative_to(root):
            raise ValueError(f"{name}: src must stay inside manifest directory")
        with Image.open(source) as image:
            image = image.convert("RGBA")
            if image.size != (width * count, height):
                report["geometryErrors"].append(f"{name}: {image.size} != {(width * count, height)}")
                continue
            frame_grid = max(1, round(grid * width / nominal_size))
            frames = []
            for i in range(count):
                frame = image.crop((i * width, 0, (i + 1) * width, height))
                frame_report = metrics(list(frame.get_flattened_data()), width, height, frame_grid, palette)
                if frame_report["visiblePixels"] == 0:
                    report["geometryErrors"].append(f"{name}: frame {i} is fully transparent")
                frame_report["frame"] = i
                frames.append(frame_report)
        report["actions"].append({"id": name, "src": action["src"], "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                                  "frameWidth": width, "frameHeight": height, "fps": fps, "frames": frames})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, nargs="?")
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--asset-root", type=Path)
    parser.add_argument("--grid", type=int, default=1, help="expected source pixel block at nominal size; measure reference first")
    parser.add_argument("--nominal-size", type=int, default=256)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.grid <= 0 or args.nominal_size <= 0:
        parser.error("grid and nominal-size must be positive")
    if args.self_test:
        self_test()
        print("self-test passed")
    if args.manifest:
        report = audit(args.manifest, args.reference, args.grid, args.nominal_size, args.asset_root)
        text = json.dumps(report, indent=2) + "\n"
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(text)
            print(f"Audited {len(report['actions'])} actions; {len(report['geometryErrors'])} geometry errors; {args.out}")
        else:
            print(text, end="")
        return 1 if report["geometryErrors"] else 0
    if not args.self_test:
        parser.error("manifest or --self-test required")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"sprite audit: {error}", file=sys.stderr)
        sys.exit(2)
