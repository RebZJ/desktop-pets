//! One portable capture session shared by dictation and meetings.
use crate::audio::{AudioCapture, Source};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

trait Recorder: Send + Sync {
    fn start(&self, directory: PathBuf) -> Result<Value, String>;
    fn start_track(
        &self,
        directory: PathBuf,
        id: String,
        source: Source,
        origin: Instant,
    ) -> Result<Value, String>;
    fn stop(&self) -> Result<Value, String>;
    fn status(&self) -> Result<Value, String>;
    fn chunks(&self) -> Result<Vec<Value>, String>;
}
impl Recorder for AudioCapture {
    fn start(&self, directory: PathBuf) -> Result<Value, String> {
        self.start(directory)
    }
    fn start_track(
        &self,
        directory: PathBuf,
        id: String,
        source: Source,
        origin: Instant,
    ) -> Result<Value, String> {
        self.start_track_at(directory, id, source, origin)
    }
    fn stop(&self) -> Result<Value, String> {
        self.stop()
    }
    fn status(&self) -> Result<Value, String> {
        self.status()
    }
    fn chunks(&self) -> Result<Vec<Value>, String> {
        self.take_chunks()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Dictation,
    Meeting,
    Voice,
}
impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Dictation => "dictation",
            Self::Meeting => "meeting",
            Self::Voice => "voice",
        }
    }
}
struct Session {
    mode: Mode,
    id: String,
    directory: PathBuf,
    tracks: Vec<(usize, Value)>,
}
#[derive(Default)]
struct State {
    active: Option<Session>,
    last: Option<Value>,
    pending: Vec<Value>,
}

pub struct Listening {
    recorders: [Arc<dyn Recorder>; 2],
    state: Mutex<State>,
}
impl Listening {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            recorders: [
                Arc::new(AudioCapture::new()?),
                Arc::new(AudioCapture::new()?),
            ],
            state: Mutex::new(State::default()),
        })
    }

    pub fn start_dictation(&self, output_root: PathBuf) -> Result<Value, String> {
        self.start(
            output_root,
            Mode::Dictation,
            &[0],
            uuid::Uuid::new_v4().to_string(),
            Instant::now(),
        )
    }
    pub fn start_voice(&self, output_root: PathBuf) -> Result<Value, String> {
        self.start(
            output_root,
            Mode::Voice,
            &[0],
            uuid::Uuid::new_v4().to_string(),
            Instant::now(),
        )
    }
    pub fn stop_voice(&self) -> Result<Value, String> {
        self.stop(Mode::Voice)
    }
    pub fn start_meeting(&self, output_root: PathBuf, params: Value) -> Result<Value, String> {
        self.start_meeting_at(
            output_root,
            params,
            uuid::Uuid::new_v4().to_string(),
            Instant::now(),
        )
    }
    pub fn start_meeting_at(
        &self,
        output_root: PathBuf,
        params: Value,
        id: String,
        origin: Instant,
    ) -> Result<Value, String> {
        uuid::Uuid::parse_str(&id).map_err(|_| "Invalid meeting session id")?;
        if !params.is_object() {
            return Err("Meeting capture parameters must be an object".into());
        }
        if params
            .get("applicationBundleId")
            .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
        {
            return Err("Portable capture records all system audio; selecting an application is unavailable".into());
        }
        let mut sources = Vec::new();
        for (index, key) in ["captureMicrophone", "captureSystem"].iter().enumerate() {
            match params.get(*key) {
                None | Some(Value::Bool(true)) => sources.push(index),
                Some(Value::Bool(false)) => {}
                _ => return Err(format!("{key} must be a boolean")),
            }
        }
        if sources.is_empty() {
            return Err("Choose microphone or system audio to record".into());
        }
        self.start(output_root, Mode::Meeting, &sources, id, origin)
    }
    fn start(
        &self,
        output_root: PathBuf,
        mode: Mode,
        sources: &[usize],
        id: String,
        origin: Instant,
    ) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.refresh(&mut state)?;
        if let Some(session) = &state.active {
            return Err(format!("{} is already recording", session.mode.name()));
        }
        if !state.pending.is_empty() {
            return Err(
                "Retrieve the previous meeting chunks before starting another recording".into(),
            );
        }
        let mut session = Session {
            mode,
            directory: output_root.join(&id),
            id,
            tracks: Vec::new(),
        };
        for &index in sources {
            let recorder = &self.recorders[index];
            let source = source(index);
            let started = if mode != Mode::Meeting {
                recorder.start(session.directory.clone())
            } else {
                recorder.start_track(
                    session.directory.clone(),
                    session.id.clone(),
                    source,
                    origin,
                )
            };
            match started {
                Ok(value) => {
                    if mode != Mode::Meeting {
                        session.id = value["sessionId"].as_str().unwrap_or(&session.id).into();
                    }
                    session.tracks.push((index, value));
                }
                Err(error) => {
                    // AudioCapture closes a failed start itself; only successful tracks need rollback.
                    let mut result = self.finish(&session, &mut state);
                    discard_chunks(&session.directory, std::mem::take(&mut state.pending));
                    let message = format!(
                        "{error}. Recording files preserved in {}",
                        session.directory.display()
                    );
                    append_error(&mut result, &message);
                    let error = result["error"].as_str().unwrap_or(&message).to_string();
                    state.last = Some(result);
                    return Err(error);
                }
            }
        }
        let result = snapshot(&session, true);
        state.active = Some(session);
        state.last = None;
        Ok(result)
    }
    pub fn stop_dictation(&self) -> Result<Value, String> {
        self.stop(Mode::Dictation)
    }
    pub fn stop_meeting(&self) -> Result<Value, String> {
        self.stop(Mode::Meeting)
    }
    fn stop(&self, mode: Mode) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(active) = &state.active {
            if active.mode != mode {
                return Err(format!("{} is already recording", active.mode.name()));
            }
        }
        if let Some(session) = state.active.take() {
            let result = self.finish(&session, &mut state);
            state.last = Some(result.clone());
            return Ok(result);
        }
        state
            .last
            .as_ref()
            .filter(|last| last["mode"] == mode.name())
            .cloned()
            .ok_or_else(|| format!("{} is not recording", mode.name()))
    }
    pub fn status(&self) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.refresh(&mut state)?;
        Ok(state
            .active
            .as_ref()
            .map(|session| snapshot(session, true))
            .or_else(|| state.last.clone())
            .unwrap_or_else(|| json!({"recording":false})))
    }
    pub fn take_chunks(&self) -> Result<Vec<Value>, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.refresh(&mut state)?;
        if let Some(session) = state.active.take() {
            let mut error = None;
            for &(index, _) in &session.tracks {
                match self.recorders[index].chunks() {
                    Ok(chunks) if session.mode == Mode::Meeting => state.pending.extend(chunks),
                    Ok(chunks) => discard_chunks(&session.directory, chunks),
                    Err(cause) => error = Some(cause),
                }
            }
            if let Some(error) = error {
                let mut result = self.finish(&session, &mut state);
                append_error(&mut result, &error);
                state.last = Some(result);
                return Err(error);
            }
            state.active = Some(session);
        }
        Ok(std::mem::take(&mut state.pending))
    }
    fn refresh(&self, state: &mut State) -> Result<(), String> {
        let Some(mut session) = state.active.take() else {
            return Ok(());
        };
        let mut error = None;
        for (index, track) in &mut session.tracks {
            match self.recorders[*index].status() {
                Ok(value) => {
                    if value["recording"] != true {
                        error = Some(
                            value["error"]
                                .as_str()
                                .unwrap_or("Audio capture stopped unexpectedly")
                                .to_string(),
                        );
                    }
                    *track = value;
                }
                Err(cause) => error = Some(cause),
            }
        }
        if let Some(error) = error {
            let mut result = self.finish(&session, state);
            append_error(&mut result, &error);
            state.last = Some(result);
        } else {
            state.active = Some(session);
        }
        Ok(())
    }
    fn finish(&self, session: &Session, state: &mut State) -> Value {
        let mut finished = Session {
            mode: session.mode,
            id: session.id.clone(),
            directory: session.directory.clone(),
            tracks: Vec::new(),
        };
        for (index, initial) in &session.tracks {
            let stopped = self.recorders[*index].stop();
            let mut track = match &stopped {
                Ok(value) => value.clone(),
                Err(_) => self.recorders[*index]
                    .status()
                    .unwrap_or_else(|_| initial.clone()),
            };
            track["recording"] = json!(false);
            if let Err(error) = stopped {
                append_error(&mut track, &error);
            }
            match self.recorders[*index].chunks() {
                Ok(chunks) if session.mode == Mode::Meeting => state.pending.extend(chunks),
                Ok(chunks) => discard_chunks(&session.directory, chunks),
                Err(error) => append_error(&mut track, &error),
            }
            finished.tracks.push((*index, track));
        }
        snapshot(&finished, false)
    }
}
fn source(index: usize) -> Source {
    if index == 0 {
        Source::Microphone
    } else {
        Source::System
    }
}
fn append_error(value: &mut Value, error: &str) {
    value["error"] = json!(match value["error"].as_str() {
        Some(existing) if existing != error => format!("{existing}; {error}"),
        _ => error.to_string(),
    });
}
fn snapshot(session: &Session, recording: bool) -> Value {
    let tracks: Vec<Value> = session
        .tracks
        .iter()
        .map(|(index, value)| {
            let mut value = value.clone();
            value["track"] = json!(source(*index).track());
            value["path"] = value["wavPath"].clone();
            value
        })
        .collect();
    let errors = tracks
        .iter()
        .filter_map(|track| track["error"].as_str())
        .collect::<Vec<_>>();
    let duration = tracks
        .iter()
        .map(|track| {
            track["offsetMs"].as_u64().unwrap_or(0) + track["durationMs"].as_u64().unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    let rms = tracks
        .iter()
        .filter_map(|track| track["level"]["rms"].as_f64())
        .fold(0.0_f64, f64::max);
    let peak = tracks
        .iter()
        .filter_map(|track| track["level"]["peak"].as_f64())
        .fold(0.0_f64, f64::max);
    let mut value = json!({"recording":recording,"sessionId":session.id,"mode":session.mode.name(),"directory":session.directory,"tracks":tracks,"durationMs":duration,"captureMicrophone":session.tracks.iter().any(|(index,_)| *index==0),"captureSystem":session.tracks.iter().any(|(index,_)| *index==1),"level":{"rms":rms,"peak":peak}});
    if session.mode != Mode::Meeting {
        if let Some(track) = tracks.first() {
            for key in ["wavPath", "duration", "frames", "capturedFrames"] {
                value[key] = track[key].clone();
            }
        }
    }
    if !errors.is_empty() {
        value["error"] = json!(errors.join("; "));
    }
    value
}
fn discard_chunks(directory: &std::path::Path, chunks: Vec<Value>) {
    for chunk in chunks {
        let Some(path) = chunk["path"].as_str().map(PathBuf::from) else {
            continue;
        };
        let valid_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                ["microphone-", "system-"].iter().any(|prefix| {
                    name.strip_prefix(prefix)
                        .and_then(|name| name.strip_suffix(".wav"))
                        .is_some_and(|number| {
                            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
                        })
                })
            });
        if path.parent() == Some(directory) && valid_name {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct FakeState {
        value: Value,
        starts: Vec<(PathBuf, String, Source, Instant)>,
        stops: usize,
        chunks: Vec<Value>,
        start_error: bool,
        stop_error: bool,
    }
    #[derive(Default)]
    struct Fake(Mutex<FakeState>);
    impl Recorder for Fake {
        fn start(&self, directory: PathBuf) -> Result<Value, String> {
            self.start_track(
                directory,
                "dictation-id".into(),
                Source::Microphone,
                Instant::now(),
            )
        }
        fn start_track(
            &self,
            directory: PathBuf,
            id: String,
            source: Source,
            origin: Instant,
        ) -> Result<Value, String> {
            let mut state = self.0.lock().unwrap();
            state
                .starts
                .push((directory.clone(), id.clone(), source, origin));
            if state.start_error {
                return Err("device unavailable".into());
            }
            state.value = json!({"recording":true,"sessionId":id,"wavPath":directory.join(format!("{}.wav", source.track())),"track":source.track(),"offsetMs":125,"durationMs":1000,"frames":16000,"level":{"rms":0.2,"peak":0.5}});
            Ok(state.value.clone())
        }
        fn stop(&self) -> Result<Value, String> {
            let mut state = self.0.lock().unwrap();
            state.stops += 1;
            state.value["recording"] = json!(false);
            if state.stop_error {
                state.value["error"] = json!("disk full");
                return Err("disk full".into());
            }
            Ok(state.value.clone())
        }
        fn status(&self) -> Result<Value, String> {
            Ok(self.0.lock().unwrap().value.clone())
        }
        fn chunks(&self) -> Result<Vec<Value>, String> {
            Ok(std::mem::take(&mut self.0.lock().unwrap().chunks))
        }
    }
    fn fixture() -> (Listening, Arc<Fake>, Arc<Fake>) {
        let mic = Arc::new(Fake::default());
        let system = Arc::new(Fake::default());
        (
            Listening {
                recorders: [mic.clone(), system.clone()],
                state: Mutex::new(State::default()),
            },
            mic,
            system,
        )
    }
    #[test]
    fn tracks_share_an_epoch_and_session_and_mode_exclusion_precedes_device_work() {
        let (capture, mic, system) = fixture();
        let started = capture
            .start_meeting(PathBuf::from("recordings"), json!({}))
            .unwrap();
        assert_eq!(started["level"]["peak"], 0.5);
        assert_eq!(started["tracks"][0]["offsetMs"], 125);
        assert!(capture
            .start_dictation(PathBuf::from("recordings"))
            .is_err());
        let a = mic.0.lock().unwrap();
        let b = system.0.lock().unwrap();
        assert_eq!(a.starts.len(), 1);
        assert_eq!(a.starts[0].0, b.starts[0].0);
        assert_eq!(a.starts[0].1, b.starts[0].1);
        assert_eq!(a.starts[0].3, b.starts[0].3);
        assert_eq!(started["sessionId"], a.starts[0].1);
    }
    #[test]
    fn hybrid_microphone_uses_supplied_identity_origin_and_merges_actual_track_offsets() {
        let (capture, mic, system) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let origin = Instant::now() - std::time::Duration::from_secs(2);
        let started = capture
            .start_meeting_at(
                PathBuf::from("recordings"),
                json!({"captureMicrophone":true,"captureSystem":false}),
                id.clone(),
                origin,
            )
            .unwrap();
        let actual = mic.0.lock().unwrap().starts[0].clone();
        assert_eq!(actual.0, PathBuf::from("recordings").join(&id));
        assert_eq!(actual.1, id);
        assert_eq!(actual.3, origin);
        assert!(system.0.lock().unwrap().starts.is_empty());
        assert!(capture.start_voice(PathBuf::from("voice")).is_err());
        let base = json!({"sessionId":id,"mode":"meeting","directory":actual.0,"captureMicrophone":true,"captureSystem":true,"trackOffsets":{},"tracks":[]});
        let merged = crate::engine::merge_meeting_capture(
            base,
            Ok(
                json!({"sessionId":id,"recording":true,"tracks":[{"track":"system","offsetMs":475,"level":{"rms":0.4,"peak":0.8}}]}),
            ),
            Some(Ok(started)),
            true,
        );
        assert_eq!(merged["sessionId"], id);
        assert_eq!(merged["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(merged["captureMicrophone"], true);
        assert_eq!(merged["trackOffsets"]["microphone"], 125);
        assert_eq!(merged["trackOffsets"]["system"], 475);
        assert_eq!(merged["level"]["rms"], 0.4);
        assert!(merged["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|track| track["path"].as_str().is_some()));
    }
    #[test]
    fn adapter_failure_stops_microphone_preserves_wav_tail_and_reports_both_failures() {
        let directory = tempfile::tempdir().unwrap();
        let (capture, mic, _) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let session = directory.path().join(&id);
        std::fs::create_dir(&session).unwrap();
        let wav = session.join("microphone.wav");
        std::fs::write(&wav, b"preserved-full-track").unwrap();
        capture
            .start_meeting_at(
                directory.path().to_path_buf(),
                json!({"captureSystem":false}),
                id.clone(),
                Instant::now(),
            )
            .unwrap();
        mic.0.lock().unwrap().stop_error = true;
        mic.0.lock().unwrap().chunks.push(json!({"sessionId":id,"path":session.join("microphone-0.wav"),"startMs":125,"endMs":1125}));
        let stopped = capture.stop_meeting().unwrap();
        let merged = crate::engine::merge_meeting_capture(
            json!({"sessionId":id,"directory":session,"captureMicrophone":true,"captureSystem":true,"trackOffsets":{},"tracks":[]}),
            Err("adapter stopped during startup".into()),
            Some(Ok(stopped)),
            false,
        );
        assert_eq!(merged["recording"], false);
        assert_eq!(merged["tracks"][0]["frames"], 16000);
        assert!(merged["error"]
            .as_str()
            .unwrap()
            .contains("adapter stopped"));
        assert!(merged["error"].as_str().unwrap().contains("disk full"));
        assert_eq!(mic.0.lock().unwrap().stops, 1);
        assert_eq!(capture.take_chunks().unwrap()[0]["startMs"], 125);
        assert_eq!(std::fs::read(wav).unwrap(), b"preserved-full-track");
        assert!(capture
            .start_dictation(directory.path().to_path_buf())
            .is_ok());
    }
    #[test]
    fn externally_supplied_meeting_identity_is_validated_before_device_work() {
        let (capture, mic, _) = fixture();
        assert!(capture
            .start_meeting_at(
                PathBuf::from("recordings"),
                json!({"captureSystem":false}),
                "../other".into(),
                Instant::now()
            )
            .is_err());
        assert!(mic.0.lock().unwrap().starts.is_empty());
    }
    #[test]
    fn voice_owns_only_the_microphone_and_resumes_after_each_released_turn() {
        let (capture, mic, system) = fixture();
        for _ in 0..2 {
            let started = capture.start_voice(PathBuf::from("voicechat")).unwrap();
            assert_eq!(started["mode"], "voice");
            assert!(started["wavPath"].as_str().is_some());
            assert!(capture.start_dictation(PathBuf::from("dictation")).is_err());
            assert!(capture
                .start_meeting(PathBuf::from("meeting"), json!({}))
                .is_err());
            assert!(capture.stop_dictation().is_err());
            assert_eq!(capture.stop_voice().unwrap()["recording"], false);
        }
        assert_eq!(mic.0.lock().unwrap().starts.len(), 2);
        assert_eq!(mic.0.lock().unwrap().stops, 2);
        assert!(system.0.lock().unwrap().starts.is_empty());
        assert!(capture.start_dictation(PathBuf::from("dictation")).is_ok());
    }
    #[test]
    fn second_track_failure_rolls_back_and_drains_before_next_session() {
        let (capture, mic, system) = fixture();
        mic.0
            .lock()
            .unwrap()
            .chunks
            .push(json!({"sessionId":"old","path":"preserved.wav"}));
        system.0.lock().unwrap().start_error = true;
        let error = capture
            .start_meeting(PathBuf::from("recordings"), json!({}))
            .unwrap_err();
        assert!(error.contains("recordings"));
        assert_eq!(mic.0.lock().unwrap().stops, 1);
        assert!(mic.0.lock().unwrap().chunks.is_empty());
        let status = capture.status().unwrap();
        assert_eq!(status["recording"], false);
        assert!(status["error"].as_str().unwrap().contains("unavailable"));
        assert!(capture.take_chunks().unwrap().is_empty());
        system.0.lock().unwrap().start_error = false;
        assert!(capture
            .start_meeting(PathBuf::from("recordings"), json!({}))
            .is_ok());
    }
    #[test]
    fn stop_attempts_both_tracks_retains_errors_and_is_idempotent() {
        let (capture, mic, system) = fixture();
        capture
            .start_meeting(PathBuf::from("recordings"), json!({}))
            .unwrap();
        mic.0.lock().unwrap().stop_error = true;
        system
            .0
            .lock()
            .unwrap()
            .chunks
            .push(json!({"path":"tail.wav"}));
        let stopped = capture.stop_meeting().unwrap();
        assert_eq!(stopped["recording"], false);
        assert_eq!(stopped["durationMs"], 1125);
        assert_eq!(stopped["tracks"][0]["frames"], 16000);
        assert!(stopped["error"].as_str().unwrap().contains("disk full"));
        assert_eq!(capture.stop_meeting().unwrap(), stopped);
        assert_eq!(mic.0.lock().unwrap().stops, 1);
        assert_eq!(system.0.lock().unwrap().stops, 1);
        assert_eq!(capture.take_chunks().unwrap().len(), 1);
        assert!(capture.take_chunks().unwrap().is_empty());
    }
    #[test]
    fn automatic_track_failure_stops_the_other_and_releases_the_mode() {
        let (capture, mic, system) = fixture();
        capture
            .start_meeting(PathBuf::from("recordings"), json!({}))
            .unwrap();
        mic.0.lock().unwrap().value["recording"] = json!(false);
        mic.0.lock().unwrap().value["error"] = json!("stream failed");
        let status = capture.status().unwrap();
        assert_eq!(status["recording"], false);
        assert!(status["error"].as_str().unwrap().contains("stream failed"));
        assert_eq!(system.0.lock().unwrap().stops, 1);
        assert!(capture.start_dictation(PathBuf::from("recordings")).is_ok());
    }
    #[test]
    fn dictation_stop_keeps_the_full_wav_contract() {
        let (capture, _, _) = fixture();
        assert_eq!(capture.status().unwrap(), json!({"recording":false}));
        capture
            .start_dictation(PathBuf::from("recordings"))
            .unwrap();
        let stopped = capture.stop_dictation().unwrap();
        assert_eq!(stopped["sessionId"], "dictation-id");
        assert_eq!(stopped["frames"], 16000);
        assert!(stopped["wavPath"]
            .as_str()
            .unwrap()
            .ends_with("microphone.wav"));
        assert_eq!(capture.stop_dictation().unwrap(), stopped);
    }
    #[test]
    fn bad_selection_is_rejected_before_starting_either_device() {
        let (capture, mic, system) = fixture();
        for params in [
            json!({"captureMicrophone":"false"}),
            json!({"captureMicrophone":false,"captureSystem":false}),
            json!({"applicationBundleId":"com.example.call"}),
            Value::Null,
        ] {
            assert!(capture
                .start_meeting(PathBuf::from("recordings"), params)
                .is_err());
        }
        assert!(mic.0.lock().unwrap().starts.is_empty());
        assert!(system.0.lock().unwrap().starts.is_empty());
    }
    #[test]
    fn discarded_chunks_cannot_delete_full_wavs_or_files_outside_the_session() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let full = directory.path().join("microphone.wav");
        let derived = directory.path().join("microphone-0.wav");
        let foreign = outside.path().join("system-0.wav");
        for path in [&full, &derived, &foreign] {
            std::fs::write(path, b"fixture").unwrap();
        }
        discard_chunks(
            directory.path(),
            [&full, &derived, &foreign]
                .map(|path| json!({"path":path}))
                .to_vec(),
        );
        assert!(full.exists());
        assert!(!derived.exists());
        assert!(foreign.exists());
    }
}
