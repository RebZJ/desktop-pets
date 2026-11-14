fn main() {
    for source in [
        "src",
        "../src",
        "../package.json",
        "tauri.conf.json",
        "tauri.dev.conf.json",
    ] {
        println!("cargo:rerun-if-changed={source}");
    }
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .output();
    let revision = output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=PACE_BUILD_REVISION={revision}");
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty());
    println!("cargo:rustc-env=PACE_BUILD_DIRTY={dirty}");
    for name in ["HEAD", "index"] {
        if let Ok(output) = std::process::Command::new("git")
            .args(["rev-parse", "--git-path", name])
            .output()
        {
            if output.status.success() {
                println!(
                    "cargo:rerun-if-changed={}",
                    String::from_utf8_lossy(&output.stdout).trim()
                );
            }
        }
    }
    if let Ok(output) = std::process::Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
    {
        if output.status.success() {
            if let Ok(path) = std::process::Command::new("git")
                .args([
                    "rev-parse",
                    "--git-path",
                    String::from_utf8_lossy(&output.stdout).trim(),
                ])
                .output()
            {
                if path.status.success() {
                    println!(
                        "cargo:rerun-if-changed={}",
                        String::from_utf8_lossy(&path.stdout).trim()
                    );
                }
            }
        }
    }
    tauri_build::build()
}
