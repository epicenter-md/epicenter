
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PausedPlayers {
    pub players: Vec<String>,
}

#[tauri::command]
pub async fn macos_pause_active_media() -> Result<PausedPlayers, String> {
    #[cfg(target_os = "macos")]
    {
        use std::time::Instant;
        let start = Instant::now();
        
        // Run Music and Spotify checks concurrently with short AppleScript timeouts
        let music_script = r#"
try
    with timeout of 0.2 seconds
        tell application "Music"
            if it is running then
                if player state is playing then
                    pause
                    return "Music"
                end if
            end if
        end tell
    end timeout
end try
return ""
"#;

        let spotify_script = r#"
try
    with timeout of 0.2 seconds
        tell application "Spotify"
            if it is running then
                if player state is playing then
                    pause
                    return "Spotify"
                end if
            end if
        end tell
    end timeout
end try
return ""
"#;

        let music_start = Instant::now();
        let spotify_start = Instant::now();
        let (music_out, spotify_out) = tokio::join!(
            async {
                let r = run_osascript(music_script).await;
                let d = music_start.elapsed();
                (r, d)
            },
            async {
                let r = run_osascript(spotify_script).await;
                let d = spotify_start.elapsed();
                (r, d)
            }
        );

        eprintln!("[macos_media] Music check took {:?}", music_out.1);
        eprintln!("[macos_media] Spotify check took {:?}", spotify_out.1);

        let mut paused_players = Vec::new();
        if let Ok(output) = music_out.0 {
            if !output.trim().is_empty() { paused_players.push(output.trim().to_string()); }
        }
        if let Ok(output) = spotify_out.0 {
            if !output.trim().is_empty() { paused_players.push(output.trim().to_string()); }
        }
        
        // Only check Books if nothing else was paused
        if paused_players.is_empty() {
            let books_start = Instant::now();
            let books_result = run_osascript(r#"
try
    with timeout of 0.3 seconds
        tell application "System Events"
            set booksProcessExists to exists process "Books"
        end tell
        if booksProcessExists then
            tell application "System Events"
                tell process "Books"
                    if exists menu item "Pause" of menu "Controls" of menu bar 1 then
                        click menu item "Pause" of menu "Controls" of menu bar 1
                        return "Books"
                    end if
                end tell
            end tell
        end if
    end timeout
end try
return ""
"#).await;
            
            let books_time = books_start.elapsed();
            eprintln!("[macos_media] Books check took {:?}", books_time);
            
            if let Ok(output) = books_result {
                if !output.trim().is_empty() {
                    paused_players.push(output.trim().to_string());
                }
            }
        }
        
        let total_time = start.elapsed();
        eprintln!("[macos_media] Total pause took {:?}", total_time);
        
        return Ok(PausedPlayers { players: paused_players });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(PausedPlayers { players: vec![] })
    }
}

#[tauri::command]
pub async fn macos_resume_media(players: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Build AppleScript dynamically based on players
        let mut script = String::new();
        for p in players {
            match p.as_str() {
                "Music" => {
                    script.push_str(
                        "try\n  tell application \"Music\"\n    if it is running then play\n  end tell\nend try\n",
                    );
                }
                "Spotify" => {
                    script.push_str(
                        "try\n  tell application \"Spotify\"\n    if it is running then play\n  end tell\nend try\n",
                    );
                }
                "Books" => {
                    script.push_str(
                        "try\n  with timeout of 1 seconds\n    tell application \"System Events\"\n      tell process \"Books\"\n        click menu item \"Play\" of menu \"Controls\" of menu bar 1\n      end tell\n    end tell\n  end timeout\nend try\n",
                    );
                }
                _ => {}
            }
        }

        if script.is_empty() {
            return Ok(());
        }

        run_osascript(&script).await.map(|_| ())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn run_osascript(script: &str) -> Result<String, String> {
    use tokio::process::Command;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(stderr)
    }
}

fn parse_comma_list(s: &str) -> Vec<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    trimmed
        .split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}


