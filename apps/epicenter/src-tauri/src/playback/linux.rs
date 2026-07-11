//! Best-effort Linux playback suppression through MPRIS.

use std::future::Future;
use std::time::Duration;

use zbus::fdo::DBusProxy;
use zbus::names::BusName;
use zbus::{Connection, Proxy};

use super::{PlaybackSuppressionMode, DUCK_TARGET};

const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const DBUS_TIMEOUT: Duration = Duration::from_secs(2);
const VOLUME_EPSILON: f64 = 0.001;

struct PlayerIdentity {
    name: String,
    unique_owner: String,
}

struct PlayingPlayer {
    identity: PlayerIdentity,
    proxy: Proxy<'static>,
}

/// Exact D-Bus identities for players Epicenter sent a pause request to.
pub(super) struct Effect {
    kind: EffectKind,
}

enum EffectKind {
    Pause(Vec<PlayerIdentity>),
    Volume(Vec<PlayerVolume>),
}

struct PlayerVolume {
    identity: PlayerIdentity,
    original: f64,
    applied: f64,
}

pub(super) async fn suppress(mode: PlaybackSuppressionMode) -> Result<Effect, String> {
    let kind = match mode {
        PlaybackSuppressionMode::Pause => EffectKind::Pause(suppress_pause().await?),
        PlaybackSuppressionMode::Duck => {
            EffectKind::Volume(suppress_volume(f64::from(DUCK_TARGET)).await?)
        }
        PlaybackSuppressionMode::Mute => EffectKind::Volume(suppress_volume(0.0).await?),
    };
    Ok(Effect { kind })
}

pub(super) async fn restore(effect: Effect) -> Result<(), String> {
    let result = match effect.kind {
        EffectKind::Pause(players) => restore_paused(players).await,
        EffectKind::Volume(players) => restore_volume(players).await,
    };
    result.map_err(|error| format!("MPRIS restoration unavailable: {error}"))
}

async fn suppress_pause() -> Result<Vec<PlayerIdentity>, String> {
    suppress_pause_inner()
        .await
        .map_err(|error| format!("MPRIS suppression unavailable: {error}"))
}

async fn suppress_volume(target: f64) -> Result<Vec<PlayerVolume>, String> {
    suppress_volume_inner(target)
        .await
        .map_err(|error| format!("MPRIS suppression unavailable: {error}"))
}

async fn suppress_pause_inner() -> zbus::Result<Vec<PlayerIdentity>> {
    let connection = timeout("connect to session bus", Connection::session()).await?;
    let names = timeout("list MPRIS players", mpris_players(&connection)).await?;
    let mut players = Vec::new();
    for name in names {
        let playing =
            match tokio::time::timeout(DBUS_TIMEOUT, playing_player(&connection, &name)).await {
                Ok(Ok(playing)) => playing,
                Err(error) => {
                    log::warn!("MPRIS observation timed out for {name}: {error}");
                    None
                }
                Ok(Err(error)) => {
                    log::warn!("MPRIS observation failed for {name}: {error}");
                    None
                }
            };
        let Some(playing) = playing else {
            continue;
        };
        let can_pause = match tokio::time::timeout(
            DBUS_TIMEOUT,
            playing.proxy.get_property::<bool>("CanPause"),
        )
        .await
        {
            Ok(Ok(can_pause)) => can_pause,
            Ok(Err(error)) => {
                log::warn!("MPRIS pause capability read failed for {name}: {error}");
                false
            }
            Err(error) => {
                log::warn!("MPRIS pause capability read timed out for {name}: {error}");
                false
            }
        };
        if !can_pause {
            continue;
        }

        let pause = playing.proxy.call::<_, _, ()>("Pause", &());
        match tokio::time::timeout(DBUS_TIMEOUT, pause).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!("MPRIS pause outcome unknown for {name}: {error}"),
            Err(error) => log::warn!("MPRIS pause outcome timed out for {name}: {error}"),
        }
        // Once Pause has been sent, a missing reply is ambiguous: conservatively
        // retain the exact identity so restoration can inspect its final state.
        players.push(playing.identity);
    }
    Ok(players)
}

async fn suppress_volume_inner(target: f64) -> zbus::Result<Vec<PlayerVolume>> {
    let connection = timeout("connect to session bus", Connection::session()).await?;
    let names = timeout("list MPRIS players", mpris_players(&connection)).await?;
    let mut players = Vec::new();
    for name in names {
        let playing =
            match tokio::time::timeout(DBUS_TIMEOUT, playing_player(&connection, &name)).await {
                Ok(Ok(playing)) => playing,
                Ok(Err(error)) => {
                    log::warn!("MPRIS observation failed for {name}: {error}");
                    None
                }
                Err(error) => {
                    log::warn!("MPRIS observation timed out for {name}: {error}");
                    None
                }
            };
        let Some(playing) = playing else {
            continue;
        };
        let original: f64 =
            match tokio::time::timeout(DBUS_TIMEOUT, playing.proxy.get_property("Volume")).await {
                Ok(Ok(volume)) => volume,
                Ok(Err(error)) => {
                    log::warn!("MPRIS volume read failed for {name}: {error}");
                    continue;
                }
                Err(error) => {
                    log::warn!("MPRIS volume read timed out for {name}: {error}");
                    continue;
                }
            };
        let requested = original.min(target);
        if approximately_equal(original, requested) {
            continue;
        }
        let write = playing.proxy.set_property("Volume", &requested);
        let applied = match tokio::time::timeout(DBUS_TIMEOUT, write).await {
            Ok(Ok(())) => {
                match tokio::time::timeout(DBUS_TIMEOUT, playing.proxy.get_property("Volume")).await
                {
                    Ok(Ok(volume)) => volume,
                    Ok(Err(error)) => {
                        log::warn!("MPRIS volume readback failed for {name}: {error}");
                        requested
                    }
                    Err(error) => {
                        log::warn!("MPRIS volume readback timed out for {name}: {error}");
                        requested
                    }
                }
            }
            Ok(Err(error)) => {
                log::warn!("MPRIS volume outcome unknown for {name}: {error}");
                requested
            }
            Err(error) => {
                log::warn!("MPRIS volume outcome timed out for {name}: {error}");
                requested
            }
        };
        players.push(PlayerVolume {
            identity: playing.identity,
            original,
            applied,
        });
    }
    Ok(players)
}

async fn restore_paused(players: Vec<PlayerIdentity>) -> zbus::Result<()> {
    let connection = timeout("connect to session bus", Connection::session()).await?;
    for identity in players {
        let name = identity.name.clone();
        match tokio::time::timeout(DBUS_TIMEOUT, restore_if_paused(&connection, identity)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!("MPRIS restore failed for {name}: {error}"),
            Err(error) => log::warn!("MPRIS restore timed out for {name}: {error}"),
        }
    }
    Ok(())
}

async fn restore_volume(players: Vec<PlayerVolume>) -> zbus::Result<()> {
    let connection = timeout("connect to session bus", Connection::session()).await?;
    for snapshot in players {
        let name = snapshot.identity.name.clone();
        let restore = restore_player_volume(&connection, snapshot);
        match tokio::time::timeout(DBUS_TIMEOUT, restore).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!("MPRIS volume restore failed for {name}: {error}"),
            Err(error) => log::warn!("MPRIS volume restore timed out for {name}: {error}"),
        }
    }
    Ok(())
}

async fn restore_player_volume(
    connection: &Connection,
    snapshot: PlayerVolume,
) -> zbus::Result<()> {
    if name_owner(connection, &snapshot.identity.name).await? != snapshot.identity.unique_owner {
        return Ok(());
    }
    let player = player_proxy(connection, &snapshot.identity.unique_owner).await?;
    let current: f64 = player.get_property("Volume").await?;
    if approximately_equal(current, snapshot.applied) {
        player.set_property("Volume", &snapshot.original).await?;
    }
    Ok(())
}

async fn restore_if_paused(connection: &Connection, identity: PlayerIdentity) -> zbus::Result<()> {
    if name_owner(connection, &identity.name).await? != identity.unique_owner {
        return Ok(());
    }
    let player = player_proxy(connection, &identity.unique_owner).await?;
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

async fn playing_player(
    connection: &Connection,
    name: &str,
) -> zbus::Result<Option<PlayingPlayer>> {
    let unique_owner = name_owner(connection, name).await?;
    let player = player_proxy(connection, &unique_owner).await?;
    let status: String = player.get_property("PlaybackStatus").await?;
    if status != "Playing" {
        return Ok(None);
    }
    Ok(Some(PlayingPlayer {
        identity: PlayerIdentity {
            name: name.to_string(),
            unique_owner,
        },
        proxy: player,
    }))
}

async fn name_owner(connection: &Connection, name: &str) -> zbus::Result<String> {
    let proxy = DBusProxy::new(connection).await?;
    let name = BusName::try_from(name)?;
    Ok(proxy.get_name_owner(name).await?.to_string())
}

async fn timeout<T>(
    operation: &str,
    future: impl Future<Output = zbus::Result<T>>,
) -> zbus::Result<T> {
    tokio::time::timeout(DBUS_TIMEOUT, future)
        .await
        .map_err(|_| zbus::Error::Failure(format!("timed out trying to {operation}")))?
}

async fn player_proxy(connection: &Connection, name: &str) -> zbus::Result<Proxy<'static>> {
    Proxy::new(connection, name.to_owned(), MPRIS_PATH, PLAYER_IFACE).await
}

fn approximately_equal(left: f64, right: f64) -> bool {
    (left - right).abs() <= VOLUME_EPSILON
}
