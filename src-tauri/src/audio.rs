//! Portable microphone and whole-system capture. Only the owner thread touches CPAL streams or files.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{FftFixedInOut, Resampler};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Seek, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, AtomicU8, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TryRecvError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const OUTPUT_RATE: u32 = 16_000;
const CHUNK_FRAMES: usize = 1024;
// At most 512 KiB of queued mono PCM; never let a slow disk grow recording memory.
const QUEUED_CHUNKS: usize = 128;
const CHUNK_SECONDS: u64 = 12;
const MAX_PENDING_CHUNKS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Microphone,
    System,
}

impl Source {
    pub fn track(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system",
        }
    }
}

struct StartRequest {
    directory: PathBuf,
    session_id: Option<String>,
    source: Source,
    origin: Instant,
}
const OVERFLOW: u8 = 1;
const DISCONNECTED: u8 = 2;
const INVALID_PCM: u8 = 3;
const DEVICE_ERROR: u8 = 4;

#[derive(Default)]
struct StreamWarnings {
    counts: [AtomicU32; 3],
}

impl StreamWarnings {
    fn record(&self, kind: cpal::ErrorKind) -> bool {
        let index = match kind {
            cpal::ErrorKind::Xrun => 0,
            cpal::ErrorKind::DeviceChanged => 1,
            cpal::ErrorKind::RealtimeDenied => 2,
            _ => return false,
        };
        let _ = self.counts[index].fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
            Some(count.saturating_add(1))
        });
        true
    }

    fn value(&self) -> Value {
        json!({"xruns":self.counts[0].load(Ordering::Relaxed),"deviceChanges":self.counts[1].load(Ordering::Relaxed),"realtimeDenied":self.counts[2].load(Ordering::Relaxed)})
    }
}

type Reply = Sender<Result<Value, String>>;

enum Command {
    Start(StartRequest, Reply),
    Chunks(Sender<Result<Vec<Value>, String>>),
    Stop(Reply),
    Status(Reply),
    Shutdown,
}

pub struct AudioCapture {
    commands: Sender<Command>,
    owner: Option<JoinHandle<()>>,
}

impl AudioCapture {
    pub fn new() -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let owner = thread::Builder::new()
            .name("pace-audio".into())
            .spawn(move || run(receiver, None))
            .map_err(|error| format!("Could not start audio worker: {error}"))?;
        Ok(Self {
            commands,
            owner: Some(owner),
        })
    }

    // Run these blocking requests outside Tauri's async executor thread.
    pub fn start(&self, output_dir: PathBuf) -> Result<Value, String> {
        self.request(|reply| {
            Command::Start(
                StartRequest {
                    directory: output_dir,
                    session_id: None,
                    source: Source::Microphone,
                    origin: Instant::now(),
                },
                reply,
            )
        })
    }

    pub fn start_track_at(
        &self,
        directory: PathBuf,
        session_id: String,
        source: Source,
        origin: Instant,
    ) -> Result<Value, String> {
        if session_id.trim().is_empty() {
            return Err("Audio session ID must not be empty".into());
        }
        self.request(|reply| {
            Command::Start(
                StartRequest {
                    directory,
                    session_id: Some(session_id),
                    source,
                    origin,
                },
                reply,
            )
        })
    }

    pub fn take_chunks(&self) -> Result<Vec<Value>, String> {
        self.request(Command::Chunks)
    }

    pub fn stop(&self) -> Result<Value, String> {
        self.request(Command::Stop)
    }

    pub fn status(&self) -> Result<Value, String> {
        self.request(Command::Status)
    }

    fn request<T>(
        &self,
        command: impl FnOnce(Sender<Result<T, String>>) -> Command,
    ) -> Result<T, String> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(command(reply))
            .map_err(|_| "Audio worker stopped".to_string())?;
        receiver
            .recv()
            .map_err(|_| "Audio worker stopped before replying".to_string())?
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(owner) = self.owner.take() {
            if owner.join().is_err() {
                eprintln!("Audio worker panicked; recording may need recovery");
            }
        }
    }
}

struct Completion {
    value: Value,
    error: Option<String>,
    chunks: Vec<Value>,
}

impl Completion {
    fn result(&self) -> Result<Value, String> {
        match &self.error {
            Some(error) => Err(error.clone()),
            None => Ok(self.value.clone()),
        }
    }
}

fn run(commands: Receiver<Command>, mut recording: Option<Recording>) {
    let mut last: Option<Completion> = None;
    loop {
        let command = commands.recv_timeout(Duration::from_millis(5));
        if let Some(active) = recording.as_mut() {
            active.pump();
            if active.error.is_some() {
                last = recording.take().map(Recording::finish);
            }
        }
        match command {
            Ok(Command::Start(request, reply)) => {
                let result = if let Some(active) = recording.as_ref() {
                    if active.source != request.source
                        || request
                            .session_id
                            .as_ref()
                            .is_some_and(|id| id != &active.session_id)
                    {
                        Err("This audio handle is already recording another track/session".into())
                    } else {
                        Ok(active.status())
                    }
                } else if last.as_ref().is_some_and(|last| !last.chunks.is_empty()) {
                    Err(
                        "Retrieve the previous recording chunks before starting another recording"
                            .into(),
                    )
                } else {
                    Recording::start(request).map(|active| {
                        let value = active.status();
                        recording = Some(active);
                        last = None;
                        value
                    })
                };
                let _ = reply.send(result);
            }
            Ok(Command::Stop(reply)) => {
                if let Some(active) = recording.take() {
                    last = Some(active.finish());
                }
                let _ = reply.send(
                    last.as_ref()
                        .map(Completion::result)
                        .unwrap_or_else(|| Ok(json!({"recording":false}))),
                );
            }
            Ok(Command::Chunks(reply)) => {
                let chunks = match recording.as_mut() {
                    Some(active) => active.sink.take_chunks(),
                    None => last
                        .as_mut()
                        .map(|last| std::mem::take(&mut last.chunks))
                        .unwrap_or_default(),
                };
                let _ = reply.send(Ok(chunks));
            }
            Ok(Command::Status(reply)) => {
                let value = recording
                    .as_ref()
                    .map(Recording::status)
                    .or_else(|| last.as_ref().map(|last| last.value.clone()))
                    .unwrap_or_else(|| json!({"recording":false}));
                let _ = reply.send(Ok(value));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(active) = recording.take() {
                    if let Some(error) = active.finish().error {
                        eprintln!("{error}");
                    }
                }
                break;
            }
        }
    }
}

enum AudioEvent {
    CapturedAt(Instant),
    Pcm(Vec<f32>),
    Error(String),
}

struct Recording {
    stream: Option<cpal::Stream>,
    receiver: Receiver<AudioEvent>,
    failure: Arc<AtomicU8>,
    warnings: Arc<StreamWarnings>,
    sink: WavSink<BufWriter<File>>,
    session_id: String,
    path: PathBuf,
    source: Source,
    origin: Instant,
    first_frame: Option<Instant>,
    level: (f32, f32),
    level_at: Instant,
    error: Option<String>,
}

fn capture_device(source: Source) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    #[cfg(target_os = "linux")]
    let host = cpal::host_from_id(cpal::HostId::PipeWire)
        .map_err(|error| format!("PipeWire audio is unavailable: {error}"))?;
    #[cfg(not(target_os = "linux"))]
    let host = cpal::default_host();
    let device = match source {
        Source::Microphone => host.default_input_device(),
        Source::System => host.default_output_device(),
    }
    .ok_or_else(|| format!("No default {} audio device is available", source.track()))?;
    // CPAL 0.18.2 would capture a duplex output device's microphone instead of a Mac tap.
    #[cfg(target_os = "macos")]
    if source == Source::System && device.supports_input() {
        return Err("System audio capture requires an output-only default device with CPAL 0.18.2; this duplex device cannot provide a system tap safely".into());
    }
    let supported = match source {
        Source::Microphone => device.default_input_config(),
        Source::System => device.default_output_config(),
    }
    .map_err(|error| format!("Could not configure {} audio: {error}", source.track()))?;
    Ok((device, supported))
}

impl Recording {
    fn start(request: StartRequest) -> Result<Self, String> {
        let (device, supported) = capture_device(request.source)?;
        let config: cpal::StreamConfig = supported.into();
        if config.channels == 0 || config.sample_rate == 0 {
            return Err("Audio returned an invalid audio format".into());
        }
        fs::create_dir_all(&request.directory)
            .map_err(|error| format!("Could not create recordings folder: {error}"))?;
        let is_track = request.session_id.is_some();
        let session_id = request
            .session_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let path = request.directory.join(if is_track {
            format!("{}.wav", request.source.track())
        } else {
            format!("dictation-{session_id}.wav")
        });
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Could not create audio WAV: {error}"))?;
        let mut sink = WavSink::new(BufWriter::new(file), config.sample_rate)?;
        if is_track {
            sink.chunks = Some(TrackChunks::new(
                request.directory,
                session_id.clone(),
                request.source,
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(QUEUED_CHUNKS);
        let failure = Arc::new(AtomicU8::new(0));
        let warnings = Arc::new(StreamWarnings::default());
        let stream = build_stream(
            &device,
            config,
            supported.sample_format(),
            sender,
            failure.clone(),
            warnings.clone(),
        )
        .and_then(|stream| {
            stream
                .play()
                .map_err(|error| format!("Could not start audio: {error}"))?;
            Ok(stream)
        });
        match stream {
            Ok(stream) => Ok(Self {
                stream: Some(stream),
                receiver,
                failure,
                warnings,
                sink,
                session_id,
                path,
                source: request.source,
                origin: request.origin,
                first_frame: None,
                level: (0.0, 0.0),
                level_at: Instant::now(),
                error: None,
            }),
            Err(error) => {
                let finalization = sink.finish_capture().0;
                Err(match finalization {
                    Ok(_) => format!("{error}. Empty WAV preserved at {}", path.display()),
                    Err(finalization) => format!(
                        "{error}. {finalization}. WAV may need recovery at {}",
                        path.display()
                    ),
                })
            }
        }
    }

    fn status(&self) -> Value {
        let level = if self.level_at.elapsed() < Duration::from_millis(250) {
            self.level
        } else {
            (0.0, 0.0)
        };
        let offset = self
            .first_frame
            .map(|at| at.saturating_duration_since(self.origin).as_millis() as u64);
        json!({"recording":true,"sessionId":self.session_id,"wavPath":self.path,"source":self.source.track(),"track":self.source.track(),"offsetMs":offset,"level":{"rms":level.0,"peak":level.1},"warnings":self.warnings.value()})
    }

    fn consume(&mut self, event: AudioEvent) {
        if self.error.is_some() {
            return;
        }
        self.error = match event {
            AudioEvent::CapturedAt(at) => {
                match self.first_frame {
                    None => {
                        self.first_frame = Some(at);
                        if let Some(chunks) = self.sink.chunks.as_mut() {
                            chunks.offset_ms =
                                at.saturating_duration_since(self.origin).as_millis() as u64;
                        }
                        None
                    }
                    Some(first) => {
                        let expected = (at.saturating_duration_since(first).as_secs_f64()
                            * self.sink.input_rate as f64)
                            .round() as u64;
                        let gap = expected.saturating_sub(self.sink.input_frames);
                        // WASAPI loopback can deliver no packets during silence; preserve that timeline.
                        if gap > self.sink.input_rate as u64 / 20 {
                            self.sink.silence(gap).err()
                        } else {
                            None
                        }
                    }
                }
            }
            AudioEvent::Pcm(samples) => {
                if !samples.is_empty() {
                    self.level = (
                        (samples.iter().map(|x| (*x as f64).powi(2)).sum::<f64>()
                            / samples.len() as f64)
                            .sqrt() as f32,
                        samples.iter().map(|x| x.abs()).fold(0.0_f32, f32::max),
                    );
                    self.level_at = Instant::now();
                }
                self.sink.push(&samples).err()
            }
            AudioEvent::Error(error) => Some(format!("Audio stream failed: {error}")),
        };
    }

    fn pump(&mut self) {
        // Bounded work lets stop/status requests run even while the microphone produces samples.
        for _ in 0..QUEUED_CHUNKS {
            match self.receiver.try_recv() {
                Ok(event) => self.consume(event),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.error
                        .get_or_insert_with(|| "Audio sample stream disconnected".into());
                    break;
                }
            }
        }
        self.check_failure();
    }

    fn check_failure(&mut self) {
        if let Some(error) = callback_failure(self.failure.load(Ordering::Acquire)) {
            self.error.get_or_insert_with(|| error.into());
        }
    }

    fn finish(mut self) -> Completion {
        // Stop callbacks before draining, so the final queued frames cannot race finalization.
        drop(self.stream.take());
        while let Ok(event) = self.receiver.try_recv() {
            self.consume(event);
        }
        self.check_failure();
        let (finalized, chunks) = self.sink.finish_capture();
        let offset = self
            .first_frame
            .map(|at| at.saturating_duration_since(self.origin).as_millis() as u64)
            .unwrap_or(0);
        match finalized {
            Ok(frames) => {
                if frames == 0 {
                    self.error
                        .get_or_insert_with(|| "No captured audio was captured".into());
                }
                let error = self
                    .error
                    .map(|error| format!("{error}. Audio saved at {}", self.path.display()));
                Completion {
                    value: json!({"recording":false,"sessionId":self.session_id,"wavPath":self.path,"duration":frames as f64 / OUTPUT_RATE as f64,"durationMs":frames * 1000 / OUTPUT_RATE as u64,"frames":frames,"source":self.source.track(),"track":self.source.track(),"offsetMs":offset,"level":{"rms":0.0,"peak":0.0},"warnings":self.warnings.value(),"error":error}),
                    error,
                    chunks,
                }
            }
            Err(error) => {
                let error = format!(
                    "{}Could not finalize audio WAV: {error}. Audio may need recovery at {}",
                    self.error
                        .map(|error| format!("{error}. "))
                        .unwrap_or_default(),
                    self.path.display()
                );
                Completion {
                    value: json!({"recording":false,"sessionId":self.session_id,"wavPath":self.path,"warnings":self.warnings.value(),"error":error}),
                    error: Some(error),
                    chunks,
                }
            }
        }
    }
}

fn callback_failure(code: u8) -> Option<&'static str> {
    match code {
        0 => None,
        OVERFLOW => Some(
            "Audio recording fell behind; the bounded audio queue overflowed and capture stopped",
        ),
        DISCONNECTED => Some("Audio sample consumer disconnected"),
        INVALID_PCM => Some("Audio supplied malformed or non-finite audio"),
        _ => Some("Audio device reported a stream error"),
    }
}

fn fail(failure: &AtomicU8, code: u8) {
    let _ = failure.compare_exchange(0, code, Ordering::AcqRel, Ordering::Acquire);
}

fn enqueue<T>(data: &[T], channels: usize, sender: &SyncSender<AudioEvent>, failure: &AtomicU8)
where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    if failure.load(Ordering::Acquire) != 0 {
        return;
    }
    if channels == 0 || !data.len().is_multiple_of(channels) {
        fail(failure, INVALID_PCM);
        return;
    }
    for block in data.chunks(CHUNK_FRAMES * channels) {
        let mut mono = Vec::with_capacity(block.len() / channels);
        for frame in block.chunks_exact(channels) {
            let sample = frame
                .iter()
                .map(|&sample| <f32 as cpal::Sample>::from_sample(sample) / channels as f32)
                .sum::<f32>();
            if !sample.is_finite() {
                fail(failure, INVALID_PCM);
                return;
            }
            mono.push(sample);
        }
        if let Err(error) = sender.try_send(AudioEvent::Pcm(mono)) {
            fail(
                failure,
                match error {
                    mpsc::TrySendError::Full(_) => OVERFLOW,
                    mpsc::TrySendError::Disconnected(_) => DISCONNECTED,
                },
            );
            return;
        }
    }
}

fn capture_instant(
    anchor: &mut Option<(cpal::StreamInstant, Instant)>,
    timestamp: cpal::InputStreamTimestamp,
    now: Instant,
) -> Instant {
    let (capture, instant) = *anchor.get_or_insert_with(|| {
        let instant = now
            .checked_sub(
                timestamp
                    .callback
                    .saturating_duration_since(timestamp.capture),
            )
            .unwrap_or(now);
        (timestamp.capture, instant)
    });
    // Callback scheduling delays must not become permanent silence in the recording.
    instant
        .checked_add(timestamp.capture.saturating_duration_since(capture))
        .unwrap_or(instant)
}

fn handle_stream_error(
    error: cpal::Error,
    sender: &SyncSender<AudioEvent>,
    failure: &AtomicU8,
    warnings: &StreamWarnings,
) {
    // These CPAL notifications leave the stream active; timestamp gaps retain missing audio time.
    if warnings.record(error.kind()) {
        return;
    }
    fail(failure, DEVICE_ERROR);
    let _ = sender.try_send(AudioEvent::Error(error.to_string()));
}

fn build_stream(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    format: cpal::SampleFormat,
    sender: SyncSender<AudioEvent>,
    failure: Arc<AtomicU8>,
    warnings: Arc<StreamWarnings>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let error_sender = sender.clone();
    let error_failure = failure.clone();
    let on_error = move |error: cpal::Error| {
        handle_stream_error(error, &error_sender, &error_failure, &warnings);
    };
    macro_rules! stream {
        ($sample:ty) => {{
            let mut clock_anchor = None;
            device.build_input_stream(
                config,
                move |data: &[$sample], info: &cpal::InputCallbackInfo| {
                    if !data.is_empty() && failure.load(Ordering::Acquire) == 0 {
                        let at =
                            capture_instant(&mut clock_anchor, info.timestamp(), Instant::now());
                        if let Err(error) = sender.try_send(AudioEvent::CapturedAt(at)) {
                            fail(
                                &failure,
                                match error {
                                    mpsc::TrySendError::Full(_) => OVERFLOW,
                                    mpsc::TrySendError::Disconnected(_) => DISCONNECTED,
                                },
                            );
                            return;
                        }
                    }
                    enqueue(data, channels, &sender, &failure);
                },
                on_error,
                Some(Duration::from_secs(3)),
            )
        }};
    }
    let stream = match format {
        cpal::SampleFormat::I8 => stream!(i8),
        cpal::SampleFormat::I16 => stream!(i16),
        cpal::SampleFormat::I24 => stream!(cpal::I24),
        cpal::SampleFormat::I32 => stream!(i32),
        cpal::SampleFormat::I64 => stream!(i64),
        cpal::SampleFormat::U8 => stream!(u8),
        cpal::SampleFormat::U16 => stream!(u16),
        cpal::SampleFormat::U24 => stream!(cpal::U24),
        cpal::SampleFormat::U32 => stream!(u32),
        cpal::SampleFormat::U64 => stream!(u64),
        cpal::SampleFormat::F32 => stream!(f32),
        cpal::SampleFormat::F64 => stream!(f64),
        other => return Err(format!("Unsupported audio sample format: {other}")),
    };
    stream.map_err(|error| format!("Could not open audio stream: {error}"))
}

struct WavSink<W: Write + Seek> {
    writer: hound::WavWriter<W>,
    resampler: Option<FftFixedInOut<f32>>,
    pending: Vec<f32>,
    skip: usize,
    input_rate: u32,
    input_frames: u64,
    written_frames: u64,
    chunks: Option<TrackChunks>,
}

impl<W: Write + Seek> WavSink<W> {
    fn new(writer: W, input_rate: u32) -> Result<Self, String> {
        if input_rate == 0 {
            return Err("Invalid audio sample rate".into());
        }
        let resampler = if input_rate == OUTPUT_RATE {
            None
        } else {
            let mut resampler =
                FftFixedInOut::new(input_rate as usize, OUTPUT_RATE as usize, CHUNK_FRAMES, 1)
                    .map_err(|error| format!("Could not create audio resampler: {error}"))?;
            // An even input block keeps the FIR delay on an exact output sample at 44.1 kHz.
            if !resampler.input_frames_next().is_multiple_of(2) {
                resampler = FftFixedInOut::new(
                    input_rate as usize,
                    OUTPUT_RATE as usize,
                    resampler.input_frames_next() + 1,
                    1,
                )
                .map_err(|error| format!("Could not create audio resampler: {error}"))?;
            }
            Some(resampler)
        };
        let skip = resampler.as_ref().map(Resampler::output_delay).unwrap_or(0);
        let writer = hound::WavWriter::new(
            writer,
            hound::WavSpec {
                channels: 1,
                sample_rate: OUTPUT_RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|error| format!("Could not write audio WAV header: {error}"))?;
        Ok(Self {
            writer,
            resampler,
            pending: Vec::new(),
            skip,
            input_rate,
            input_frames: 0,
            written_frames: 0,
            chunks: None,
        })
    }

    fn target_frames(&self) -> u64 {
        self.input_frames * OUTPUT_RATE as u64 / self.input_rate as u64
    }

    fn take_chunks(&mut self) -> Vec<Value> {
        self.chunks
            .as_mut()
            .map(|chunks| std::mem::take(&mut chunks.pending))
            .unwrap_or_default()
    }

    fn silence(&mut self, mut frames: u64) -> Result<(), String> {
        let zeros = [0.0; CHUNK_FRAMES];
        while frames > 0 {
            let count = frames.min(CHUNK_FRAMES as u64) as usize;
            self.push(&zeros[..count])?;
            frames -= count as u64;
        }
        Ok(())
    }

    fn push(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err("Non-finite audio PCM".into());
        }
        if self.target_frames() + samples.len() as u64 * OUTPUT_RATE as u64 / self.input_rate as u64
            > (u32::MAX as u64 - 44) / 2
        {
            return Err("Audio recording reached the WAV size limit".into());
        }
        self.input_frames += samples.len() as u64;
        if self.resampler.is_none() {
            return self.write(samples);
        }
        let chunk_size = self.resampler.as_ref().unwrap().input_frames_next();
        for block in samples.chunks(CHUNK_FRAMES) {
            self.pending.extend_from_slice(block);
            while self.pending.len() >= chunk_size {
                let output = self
                    .resampler
                    .as_mut()
                    .unwrap()
                    .process(&[&self.pending[..chunk_size]], None)
                    .map_err(|error| format!("Audio resampling failed: {error}"))?;
                self.pending.drain(..chunk_size);
                self.write(&output[0])?;
            }
        }
        Ok(())
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        let skip = self.skip.min(samples.len());
        self.skip -= skip;
        let count = (self.target_frames() - self.written_frames).min((samples.len() - skip) as u64)
            as usize;
        for &sample in &samples[skip..skip + count] {
            let pcm = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            self.writer
                .write_sample(pcm)
                .map_err(|error| format!("Could not write captured audio: {error}"))?;
            self.written_frames += 1;
            if let Some(chunks) = self.chunks.as_mut() {
                if chunks.push(pcm)? {
                    self.writer
                        .flush()
                        .map_err(|error| format!("Could not flush recording WAV: {error}"))?;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn finish(self) -> Result<u64, String> {
        self.finish_capture().0
    }

    fn finish_capture(mut self) -> (Result<u64, String>, Vec<Value>) {
        let flush = (|| {
            if self.resampler.is_some() {
                let output = self
                    .resampler
                    .as_mut()
                    .unwrap()
                    .process_partial(Some(&[&self.pending[..]]), None)
                    .map_err(|error| error.to_string())?;
                self.write(&output[0])?;
                // Drain filter delay and pad only the final incomplete input block.
                while self.written_frames < self.target_frames() {
                    let output = self
                        .resampler
                        .as_mut()
                        .unwrap()
                        .process_partial::<&[f32]>(None, None)
                        .map_err(|error| error.to_string())?;
                    self.write(&output[0])?;
                }
            }
            Ok::<_, String>(())
        })();
        let tail = self
            .chunks
            .as_mut()
            .map(TrackChunks::finish)
            .unwrap_or(Ok(()));
        let chunks = self.take_chunks();
        let finalize = self
            .writer
            .finalize()
            .map_err(|error| format!("Could not finalize WAV header: {error}"));
        let errors = [flush.err(), finalize.err(), tail.err()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        (
            if errors.is_empty() {
                Ok(self.written_frames)
            } else {
                Err(errors.join("; "))
            },
            chunks,
        )
    }
}

struct TrackChunks {
    directory: PathBuf,
    session_id: String,
    source: Source,
    offset_ms: u64,
    frames: u64,
    chunk_start: u64,
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    pending: Vec<Value>,
}

impl TrackChunks {
    fn new(directory: PathBuf, session_id: String, source: Source) -> Self {
        Self {
            directory,
            session_id,
            source,
            offset_ms: 0,
            frames: 0,
            chunk_start: 0,
            writer: None,
            pending: Vec::new(),
        }
    }

    fn path(&self) -> PathBuf {
        self.directory
            .join(format!("{}-{}.wav", self.source.track(), self.chunk_start))
    }

    fn push(&mut self, pcm: i16) -> Result<bool, String> {
        if self.writer.is_none() {
            if self.pending.len() >= MAX_PENDING_CHUNKS {
                return Err(
                    "Audio chunk consumer fell behind; retrieve pending chunks before continuing"
                        .into(),
                );
            }
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path())
                .map_err(|error| format!("Could not create audio chunk: {error}"))?;
            self.writer = Some(
                hound::WavWriter::new(
                    BufWriter::new(file),
                    hound::WavSpec {
                        channels: 1,
                        sample_rate: OUTPUT_RATE,
                        bits_per_sample: 16,
                        sample_format: hound::SampleFormat::Int,
                    },
                )
                .map_err(|error| format!("Could not write audio chunk header: {error}"))?,
            );
        }
        self.writer
            .as_mut()
            .unwrap()
            .write_sample(pcm)
            .map_err(|error| format!("Could not write audio chunk: {error}"))?;
        self.frames += 1;
        if self.frames - self.chunk_start == OUTPUT_RATE as u64 * CHUNK_SECONDS {
            self.finish()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn finish(&mut self) -> Result<(), String> {
        if let Some(writer) = self.writer.take() {
            writer
                .finalize()
                .map_err(|error| format!("Could not finalize audio chunk: {error}"))?;
            let start = self.offset_ms + self.chunk_start * 1000 / OUTPUT_RATE as u64;
            let end = self.offset_ms + self.frames * 1000 / OUTPUT_RATE as u64;
            self.pending.push(json!({"sessionId":self.session_id,"path":self.path(),"track":self.source.track(),"startMs":start,"endMs":end,"start":self.offset_ms as f64 / 1000.0 + self.chunk_start as f64 / OUTPUT_RATE as f64,"end":self.offset_ms as f64 / 1000.0 + self.frames as f64 / OUTPUT_RATE as f64}));
            self.chunk_start = self.frames;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn capture_handle_is_send_and_sync_and_idle_stop_is_idempotent() {
        fn require_send_sync<T: Send + Sync>() {}
        require_send_sync::<AudioCapture>();
        let capture = AudioCapture::new().unwrap();
        assert_eq!(capture.status().unwrap()["recording"], false);
        assert_eq!(capture.stop().unwrap(), capture.stop().unwrap());
    }

    fn synthetic_capture(
        path: PathBuf,
        failure: Arc<AtomicU8>,
    ) -> (AudioCapture, SyncSender<AudioEvent>) {
        synthetic_capture_for(path, failure, Source::Microphone, Instant::now(), false)
    }

    fn synthetic_capture_for(
        path: PathBuf,
        failure: Arc<AtomicU8>,
        source: Source,
        origin: Instant,
        chunked: bool,
    ) -> (AudioCapture, SyncSender<AudioEvent>) {
        synthetic_capture_with_warnings(
            path,
            failure,
            source,
            origin,
            chunked,
            Arc::new(StreamWarnings::default()),
        )
    }

    fn synthetic_capture_with_warnings(
        path: PathBuf,
        failure: Arc<AtomicU8>,
        source: Source,
        origin: Instant,
        chunked: bool,
        warnings: Arc<StreamWarnings>,
    ) -> (AudioCapture, SyncSender<AudioEvent>) {
        let (commands, receiver) = mpsc::channel();
        let (sender, pcm) = mpsc::sync_channel(QUEUED_CHUNKS);
        let owner = thread::spawn(move || {
            let mut sink =
                WavSink::new(BufWriter::new(File::create(&path).unwrap()), OUTPUT_RATE).unwrap();
            if chunked {
                sink.chunks = Some(TrackChunks::new(
                    path.parent().unwrap().to_path_buf(),
                    "fixture-session".into(),
                    source,
                ));
            }
            let recording = Recording {
                stream: None,
                receiver: pcm,
                failure,
                warnings,
                sink,
                session_id: "fixture-session".into(),
                path,
                source,
                origin,
                first_frame: None,
                level: (0.0, 0.0),
                level_at: Instant::now(),
                error: None,
            };
            run(receiver, Some(recording));
        });
        (
            AudioCapture {
                commands,
                owner: Some(owner),
            },
            sender,
        )
    }

    #[test]
    fn simultaneous_tracks_keep_their_files_offsets_chunks_and_levels_separate() {
        let dir = tempfile::tempdir().unwrap();
        let origin = Instant::now();
        let (mic, mic_pcm) = synthetic_capture_for(
            dir.path().join("microphone.wav"),
            Arc::new(AtomicU8::new(0)),
            Source::Microphone,
            origin,
            true,
        );
        let (system, system_pcm) = synthetic_capture_for(
            dir.path().join("system.wav"),
            Arc::new(AtomicU8::new(0)),
            Source::System,
            origin,
            true,
        );
        let frames = OUTPUT_RATE as usize * CHUNK_SECONDS as usize;
        mic_pcm
            .send(AudioEvent::CapturedAt(origin + Duration::from_millis(125)))
            .unwrap();
        mic_pcm
            .send(AudioEvent::Pcm(vec![0.5; frames + 37]))
            .unwrap();
        system_pcm
            .send(AudioEvent::CapturedAt(origin + Duration::from_millis(250)))
            .unwrap();
        system_pcm
            .send(AudioEvent::Pcm(vec![-0.25; frames + 79]))
            .unwrap();
        let status = mic.status().unwrap();
        assert_eq!(status["offsetMs"], 125);
        assert_eq!(status["level"]["rms"], 0.5);
        assert_eq!(status["level"]["peak"], 0.5);
        assert!(mic
            .start_track_at(
                dir.path().to_path_buf(),
                "another-session".into(),
                Source::System,
                origin
            )
            .is_err());
        let first = mic.take_chunks().unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["track"], "microphone");
        assert_eq!(first[0]["startMs"], 125);
        assert_eq!(first[0]["endMs"], 12_125);
        let stopped = mic.stop().unwrap();
        assert_eq!(stopped["frames"], frames + 37);
        assert_eq!(mic.stop().unwrap(), stopped);
        let tail = mic.take_chunks().unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0]["startMs"], 12_125);
        assert_eq!(tail[0]["endMs"], 12_127);
        assert_eq!(
            hound::WavReader::open(tail[0]["path"].as_str().unwrap())
                .unwrap()
                .duration(),
            37
        );
        assert!(mic.take_chunks().unwrap().is_empty());
        system.stop().unwrap();
        let chunks = system.take_chunks().unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0]["sessionId"], "fixture-session");
        assert_eq!(chunks[0]["track"], "system");
        assert_eq!(chunks[0]["startMs"], 250);
        assert_eq!(chunks[1]["startMs"], 12_250);
        assert_eq!(chunks[1]["endMs"], 12_254);
        for (track, expected, length) in [
            ("microphone", 16_384, frames + 37),
            ("system", -8192, frames + 79),
        ] {
            let samples = hound::WavReader::open(dir.path().join(format!("{track}.wav")))
                .unwrap()
                .into_samples::<i16>()
                .map(Result::unwrap)
                .collect::<Vec<_>>();
            assert_eq!(samples.len(), length);
            assert!(samples.into_iter().all(|sample| sample == expected));
        }
    }

    #[test]
    fn delayed_callbacks_do_not_add_silence_when_capture_timestamps_are_regular() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.wav");
        let origin = Instant::now();
        let (capture, pcm) = synthetic_capture_for(
            path.clone(),
            Arc::new(AtomicU8::new(0)),
            Source::System,
            origin,
            true,
        );
        let mut anchor = None;
        for (index, wall_ms) in [110, 320, 330, 340].into_iter().enumerate() {
            let capture_time = cpal::StreamInstant::ZERO
                .checked_add(Duration::from_millis(10_000 + index as u64 * 10))
                .unwrap();
            let timestamp = cpal::InputStreamTimestamp {
                capture: capture_time,
                callback: capture_time.checked_add(Duration::from_millis(10)).unwrap(),
            };
            let at = capture_instant(
                &mut anchor,
                timestamp,
                origin + Duration::from_millis(wall_ms),
            );
            assert_eq!(at, origin + Duration::from_millis(100 + index as u64 * 10));
            pcm.send(AudioEvent::CapturedAt(at)).unwrap();
            pcm.send(AudioEvent::Pcm(vec![0.5; 160])).unwrap();
        }
        let stopped = capture.stop().unwrap();
        assert_eq!(stopped["frames"], 640);
        let chunks = capture.take_chunks().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["startMs"], 100);
        assert_eq!(chunks[0]["endMs"], 140);
        let samples = hound::WavReader::open(path)
            .unwrap()
            .into_samples::<i16>()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert_eq!(samples.len(), 640);
        assert!(samples.into_iter().all(|sample| sample == 16_384));
    }

    #[test]
    fn timestamp_gaps_remain_silence_in_archive_and_chunk_timeline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.wav");
        let origin = Instant::now();
        let (capture, pcm) = synthetic_capture_for(
            path.clone(),
            Arc::new(AtomicU8::new(0)),
            Source::System,
            origin,
            true,
        );
        pcm.send(AudioEvent::CapturedAt(origin + Duration::from_millis(100)))
            .unwrap();
        pcm.send(AudioEvent::Pcm(vec![0.5; 160])).unwrap();
        pcm.send(AudioEvent::CapturedAt(
            origin + Duration::from_millis(1_100),
        ))
        .unwrap();
        pcm.send(AudioEvent::Pcm(vec![0.25; 160])).unwrap();
        let stopped = capture.stop().unwrap();
        assert_eq!(stopped["frames"], 16_160);
        let chunks = capture.take_chunks().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["startMs"], 100);
        assert_eq!(chunks[0]["endMs"], 1_110);
        let samples = hound::WavReader::open(path)
            .unwrap()
            .into_samples::<i16>()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert!(samples[160..16_000].iter().all(|sample| *sample == 0));
        assert_eq!(samples[16_000], 8192);
    }

    #[test]
    fn chunk_creation_and_pending_consumer_failures_reach_stop_without_losing_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.wav");
        let origin = Instant::now();
        let (capture, pcm) = synthetic_capture_for(
            path.clone(),
            Arc::new(AtomicU8::new(0)),
            Source::System,
            origin,
            true,
        );
        fs::create_dir(dir.path().join("system-0.wav")).unwrap();
        pcm.send(AudioEvent::Pcm(vec![0.5; 160])).unwrap();
        let error = capture.stop().unwrap_err();
        assert!(error.contains("Could not create audio chunk"));
        assert!(error.contains(path.to_str().unwrap()));
        assert_eq!(capture.stop().unwrap_err(), error);
        assert_eq!(hound::WavReader::open(path).unwrap().duration(), 1);
        let mut chunks = TrackChunks::new(
            dir.path().to_path_buf(),
            "fixture".into(),
            Source::Microphone,
        );
        chunks.pending = vec![json!({}); MAX_PENDING_CHUNKS];
        assert!(chunks.push(1).unwrap_err().contains("consumer fell behind"));
    }

    #[test]
    fn stop_drains_early_audio_and_returns_the_same_completed_session_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.wav");
        let (capture, sender) = synthetic_capture(path.clone(), Arc::new(AtomicU8::new(0)));
        sender.send(AudioEvent::Pcm(vec![0.5; 37])).unwrap();
        assert_eq!(
            capture.start(dir.path().to_path_buf()).unwrap()["sessionId"],
            "fixture-session"
        );
        let stopped = capture.stop().unwrap();
        assert_eq!(stopped["recording"], false);
        assert_eq!(stopped["sessionId"], "fixture-session");
        assert_eq!(stopped["duration"], 37.0 / OUTPUT_RATE as f64);
        assert_eq!(capture.stop().unwrap(), stopped);
        assert_eq!(capture.status().unwrap(), stopped);
        assert_eq!(hound::WavReader::open(path).unwrap().duration(), 37);
    }

    #[test]
    fn recoverable_notifications_keep_recording_later_pcm_and_report_bounded_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recoverable.wav");
        let failure = Arc::new(AtomicU8::new(0));
        let warnings = Arc::new(StreamWarnings::default());
        let (capture, sender) = synthetic_capture_with_warnings(
            path.clone(),
            failure.clone(),
            Source::Microphone,
            Instant::now(),
            false,
            warnings.clone(),
        );
        enqueue(&[0.5_f32; 170], 1, &sender, &failure);
        for kind in [
            cpal::ErrorKind::Xrun,
            cpal::ErrorKind::DeviceChanged,
            cpal::ErrorKind::RealtimeDenied,
        ] {
            handle_stream_error(cpal::Error::new(kind), &sender, &failure, &warnings);
        }
        enqueue(&[0.25_f32; 1600], 1, &sender, &failure);
        assert_eq!(failure.load(Ordering::Acquire), 0);
        let status = capture.status().unwrap();
        assert_eq!(status["recording"], true);
        assert_eq!(
            status["warnings"],
            json!({"xruns":1,"deviceChanges":1,"realtimeDenied":1})
        );
        let stopped = capture.stop().unwrap();
        assert_eq!(stopped["frames"], 1770);
        assert_eq!(stopped["warnings"], status["warnings"]);
        assert!(stopped["error"].is_null());
        let samples = hound::WavReader::open(path)
            .unwrap()
            .into_samples::<i16>()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert_eq!(samples.len(), 1770);
        assert!(samples[..170].iter().all(|sample| *sample == 16384));
        assert!(samples[170..].iter().all(|sample| *sample == 8192));
        warnings.counts[0].store(u32::MAX, Ordering::Relaxed);
        assert!(warnings.record(cpal::ErrorKind::Xrun));
        assert_eq!(warnings.counts[0].load(Ordering::Relaxed), u32::MAX);
    }

    #[test]
    fn device_disconnect_is_still_fatal_and_preserves_the_captured_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disconnected.wav");
        let failure = Arc::new(AtomicU8::new(0));
        let warnings = Arc::new(StreamWarnings::default());
        let (capture, sender) = synthetic_capture_with_warnings(
            path.clone(),
            failure.clone(),
            Source::Microphone,
            Instant::now(),
            false,
            warnings.clone(),
        );
        enqueue(&[0.5_f32; 170], 1, &sender, &failure);
        handle_stream_error(
            cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable),
            &sender,
            &failure,
            &warnings,
        );
        assert_eq!(failure.load(Ordering::Acquire), DEVICE_ERROR);
        assert!(capture.stop().unwrap_err().contains(path.to_str().unwrap()));
        assert_eq!(hound::WavReader::open(path).unwrap().duration(), 170);
        assert_eq!(
            capture.status().unwrap()["warnings"],
            json!({"xruns":0,"deviceChanges":0,"realtimeDenied":0})
        );
        for kind in [
            cpal::ErrorKind::PermissionDenied,
            cpal::ErrorKind::InvalidInput,
            cpal::ErrorKind::UnsupportedConfig,
            cpal::ErrorKind::StreamInvalidated,
            cpal::ErrorKind::Other,
        ] {
            assert!(!warnings.record(kind));
        }
    }

    #[test]
    fn worker_failure_preserves_partial_wav_and_remains_an_error_on_repeated_stop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("failed.wav");
        let failure = Arc::new(AtomicU8::new(0));
        let (capture, sender) = synthetic_capture(path.clone(), failure.clone());
        sender.send(AudioEvent::Pcm(vec![0.25; 37])).unwrap();
        fail(&failure, OVERFLOW);
        let error = capture.stop().unwrap_err();
        assert!(error.contains("overflowed"));
        assert!(error.contains(path.to_str().unwrap()));
        assert_eq!(capture.stop().unwrap_err(), error);
        assert_eq!(capture.status().unwrap()["recording"], false);
        assert_eq!(capture.status().unwrap()["error"], error);
        assert_eq!(hound::WavReader::open(path).unwrap().duration(), 37);
    }

    #[test]
    fn dropping_handle_finalizes_queued_audio_without_a_stop_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shutdown.wav");
        let (capture, sender) = synthetic_capture(path.clone(), Arc::new(AtomicU8::new(0)));
        sender.send(AudioEvent::Pcm(vec![0.25; 37])).unwrap();
        drop(capture);
        assert_eq!(hound::WavReader::open(path).unwrap().duration(), 37);
    }

    #[test]
    fn first_frames_and_tail_are_preserved_in_mono_pcm16_wav() {
        let mut bytes = Cursor::new(Vec::new());
        let mut sink = WavSink::new(&mut bytes, OUTPUT_RATE).unwrap();
        sink.push(&[0.5, -0.5, 1.0, -1.0]).unwrap();
        assert_eq!(sink.finish().unwrap(), 4);
        bytes.set_position(0);
        let mut reader = hound::WavReader::new(bytes).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, OUTPUT_RATE);
        assert_eq!(reader.spec().bits_per_sample, 16);
        assert_eq!(
            reader
                .samples::<i16>()
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            [16384, -16384, 32767, -32767]
        );
    }

    fn tone(rate: u32, frames: usize, hz: f32) -> Vec<f32> {
        (0..frames)
            .map(|i| (std::f32::consts::TAU * hz * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn resampled(rate: u32, samples: &[f32], split: usize) -> Vec<i16> {
        let mut bytes = Cursor::new(Vec::new());
        let mut sink = WavSink::new(&mut bytes, rate).unwrap();
        for block in samples.chunks(split) {
            sink.push(block).unwrap();
        }
        assert_eq!(
            sink.finish().unwrap(),
            samples.len() as u64 * OUTPUT_RATE as u64 / rate as u64
        );
        bytes.set_position(0);
        hound::WavReader::new(bytes)
            .unwrap()
            .into_samples::<i16>()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn resamples_44100_and_48000_with_delay_compensated_and_tail_flushed() {
        for rate in [44_100, 48_000] {
            let input = tone(rate, rate as usize + 137, 1000.0);
            let output = resampled(rate, &input, 137);
            assert_eq!(
                output.len(),
                input.len() * OUTPUT_RATE as usize / rate as usize
            );
            let expected = tone(OUTPUT_RATE, output.len(), 1000.0);
            let error = output
                .iter()
                .zip(&expected)
                .skip(100)
                .take(output.len() - 200)
                .map(|(sample, expected)| (*sample as f32 / 32767.0 - expected).powi(2))
                .sum::<f32>()
                / (output.len() - 200) as f32;
            assert!(
                error.sqrt() < 0.003,
                "rate {rate}, RMS error {}",
                error.sqrt()
            );
            assert_eq!(output, resampled(rate, &input, 1024));
            assert_eq!(
                resampled(rate, &input[..37], 5).len(),
                37 * OUTPUT_RATE as usize / rate as usize
            );
        }
    }

    #[test]
    fn resampling_filters_out_aliasing_above_output_nyquist() {
        let input = tone(48_000, 48_000, 12_000.0);
        let output = resampled(48_000, &input, 1024);
        let peak = output
            .iter()
            .skip(500)
            .take(output.len() - 1000)
            .map(|x| x.abs())
            .max()
            .unwrap();
        assert!(peak < 100, "aliased peak {peak}");
    }

    #[test]
    fn callback_buffers_before_any_consumer_and_downmixes_channels() {
        let (sender, receiver) = mpsc::sync_channel(QUEUED_CHUNKS);
        let failure = AtomicU8::new(0);
        enqueue(&[0.5_f32, 0.25, -0.5, -0.25], 2, &sender, &failure);
        match receiver.try_recv().unwrap() {
            AudioEvent::Pcm(pcm) => assert_eq!(pcm, [0.375, -0.375]),
            _ => panic!("expected PCM"),
        }
        assert_eq!(failure.load(Ordering::Acquire), 0);
    }

    #[test]
    fn callback_overflow_and_disconnect_fail_instead_of_dropping_silently() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let failure = AtomicU8::new(0);
        enqueue(&[0.25_f32; CHUNK_FRAMES + 1], 1, &sender, &failure);
        assert_eq!(failure.load(Ordering::Acquire), OVERFLOW);
        assert!(callback_failure(OVERFLOW).unwrap().contains("overflowed"));
        drop(receiver);
        let failure = AtomicU8::new(0);
        enqueue(&[0.25_f32], 1, &sender, &failure);
        assert_eq!(failure.load(Ordering::Acquire), DISCONNECTED);
    }

    #[test]
    fn malformed_audio_is_rejected() {
        let (sender, _) = mpsc::sync_channel(1);
        for (pcm, channels) in [(&[f32::NAN][..], 1), (&[0.5][..], 2), (&[0.5][..], 0)] {
            let failure = AtomicU8::new(0);
            enqueue(pcm, channels, &sender, &failure);
            assert_eq!(failure.load(Ordering::Acquire), INVALID_PCM);
        }
        assert!(WavSink::new(Cursor::new(Vec::new()), 0).is_err());
        assert!(WavSink::new(Cursor::new(Vec::new()), OUTPUT_RATE)
            .unwrap()
            .push(&[f32::INFINITY])
            .is_err());
    }

    #[test]
    fn disk_write_and_finalize_errors_are_reported() {
        struct Broken {
            inner: Cursor<Vec<u8>>,
            bytes_left: usize,
        }
        impl Write for Broken {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.bytes_left == 0 {
                    return Err(std::io::Error::other("disk full"));
                }
                let count = self.bytes_left.min(bytes.len());
                self.bytes_left -= count;
                self.inner.write(&bytes[..count])
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl Seek for Broken {
            fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
                self.inner.seek(position)
            }
        }
        let mut sink = WavSink::new(
            Broken {
                inner: Cursor::new(Vec::new()),
                bytes_left: 46,
            },
            OUTPUT_RATE,
        )
        .unwrap();
        assert!(sink.push(&[0.5; 16]).unwrap_err().contains("disk full"));
        assert!(sink.finish().unwrap_err().contains("disk full"));
        assert!(WavSink::new(
            Broken {
                inner: Cursor::new(Vec::new()),
                bytes_left: 0
            },
            OUTPUT_RATE
        )
        .err()
        .unwrap()
        .contains("header"));
    }
}
