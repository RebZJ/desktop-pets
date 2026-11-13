use chrono::{Duration, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
use uuid::Uuid;

pub struct Database(Mutex<Connection>);

pub fn defaults() -> Value {
    json!({
        "onboardingCompleted":false, "theme":"camp", "interfaceFont":"pixel", "captureProtectionEnabled":true,
        "language":"auto", "voice":"Kiki", "voiceEngine":"auto", "speechEnabled":false,
        "dictationShortcut":"Alt+Shift+D", "completionShortcut":"Alt+Shift+Enter", "dictationLanguage":"en", "dictationVocabulary":"", "writingExamples":"",
        "soundEnabled":true, "petSize":160, "activePack":"pace", "volume":0.65, "pitch":1.05, "rate":1.0,
        "memoryEnabled":false, "allowedApps":[], "allowedDomains":[],
        "retentionDays":30, "meetingTips":true, "clickThrough":false,
        "hideShortcut":"Alt+Shift+Space", "commandShortcut":"Alt+Space"
    })
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
             CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL, PRIMARY KEY(kind,id));
             CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
             CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY,app TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);
             CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text,content='memory',content_rowid='id',tokenize='trigram');
             CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN INSERT INTO memory_fts(rowid,text) VALUES(new.id,new.text); END;
             CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',old.id,old.text); END;"
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO settings VALUES(1,?1)",
            [defaults().to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn settings(&self) -> Result<Value, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        Self::read_settings(&conn)
    }

    fn read_settings(conn: &Connection) -> Result<Value, String> {
        let text: String = conn
            .query_row("SELECT data FROM settings WHERE id=1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut value = defaults();
        if let Some(object) = serde_json::from_str::<Value>(&text)
            .map_err(|e| e.to_string())?
            .as_object()
        {
            value.as_object_mut().unwrap().extend(object.clone());
        }
        Ok(value)
    }

    pub fn update_settings(&self, patch: &Value) -> Result<Value, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut settings = Self::read_settings(&conn)?;
        let patch = patch.as_object().ok_or("Settings must be an object")?;
        for (key, value) in patch {
            let existing = settings
                .get(key)
                .ok_or_else(|| format!("Unknown setting: {key}"))?;
            if existing.is_boolean() && !value.is_boolean()
                || existing.is_string() && !value.is_string()
                || existing.is_array()
                    && !value
                        .as_array()
                        .is_some_and(|a| a.len() <= 100 && a.iter().all(Value::is_string))
                || existing.is_number() && !value.is_number()
            {
                return Err(format!("Invalid value for {key}"));
            }
            match key.as_str() {
                "theme"
                    if !["camp", "night", "handheld"].contains(&value.as_str().unwrap_or("")) =>
                {
                    return Err("Unsupported theme".into())
                }
                "interfaceFont"
                    if !["pixel", "inter", "fira"].contains(&value.as_str().unwrap_or("")) =>
                {
                    return Err("Unsupported interface font".into())
                }
                "dictationLanguage"
                    if !["auto", "en", "zh", "ja", "es"]
                        .contains(&value.as_str().unwrap_or("")) =>
                {
                    return Err("Unsupported dictation language".into())
                }
                "dictationVocabulary"
                    if value
                        .as_str()
                        .is_some_and(|text| text.chars().count() > 4000) =>
                {
                    return Err("Keep custom vocabulary below 4,000 characters".into())
                }
                "writingExamples"
                    if value
                        .as_str()
                        .is_some_and(|text| text.chars().count() > 8000) =>
                {
                    return Err("Keep writing examples below 8,000 characters".into())
                }
                "voiceEngine"
                    if !["auto", "kitten", "qwen"].contains(&value.as_str().unwrap_or("")) =>
                {
                    return Err("Unsupported voice engine".into())
                }
                "volume" if !(0.0..=1.0).contains(&value.as_f64().unwrap_or(-1.0)) => {
                    return Err("Volume must be between 0 and 1".into())
                }
                "pitch" if !(0.75..=1.5).contains(&value.as_f64().unwrap_or(-1.0)) => {
                    return Err("Pitch must be between 0.75 and 1.5".into())
                }
                "rate" if !(0.5..=1.5).contains(&value.as_f64().unwrap_or(-1.0)) => {
                    return Err("Speaking rate must be between 0.5 and 1.5".into())
                }
                "retentionDays" if !value.as_u64().is_some_and(|n| (1..=365).contains(&n)) => {
                    return Err("Memory retention must be 1–365 days".into())
                }
                "petSize" if !value.as_u64().is_some_and(|n| (80..=256).contains(&n)) => {
                    return Err("Pet size must be 80–256 pixels".into())
                }
                "language"
                    if !["en", "zh", "ja", "es", "auto"]
                        .contains(&value.as_str().unwrap_or("")) =>
                {
                    return Err("Unsupported language".into())
                }
                _ => {}
            }
            settings[key] = value.clone();
        }
        conn.execute(
            "UPDATE settings SET data=?1 WHERE id=1",
            [settings.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(settings)
    }

    pub fn list(&self, kind: &str) -> Result<Vec<Value>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut statement = conn
            .prepare("SELECT data FROM documents WHERE kind=?1 ORDER BY rowid DESC")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([kind], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    pub fn get(&self, kind: &str, id: &str) -> Result<Value, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let text: String = conn
            .query_row(
                "SELECT data FROM documents WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .map_err(|_| format!("{kind} not found"))?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    pub fn put(&self, kind: &str, id: &str, data: &Value) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.execute("INSERT INTO documents(kind,id,data) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", params![kind,id,data.to_string()]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove(&self, kind: &str, id: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "DELETE FROM documents WHERE kind=?1 AND id=?2",
                params![kind, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_meeting(&self, id: &str) -> Result<(), String> {
        let mut conn = self.0.lock().map_err(|error| error.to_string())?;
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM documents WHERE kind='meeting' AND id=?1", [id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM messages WHERE conversation_id=?1",
                [format!("meeting-{id}")],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    #[cfg(test)]
    pub fn add_message(
        &self,
        conversation: &str,
        role: &str,
        content: &str,
    ) -> Result<Value, String> {
        let conn = self.0.lock().map_err(|error| error.to_string())?;
        Self::insert_message(&conn, conversation, role, content, None)
    }

    pub fn add_meeting_message(
        &self,
        id: &str,
        role: &str,
        content: &str,
    ) -> Result<Value, String> {
        let conn = self.0.lock().map_err(|error| error.to_string())?;
        Self::insert_message(&conn, &format!("meeting-{id}"), role, content, Some(id))
    }

    fn insert_message(
        conn: &Connection,
        conversation: &str,
        role: &str,
        content: &str,
        meeting: Option<&str>,
    ) -> Result<Value, String> {
        let message = json!({"id":Uuid::new_v4().to_string(),"conversationId":conversation,"role":role,"content":content,"createdAt":Utc::now().to_rfc3339()});
        let inserted = conn.execute(
            "INSERT INTO messages SELECT ?1,?2,?3,?4,?5 WHERE ?6 IS NULL OR EXISTS(SELECT 1 FROM documents WHERE kind='meeting' AND id=?6)",
            params![message["id"].as_str(), conversation, role, content, message["createdAt"].as_str(), meeting],
        ).map_err(|error| error.to_string())?;
        if inserted == 0 {
            return Err("This meeting was deleted; the message was not saved.".into());
        }
        Ok(message)
    }

    pub fn messages(&self, conversation: &str) -> Result<Vec<Value>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare("SELECT id,role,content,created_at FROM (SELECT rowid,id,role,content,created_at FROM messages WHERE conversation_id=?1 ORDER BY rowid DESC LIMIT 40) ORDER BY rowid").map_err(|e| e.to_string())?;
        let rows = statement.query_map([conversation], |r| Ok(json!({"id":r.get::<_,String>(0)?,"role":r.get::<_,String>(1)?,"content":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?}))).map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    #[cfg(any(test, debug_assertions))]
    pub fn add_memory(&self, app: &str, title: &str, text: &str) -> Result<bool, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        Self::insert_memory(&conn, app, title, text)
    }

    pub fn add_captured_memory(&self, app: &str, title: &str, text: &str) -> Result<bool, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let raw: String = conn
            .query_row("SELECT data FROM settings WHERE id=1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let settings: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if settings["memoryEnabled"] != true
            || !settings["allowedApps"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(app)))
        {
            return Ok(false);
        }
        Self::insert_memory(&conn, app, title, text)
    }

    fn insert_memory(
        conn: &Connection,
        app: &str,
        title: &str,
        text: &str,
    ) -> Result<bool, String> {
        let text: String = text.trim().chars().take(12000).collect();
        if text.is_empty() {
            return Ok(false);
        }
        let duplicate: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM memory WHERE app=?1 AND title=?2 AND text=?3 AND created_at>?4)", params![app,title,text,(Utc::now()-Duration::hours(24)).to_rfc3339()], |r| r.get(0)).map_err(|e| e.to_string())?;
        if duplicate {
            return Ok(false);
        }
        conn.execute(
            "INSERT INTO memory(app,title,text,created_at) VALUES(?1,?2,?3,?4)",
            params![app, title, text, Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn search_memory(&self, query: &str, limit: usize) -> Result<Vec<Value>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let query: String = query.trim().chars().take(500).collect();
        let limit = limit.clamp(1, 100);
        let sql = if query.chars().count() >= 3 {
            "SELECT m.id,m.app,m.title,m.text,m.created_at FROM memory m JOIN memory_fts f ON m.id=f.rowid WHERE memory_fts MATCH ?1 ORDER BY m.created_at DESC LIMIT ?2"
        } else {
            "SELECT id,app,title,text,created_at FROM memory WHERE text LIKE ?1 ESCAPE '\\' ORDER BY created_at DESC LIMIT ?2"
        };
        let needle = if query.chars().count() >= 3 {
            format!("\"{}\"", query.replace('"', "\"\""))
        } else {
            format!(
                "%{}%",
                query
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        };
        let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![needle,limit], |r| Ok(json!({"id":r.get::<_,i64>(0)?.to_string(),"app":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"text":r.get::<_,String>(3)?,"createdAt":r.get::<_,String>(4)?}))).map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    pub fn get_memory(&self, id: &str) -> Result<Value, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT id,app,title,text,created_at FROM memory WHERE id=?1",[id],|r|Ok(json!({"id":r.get::<_,i64>(0)?.to_string(),"app":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"text":r.get::<_,String>(3)?,"createdAt":r.get::<_,String>(4)?}))).map_err(|_|"This memory has been deleted or is no longer available".into())
    }

    pub fn delete_memory(&self, id: Option<&str>, app: Option<&str>) -> Result<(), String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(id) = id {
            conn.execute("DELETE FROM memory WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        } else if let Some(app) = app {
            conn.execute("DELETE FROM memory WHERE app=?1", [app])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute("DELETE FROM memory", [])
                .map_err(|e| e.to_string())?;
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn prune_memory(&self, days: i64) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "DELETE FROM memory WHERE created_at<?1",
                [(Utc::now() - Duration::days(days)).to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Database {
        Database::open(Path::new(":memory:")).unwrap()
    }
    #[test]
    fn validates_settings_before_saving() {
        let db = database();
        assert!(db.update_settings(&json!({"memoryEnabled":"yes"})).is_err());
        assert!(db.update_settings(&json!({"volume":2})).is_err());
        assert!(db.update_settings(&json!({"allowedApps":[42]})).is_err());
        assert_eq!(
            db.update_settings(&json!({"language":"ja"})).unwrap()["language"],
            "ja"
        );
    }
    #[test]
    fn onboarding_completion_merges_legacy_settings_and_requires_a_boolean() {
        let db = database();
        assert_eq!(db.settings().unwrap()["onboardingCompleted"], false);
        let mut legacy = defaults();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("onboardingCompleted");
        legacy["language"] = json!("ja");
        db.0.lock()
            .unwrap()
            .execute(
                "UPDATE settings SET data=?1 WHERE id=1",
                [legacy.to_string()],
            )
            .unwrap();
        let merged = db.settings().unwrap();
        assert_eq!(merged["onboardingCompleted"], false);
        assert_eq!(merged["language"], "ja");
        db.update_settings(&json!({"onboardingCompleted":true}))
            .unwrap();
        assert_eq!(db.settings().unwrap()["onboardingCompleted"], true);
        assert!(db
            .update_settings(&json!({"onboardingCompleted":"yes"}))
            .is_err());
        assert_eq!(db.settings().unwrap()["onboardingCompleted"], true);
    }
    #[test]
    fn appearance_and_capture_settings_are_persisted_and_validated() {
        let db = database();
        db.0.lock()
            .unwrap()
            .execute(
                "UPDATE settings SET data=?1 WHERE id=1",
                [json!({"language":"ja"}).to_string()],
            )
            .unwrap();
        let defaults = db.settings().unwrap();
        assert_eq!(defaults["language"], "ja");
        assert_eq!(defaults["theme"], "camp");
        assert_eq!(defaults["interfaceFont"], "pixel");
        assert_eq!(defaults["captureProtectionEnabled"], true);
        for theme in ["camp", "night", "handheld"] {
            for font in ["pixel", "inter", "fira"] {
                db.update_settings(
                    &json!({"theme":theme,"interfaceFont":font,"captureProtectionEnabled":false}),
                )
                .unwrap();
                let settings = db.settings().unwrap();
                assert_eq!(settings["theme"], theme);
                assert_eq!(settings["interfaceFont"], font);
                assert_eq!(settings["captureProtectionEnabled"], false);
            }
        }
        for patch in [
            json!({"theme":"unknown"}),
            json!({"interfaceFont":"comic"}),
            json!({"captureProtectionEnabled":"yes"}),
        ] {
            assert!(db.update_settings(&patch).is_err());
        }
        assert_eq!(db.settings().unwrap()["theme"], "handheld");
        assert_eq!(db.settings().unwrap()["captureProtectionEnabled"], false);
    }
    #[test]
    fn concurrent_settings_patches_preserve_each_other() {
        use std::sync::{Arc, Barrier};
        let db = Arc::new(database());
        for _ in 0..32 {
            db.update_settings(&defaults()).unwrap();
            let patches = [
                json!({"language":"ja"}),
                json!({"voice":"Ryan"}),
                json!({"volume":0.4}),
                json!({"retentionDays":7}),
                json!({"petSize":128}),
                json!({"memoryEnabled":true}),
                json!({"allowedApps":["mail"]}),
                json!({"meetingTips":false}),
            ];
            let barrier = Arc::new(Barrier::new(patches.len()));
            let threads: Vec<_> = patches
                .iter()
                .cloned()
                .map(|patch| {
                    let db = db.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        db.update_settings(&patch).unwrap();
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }
            let settings = db.settings().unwrap();
            for patch in patches {
                for (key, value) in patch.as_object().unwrap() {
                    assert_eq!(&settings[key], value, "{key}");
                }
            }
        }
    }
    #[test]
    fn captured_memory_respects_current_opt_in_and_app_grant() {
        let db = database();
        assert!(!db
            .add_captured_memory("mail", "Work", "Capture before opting in")
            .unwrap());
        db.update_settings(&json!({"memoryEnabled":true,"allowedApps":["mail"]}))
            .unwrap();
        assert!(db
            .add_captured_memory("mail", "Work", "Allowed captured context")
            .unwrap());
        db.update_settings(&json!({"allowedApps":[]})).unwrap();
        assert!(!db
            .add_captured_memory("mail", "Work", "Stale capture after app revocation")
            .unwrap());
        db.update_settings(&json!({"allowedApps":["mail"],"memoryEnabled":false}))
            .unwrap();
        assert!(!db
            .add_captured_memory("mail", "Work", "Stale capture after pausing")
            .unwrap());
        assert_eq!(db.search_memory("", 10).unwrap().len(), 1);
    }
    #[test]
    fn searches_all_four_languages_and_deletes_index() {
        let db = database();
        for (app, text) in [
            ("mail", "Tomorrow we ship the meeting notes"),
            ("chat", "明日の会議で確認しましょう"),
            ("chat", "明天的会议需要准备笔记"),
            ("mail", "Mañana tenemos reunión con José"),
        ] {
            assert!(db.add_memory(app, "Work", text).unwrap());
        }
        assert!(!db
            .add_memory("chat", "Work", "明天的会议需要准备笔记")
            .unwrap());
        for query in ["meeting", "会議", "会议需要", "reunión", "José"] {
            assert_eq!(db.search_memory(query, 10).unwrap().len(), 1, "{query}");
        }
        assert!(db.search_memory("' OR 1=1 --", 10).unwrap().is_empty());
        db.delete_memory(None, Some("chat")).unwrap();
        assert!(db.search_memory("会议", 10).unwrap().is_empty());
        db.delete_memory(None, None).unwrap();
        assert!(db.search_memory("", 10).unwrap().is_empty());
    }
    #[test]
    fn deleting_a_meeting_removes_only_its_document_and_conversation() {
        let db = database();
        for id in ["selected", "other"] {
            db.put("meeting", id, &json!({"id":id,"status":"completed"}))
                .unwrap();
            db.add_meeting_message(id, "user", "Question").unwrap();
            db.add_meeting_message(id, "assistant", "Answer").unwrap();
        }
        db.put("dictation", "selected", &json!({"path":"keep.wav"}))
            .unwrap();
        db.add_message("general-chat", "user", "Keep my old chat")
            .unwrap();
        db.add_memory("test", "Keep", "Unrelated saved memory")
            .unwrap();
        let settings = db.update_settings(&json!({"language":"ja"})).unwrap();
        let other = db.get("meeting", "other").unwrap();
        let other_messages = db.messages("meeting-other").unwrap();
        let old_chat = db.messages("general-chat").unwrap();
        db.delete_meeting("selected").unwrap();
        assert!(db.get("meeting", "selected").is_err());
        assert!(db.messages("meeting-selected").unwrap().is_empty());
        assert_eq!(db.get("meeting", "other").unwrap(), other);
        assert_eq!(db.messages("meeting-other").unwrap(), other_messages);
        assert_eq!(db.messages("general-chat").unwrap(), old_chat);
        assert_eq!(db.get("dictation", "selected").unwrap()["path"], "keep.wav");
        assert_eq!(db.settings().unwrap(), settings);
        assert_eq!(db.search_memory("", 10).unwrap().len(), 1);
    }

    #[test]
    fn delayed_meeting_answer_cannot_recreate_a_deleted_conversation() {
        let db = std::sync::Arc::new(database());
        db.put("meeting", "selected", &json!({"id":"selected"}))
            .unwrap();
        db.add_meeting_message("selected", "user", "An in-flight question")
            .unwrap();
        let (deleted, wait_for_delete) = std::sync::mpsc::channel();
        let pending_db = db.clone();
        let pending_answer = std::thread::spawn(move || {
            wait_for_delete.recv().unwrap();
            pending_db.add_meeting_message("selected", "assistant", "A late answer")
        });
        db.delete_meeting("selected").unwrap();
        deleted.send(()).unwrap();
        assert!(pending_answer
            .join()
            .unwrap()
            .unwrap_err()
            .contains("deleted"));
        assert!(db
            .add_meeting_message("selected", "user", "A late question")
            .is_err());
        assert!(db.messages("meeting-selected").unwrap().is_empty());
    }

    #[test]
    fn failed_conversation_delete_rolls_back_the_meeting_delete() {
        let db = database();
        db.put("meeting", "selected", &json!({"id":"selected"}))
            .unwrap();
        db.add_meeting_message("selected", "user", "Keep on failed delete")
            .unwrap();
        db.0.lock().unwrap().execute_batch("CREATE TEMP TRIGGER reject_message_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END;").unwrap();
        assert!(db
            .delete_meeting("selected")
            .unwrap_err()
            .contains("synthetic delete failure"));
        assert_eq!(db.get("meeting", "selected").unwrap()["id"], "selected");
        assert_eq!(db.messages("meeting-selected").unwrap().len(), 1);
    }

    #[test]
    fn preserves_message_order_and_documents() {
        let db = database();
        db.add_message("a", "user", "Hello").unwrap();
        db.add_message("a", "assistant", "Hi").unwrap();
        assert_eq!(db.messages("a").unwrap()[0]["role"], "user");
        db.put("meeting", "m", &json!({"id":"m","segments":[]}))
            .unwrap();
        assert_eq!(db.get("meeting", "m").unwrap()["id"], "m");
    }
}
