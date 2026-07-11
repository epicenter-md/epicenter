//! Best-effort Linux playback suppression through MPRIS.

use std::time::Duration;

use zbus::fdo::DBusProxy;
use zbus::{Connection, Proxy};

const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const DBUS_TIMEOUT: Duration = Duration::from_secs(2);

/// Exact MPRIS bus names for players Epicenter successfully paused.
pub(super) struct Effect {
    players: Vec<String>,
}

pub(super) async fn suppress() -> Result<Effect, String> {
    match tokio::time::timeout(DBUS_TIMEOUT, suppress_inner()).await {
        Ok(Ok(effect)) => Ok(effect),
        Ok(Err(error)) => Err(format!("MPRIS suppression unavailable: {error}")),
        Err(_) => Err("MPRIS suppression timed out".to_string()),
    }
}

pub(super) async fn restore(effect: Effect) -> Result<(), String> {
    if effect.players.is_empty() {
        return Ok(());
    }
    match tokio::time::timeout(DBUS_TIMEOUT, restore_inner(effect)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("MPRIS restoration unavailable: {error}")),
        Err(_) => Err("MPRIS restoration timed out".to_string()),
    }
}

async fn suppress_inner() -> zbus::Result<Effect> {
    let connection = Connection::session().await?;
    let mut players = Vec::new();
    for name in mpris_players(&connection).await? {
        match pause_if_playing(&connection, &name).await {
            Ok(true) => players.push(name),
            Ok(false) => {}
            Err(error) => log::warn!("MPRIS pause failed for {name}: {error}"),
        }
    }
    Ok(Effect { players })
}

async fn restore_inner(effect: Effect) -> zbus::Result<()> {
    let connection = Connection::session().await?;
    let live = mpris_players(&connection).await?;
    for name in effect.players {
        if !live.contains(&name) {
            continue;
        }
        if let Err(error) = restore_if_paused(&connection, &name).await {
            log::warn!("MPRIS restore failed for {name}: {error}");
        }
    }
    Ok(())
}

async fn restore_if_paused(connection: &Connection, name: &str) -> zbus::Result<()> {
    let player = player_proxy(connection, name).await?;
    let status: String = player.get_property("PlaybackStatus").await?;
    if status == "Paused" {
        player.call::<_, _, ()>("Play", &()).await?;
    }
    Ok(())
}

async fn mpris_players(connection: &Connection) -> zbus::Result<Vec<String>> {
    let dbus = DBusProxy::new(connection).await?;
    let names = dbus.list_names().await?;
    Ok(names
        .into_iter()
        .map(|name| name.as_str().to_owned())
        .filter(|name| name.starts_with(MPRIS_PREFIX))
        .collect())
}

async fn pause_if_playing(connection: &Connection, name: &str) -> zbus::Result<bool> {
    let player = player_proxy(connection, name).await?;
    if !player
        .get_property::<bool>("CanPause")
        .await
        .unwrap_or(false)
    {
        return Ok(false);
    }
    let status: String = player.get_property("PlaybackStatus").await?;
    if status != "Playing" {
        return Ok(false);
    }
    player.call::<_, _, ()>("Pause", &()).await?;
    Ok(true)
}

async fn player_proxy(connection: &Connection, name: &str) -> zbus::Result<Proxy<'static>> {
    Proxy::new(connection, name.to_owned(), MPRIS_PATH, PLAYER_IFACE).await
}
