//! Portable WebRTC AEC3 preprocessing. Raw capture files are always preserved.
use aec3::{nodes::audio::AudioFormat, pipelines::linear};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tempfile::NamedTempFile;

const RATE: u64 = 16_000;
const FRAME: usize = 160; // AEC3 processes exactly 10ms.
const MAX_OFFSET_MS: u64 = 24 * 60 * 60 * 1000;
const REFERENCE_PAD: i64 = 200 * 16;

#[derive(Default)]
pub struct EchoOptions<'a> {
    /// Only for Pace's active canonical system.wav, never arbitrary imported WAVs.
    pub allow_growing_reference: bool,
    /// Full microphone track and its absolute offset, for up to 1s live pre-roll.
    pub microphone_history: Option<(&'a Path, u64)>,
}

pub struct EchoResult {
    /// Keep this owner alive through ASR/diarization. Dropping it removes only the derivative.
    pub cleaned: Option<NamedTempFile>,
    pub metadata: Value,
}

/// Both offsets are relative to the same recording origin. For a live chunk,
/// mic_offset_ms is that chunk's absolute start, not the microphone track origin.
/// Run on a blocking worker. Missing reference coverage returns the original via None.
pub fn clean_microphone(
    microphone: &Path,
    reference: &Path,
    mic_offset_ms: u64,
    reference_offset_ms: u64,
    options: EchoOptions<'_>,
    cancelled: &AtomicBool,
) -> Result<EchoResult, String> {
    let started = Instant::now();
    let mic_start = offset_frames(mic_offset_ms)?;
    let reference_start = offset_frames(reference_offset_ms)?;
    let mut mic = Pcm::open(microphone, false)?;
    let mut render = Pcm::open(reference, options.allow_growing_reference)?;
    let mic_end = mic_start
        .checked_add(mic.frames as i64)
        .ok_or("Invalid microphone duration.")?;
    let reference_end = reference_start
        .checked_add(render.frames as i64)
        .ok_or("Invalid reference duration.")?;
    let leading_missing = (reference_start - mic_start).max(0).min(mic.frames as i64);
    let trailing_missing = (mic_end - reference_end).max(0).min(mic.frames as i64);
    if mic.frames == 0
        || render.frames == 0
        || leading_missing > REFERENCE_PAD
        || trailing_missing > REFERENCE_PAD
    {
        return Ok(EchoResult {
            cleaned: None,
            metadata: json!({"backend":"aec3-rust-0.4.0",
            "status":"reference-unavailable","leadingMissingMs":leading_missing / 16,"trailingMissingMs":trailing_missing / 16}),
        });
    }
    check_cancel(cancelled)?;
    let format = AudioFormat::ten_ms(RATE as u32, 1);
    // Keep AEC3's adaptive/double-talk behavior; do not gate/subtract the microphone
    // or apply automatic gain that could amplify residual echo.
    let mut aec = linear::builder(format, format)
        .enable_noise_suppression(false)
        .enable_gain_controller2(false)
        .enable_post_filter(false)
        .build()
        .map_err(|e| format!("Could not initialize meeting echo cancellation: {e}"))?;
    let mut reference_frame = [0.0; FRAME];
    let mut mic_frame = [0.0; FRAME];
    let mut output = [0.0; FRAME];
    let mut warmup_frames = 0;
    if let Some((history_path, history_offset)) = options.microphone_history {
        let history_start = offset_frames(history_offset)?;
        let mut history = Pcm::open(history_path, false)?;
        let history_end = history_start + history.frames as i64;
        if history_end >= mic_start {
            let start = (mic_start - RATE as i64)
                .max(history_start)
                .max(reference_start);
            // End exactly at this chunk, so no duplicate capture samples enter AEC3.
            warmup_frames = ((mic_start - start).max(0) / FRAME as i64) * FRAME as i64;
            let start = mic_start - warmup_frames;
            for at in (start..mic_start).step_by(FRAME) {
                check_cancel(cancelled)?;
                render.frame(at - reference_start, &mut reference_frame)?;
                history.frame(at - history_start, &mut mic_frame)?;
                aec.handle_render_frame(&reference_frame)
                    .map_err(dsp_error)?;
                if !aec
                    .process_capture_frame(&mic_frame, &mut output)
                    .map_err(dsp_error)?
                {
                    return Err("Meeting echo cancellation returned no microphone frame.".into());
                }
            }
        }
    }
    let cleaned = tempfile::Builder::new()
        .prefix("pace-meeting-aec-")
        .suffix(".wav")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let mut writer = hound::WavWriter::new(
        BufWriter::new(cleaned.reopen().map_err(|e| e.to_string())?),
        hound::WavSpec {
            channels: 1,
            sample_rate: RATE as u32,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|e| e.to_string())?;
    for first in (0..mic.frames).step_by(FRAME) {
        check_cancel(cancelled)?;
        render.frame(
            mic_start + first as i64 - reference_start,
            &mut reference_frame,
        )?;
        mic.frame(first as i64, &mut mic_frame)?;
        aec.handle_render_frame(&reference_frame)
            .map_err(dsp_error)?;
        if !aec
            .process_capture_frame(&mic_frame, &mut output)
            .map_err(dsp_error)?
        {
            return Err("Meeting echo cancellation returned no microphone frame.".into());
        }
        let count = (mic.frames - first).min(FRAME as u64) as usize;
        for sample in &output[..count] {
            if !sample.is_finite() {
                return Err("Meeting echo cancellation returned invalid audio.".into());
            }
            writer
                .write_sample(
                    (sample.clamp(-1.0, 1.0) * 32768.0)
                        .round()
                        .clamp(-32768.0, 32767.0) as i16,
                )
                .map_err(|e| e.to_string())?;
        }
    }
    writer.finalize().map_err(|e| e.to_string())?;
    check_cancel(cancelled)?;
    Ok(EchoResult {
        cleaned: Some(cleaned),
        metadata: json!({"backend":"aec3-rust-0.4.0","status":"processed",
        "sampleRate":RATE,"frames":mic.frames,"warmupMs":warmup_frames / 16,
        "referencePaddingMs":(leading_missing + trailing_missing) / 16,
        "processingMs":started.elapsed().as_secs_f64()*1000.0}),
    })
}

fn offset_frames(ms: u64) -> Result<i64, String> {
    if ms > MAX_OFFSET_MS {
        return Err("Meeting audio offset is outside the supported range.".into());
    }
    Ok((ms * 16) as i64)
}
fn check_cancel(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("Meeting echo cancellation cancelled.".into())
    } else {
        Ok(())
    }
}
fn dsp_error(error: aec3::graph::GraphError) -> String {
    format!("Meeting echo cancellation failed: {error}")
}

struct Pcm {
    file: BufReader<File>,
    frames: u64,
    next_frame: u64,
}
impl Pcm {
    fn open(path: &Path, growing: bool) -> Result<Self, String> {
        if growing && path.file_name().and_then(|s| s.to_str()) != Some("system.wav") {
            return Err("Growing echo reference must be the active system.wav track.".into());
        }
        let file = File::open(path).map_err(|e| e.to_string())?;
        let bytes = file.metadata().map_err(|e| e.to_string())?.len();
        let mut file = BufReader::new(file);
        let mut header = [0u8; 44];
        file.read_exact(&mut header)
            .map_err(|e| format!("Invalid meeting WAV header: {e}"))?;
        let u16_at = |i| u16::from_le_bytes([header[i], header[i + 1]]);
        let u32_at = |i| u32::from_le_bytes(header[i..i + 4].try_into().unwrap());
        // Exactly the canonical layout produced by both Pace capture owners.
        // No generic RIFF chunk scanning: later metadata chunks must never become PCM.
        if &header[..4] != b"RIFF"
            || &header[8..16] != b"WAVEfmt "
            || u32_at(16) != 16
            || u16_at(20) != 1
            || u16_at(22) != 1
            || u32_at(24) != RATE as u32
            || u32_at(28) != RATE as u32 * 2
            || u16_at(32) != 2
            || u16_at(34) != 16
            || &header[36..40] != b"data"
            || u32_at(40) % 2 != 0
        {
            return Err(
                "Echo cancellation needs Pace's canonical mono16k PCM16 WAV tracks.".into(),
            );
        }
        let declared = u32_at(40) as u64;
        if u32_at(4) as u64 + 8 != declared + 44 {
            return Err(
                "Echo reference contains unsupported RIFF chunks or an incomplete header update."
                    .into(),
            );
        }
        let physical = bytes.saturating_sub(44);
        if declared > physical {
            return Err("Meeting echo reference is truncated.".into());
        }
        // Only trusted active Pace system tracks may extend beyond their stale
        // RIFF length. Fixed/foreign files always honor the declared data boundary.
        let frames = if growing { physical / 2 } else { declared / 2 };
        if frames > MAX_OFFSET_MS * 16 {
            return Err("Meeting WAV is too long for echo cancellation.".into());
        }
        Ok(Self {
            file,
            frames,
            next_frame: 0,
        })
    }

    fn frame(&mut self, first: i64, output: &mut [f32; FRAME]) -> Result<(), String> {
        output.fill(0.0);
        let skip = (-first).clamp(0, FRAME as i64) as usize;
        let first = first.max(0) as u64;
        if first >= self.frames || skip == FRAME {
            return Ok(());
        }
        let count = (self.frames - first).min((FRAME - skip) as u64) as usize;
        let mut bytes = [0u8; FRAME * 2];
        if first != self.next_frame {
            self.file
                .seek(SeekFrom::Start(44 + first * 2))
                .map_err(|e| e.to_string())?;
        }
        self.file
            .read_exact(&mut bytes[..count * 2])
            .map_err(|e| format!("Incomplete meeting PCM: {e}"))?;
        self.next_frame = first + count as u64;
        for (sample, raw) in output[skip..skip + count]
            .iter_mut()
            .zip(bytes[..count * 2].chunks_exact(2))
        {
            *sample = i16::from_le_bytes([raw[0], raw[1]]) as f32 / 32768.0;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_reference_skips_processing_and_growing_length_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let mic = dir.path().join("microphone.wav");
        let reference = dir.path().join("system.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        for path in [&mic, &reference] {
            let mut writer = hound::WavWriter::create(path, spec).unwrap();
            for _ in 0..16000 {
                writer.write_sample(100i16).unwrap();
            }
            writer.finalize().unwrap();
        }
        let original = std::fs::read(&mic).unwrap();
        let result = clean_microphone(
            &mic,
            &reference,
            1000,
            0,
            EchoOptions::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(result.cleaned.is_none());
        assert_eq!(result.metadata["status"], "reference-unavailable");
        assert_eq!(std::fs::read(&mic).unwrap(), original);
        // Emulate only our active writer's stale data length, not arbitrary RIFFs.
        let mut bytes = std::fs::read(&reference).unwrap();
        bytes[4..8].copy_from_slice(&36u32.to_le_bytes());
        bytes[40..44].copy_from_slice(&0u32.to_le_bytes());
        std::fs::write(&reference, &bytes).unwrap();
        assert_eq!(Pcm::open(&reference, false).unwrap().frames, 0);
        assert_eq!(Pcm::open(&reference, true).unwrap().frames, 16000);
        assert!(Pcm::open(&mic, true).is_err());
        assert!(offset_frames(u64::MAX).is_err());
        assert!(clean_microphone(
            &mic,
            &reference,
            0,
            0,
            EchoOptions {
                allow_growing_reference: true,
                ..Default::default()
            },
            &AtomicBool::new(true)
        )
        .is_err());
    }
}
