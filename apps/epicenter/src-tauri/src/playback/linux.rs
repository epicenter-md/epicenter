//! Best-effort Linux playback suppression through MPRIS.

use std::future::Future;
use std::time::Duration;

use zbus::fdo::DBusProxy;
use zbus::names::BusName;
use zbus::{Connection, Proxy};

const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const DBUS_TIMEOUT: Duration = Duration::from_secs(2);

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
    players: Vec<PlayerIdentity>,
}

pub(super) async fn suppress() -> Result<Effect, String> {
    suppress_inner()
        .await
        .map_err(|error| format!("MPRIS suppression unavailable: {error}"))
}

pub(super) async fn restore(effect: Effect) -> Result<(), String> {
    if effect.players.is_empty() {
        return Ok(());
    }
    restore_inner(effect)
        .await
        .map_err(|error| format!("MPRIS restoration unavailable: {error}"))
}

async fn suppress_inner() -> zbus::Result<Effect> {
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
    Ok(Effect { players })
}

async fn restore_inner(effect: Effect) -> zbus::Result<()> {
    let connection = timeout("connect to session bus", Connection::session()).await?;
    for identity in effect.players {
        let name = identity.name.clone();
        match tokio::time::timeout(DBUS_TIMEOUT, restore_if_paused(&connection, identity)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!("MPRIS restore failed for {name}: {error}"),
            Err(error) => log::warn!("MPRIS restore timed out for {name}: {error}"),
        }
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
    if !player
        .get_property::<bool>("CanPause")
        .await
        .unwrap_or(false)
    {
        return Ok(None);
    }
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
