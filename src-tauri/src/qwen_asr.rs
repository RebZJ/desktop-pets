//! Qwen3-ASR uses the existing portable llama.cpp binary, with an ASR-owned child.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};

const MODEL: &str = "qwen3-asr-1.7b";
const DECODER: &str = "Qwen3-ASR-1.7B-Q8_0.gguf";
const ENCODER: &str = "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf";

pub struct QwenAsr {
    binary: PathBuf,
    root: PathBuf,
    cancelled: Arc<AtomicBool>,
    server: Mutex<Option<Server>>,
}

impl QwenAsr {
    pub fn new(binary: PathBuf, models: &Path, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            binary,
            root: models.join(MODEL),
            cancelled,
            server: Mutex::new(None),
        }
    }

    pub fn installed(models: &Path) -> bool {
        [DECODER, ENCODER]
            .iter()
            .all(|file| models.join(MODEL).join(file).is_file())
    }

    pub async fn prepare(&self) -> Result<(), String> {
        self.request(None).await.map(|_| ())
    }

    pub async fn transcribe(&self, params: Value) -> Result<Value, String> {
        self.request(Some(params)).await
    }

    async fn request(&self, params: Option<Value>) -> Result<Value, String> {
        let mut slot = self.server.lock().await;
        // Keep the child in this future, not in shared storage while it is busy.
        // Aborting an owning voice task therefore kills its ASR child immediately.
        let mut server = slot.take();
        let action = async {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("Speech processing cancelled.".into());
            }
            let started = Instant::now();
            let cold = match server.as_mut() {
                Some(server) => !matches!(server.child.try_wait(), Ok(None)),
                None => true,
            };
            if cold {
                server = Some(Server::start(&self.binary, &self.root).await?);
            }
            let load_ms = started.elapsed().as_secs_f64() * 1000.0;
            let Some(params) = params else {
                return Ok(json!({"model":MODEL,"cold":cold,"loadMs":load_ms}));
            };
            let mut result = server.as_ref().unwrap().transcribe(params).await?;
            result["cold"] = json!(cold);
            result["loadMs"] = json!(load_ms);
            Ok(result)
        };
        let result = tokio::select! {
            // Startup and every 30s window have their own deadlines. A long meeting
            // must not inherit a short dictation-wide deadline.
            result = action => result,
            _ = wait_cancelled(&self.cancelled) => Err("Speech processing cancelled.".into()),
        };
        if result.is_ok() && !self.cancelled.load(Ordering::SeqCst) {
            *slot = server;
        } else if let Some(mut server) = server {
            let _ = server.child.kill().await;
        }
        result
    }

    pub async fn stop(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.release().await;
    }

    pub async fn release(&self) {
        if let Some(mut server) = self.server.lock().await.take() {
            let _ = server.child.kill().await;
        }
    }
}

async fn wait_cancelled(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

struct Server {
    child: Child,
    client: reqwest::Client,
    endpoint: String,
    key: String,
}

impl Server {
    async fn start(binary: &Path, root: &Path) -> Result<Self, String> {
        if ![DECODER, ENCODER]
            .iter()
            .all(|file| root.join(file).is_file())
        {
            return Err("Install Qwen3-ASR 1.7B in Local models before recording.".into());
        }
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let key = uuid::Uuid::new_v4().to_string();
        let endpoint = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let child = Command::new(binary)
            .arg("--model")
            .arg(root.join(DECODER))
            .arg("--mmproj")
            .arg(root.join(ENCODER))
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--ctx-size",
                "8192",
                "--parallel",
                "1",
                "--no-webui",
                "--no-context-shift",
                "--jinja",
            ])
            .env("LLAMA_API_KEY", &key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start Qwen3-ASR: {e}"))?;
        let mut server = Self {
            child,
            client,
            endpoint,
            key,
        };
        tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                if !matches!(server.child.try_wait(), Ok(None)) {
                    return Err(
                        "Qwen3-ASR could not load. Check its model files and available memory."
                            .to_owned(),
                    );
                }
                if server
                    .client
                    .get(format!("{}/health", server.endpoint))
                    .bearer_auth(&server.key)
                    .timeout(Duration::from_secs(2))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success())
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| {
            "Qwen3-ASR was not ready within 90 seconds. Close other large applications and retry."
                .to_owned()
        })??;
        Ok(server)
    }

    async fn transcribe(&self, params: Value) -> Result<Value, String> {
        let started = Instant::now();
        let path = crate::asr::input_path(&params)?;
        let samples = tokio::task::spawn_blocking(move || crate::asr::read_pcm(&path))
            .await
            .map_err(|e| e.to_string())??;
        let language =
            crate::asr::normalize_language(params["language"].as_str().unwrap_or("auto"));
        let forced_language = language_name(&language)?;
        let terms = crate::asr::vocabulary(params.get("dictationVocabulary"))?;
        let ranges = ranges(&params, samples.len())?;
        let mut segments = Vec::new();
        let mut detected = language.clone();
        for (start, end, speaker) in &ranges {
            // Exact digital silence must not turn into a model hallucination.
            if samples[*start..*end].iter().all(|sample| *sample == 0) {
                continue;
            }
            let mut audio = Cursor::new(Vec::new());
            {
                let mut writer = hound::WavWriter::new(
                    &mut audio,
                    hound::WavSpec {
                        channels: 1,
                        sample_rate: 16000,
                        bits_per_sample: 16,
                        sample_format: hound::SampleFormat::Int,
                    },
                )
                .map_err(|e| e.to_string())?;
                for sample in &samples[*start..*end] {
                    writer.write_sample(*sample).map_err(|e| e.to_string())?;
                }
                writer.finalize().map_err(|e| e.to_string())?;
            }
            let mut messages = vec![
                json!({"role":"system","content":terms.join(", ")}),
                json!({"role":"user","content":[{"type":"input_audio","input_audio":{
                    "data":format!("data:audio/wav;base64,{}", STANDARD.encode(audio.into_inner())),"format":"wav"}}]}),
            ];
            if let Some(language) = forced_language {
                messages.push(
                    json!({"role":"assistant","content":format!("language {language}<asr_text>")}),
                );
            }
            let body = json!({"messages":messages,"temperature":0,"max_tokens":2048,"stream":false,
                "add_generation_prompt":forced_language.is_none(),"continue_final_message":forced_language.is_some()});
            let response = self
                .client
                .post(format!("{}/v1/chat/completions", self.endpoint))
                .bearer_auth(&self.key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Qwen3-ASR request failed: {e}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "Qwen3-ASR rejected audio (HTTP {}).",
                    response.status()
                ));
            }
            let value: Value = response
                .json()
                .await
                .map_err(|e| format!("Invalid Qwen3-ASR response: {e}"))?;
            if value["choices"][0]["finish_reason"] == "length" {
                return Err("Qwen3-ASR reached its transcription limit. Saved audio is preserved for retry.".into());
            }
            let raw = value["choices"][0]["message"]["content"]
                .as_str()
                .ok_or("Qwen3-ASR returned no transcript.")?;
            let (text, parsed_language) = parse_output(raw);
            if let Some(language) = parsed_language {
                detected = language;
            }
            if text.is_empty() {
                continue;
            }
            let mut segment = json!({"text":text,"start":*start as f64 / 16000.0,"end":*end as f64 / 16000.0,
                "startMs":*start as u64 / 16,"endMs":*end as u64 / 16});
            if !speaker.is_null() {
                segment["speaker"] = speaker.clone();
            }
            segments.push(segment);
        }
        let text = segments
            .iter()
            .filter_map(|s| s["text"].as_str())
            .collect::<Vec<_>>()
            .join(if matches!(detected.as_str(), "zh" | "ja" | "yue") {
                ""
            } else {
                " "
            });
        Ok(
            json!({"text":text,"segments":segments,"language":detected,"model":MODEL,"granularity":"phrase",
            "timestampSource":if params["speakerSegments"].is_array() {"speaker-turn-window"}else{"audio-window"},
            "speakerOverlapPolicy":"chronological-nonoverlapping",
            "windows":ranges.len(),"duration":samples.len() as f64 / 16000.0,
            "vocabularyTerms":terms.len(),"transcriptionMs":started.elapsed().as_secs_f64() * 1000.0}),
        )
    }
}

// Bounds describe actual input windows, never estimated word positions.
fn ranges(params: &Value, frames: usize) -> Result<Vec<(usize, usize, Value)>, String> {
    let mut intervals = Vec::new();
    if let Some(turns) = params.get("speakerSegments") {
        let turns = turns
            .as_array()
            .ok_or("Invalid speaker turns for Qwen3-ASR.")?;
        for turn in turns {
            let start = turn["start"]
                .as_f64()
                .ok_or("Missing speaker turn start.")?;
            let end = turn["end"].as_f64().ok_or("Missing speaker turn end.")?;
            if !start.is_finite()
                || !end.is_finite()
                || start < 0.0
                || end <= start
                || end > frames as f64 / 16000.0 + 0.05
            {
                return Err("Speaker turn lies outside its audio track.".into());
            }
            let first = (start * 16000.0).round() as usize;
            let last = ((end * 16000.0).round() as usize).min(frames);
            if first < last {
                intervals.push((first, last, turn["speaker"].clone()));
            }
        }
    } else {
        intervals.push((0, frames, Value::Null));
    }
    intervals.sort_by_key(|(start, end, _)| (*start, *end));
    let mut turns: Vec<(usize, usize, Value)> = Vec::new();
    for (mut start, end, speaker) in intervals {
        if let Some(previous) = turns.last_mut() {
            if start <= previous.1 && speaker == previous.2 {
                previous.1 = previous.1.max(end);
                continue;
            }
            // Mono ASR cannot separate simultaneous speakers. Never decode the
            // same samples twice merely because diarization turns overlap.
            start = start.max(previous.1);
        }
        if start < end {
            turns.push((start, end, speaker));
        }
    }
    let mut result = Vec::new();
    for (start, end, speaker) in turns {
        for first in (start..end).step_by(30 * 16000) {
            result.push((first, (first + 30 * 16000).min(end), speaker.clone()));
        }
    }
    Ok(result)
}

pub(crate) fn validate_language(language: &str) -> Result<(), String> {
    language_name(&crate::asr::normalize_language(language)).map(|_| ())
}

fn language_name(code: &str) -> Result<Option<&'static str>, String> {
    Ok(Some(match code {
        "auto" | "" => return Ok(None),
        "zh" => "Chinese", "en" => "English", "yue" => "Cantonese", "ar" => "Arabic",
        "de" => "German", "fr" => "French", "es" => "Spanish", "pt" => "Portuguese",
        "id" => "Indonesian", "it" => "Italian", "ko" => "Korean", "ru" => "Russian",
        "th" => "Thai", "vi" => "Vietnamese", "ja" => "Japanese", "tr" => "Turkish",
        "hi" => "Hindi", "ms" => "Malay", "nl" => "Dutch", "sv" => "Swedish",
        "da" => "Danish", "fi" => "Finnish", "pl" => "Polish", "cs" => "Czech",
        "fil" | "tl" => "Filipino", "fa" => "Persian", "el" => "Greek", "hu" => "Hungarian",
        "mk" => "Macedonian", "ro" => "Romanian",
        _ => return Err("Qwen3-ASR does not support this language. Choose automatic language detection or a supported language.".into()),
    }))
}

fn parse_output(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    let Some((metadata, text)) = raw.split_once("<asr_text>") else {
        return (raw.to_owned(), None);
    };
    let language = metadata
        .lines()
        .find_map(|line| line.trim().strip_prefix("language "));
    if language.is_some_and(|name| name.trim().eq_ignore_ascii_case("None")) {
        return (String::new(), None);
    }
    let code = language.and_then(|name| {
        [
            "zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th", "vi",
            "ja", "tr", "hi", "ms", "nl", "sv", "da", "fi", "pl", "cs", "fil", "fa", "el", "hu",
            "mk", "ro",
        ]
        .into_iter()
        .find(|code| {
            language_name(code)
                .ok()
                .flatten()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name.trim()))
        })
    });
    (text.trim().to_owned(), code.map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_metadata_never_becomes_dictated_text() {
        assert_eq!(
            parse_output("language None<asr_text>hallucinated words"),
            (String::new(), None)
        );
        assert_eq!(
            parse_output("language Chinese<asr_text>你好。"),
            ("你好。".into(), Some("zh".into()))
        );
        assert_eq!(
            parse_output("Plain dictated words."),
            ("Plain dictated words.".into(), None)
        );
    }

    #[test]
    fn overlapping_turns_decode_each_sample_once_and_keep_real_bounds() {
        let result = ranges(
            &json!({"speakerSegments":[
                {"start":1.0,"end":4.0,"speaker":"A"},
                {"start":0.0,"end":2.0,"speaker":"B"},
                {"start":3.0,"end":5.0,"speaker":"A"},
                {"start":5.0,"end":6.0,"speaker":"C"}
            ]}),
            6 * 16000,
        )
        .unwrap();
        assert_eq!(
            result,
            vec![
                (0, 32000, json!("B")),
                (32000, 80000, json!("A")),
                (80000, 96000, json!("C"))
            ]
        );
        let windows = ranges(
            &json!({"speakerSegments":[{"start":1.0,"end":66.0,"speaker":"A"}]}),
            66 * 16000,
        )
        .unwrap();
        assert_eq!(
            windows
                .iter()
                .map(|(start, end, _)| (*start / 16000, *end / 16000))
                .collect::<Vec<_>>(),
            [(1, 31), (31, 61), (61, 66)]
        );
        assert!(ranges(&json!({"speakerSegments":[]}), 16000)
            .unwrap()
            .is_empty());
        assert!(ranges(&json!({"speakerSegments":[{"start":0.0,"end":2.0}]}), 16000).is_err());
    }
}
