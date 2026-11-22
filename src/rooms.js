// A "room" is one voice channel's watch session: one shared Plex stream, one server-owned clock.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as plex from './plex.js';
import { findPreset } from './settings.js';

export const events = new EventEmitter(); // 'update' (room), 'end' (roomId)
const rooms = new Map(); // voiceChannelId -> room

const now = () => Date.now();

export function position(room) {
  if (!room) return 0;
  const p = room.playing ? room.anchorPos + (now() - room.anchorTime) / 1000 : room.anchorPos;
  return room.item.duration ? Math.min(p, room.item.duration) : p;
}

export function publicState(room) {
  if (!room) return { active: false };
  return {
    active: true,
    title: room.item.title,
    source: room.item.source,
    duration: room.item.duration,
    playlist: room.playlist,
    playlistVersion: room.playlistVersion,
    offsetBase: room.offsetBase, // stream time 0 == this many seconds into the title
    playing: room.playing,
    position: position(room),
    serverTime: now(),
    startedBy: room.startedBy,
    startedById: room.startedById,
    quality: room.quality,
  };
}

export const get = (roomId) => rooms.get(roomId);
export const all = () => [...rooms.values()];
/** The room a user started, if any (one stream per user). */
export const startedBy = (userId) => [...rooms.values()].find((r) => r.startedById === userId) || null;

/** Change a running stream's quality; restarts Plex's transcode at the current position. */
export async function setQuality(roomId, quality) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.quality = findPreset(quality).id;
  return reload(roomId);
}
const emit = (room) => events.emit('update', room);

async function releasePlex(room) {
  if (!room.plexSession) return;
  const sessionId = room.plexSession;
  room.plexSession = null;
  await plex.stopTranscode(sessionId);
  if (room.plexKey) {
    // "stopped" tells Plex the playback ended; for live TV this frees the tuner.
    await plex.timeline({ key: room.plexKey, ratingKey: room.plexRatingKey, state: 'stopped', timeMs: position(room) * 1000, durationMs: room.item.duration * 1000, sessionId });
  }
}

/** (Re)start the shared Plex stream at `seconds` into the title (ignored for live TV). */
async function load(room, seconds) {
  await releasePlex(room);
  const sessionId = crypto.randomUUID();
  if (room.item.source === 'live') {
    const tuned = await plex.tune(room.item, sessionId);
    room.plexKey = tuned.key;
    room.plexRatingKey = tuned.ratingKey;
    room.masterPlaylist = await plex.startTranscode({ path: tuned.key, sessionId, preset: findPreset(room.quality) });
    room.offsetBase = 0;
  } else {
    room.plexKey = `/library/metadata/${room.item.ratingKey}`;
    room.plexRatingKey = room.item.ratingKey;
    const preset = findPreset(room.quality);
    const mediaIndex = await plex.pickMediaIndex(room.item.ratingKey, preset);
    room.masterPlaylist = await plex.startTranscode({ path: room.plexKey, offset: seconds, mediaIndex, sessionId, preset });
    // Plex's playlist always spans the whole title (EXT-X-START marks where this transcode begins),
    // so stream time == title time; the player seeks straight to the position.
    room.offsetBase = 0;
  }
  room.plexSession = sessionId;
  room.playlistVersion++;
  room.playlist = `room/${room.id}/master.m3u8?v=${room.playlistVersion}`; // client prefixes /media/t/<token>/
}

export async function start(roomId, guildId, item, user, quality) {
  await stop(roomId, false, 'replaced by a new title');
  const room = {
    id: roomId, guildId, item, startedBy: user.name, startedById: user.id, quality: findPreset(quality).id,
    playing: true, anchorPos: 0, anchorTime: now(),
    offsetBase: 0, playlistVersion: 0, playlist: null,
    plexSession: null, plexKey: null, plexRatingKey: null,
    viewers: 0, idleSince: now(),
  };
  rooms.set(roomId, room);
  try {
    await load(room, 0);
  } catch (e) {
    rooms.delete(roomId);
    throw e;
  }
  room.anchorTime = now();
  emit(room);
  return room;
}

export function pause(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.playing) return room;
  room.anchorPos = position(room);
  room.anchorTime = now();
  room.playing = false;
  emit(room);
  return room;
}

export async function resume(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.playing) return room;
  // Live TV resumes at the live edge; a fresh tune avoids a stale session after a long pause.
  if (room.item.source === 'live') await load(room, 0);
  room.anchorTime = now();
  room.playing = true;
  emit(room);
  return room;
}

export async function seek(roomId, seconds) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (room.item.source !== 'plex') throw new Error("You can't seek live TV.");
  const target = Math.max(0, Math.min(seconds, (room.item.duration || seconds) - 5));
  await load(room, target); // restart Plex's transcode at the new point so every viewer lands together
  room.anchorPos = target;
  room.anchorTime = now();
  emit(room);
  return room;
}

/** Restart the stream at the current position (used after the admin changes quality settings). */
export async function reload(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const isLive = room.item.source === 'live';
  const pos = isLive ? 0 : position(room);
  await load(room, pos);
  room.anchorPos = pos;
  room.anchorTime = now();
  emit(room);
  return room;
}

export async function stop(roomId, announce = true, reason = 'stopped') {
  const room = rooms.get(roomId);
  if (!room) return false;
  console.log(`[room] ${room.item.title} in ${roomId} ended: ${reason} (at ${Math.floor(position(room))}s, ${room.viewers} watching)`);
  rooms.delete(roomId);
  await releasePlex(room);
  if (announce) events.emit('end', roomId);
  return true;
}

export function setViewers(roomId, count) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.viewers !== count) console.log(`[room] ${room.item.title}: ${count} watching`);
  room.viewers = count;
  if (count > 0) room.idleSince = null;
  else if (!room.idleSince) room.idleSince = now();
}

// Housekeeping: keep Plex sessions alive, report progress, end finished titles, clean up empty rooms.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.plexSession) {
      plex.pingTranscode(room.plexSession);
      plex.timeline({
        key: room.plexKey, ratingKey: room.plexRatingKey, state: room.playing ? 'playing' : 'paused',
        timeMs: position(room) * 1000, durationMs: room.item.duration * 1000, sessionId: room.plexSession,
      });
    }
    if (room.item.duration && position(room) >= room.item.duration - 1) { stop(room.id, true, 'reached the end'); continue; }
    if (room.idleSince && now() - room.idleSince > 10 * 60_000) stop(room.id, true, 'nobody watching for 10 minutes');
  }
}, 20_000).unref();
