use tauri::State;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PausedPlayers {
    pub players: Vec<String>,
}

#[tauri::command]
pub async fn macos_pause_active_media() -> Result<PausedPlayers, String> {
    #[cfg(target_os = "macos")]
    {
        // AppleScript to check state and pause Music and Spotify if playing
        let script = r#"
set pausedPlayers to {}

-- Apple Music
try
    tell application "Music"
        if it is running then
            if player state is playing then
                pause
                set end of pausedPlayers to "Music"
            end if
        end if
    end tell
end try

-- Spotify
try
    tell application "Spotify"
        if it is running then
            if player state is playing then
                pause
                set end of pausedPlayers to "Spotify"
            end if
        end if
    end tell
end try

return pausedPlayers as string
"#;

        match run_osascript(script).await {
            Ok(output) => {
                let players = parse_comma_list(&output);
                Ok(PausedPlayers { players })
            }
            Err(e) => Err(format!("Failed to pause media: {}", e)),
        }
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


