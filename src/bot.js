// The bot has no commands. It provides presence in the server: voice-channel lookups,
// role checks, and "now playing" notices in each voice channel's text chat.
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './config.js';
import { settings } from './settings.js';
import * as auth from './auth.js';
import * as rooms from './rooms.js';

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

client.once(Events.ClientReady, (c) => console.log(`Discord bot logged in as ${c.user.tag}`));

// If everyone leaves a voice channel, stop its stream after a one-minute grace period.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const chId = oldState.channelId;
  if (!chId || !rooms.get(chId)) return;
  setTimeout(() => {
    const ch = oldState.guild.channels.cache.get(chId);
    if (ch && ch.members.filter((m) => !m.user.bot).size === 0) rooms.stop(chId);
  }, 60_000);
});

export async function startBot() {
  auth.setClient(client);
  await client.login(config.botToken);
}
