#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "$#" -ne 1 ]; then echo 'Usage: native/scripts/test-diarization.sh /absolute/path/to/multi-speaker.wav' >&2; exit 1; fi
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/pace-diarization-test.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
cat > "$test_dir/Check.swift" <<'SWIFT'
import Foundation
@main enum Check {
    static func main() async throws {
        let result = try await BridgeService.handle(method: "audio.diarize", params: ["path": CommandLine.arguments[1]], emit: { _ in })
        guard let result, let segments = result["segments"] as? [[String: Any]], !segments.isEmpty,
              let speakerCount = result["speakerCount"] as? Int, speakerCount >= 2 else {
            throw BridgeError("fixture_failed", "The multi-speaker fixture did not produce at least two speakers.")
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
}
SWIFT
swiftc -swift-version 5 -parse-as-library \
    "$project_root/native/PaceNative/Sources/PaceNative/Bridge.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Meetings.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Diarization.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Models.swift" \
    "$test_dir/Check.swift" -o "$test_dir/diarization-check"
PACE_BIN_DIR="$project_root/native/bin" "$test_dir/diarization-check" "$1"
