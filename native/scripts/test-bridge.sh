#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/pace-bridge-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
# The native bridge has no MLX dependency, so run its fixtures without compiling model kernels.
sed '/^@testable import PaceNative$/d' "$project_root/native/PaceNative/Tests/PaceNativeTests/BridgeTests.swift" > "$test_dir/BridgeTests.swift"
sed '/^@testable import PaceNative$/d' "$project_root/native/PaceNative/Tests/PaceNativeTests/DictationTests.swift" > "$test_dir/DictationTests.swift"
sed '/^@testable import PaceNative$/d' "$project_root/native/PaceNative/Tests/PaceNativeTests/RequestTasksTests.swift" > "$test_dir/RequestTasksTests.swift"
cat > "$test_dir/main.swift" <<'SWIFT'
import XCTest
let suite = BridgeTests.defaultTestSuite
suite.run()
guard let result = suite.testRun, result.executionCount >= 8, result.hasSucceeded else { exit(1) }
let dictation = DictationTests.defaultTestSuite
dictation.run()
guard let result = dictation.testRun, result.executionCount == 3, result.hasSucceeded else { exit(1) }
let requests = RequestTasksTests.defaultTestSuite
requests.run()
guard let result = requests.testRun, result.executionCount == 3, result.hasSucceeded else { exit(1) }
SWIFT
developer="$(xcode-select -p)"
frameworks="$developer/Platforms/MacOSX.platform/Developer/Library/Frameworks"
private_frameworks="$developer/Platforms/MacOSX.platform/Developer/Library/PrivateFrameworks"
shared_frameworks="$developer/../SharedFrameworks"
swift_support="$developer/Platforms/MacOSX.platform/Developer/usr/lib"
swiftc -swift-version 5 -F "$frameworks" -I "$swift_support" -L "$swift_support" -lXCTestSwiftSupport \
    -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$swift_support" \
    -Xlinker -rpath -Xlinker "$private_frameworks" -Xlinker -rpath -Xlinker "$shared_frameworks" \
    "$project_root/native/PaceNative/Sources/PaceNative/Bridge.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Dictation.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/RequestTasks.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Meetings.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Diarization.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/Models.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/KittenBundle.swift" \
    "$project_root/native/PaceNative/Sources/PaceNative/MoonshineBundle.swift" \
    "$test_dir/BridgeTests.swift" "$test_dir/DictationTests.swift" "$test_dir/RequestTasksTests.swift" "$test_dir/main.swift" -o "$test_dir/bridge-tests"
"$test_dir/bridge-tests"
