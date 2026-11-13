//! Token-protected loopback bridge for testing the real desktop host. Not compiled into releases.
use crate::{dispatch, AppState};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use uuid::Uuid;

pub fn start(app: AppHandle) {
    let Ok(port) = std::env::var("PACE_E2E_PORT") else {
        return;
    };
    let Ok(port) = port.parse::<u16>() else {
        return;
    };
    let token = std::env::var("PACE_E2E_TOKEN").unwrap_or_else(|_| Uuid::new_v4().to_string());
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("E2E bridge unavailable: {e}");
                return;
            }
        };
        let state = app.state::<AppState>();
        let endpoint = json!({"url":format!("http://127.0.0.1:{port}"),"token":token});
        if let Err(e) = std::fs::write(state.data_dir.join("e2e-bridge.json"), endpoint.to_string())
        {
            eprintln!("E2E bridge metadata: {e}");
            return;
        }
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let handle = app.clone();
            let secret = token.clone();
            tokio::spawn(async move {
                let _ = serve(socket, handle, &secret).await;
            });
        }
    });
}

async fn serve(socket: TcpStream, app: AppHandle, token: &str) -> Result<(), String> {
    let (mut reader, mut writer) = socket.into_split();
    let mut input = BufReader::new(&mut reader);
    let mut first = String::new();
    tokio::time::timeout(Duration::from_secs(5), input.read_line(&mut first))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut length = 0usize;
    let mut authorized = false;
    let mut header_bytes = first.len();
    loop {
        let mut line = String::new();
        input
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        header_bytes += line.len();
        if header_bytes > 8192 {
            return Err("Header too large".into());
        }
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            match key.to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().map_err(|_| "Invalid length")?,
                "authorization" => authorized = value.trim() == format!("Bearer {token}"),
                _ => {}
            }
        }
    }
    let result = if first.starts_with("OPTIONS ") {
        json!({"ok":true})
    } else if !authorized {
        json!({"ok":false,"error":"Unauthorized test request"})
    } else if length > 512 * 1024 {
        json!({"ok":false,"error":"Request too large"})
    } else {
        let mut body = vec![0u8; length];
        input
            .read_exact(&mut body)
            .await
            .map_err(|e| e.to_string())?;
        match serde_json::from_slice::<Value>(&body) {
            Ok(request) => {
                let method = request["method"].as_str().unwrap_or("");
                let params = request.get("params").cloned().unwrap_or(json!({}));
                let result = match method {
                    "_test.memory.add" => {
                        let state = app.state::<AppState>();
                        state
                            .db
                            .add_memory(
                                params["app"].as_str().unwrap_or("test"),
                                params["title"].as_str().unwrap_or("Fixture"),
                                params["text"].as_str().unwrap_or(""),
                            )
                            .map(|added| json!({"added":added}))
                    }
                    "_test.meeting.seed" => {
                        let state = app.state::<AppState>();
                        let id = params["id"].as_str().unwrap_or("fixture");
                        state.db.put("meeting", id, &params).map(|_| params)
                    }
                    "_test.audio.chunk" => crate::process_chunk(&app, &params).await,
                    "_test.worker.crash" => {
                        app.state::<AppState>().native.stop().await;
                        Ok(json!({"stopped":true}))
                    }
                    "_test.windows" => {
                        #[cfg(target_os = "macos")]
                        let native = crate::pet_panel::inspect(&app).await?;
                        #[cfg(not(target_os = "macos"))]
                        let native = Value::Null;
                        Ok(json!(app.webview_windows().into_iter().map(|(label,window)|{
                        let size=window.inner_size().ok().map(|size|size.to_logical::<f64>(window.scale_factor().unwrap_or(1.0)));
                        json!({"label":label,"visible":window.is_visible().unwrap_or(false),"width":size.map(|s|s.width),"height":size.map(|s|s.height),"native":if label=="pet" { native.clone() } else { Value::Null }})
                    }).collect::<Vec<_>>()))
                    },
                    "_test.download" => app.get_webview_window("main").ok_or("Main window is missing".to_string()).and_then(|window| {
                        window.eval("{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Pace native download fixture\\n'],{type:'text/markdown'}));a.download='pace-native-download-fixture.md';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),30000);}").map(|_|json!({"requested":true})).map_err(|error|error.to_string())
                    }),
                    "_test.quit" => {
                        let handle = app.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            handle.exit(0);
                        });
                        Ok(json!({"quitting":true}))
                    }
                    _ => dispatch(app.clone(), method.to_string(), Some(params)).await,
                };
                match result {
                    Ok(value) => json!({"ok":true,"data":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                }
            }
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        }
    };
    let body = result.to_string();
    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: http://127.0.0.1:1420\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
    writer
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
