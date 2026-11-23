// The bots have no commands. They provide presence in each server: voice-channel lookups,
// role checks, and "now playing" notices in each voice channel's text chat.
// Each Discord app's bot is run by discord.js (see discord.js); messages go out through
// whichever bot is in the channel's server.
import { Events } from 'discord.js';
import { settings } from './settings.js';
import * as discord from './discord.js';
import * as rooms from './rooms.js';
import * as plex from './plex.js';
import * as sources from './sources.js';

/** Post a message in a voice channel's built-in text chat. */
export async function announce(channelId, content) {
  if (!settings().announceInVoiceChat) return;
  try {
    const ch = discord.channel(channelId);
    if (ch?.isTextBased()) await ch.send({ content, allowedMentions: { parse: [] } });
  } catch (e) { console.warn('announce failed:', e.message); }
}

/**
 * "Now playing" post in a text channel the user picked when pressing Play:
 * a card with the poster, synopsis and a link to the voice channel.
 */
export async function announceNowPlaying(textChannelId, { item, voiceChannelId, startedBy }) {
  try {
    const ch = discord.channel(textChannelId);
    if (!ch?.isTextBased()) return;
    const msg = item.source === 'live'
      ? await liveCard(item)
      : await titleCard(item);
    await ch.send({
      content: `▶️ **Now playing** in <#${voiceChannelId}>, started by ${startedBy}. Join the voice channel and open **Activities** (🚀) to watch.`,
      ...msg,
      allowedMentions: { parse: [] },
    });
  } catch (e) { console.warn('now-playing announcement failed:', e.message); }
}

const clip = (t, n) => (t && t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t || '');
/** Fetch an image (Plex path or URL) through Plex's photo transcoder and attach it to the message. */
async function attach(files, src, name, w, h) {
  if (!src) return null;
  // Images go through their media server (Plex's photo transcoder, or Jellyfin/Emby's image API).
  const r = await sources.anyImage(src, w, h);
  if (!r?.ok) {
    // Logos on the LAN or odd hosts: try them directly.
    const d = /^https?:/.test(src) ? await fetch(src).catch(() => null) : null;
    if (!d?.ok) return null;
    files.push({ attachment: Buffer.from(await d.arrayBuffer()), name });
    return `attachment://${name}`;
  }
  files.push({ attachment: Buffer.from(await r.arrayBuffer()), name });
  return `attachment://${name}`;
}

async function titleCard(item) {
  const files = [];
  const poster = await attach(files, item.thumb, 'poster.jpg', 300, 450);
  const facts = [item.year, item.contentRating, item.duration ? `${Math.round(item.duration / 60)} min` : ''].filter(Boolean).join(' · ');
  return {
    embeds: [{
      color: 0x1a86d8,
      title: item.title,
      description: [facts && `*${facts}*`, clip(item.summary, 300)].filter(Boolean).join('\n\n') || undefined,
      thumbnail: poster ? { url: poster } : undefined,
    }],
    files,
  };
}

/** Live TV: channel as the header, then the programme on now with start/end/time left, poster and description. */
async function liveCard(item) {
  const info = await plex.liveNow(item.channelId).catch(() => null);
  const files = [];
  const chName = info?.channel ? [info.channel.number, info.channel.callSign || info.channel.name].filter(Boolean).join(' · ') : item.title;
  const logo = await attach(files, info?.channel?.thumb, 'logo.png', 120, 90);
  const p = info?.now;
  const author = { name: `📡 LIVE TV · Channel ${chName}`, icon_url: logo || undefined };
  if (!p) {
    return { embeds: [{ color: 0xe0261b, author, title: item.title, description: 'No guide information for this channel right now.', thumbnail: logo ? { url: logo } : undefined }], files };
  }
  const poster = await attach(files, p.thumb, 'poster.jpg', 300, 450);
  const s = Math.floor(p.start / 1000), e = Math.floor(p.stop / 1000);
  const left = Math.max(0, Math.round((p.stop - Date.now()) / 60_000));
  const leftTxt = left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left}m`;
  const ep = p.season != null && p.episode != null ? `S${String(p.season).padStart(2, '0')}E${String(p.episode).padStart(2, '0')}` : '';
  const sub = [ep, p.subtitle].filter(Boolean).join(' · ');
  const facts = [p.premiere ? '🆕 New' : '', p.contentRating, p.year, p.genres.join(', ')].filter(Boolean).join(' · ');
  return {
    embeds: [{
      color: 0xe0261b,
      author,
      title: p.title,
      description: [[sub && `**${sub}**`, facts && `*${facts}*`].filter(Boolean).join('\n'), clip(p.desc, 350)].filter(Boolean).join('\n\n') || undefined,
      fields: [
        { name: 'Started', value: `<t:${s}:t>`, inline: true },
        { name: 'Ends', value: `<t:${e}:t>`, inline: true },
        { name: 'Time left', value: `${leftTxt} (ends <t:${e}:R>)`, inline: true },
        // Discord timestamps show in each reader's own time zone.
        ...(info.next ? [{ name: 'Up next', value: `<t:${Math.floor(info.next.start / 1000)}:t> · ${clip(info.next.title, 80)}`, inline: false }] : []),
      ],
      thumbnail: poster ? { url: poster } : logo ? { url: logo } : undefined,
    }],
    files,
  };
}

// If everyone leaves a voice channel, stop its stream after a one-minute grace period.
const pendingEmpty = new Set();
discord.onClient((client) => {
  client.on(Events.VoiceStateUpdate, (oldState) => {
    const chId = oldState.channelId;
    if (!chId || !rooms.get(chId) || pendingEmpty.has(chId)) return; // several bots can share a server
    pendingEmpty.add(chId);
    setTimeout(() => {
      pendingEmpty.delete(chId);
      const ch = discord.channel(chId);
      if (ch && ch.members.filter((m) => !m.user.bot).size === 0) rooms.stop(chId, true, 'voice channel empty for 1 minute');
    }, 60_000);
  });
});

export async function startBot() {
  await discord.sync();
}
