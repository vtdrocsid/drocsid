// Static config (secrets and URLs) from environment variables — see .env.example.
// Everything adjustable at runtime lives in settings.js and is edited on the Admin page.
const req = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
};
export const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  publicUrl: req('PUBLIC_URL').replace(/\/$/, ''),

  clientId: req('DISCORD_CLIENT_ID'),
  clientSecret: req('DISCORD_CLIENT_SECRET'),
  botToken: req('DISCORD_BOT_TOKEN'),
  guildId: req('DISCORD_GUILD_ID'),
  // Bootstrap admins (always admin, can't be removed in the UI). Comma-separated Discord user IDs.
  ownerIds: list(req('OWNER_USER_IDS')),

  plexUrl: req('PLEX_URL').replace(/\/$/, ''),
  plexToken: req('PLEX_TOKEN'),

  dataDir: process.env.DATA_DIR || '/data',
  port: Number(process.env.PORT || 3000),
};
