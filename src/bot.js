// The bot has no commands. It provides presence in the server: voice-channel lookups,
// role checks, and "now playing" notices in each voice channel's text chat.
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './config.js';
import { settings } from './settings.js';
import * as auth from './auth.js';
import * as rooms from './rooms.js';
import * as plex from './plex.js';

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

/** Post a message in a voice channel's built-in text chat. */
export async function announce(channelId, content) {
  if (!settings().announceInVoiceChat) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch?.isTextBased()) await ch.send({ content, allowedMentions: { parse: [] } });
  } catch (e) { console.warn('announce failed:', e.message); }
}

/**
 * "Now playing" post in a text channel the user picked when pressing Play:
 * a card with the poster, synopsis and a link to the voice channel.
 */
export async function announceNowPlaying(textChannelId, { item, voiceChannelId, startedBy }) {
  try {
    const ch = await client.channels.fetch(textChannelId);
    if (!ch?.isTextBased()) return;
    const files = [];
    let thumbnail;
    if (item.thumb && item.source === 'plex') {
      const r = await fetch(plex.photoUrl(item.thumb, 300, 450)).catch(() => null);
      if (r?.ok) {
        files.push({ attachment: Buffer.from(await r.arrayBuffer()), name: 'poster.jpg' });
        thumbnail = { url: 'attachment://poster.jpg' };
      }
    }
    const sum = item.summary && item.summary.length > 300 ? item.summary.slice(0, 297).trimEnd() + '…' : item.summary;
    const facts = [item.year, item.contentRating, item.duration ? `${Math.round(item.duration / 60)} min` : ''].filter(Boolean).join(' · ');
    await ch.send({
      content: `▶️ **Now playing** in <#${voiceChannelId}>, started by ${startedBy}. Join the voice channel and open **Activities** (🚀) to watch.`,
      embeds: [{
        color: 0x1a86d8,
        title: item.source === 'live' ? `📡 ${item.title}` : item.title,
        description: [facts && `*${facts}*`, sum].filter(Boolean).join('\n\n') || undefined,
        thumbnail,
      }],
      files,
      allowedMentions: { parse: [] },
    });
  } catch (e) { console.warn('now-playing announcement failed:', e.message); }
}

client.once(Events.ClientReady, (c) => console.log(`Discord bot logged in as ${c.user.tag}`));

// If everyone leaves a voice channel, stop its stream after a one-minute grace period.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const chId = oldState.channelId;
  if (!chId || !rooms.get(chId)) return;
  setTimeout(() => {
    const ch = oldState.guild.channels.cache.get(chId);
    if (ch && ch.members.filter((m) => !m.user.bot).size === 0) rooms.stop(chId, true, 'voice channel empty for 1 minute');
  }, 60_000);
});

export async function startBot() {
  auth.setClient(client);
  await client.login(config.botToken);
}
