#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/pace-bridge-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
# The native bridge has no MLX dependency, so run its fixtures without compiling model kernels.
sed '/^@testable import PaceNative$/d' "$project_root/native/PaceNative/Tests/PaceNativeTests/BridgeTests.swift" > "$test_dir/BridgeTests.swift"
cat > "$test_dir/main.swift" <<'SWIFT'
import XCTest
let suite = BridgeTests.defaultTestSuite
suite.run()
guard let result = suite.testRun, result.executionCount >= 8, result.hasSucceeded else { exit(1) }
SWIFT
frameworks="$(xcode-select -p)/Platforms/MacOSX.platform/Developer/Library/Frameworks"
swift_support="$(xcode-select -p)/Platforms/MacOSX.platform/Developer/usr/lib"
swiftc -swift-version 5 -F "$frameworks" -I "$swift_support" -L "$swift_support" -lXCTestSwiftSupport \
    -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$swift_support" \
    "$project_root/native/PaceNative/Sources/PaceNative/Bridge.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Meetings.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Diarization.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Models.swift" \
    "$test_dir/BridgeTests.swift" "$test_dir/main.swift" -o "$test_dir/bridge-tests"
"$test_dir/bridge-tests"
