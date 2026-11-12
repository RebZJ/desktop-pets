use crate::db::Database;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use uuid::Uuid;

pub fn save_extension(db: &Database, params: &Value) -> Result<Value, String> {
    let name = params["name"].as_str().unwrap_or("").trim();
    let command = params["command"].as_str().unwrap_or("").trim();
    if name.is_empty() || name.len() > 120 || command.is_empty() || command.len() > 4096 {
        return Err("Enter a name and a local executable path or command".into());
    }
    let args = params
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if args.len() > 64
        || args
            .iter()
            .any(|a| !a.as_str().is_some_and(|s| s.len() < 8192))
    {
        return Err("Arguments must be a list of strings".into());
    }
    let item = json!({"id":Uuid::new_v4().to_string(),"name":name,"command":command,"args":args,"enabled":true,"enabledTools":[]});
    db.put("extension", item["id"].as_str().unwrap(), &item)?;
    Ok(item)
}

pub fn update_extension(db: &Database, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_str().ok_or("Extension id is required")?;
    let mut item = db.get("extension", id)?;
    if let Some(enabled) = params.get("enabled") {
        if !enabled.is_boolean() {
            return Err("Enabled must be true or false".into());
        }
        item["enabled"] = enabled.clone();
    }
    if let Some(tools) = params.get("enabledTools") {
        if !tools.as_array().is_some_and(|a| {
            a.len() <= 100
                && a.iter()
                    .all(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256))
        }) {
            return Err("Tool permissions must be a list of names".into());
        }
        item["enabledTools"] = tools.clone();
    }
    db.put("extension", id, &item)?;
    Ok(item)
}

struct McpConnection {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpConnection {
    async fn open(config: &Value) -> Result<Self, String> {
        if config["enabled"] != true {
            return Err("This extension is disabled".into());
        }
        let command = config["command"].as_str().ok_or("Missing executable")?;
        let args: Vec<&str> = config["args"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        // No shell interpolation: a configured MCP server is an explicitly trusted local program.
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start the local extension: {e}"))?;
        let input = child.stdin.take().ok_or("No extension input")?;
        let output = BufReader::new(child.stdout.take().ok_or("No extension output")?);
        let mut connection = Self {
            child,
            input,
            output,
            next_id: 1,
        };
        connection.rpc("initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Desktop Pets","version":"0.1.0"}})).await?;
        connection
            .input
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
            .await
            .map_err(|e| e.to_string())?;
        Ok(connection)
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let message = format!(
            "{}\n",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        );
        self.input
            .write_all(message.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(45),async {
            loop {
                let mut buffer=Vec::new();
                let count=(&mut self.output).take(1024*1024+1).read_until(b'\n',&mut buffer).await.map_err(|e|e.to_string())?;
                if count==0 { return Err("The extension stopped before replying".into()) }
                if buffer.len()>1024*1024 { return Err("The extension response exceeds 1 MB".into()) }
                let response:Value=serde_json::from_slice(&buffer).map_err(|_|"The extension did not return valid MCP JSON".to_string())?;
                if response.get("method").is_some() && response.get("id").is_some() {
                    let denial=format!("{}\n",json!({"jsonrpc":"2.0","id":response["id"],"error":{"code":-32601,"message":"Desktop Pets does not accept server-initiated actions"}}));
                    self.input.write_all(denial.as_bytes()).await.map_err(|e|e.to_string())?;
                    continue;
                }
                if response.get("id")==Some(&json!(id)) {
                    if let Some(error)=response.get("error") { return Err(format!("Extension error: {}",error["message"].as_str().unwrap_or("Unknown error"))) }
                    return Ok(response.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        }).await.map_err(|_|"The extension did not reply within 45 seconds".to_string())?
    }
}

pub async fn inspect(config: &Value) -> Result<Value, String> {
    let mut connection = McpConnection::open(config).await?;
    let result = connection.rpc("tools/list", json!({})).await;
    let _ = connection.child.kill().await;
    result
}

pub async fn call(db: &Database, id: &str, params: &Value) -> Result<Value, String> {
    let config = db.get("extension", id)?;
    let tool = params["tool"].as_str().ok_or("Select a tool")?;
    if params["confirmed"] != true {
        return Err("Review the tool arguments and confirm this action before running it".into());
    }
    if !config["enabledTools"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(tool)))
    {
        return Err("Enable this tool in the extension permissions before running it".into());
    }
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    if !arguments.is_object() || arguments.to_string().len() > 64 * 1024 {
        return Err("Tool arguments must be a JSON object below 64 KB".into());
    }
    let mut connection = McpConnection::open(&config).await?;
    let current = db.get("extension", id)?;
    if current["enabled"] != true
        || !current["enabledTools"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(tool)))
    {
        return Err("This tool's permission was revoked while the extension was starting".into());
    }
    if current["command"] != config["command"] || current["args"] != config["args"] {
        return Err("The extension configuration changed. Review it and confirm again".into());
    }
    let result = connection
        .rpc("tools/call", json!({"name":tool,"arguments":arguments}))
        .await;
    let _ = connection.child.kill().await;
    result
}

fn relative_path(name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if name.is_empty()
        || name.contains('\\')
        || name.contains(':')
        || !path.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Pet packs cannot contain absolute paths or parent directories".into());
    }
    Ok(path.to_path_buf())
}

pub fn validate_manifest(manifest: &Value) -> Result<(), String> {
    if manifest["version"].as_str() != Some("1") && manifest["version"].as_u64() != Some(1) {
        return Err("This pet pack needs manifest version 1".into());
    }
    let id = manifest["id"].as_str().ok_or("Pet pack needs an id")?;
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || id == "pace"
    {
        return Err(
            "Use a unique pack id containing letters, digits, hyphens or underscores".into(),
        );
    }
    for key in ["name", "license", "attribution"] {
        if !manifest[key]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.len() < 2000)
        {
            return Err(format!("Pet pack needs {key}"));
        }
    }
    let actions = manifest["actions"]
        .as_array()
        .ok_or("Pet pack needs an actions list")?;
    if actions.is_empty() || actions.len() > 64 || !actions.iter().any(|a| a["id"] == "idle") {
        return Err("Pet pack needs an idle action and at most 64 actions".into());
    }
    for action in actions {
        let src = action["src"].as_str().ok_or("Action needs a sprite path")?;
        relative_path(src)?;
        if !["png", "webp"].contains(
            &Path::new(src)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or(""),
        ) {
            return Err("Sprites must be PNG or WebP files".into());
        }
        if !action["id"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 64)
        {
            return Err("Action needs an id".into());
        }
        for key in ["frameWidth", "frameHeight", "frameCount"] {
            let maximum = if key == "frameCount" { 512 } else { 2048 };
            if !action[key]
                .as_u64()
                .is_some_and(|n| (1..=maximum).contains(&n))
            {
                return Err(format!("Invalid {key}"));
            }
        }
        if !action["fps"]
            .as_f64()
            .is_some_and(|n| (1.0..=60.0).contains(&n))
        {
            return Err("Action FPS must be 1–60".into());
        }
    }
    if manifest
        .get("personality")
        .is_some_and(|v| !v.as_str().is_some_and(|s| s.len() <= 8000))
    {
        return Err("Personality text must be below 8 KB".into());
    }
    if let Some(sounds) = manifest.get("sounds") {
        let sounds = sounds
            .as_object()
            .filter(|m| m.len() <= 64)
            .ok_or("Sounds must map at most 64 actions to WAV paths")?;
        for (action, source) in sounds {
            if action.is_empty() || action.len() > 64 {
                return Err("Invalid sound action".into());
            }
            let source = source.as_str().ok_or("Sound needs a WAV path")?;
            relative_path(source)?;
            if !source.ends_with(".wav") {
                return Err("Pet sounds must use WAV files".into());
            }
        }
    }
    Ok(())
}

fn validate_sound(bytes: &[u8]) -> Result<(), String> {
    let invalid =
        || "Pet sounds must be PCM16 mono/stereo WAV, 8–48 kHz and at most 3 seconds".to_string();
    if bytes.len() < 44
        || bytes.len() > 2 * 1024 * 1024
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
    {
        return Err(invalid());
    }
    let mut position = 12usize;
    let mut format = None;
    let mut audio_bytes = None;
    while position + 8 <= bytes.len() {
        let size =
            u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
        let end = position
            .checked_add(8)
            .and_then(|n| n.checked_add(size))
            .ok_or_else(invalid)?;
        let data = bytes.get(position + 8..end).ok_or_else(invalid)?;
        match &bytes[position..position + 4] {
            b"fmt " => {
                if data.len() < 16 {
                    return Err(invalid());
                }
                format = Some((
                    u16::from_le_bytes(data[0..2].try_into().unwrap()),
                    u16::from_le_bytes(data[2..4].try_into().unwrap()),
                    u32::from_le_bytes(data[4..8].try_into().unwrap()),
                    u16::from_le_bytes(data[14..16].try_into().unwrap()),
                ));
            }
            b"data" => audio_bytes = Some(size),
            _ => {}
        }
        position = end.checked_add(size % 2).ok_or_else(invalid)?;
    }
    let Some((encoding, channels, rate, bits)) = format else {
        return Err(invalid());
    };
    let Some(size) = audio_bytes else {
        return Err(invalid());
    };
    if encoding != 1
        || !(1..=2).contains(&channels)
        || !(8000..=48000).contains(&rate)
        || bits != 16
        || size == 0
        || size % ((channels as usize) * 2) != 0
        || size > (rate as usize) * (channels as usize) * 2 * 3
    {
        return Err(invalid());
    }
    Ok(())
}

fn sprite_dimensions(bytes: &[u8], extension: &str) -> Result<(u32, u32), String> {
    let invalid = || "Invalid or unsupported PNG/WebP sprite header".to_string();
    let dimensions = match extension {
        "png" => {
            if bytes.len() < 33
                || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                || bytes[8..12] != 13u32.to_be_bytes()
                || &bytes[12..16] != b"IHDR"
            {
                return Err(invalid());
            }
            let mut offset = 33usize;
            while offset < bytes.len() {
                let header = bytes.get(offset..offset + 8).ok_or_else(invalid)?;
                let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
                let end = offset
                    .checked_add(12)
                    .and_then(|start| start.checked_add(length))
                    .ok_or_else(invalid)?;
                if end > bytes.len() {
                    return Err(invalid());
                }
                if matches!(&header[4..8], b"acTL" | b"fcTL" | b"fdAT") {
                    return Err("Pet sprites must be static PNG sheets, without animation".into());
                }
                if &header[4..8] == b"IEND" {
                    break;
                }
                offset = end;
            }
            (
                u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
                u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
            )
        }
        "webp" => {
            if bytes.len() < 20
                || &bytes[..4] != b"RIFF"
                || &bytes[8..12] != b"WEBP"
                || (u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize).checked_add(8)
                    != Some(bytes.len())
            {
                return Err(invalid());
            }
            let mut offset = 12usize;
            let mut canvas = None;
            let mut image = None;
            while offset < bytes.len() {
                let header = bytes.get(offset..offset + 8).ok_or_else(invalid)?;
                let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
                let start = offset + 8;
                let end = start.checked_add(length).ok_or_else(invalid)?;
                let payload = bytes.get(start..end).ok_or_else(invalid)?;
                let decoded = match &header[..4] {
                    b"VP8X" => {
                        if offset != 12
                            || payload.len() != 10
                            || payload[0] & 0xc3 != 0
                            || payload[1..4] != [0, 0, 0]
                        {
                            return Err(
                                "Pet sprites must be static WebP sheets, without animation".into(),
                            );
                        }
                        let u24 =
                            |data: &[u8]| u32::from_le_bytes([data[0], data[1], data[2], 0]) + 1;
                        canvas = Some((u24(&payload[4..7]), u24(&payload[7..10])));
                        None
                    }
                    b"VP8 " => {
                        if payload.len() < 10
                            || payload[0] & 1 != 0
                            || payload[3..6] != [0x9d, 0x01, 0x2a]
                        {
                            return Err(invalid());
                        }
                        Some((
                            (u16::from_le_bytes(payload[6..8].try_into().unwrap()) & 0x3fff) as u32,
                            (u16::from_le_bytes(payload[8..10].try_into().unwrap()) & 0x3fff)
                                as u32,
                        ))
                    }
                    b"VP8L" => {
                        if payload.len() < 5 || payload[0] != 0x2f {
                            return Err(invalid());
                        }
                        let bits = u32::from_le_bytes(payload[1..5].try_into().unwrap());
                        if bits >> 29 != 0 {
                            return Err(invalid());
                        }
                        Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
                    }
                    b"ANIM" | b"ANMF" => {
                        return Err(
                            "Pet sprites must be static WebP sheets, without animation".into()
                        )
                    }
                    _ => None,
                };
                if let Some(dimensions) = decoded {
                    if image.replace(dimensions).is_some() {
                        return Err(invalid());
                    }
                }
                offset = end.checked_add(length % 2).ok_or_else(invalid)?;
                if offset > bytes.len() {
                    return Err(invalid());
                }
            }
            let dimensions = image.ok_or_else(invalid)?;
            if canvas.is_some_and(|canvas| canvas != dimensions) {
                return Err("WebP canvas and encoded image dimensions do not match".into());
            }
            dimensions
        }
        _ => return Err(invalid()),
    };
    if dimensions.0 == 0
        || dimensions.1 == 0
        || u64::from(dimensions.0) * u64::from(dimensions.1) > 16_000_000
    {
        return Err("Pet sprite images must contain at most 16 million pixels".into());
    }
    Ok(dimensions)
}

pub fn import_pack(db: &Database, data_dir: &Path, archive_path: &Path) -> Result<Value, String> {
    if fs::metadata(archive_path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("Pet pack ZIP must be below 32 MB".into());
    }
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid pet ZIP: {e}"))?;
    if archive.len() > 128 {
        return Err("Pet packs may contain at most 128 files".into());
    }
    let mut total = 0u64;
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let relative = relative_path(entry.name())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Pet packs cannot contain symbolic links".into());
        }
        if !["json", "webp", "png", "wav", "txt", "md"]
            .contains(&relative.extension().and_then(|s| s.to_str()).unwrap_or(""))
        {
            return Err("Pet packs may contain JSON, PNG, WebP, WAV and text license/documentation files only".into());
        }
        total = total.checked_add(entry.size()).ok_or("Invalid pack size")?;
        if total > 64 * 1024 * 1024 || entry.size() > 32 * 1024 * 1024 {
            return Err("Uncompressed pet pack exceeds 64 MB".into());
        }
        if entries
            .iter()
            .any(|(_, p): &(usize, PathBuf)| *p == relative)
        {
            return Err("Pet pack has duplicate file paths".into());
        }
        entries.push((i, relative));
    }
    let manifest_index = entries
        .iter()
        .find(|(_, p)| p == Path::new("manifest.json"))
        .ok_or("Put manifest.json at the root of the ZIP")?
        .0;
    let manifest: Value = {
        let mut entry = archive
            .by_index(manifest_index)
            .map_err(|e| e.to_string())?;
        let declared = entry.size();
        if declared > 128 * 1024 {
            return Err("Pet manifest exceeds 128 KB".into());
        }
        let mut text = String::new();
        (&mut entry)
            .take(128 * 1024 + 1)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        if text.len() > 128 * 1024 || text.len() as u64 != declared {
            return Err("Pet manifest size is invalid".into());
        }
        serde_json::from_str(&text).map_err(|e| format!("Invalid manifest: {e}"))?
    };
    validate_manifest(&manifest)?;
    let id = manifest["id"].as_str().unwrap();
    let packs_dir = data_dir.join("packs");
    fs::create_dir_all(&packs_dir).map_err(|e| e.to_string())?;
    let destination = packs_dir.join(id);
    if destination.exists() {
        return Err(
            "A pet with that id is already installed; remove it before importing a replacement"
                .into(),
        );
    }
    let staging = packs_dir.join(format!(".import-{}", Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let extraction = (|| -> Result<(), String> {
        let mut extracted = 0u64;
        for (index, relative) in &entries {
            let path = staging.join(relative);
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut entry = archive.by_index(*index).map_err(|e| e.to_string())?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|e| e.to_string())?;
            let expected = entry.size();
            let limit = expected
                .min(32 * 1024 * 1024)
                .min(64 * 1024 * 1024 - extracted);
            let copied = std::io::copy(&mut (&mut entry).take(limit + 1), &mut output)
                .map_err(|e| e.to_string())?;
            if copied > limit || copied != expected {
                return Err(
                    "Pet ZIP extracted bytes exceed its declared size or the allowed limit".into(),
                );
            }
            extracted += copied;
            output.flush().map_err(|e| e.to_string())?;
        }
        for action in manifest["actions"].as_array().unwrap() {
            let path = staging.join(action["src"].as_str().unwrap());
            if !path.is_file() {
                return Err("A sprite listed in the manifest is missing".into());
            }
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let dimensions = sprite_dimensions(
                &bytes,
                path.extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or(""),
            )?;
            let expected_width =
                action["frameWidth"].as_u64().unwrap() * action["frameCount"].as_u64().unwrap();
            if u64::from(dimensions.0) != expected_width
                || u64::from(dimensions.1) != action["frameHeight"].as_u64().unwrap()
            {
                return Err(
                    "Sprite dimensions must match frameWidth × frameCount by frameHeight".into(),
                );
            }
        }
        if let Some(sounds) = manifest["sounds"].as_object() {
            for source in sounds.values() {
                let path = staging.join(source.as_str().ok_or("Invalid sound path")?);
                let bytes =
                    fs::read(path).map_err(|_| "A sound listed in the manifest is missing")?;
                validate_sound(&bytes)?;
            }
        }
        fs::rename(&staging, &destination).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let mut installed = manifest.clone();
    installed["directory"] = json!(destination);
    installed["installed"] = json!(true);
    if let Err(error) = db.put("pack", id, &installed) {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_original_earcons_and_rejects_unsafe_sound_paths() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let bytes = fs::read(root.join("public/pets/pace/sounds/sleepy-purr.wav")).unwrap();
        assert!(validate_sound(&bytes).is_ok());
        let mut bad = bytes.clone();
        bad[22] = 0;
        assert!(validate_sound(&bad).is_err());
        let mut p = pack();
        p["sounds"] = json!({"happy":"../private.wav"});
        assert!(validate_manifest(&p).is_err());
        p["sounds"] = json!({"happy":"sounds/chirp.wav"});
        assert!(validate_manifest(&p).is_ok());
    }
    fn pack() -> Value {
        json!({"id":"test-pet","name":"Test","version":1,"license":"CC BY 4.0","attribution":"Test author","actions":[{"id":"idle","src":"idle.webp","frameWidth":256,"frameHeight":256,"frameCount":8,"fps":12}]})
    }
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend(13u32.to_be_bytes());
        bytes.extend(b"IHDR");
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }
    fn lossless_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x2f];
        bytes.extend(((width - 1) | ((height - 1) << 14)).to_le_bytes());
        bytes
    }
    fn webp_chunks(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        for (tag, payload) in chunks {
            bytes.extend(*tag);
            bytes.extend((payload.len() as u32).to_le_bytes());
            bytes.extend(payload);
            if payload.len() % 2 != 0 {
                bytes.push(0);
            }
        }
        let length = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        bytes
    }
    #[test]
    fn checks_png_and_all_three_webp_dimension_headers() {
        assert_eq!(
            sprite_dimensions(&png_header(2048, 256), "png").unwrap(),
            (2048, 256)
        );
        let lossy = webp_chunks(&[(
            b"VP8 ",
            vec![0x10, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x08, 0x00, 0x01],
        )]);
        assert_eq!(sprite_dimensions(&lossy, "webp").unwrap(), (2048, 256));
        let lossless = webp_chunks(&[(b"VP8L", lossless_header(2048, 256))]);
        assert_eq!(sprite_dimensions(&lossless, "webp").unwrap(), (2048, 256));
        let canvas = vec![0, 0, 0, 0, 0xff, 0x07, 0, 0xff, 0, 0];
        let extended = webp_chunks(&[
            (b"VP8X", canvas.clone()),
            (b"VP8L", lossless_header(2048, 256)),
        ]);
        assert_eq!(sprite_dimensions(&extended, "webp").unwrap(), (2048, 256));
        let mismatch = webp_chunks(&[(b"VP8X", canvas), (b"VP8L", lossless_header(1, 1))]);
        assert!(sprite_dimensions(&mismatch, "webp").is_err());
        assert!(sprite_dimensions(&png_header(4001, 4000), "png")
            .unwrap_err()
            .contains("16 million"));
        assert!(sprite_dimensions(&png_header(0, 256), "png").is_err());
        assert!(sprite_dimensions(&lossless, "png").is_err());
        assert!(sprite_dimensions(&png_header(2048, 256), "webp").is_err());
        let mut animated_png = png_header(2048, 256);
        animated_png.extend(8u32.to_be_bytes());
        animated_png.extend(b"acTL");
        animated_png.extend([0; 12]);
        assert!(sprite_dimensions(&animated_png, "png").is_err());
        for length in 0..lossless.len() {
            assert!(sprite_dimensions(&lossless[..length], "webp").is_err());
        }
        let animated = webp_chunks(&[
            (b"VP8X", vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            (b"VP8L", lossless_header(1, 1)),
        ]);
        assert!(sprite_dimensions(&animated, "webp").is_err());
    }
    #[test]
    fn imported_sprite_geometry_must_match_the_manifest() {
        let sprite = include_bytes!("../../public/pets/pace/idle.webp");
        let (width, height) = sprite_dimensions(sprite, "webp").unwrap();
        assert_eq!(width % 256, 0);
        for case in ["valid", "wrong_geometry", "wrong_signature"] {
            let folder = tempfile::tempdir().unwrap();
            let mut manifest = pack();
            manifest["actions"][0]["frameWidth"] = json!(256);
            manifest["actions"][0]["frameHeight"] = json!(height);
            manifest["actions"][0]["frameCount"] =
                json!(width / 256 + u32::from(case == "wrong_geometry"));
            let source = if case == "wrong_signature" {
                "idle.png"
            } else {
                "idle.webp"
            };
            manifest["actions"][0]["src"] = json!(source);
            let archive = folder.path().join("pack.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", options).unwrap();
            zip.write_all(manifest.to_string().as_bytes()).unwrap();
            zip.start_file(source, options).unwrap();
            zip.write_all(sprite).unwrap();
            zip.finish().unwrap();
            let db = Database::open(Path::new(":memory:")).unwrap();
            let result = import_pack(&db, folder.path(), &archive);
            assert_eq!(result.is_ok(), case == "valid", "{case}: {result:?}");
            assert_eq!(db.list("pack").unwrap().len(), usize::from(case == "valid"));
        }
    }
    #[test]
    fn blocks_pack_traversal_and_bad_frames() {
        assert!(validate_manifest(&pack()).is_ok());
        for bad in [
            "../escape.webp",
            "/tmp/escape.webp",
            "a/../../escape.webp",
            "a\\escape.webp",
        ] {
            let mut p = pack();
            p["actions"][0]["src"] = json!(bad);
            assert!(validate_manifest(&p).is_err());
        }
        let mut p = pack();
        p["actions"][0]["frameCount"] = json!(0);
        assert!(validate_manifest(&p).is_err());
    }
    #[tokio::test]
    async fn denies_tools_without_explicit_grants_and_confirmation() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        db.put(
            "extension",
            "server",
            &json!({"enabled":true,"command":"does-not-exist","enabledTools":[]}),
        )
        .unwrap();
        assert!(
            call(&db, "server", &json!({"tool":"send","confirmed":true}))
                .await
                .unwrap_err()
                .contains("Enable")
        );
        assert!(call(&db, "server", &json!({"tool":"send"}))
            .await
            .unwrap_err()
            .contains("confirm"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rechecks_tool_grants_after_server_initialization() {
        for change in ["revoke", "disable", "remove", "configuration"] {
            let folder = tempfile::tempdir().unwrap();
            let script = folder.path().join("server.sh");
            let called = folder.path().join("called");
            let starting = folder.path().join("starting");
            fs::write(&script,r#"#!/bin/sh
IFS= read -r initialize
printf started > "$2"
sleep 0.1
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}'
IFS= read -r notification
if IFS= read -r request; then
    printf called > "$1"
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}'
fi
"#).unwrap();
            let db = Database::open(Path::new(":memory:")).unwrap();
            db.put("extension","server",&json!({"enabled":true,"command":"/bin/sh","args":[script,called,starting],"enabledTools":["send"]})).unwrap();
            let revoke = async {
                let mut observed = false;
                for _ in 0..200 {
                    if starting.exists() {
                        observed = true;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                assert!(observed, "The fixture server did not start");
                if change == "remove" {
                    db.remove("extension", "server").unwrap();
                } else {
                    let mut config = db.get("extension", "server").unwrap();
                    match change {
                        "disable" => config["enabled"] = json!(false),
                        "configuration" => config["command"] = json!("/usr/bin/true"),
                        _ => config["enabledTools"] = json!([]),
                    }
                    db.put("extension", "server", &config).unwrap();
                }
            };
            let params = json!({"tool":"send","confirmed":true});
            let (result, _) = tokio::join!(call(&db, "server", &params), revoke);
            assert!(result.is_err(), "{change} must prevent the tool call");
            assert!(!called.exists(), "The tool ran after {change}");
        }
    }
    #[test]
    fn rejects_zip_entries_that_expand_beyond_their_declared_size() {
        use std::io::Cursor;
        let folder = tempfile::tempdir().unwrap();
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(pack().to_string().as_bytes()).unwrap();
        zip.start_file("idle.webp", options).unwrap();
        zip.write_all(&vec![b'x'; 8192]).unwrap();
        let mut bytes = zip.finish().unwrap().into_inner();
        let header = (0..bytes.len() - 46)
            .find(|&index| {
                bytes[index..].starts_with(b"PK\x01\x02")
                    && bytes.get(index + 46..index + 55) == Some(b"idle.webp")
            })
            .unwrap();
        bytes[header + 24..header + 28].copy_from_slice(&1u32.to_le_bytes());
        let archive = folder.path().join("misdeclared.zip");
        fs::write(&archive, bytes).unwrap();
        let db = Database::open(Path::new(":memory:")).unwrap();
        let error = import_pack(&db, folder.path(), &archive).unwrap_err();
        assert!(error.contains("declared size"), "{error}");
        assert!(db.list("pack").unwrap().is_empty());
        assert_eq!(
            fs::read_dir(folder.path().join("packs")).unwrap().count(),
            0
        );
    }
}
