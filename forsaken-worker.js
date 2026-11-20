const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { Pool } = require("pg");
const { initializeAiDatabase, handleAiCommand } = require("./ai");
const express = require("express");
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, AttachmentBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CUSTOM_FILE = path.join(DATA_DIR, "custom-commands.json");
const INVITES_FILE = path.join(DATA_DIR, "invite-counts.json");
const WELCOME_SETTINGS_FILE = path.join(DATA_DIR, "welcome-settings.json");
const VERIFY_SETTINGS_FILE = path.join(DATA_DIR, "verification-settings.json");
const SECURITY_SETTINGS_FILE = path.join(DATA_DIR, "security-settings.json");
const TICKET_SETTINGS_FILE = path.join(DATA_DIR, "ticket-settings.json");
function loadTicketSettings() { try { return JSON.parse(fs.readFileSync(TICKET_SETTINGS_FILE, "utf8")); } catch { return {}; } }
const ticketSettings = loadTicketSettings();
function saveTicketSettings() { fs.writeFileSync(TICKET_SETTINGS_FILE, JSON.stringify(ticketSettings, null, 2)); }
function canManageTicket(member, settings) {
  if (!member || !settings) return false;
  return member.id === "1415008230714904722" || member.roles.cache.has(settings.founderRoleId) ||
    (settings.staffRoleIds || []).some(id => member.roles.cache.has(id));
}
async function sendTicketTranscript(channel, transcriptChannel, closedBy) {
  const lines = [];
  let before;
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    const ordered = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of ordered) {
      const body = (m.content || "").replace(/\r/g, "");
      const files = [...m.attachments.values()].map(a => a.url).join(", ");
      lines.push("[" + new Date(m.createdTimestamp).toISOString() + "] " + m.author.tag + " (" + m.author.id + "): " + body + (files ? " [Attachments: " + files + "]" : ""));
    }
    before = page.last().id;
    if (page.size < 100) break;
  }
  lines.sort((a, b) => a.localeCompare(b));
  const content = "Ticket: #" + channel.name + "\nChannel ID: " + channel.id + "\nClosed by: " + closedBy.tag + "\nMessages exported: " + lines.length + "\n\n" + lines.join("\n");
  const file = new AttachmentBuilder(Buffer.from(content.slice(0, 1900000), "utf8"), { name: "transcript-" + channel.id + ".txt" });
  await transcriptChannel.send({ content: "Ticket transcript for #" + channel.name + ". Founder-only archive.", files: [file] });
}

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const VERIFY_ROLE_ID = process.env.VERIFY_ROLE_ID;

fs.mkdirSync(DATA_DIR, { recursive: true });
function loadCustom() {
  try { return JSON.parse(fs.readFileSync(CUSTOM_FILE, "utf8")); }
  catch { return {}; }
}
let customCommands = loadCustom();
function loadInviteCounts() {
  try { return JSON.parse(fs.readFileSync(INVITES_FILE, "utf8")); }
  catch { return {}; }
}
const inviteCounts = loadInviteCounts();
function loadWelcomeSettings() {
  try { return JSON.parse(fs.readFileSync(WELCOME_SETTINGS_FILE, "utf8")); }
  catch { return {}; }
}
const welcomeChannels = loadWelcomeSettings();
function loadVerifySettings() { try { return JSON.parse(fs.readFileSync(VERIFY_SETTINGS_FILE, "utf8")); } catch { return {}; } }
const verifySettings = loadVerifySettings();
function loadSecuritySettings() { try { return JSON.parse(fs.readFileSync(SECURITY_SETTINGS_FILE, "utf8")); } catch { return {}; } }
const securitySettings = loadSecuritySettings();
function saveSecuritySettings() { fs.writeFileSync(SECURITY_SETTINGS_FILE, JSON.stringify(securitySettings, null, 2)); }
function getSecuritySettings(guildId) { return securitySettings[guildId] || { antiLink: true, antiSpam: true, antiRaid: true }; }
function saveVerifySettings() { fs.writeFileSync(VERIFY_SETTINGS_FILE, JSON.stringify(verifySettings, null, 2)); }
async function getVerificationSettings(guildId) {
  if (pool) {
    const result = await pool.query(
      "SELECT role_id AS \"roleId\", welcome_channel_id AS \"welcomeChannelId\", panel_message_id AS \"panelMessageId\" FROM verification_settings WHERE guild_id=$1",
      [guildId]
    );
    if (result.rowCount) return result.rows[0];
  }
  return verifySettings[guildId] || null;
}
async function persistVerificationSettings(guildId, settings) {
  if (!pool) throw new Error("DATABASE_URL is required for permanent verification settings");
  await pool.query(
    `INSERT INTO verification_settings(guild_id, role_id, welcome_channel_id, panel_message_id)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(guild_id) DO UPDATE SET role_id=EXCLUDED.role_id,
     welcome_channel_id=EXCLUDED.welcome_channel_id,
     panel_message_id=COALESCE(EXCLUDED.panel_message_id, verification_settings.panel_message_id),
     updated_at=NOW()`,
    [guildId, settings.roleId, settings.welcomeChannelId, settings.panelMessageId || null]
  );
  verifySettings[guildId] = settings;
  saveVerifySettings();
}
function saveWelcomeSettings() {
  fs.writeFileSync(WELCOME_SETTINGS_FILE, JSON.stringify(welcomeChannels, null, 2));
}
function saveInviteCounts() {
  fs.writeFileSync(INVITES_FILE, JSON.stringify(inviteCounts, null, 2));
}
function saveCustom() {
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(customCommands, null, 2));
}

const app = express();
app.get("/", (_req, res) => res.status(200).send("Devine Beamzz Bot is running."));
app.get("/health", (_req, res) => res.json({ ok: true, botConfigured: Boolean(TOKEN) }));
const DATABASE_URL = process.env.DATABASE_URL;
const OAUTH_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "https://devine-beamzz-bot.onrender.com/auth/discord/callback";
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: false, max: 3 }) : null;
const aiDbReady = pool ? initializeAiDatabase(pool).catch(err => console.error("Forsaken AI database initialization failed:", err.message)) : Promise.resolve();
function tokenKey() {
  if (!OAUTH_KEY) throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is not configured");
  return crypto.createHash("sha256").update(OAUTH_KEY, "utf8").digest();
}
function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function unseal(value) {
  const [iv, tag, data] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
async function initRecoveryDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL,
    discord_user_id TEXT, guild_id TEXT, role_id TEXT
  )`);
  await pool.query("ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS discord_user_id TEXT");
  await pool.query("ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS guild_id TEXT");
  await pool.query("ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS role_id TEXT");
  await pool.query(`CREATE TABLE IF NOT EXISTS authorized_members (
    discord_user_id TEXT PRIMARY KEY,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS verification_settings (
    guild_id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL,
    welcome_channel_id TEXT NOT NULL,
    panel_message_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE verification_settings ADD COLUMN IF NOT EXISTS panel_message_id TEXT");
  console.log("OAuth recovery database schema is ready.");
}
if (pool) initRecoveryDb().catch(err => console.error("Recovery database initialization failed:", err.message));
app.get("/auth/discord", async (req, res) => {
  if (!pool || !OAUTH_KEY || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !TOKEN) {
    return res.status(503).send("Member authorization is not configured yet. Please contact a server administrator.");
  }
  const { guild_id: guildId, user_id: userId, role_id: roleId } = req.query;
  if (![guildId, userId, roleId].every(value => typeof value === "string" && /^\d{17,20}$/.test(value))) {
    return res.status(400).send("Invalid verification request. Return to Discord and press Verify again.");
  }
  try {
    await initRecoveryDb();
    const state = crypto.randomBytes(32).toString("hex");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    await pool.query(
      "INSERT INTO oauth_states(state_hash, expires_at, discord_user_id, guild_id, role_id) VALUES($1, NOW() + INTERVAL '10 minutes', $2, $3, $4)",
      [stateHash, userId, guildId, roleId]
    );
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "identify guilds.join");
    url.searchParams.set("state", state);
    return res.redirect(302, url.toString());
  } catch (err) {
    console.error("OAuth start failed:", err.message);
    return res.status(500).send("Could not start Discord authorization. Please try again later.");
  }
});
app.get("/auth/discord/callback", async (req, res) => {
  if (!pool || !OAUTH_KEY) return res.status(503).send("Authorization storage is unavailable.");
  const { code, state, error } = req.query;
  if (error) return res.status(400).send("Discord authorization was cancelled. No account was stored.");
  if (typeof code !== "string" || typeof state !== "string") return res.status(400).send("Missing authorization details.");
  try {
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    await initRecoveryDb();
    const stateResult = await pool.query("DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at > NOW() RETURNING discord_user_id, guild_id, role_id", [stateHash]);
    if (!stateResult.rowCount) return res.status(400).send("This authorization link expired or was already used. Return to Discord and press Verify again.");
    const verification = stateResult.rows[0];
    if (!verification.discord_user_id || !verification.guild_id || !verification.role_id) {
      return res.status(400).send("This is not a valid server verification request. Return to Discord and try again.");
    }
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) throw new Error("Discord token exchange failed");
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + tokens.access_token }
    });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) throw new Error("Could not identify Discord account");
    if (user.id !== verification.discord_user_id) {
      return res.status(403).send("The Discord account you authorized is not the account that clicked Verify. Nothing was verified. Return to the original account and try again.");
    }
    const grantedScopes = String(tokens.scope || "").split(/\s+/);
    if (!grantedScopes.includes("identify") || !grantedScopes.includes("guilds.join")) {
      return res.status(403).send("Discord did not grant the required identify and server-join permissions. Nothing was verified.");
    }
    await pool.query(`INSERT INTO authorized_members(discord_user_id, access_token_enc, refresh_token_enc, expires_at, consented_at, revoked_at)
      VALUES($1,$2,$3,NOW() + ($4 || ' seconds')::interval,NOW(),NULL)
      ON CONFLICT(discord_user_id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc,
      refresh_token_enc=EXCLUDED.refresh_token_enc, expires_at=EXCLUDED.expires_at, consented_at=NOW(), revoked_at=NULL`,
      [user.id, seal(tokens.access_token), seal(tokens.refresh_token), String(Number(tokens.expires_in || 604800))]);

    const joinResponse = await fetch("https://discord.com/api/v10/guilds/" + verification.guild_id + "/members/" + user.id, {
      method: "PUT",
      headers: { Authorization: "Bot " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: tokens.access_token })
    });
    if (!joinResponse.ok) {
      const detail = await joinResponse.text().catch(() => "");
      console.error("OAuth member join failed:", joinResponse.status, detail.slice(0, 300));
      return res.status(502).send("Your permission was saved, but the bot could not complete the server membership step. Ask a server administrator to check the bot's guild membership and permissions. You have not been marked verified.");
    }

    const roleResponse = await fetch(
      "https://discord.com/api/v10/guilds/" + verification.guild_id + "/members/" + user.id + "/roles/" + verification.role_id,
      { method: "PUT", headers: { Authorization: "Bot " + TOKEN } }
    );
    if (!roleResponse.ok) {
      const detail = await roleResponse.text().catch(() => "");
      console.error("OAuth verification role assignment failed:", roleResponse.status, detail.slice(0, 300));
      return res.status(502).send("Discord authorization succeeded, but the Verified role could not be assigned. You have not been marked verified. Please contact a server administrator.");
    }
    return res.send("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='font-family:Arial;max-width:650px;margin:40px auto;padding:20px'><h2>You're verified</h2><p>Discord authorization succeeded and the server has confirmed your Verified role. You can return to Discord.</p><p>You can revoke Forsaken's access later in Discord User Settings → Authorized Apps.</p></body></html>");
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    return res.status(500).send("Authorization could not be saved. Please contact the server owner.");
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Health server listening on " + PORT));

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing. Add it in Render Environment settings.");
} else {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.GuildMember]
  });

  const commands = [
    new SlashCommandBuilder().setName("security").setDescription("Configure server anti-abuse protection")
      .addSubcommand(sc => sc.setName("antilink").setDescription("Turn link filtering on or off")
        .addBooleanOption(o => o.setName("enabled").setDescription("Enable link filtering").setRequired(true)))
      .addSubcommand(sc => sc.setName("antispam").setDescription("Turn spam protection on or off")
        .addBooleanOption(o => o.setName("enabled").setDescription("Enable spam protection").setRequired(true)))
      .addSubcommand(sc => sc.setName("antiraid").setDescription("Turn raid detection on or off")
        .addBooleanOption(o => o.setName("enabled").setDescription("Enable raid detection").setRequired(true)))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("unhook").setDescription("Post the Forsaken unhook and account-safety announcement")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("site").setDescription("Open the Forsaken website"),
    new SlashCommandBuilder().setName("alerts").setDescription("Opt in or out of Forsaken announcement alerts"),
    new SlashCommandBuilder().setName("nuke").setDescription("Send a controlled owner-only announcement")
      .addStringOption(o => o.setName("text").setDescription("Announcement text").setMaxLength(1800).setRequired(true))
      .addIntegerOption(o => o.setName("limit").setDescription("Maximum channels to send to (1-5)").setMinValue(1).setMaxValue(5).setRequired(true))
      .addIntegerOption(o => o.setName("delay").setDescription("Delay between sends in seconds (1-60)").setMinValue(1).setMaxValue(60).setRequired(true)),
    new SlashCommandBuilder().setName("stopnuke").setDescription("Stop your active announcement"),
    new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages")
      .addIntegerOption(o => o.setName("amount").setDescription("Number of messages (1-1000)").setMinValue(1).setMaxValue(1000).setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName("ban").setDescription("Ban a member from this server")
      .addUserOption(o => o.setName("user").setDescription("Member to ban").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason for the ban").setMaxLength(500))
      .addIntegerOption(o => o.setName("delete-days").setDescription("Delete recent message history (0-7 days)").setMinValue(0).setMaxValue(7))
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder().setName("unban").setDescription("Unban a user by Discord ID")
      .addStringOption(o => o.setName("user-id").setDescription("Discord user ID").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason for the unban").setMaxLength(500))
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder().setName("timeout").setDescription("Temporarily prevent a member from chatting")
      .addUserOption(o => o.setName("user").setDescription("Member to timeout").setRequired(true))
      .addIntegerOption(o => o.setName("minutes").setDescription("Duration (1-40320 minutes)").setMinValue(1).setMaxValue(40320).setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason for the timeout").setMaxLength(500))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName("untimeout").setDescription("Remove a member's timeout")
      .addUserOption(o => o.setName("user").setDescription("Member to untimeout").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason for removing timeout").setMaxLength(500))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName("kick").setDescription("Remove a member from this server")
      .addUserOption(o => o.setName("user").setDescription("Member to kick").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason for the kick").setMaxLength(500))
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    new SlashCommandBuilder().setName("slowmode").setDescription("Set the current channel's slowmode")
      .addIntegerOption(o => o.setName("seconds").setDescription("Delay between messages (0-21600)").setMinValue(0).setMaxValue(21600).setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    new SlashCommandBuilder().setName("lock").setDescription("Lock the current channel for @everyone")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    new SlashCommandBuilder().setName("unlock").setDescription("Unlock the current channel for @everyone")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    new SlashCommandBuilder().setName("invite-stats").setDescription("Show invite counts for this server")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("invites").setDescription("Show how many members a user has invited")
      .addUserOption(o => o.setName("user").setDescription("Member to check; defaults to you")),
    new SlashCommandBuilder().setName("reinvite").setDescription("Restore members who have explicitly authorized Forsaken"),
    new SlashCommandBuilder().setName("ticket").setDescription("Configure and manage private support tickets")
      .addSubcommand(sc => sc.setName("setup").setDescription("Post the ticket panel and set the private transcript channel")
        .addChannelOption(o => o.setName("panel-channel").setDescription("Where members open tickets").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addChannelOption(o => o.setName("transcript-channel").setDescription("Private channel for closed-ticket transcripts").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addRoleOption(o => o.setName("founder-role").setDescription("Role that can view/manage all tickets and transcripts").setRequired(true)))
      .addSubcommandGroup(g => g.setName("role").setDescription("Manage ticket staff roles")
        .addSubcommand(sc => sc.setName("add").setDescription("Allow a role to view and manage open tickets")
          .addRoleOption(o => o.setName("role").setDescription("Staff role").setRequired(true)))
        .addSubcommand(sc => sc.setName("remove").setDescription("Remove a role's ticket access")
          .addRoleOption(o => o.setName("role").setDescription("Staff role").setRequired(true))))
      .addSubcommand(sc => sc.setName("close").setDescription("Close this ticket and save its transcript")),
    new SlashCommandBuilder().setName("verification").setDescription("Set up member verification and channel access")
      .addSubcommand(sc => sc.setName("setup").setDescription("Create the Verified role and lock public channels until members verify")
        .addChannelOption(o => o.setName("welcome-channel").setDescription("The only channel unverified members can see").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))),
    new SlashCommandBuilder().setName("verify").setDescription("Manage the permanent Forsaken verification panel")
      .addSubcommand(sc => sc.setName("setup").setDescription("Post or update the permanent verification panel")
        .addChannelOption(o => o.setName("channel").setDescription("Dedicated verification channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))),
    new SlashCommandBuilder().setName("welcome").setDescription("Configure the Forsaken welcome message")
      .addSubcommand(sc => sc.setName("setup").setDescription("Choose the channel for welcome messages")
        .addChannelOption(o => o.setName("channel").setDescription("Channel where new members will be welcomed").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))),
    new SlashCommandBuilder().setName("hidelink").setDescription("Format a Roblox profile, private server, or group link")
      .addStringOption(o => o.setName("type").setDescription("Choose the Roblox link type").setRequired(true)
        .addChoices(
          { name: "Profile link", value: "profile" },
          { name: "Private server link", value: "private-server" },
          { name: "Group link", value: "group" }
        ))
      .addStringOption(o => o.setName("url").setDescription("Paste the full original Roblox URL").setRequired(true)),
    new SlashCommandBuilder().setName("up").setDescription("Show public Discord profile information")
      .addUserOption(o => o.setName("user").setDescription("Member to look up")),
    new SlashCommandBuilder().setName("command-add").setDescription("Add a custom text command")
      .addStringOption(o => o.setName("name").setDescription("Command name, letters/numbers/hyphens").setRequired(true))
      .addStringOption(o => o.setName("response").setDescription("Reply text").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("command-edit").setDescription("Edit a custom text command")
      .addStringOption(o => o.setName("name").setDescription("Existing command name").setRequired(true))
      .addStringOption(o => o.setName("response").setDescription("New reply text").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("command-remove").setDescription("Remove a custom text command")
      .addStringOption(o => o.setName("name").setDescription("Command name").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("command-list").setDescription("List custom text commands")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder().setName("custom").setDescription("Run a saved custom reply command")
      .addStringOption(o => o.setName("name").setDescription("Saved command name").setRequired(true)),
    new SlashCommandBuilder().setName("ai").setDescription("Chat with Forsaken AI and manage its training")
      .addSubcommand(sc => sc.setName("prompt").setDescription("Ask Forsaken AI a question")
        .addStringOption(o => o.setName("prompt").setDescription("What would you like to ask?").setMaxLength(1800).setRequired(true)))
      .addSubcommand(sc => sc.setName("teach").setDescription("Teach Forsaken AI a fact (owner only)")
        .addStringOption(o => o.setName("question").setDescription("Question or topic").setMaxLength(1000).setRequired(true))
        .addStringOption(o => o.setName("answer").setDescription("Correct answer to remember").setMaxLength(2500).setRequired(true)))
      .addSubcommand(sc => sc.setName("forget").setDescription("Remove a training entry (owner only)")
        .addIntegerOption(o => o.setName("id").setDescription("Training entry ID").setMinValue(1).setRequired(true)))
      .addSubcommand(sc => sc.setName("knowledge").setDescription("View saved training entries (owner only)"))
      .addSubcommand(sc => sc.setName("personality").setDescription("Change Forsaken AI's personality (owner only)")
        .addStringOption(o => o.setName("text").setDescription("Describe how the AI should behave").setMaxLength(500).setRequired(true)))
      .addSubcommand(sc => sc.setName("reset").setDescription("Clear your own private AI conversation memory")),
    new SlashCommandBuilder().setName("revamp").setDescription("Use OpenAI to redesign this server from your prompt")
      .addSubcommand(sc => sc.setName("server").setDescription("Generate a server redesign plan")
        .addStringOption(o => o.setName("prompt").setDescription("Describe the server style and layout you want").setMaxLength(1000).setRequired(true))),
    new SlashCommandBuilder().setName("emoji").setDescription("Generate a custom server emoji with AI")
      .addSubcommand(sc => sc.setName("generate").setDescription("Create and add an AI-generated emoji to this server")
        .addStringOption(o => o.setName("prompt").setDescription("Describe the emoji you want").setMaxLength(500).setRequired(true))),
    new SlashCommandBuilder().setName("servers").setDescription("Post the permanent Forsaken game server directory")
  ];

  const inviteCache = new Map();
  const mobileCopyLinks = new Map();
  const activeBroadcasts = new Map();
  const pendingRevamps = new Map();
  async function cacheInvites(guild) {
    try {
      const invites = await guild.invites.fetch();
      inviteCache.set(guild.id, new Map(invites.map(i => [i.code, i.uses ?? 0])));
    } catch (e) {
      console.warn("Could not fetch invites for " + guild.id + "; grant Manage Server/View Audit Log as needed.", e.message);
    }
  }

  function publishManagerSnapshot() {
    if (!process.send) return;
    const guilds=[...client.guilds.cache.values()].map(g=>({id:g.id,name:g.name,memberCount:g.memberCount,channels:[...g.channels.cache.values()].filter(c=>c.isTextBased()).map(c=>({id:c.id,name:c.name}))}));
    process.send({type:"snapshot",guilds,commands:commands.map(c=>{const j=c.toJSON();return {name:j.name,description:j.description||""};})});
  }
  client.on("guildCreate",publishManagerSnapshot);
  client.on("guildDelete",publishManagerSnapshot);
  client.on("channelCreate",publishManagerSnapshot);
  client.on("channelDelete",publishManagerSnapshot);
  client.once("ready", async () => {
    console.log("Logged in as " + client.user.tag);
    try {
      const rest = new REST({ version: "10" }).setToken(TOKEN);
      const applicationId = client.application.id;

      // Publish one global command set for every server where Forsaken is installed.
      const uniqueCommands = [...new Map(commands.map(command => {
        const json = command.toJSON();
        return [json.name, json];
      })).values()];
      await rest.put(Routes.applicationCommands(applicationId), { body: uniqueCommands });
      console.log("Registered " + uniqueCommands.length + " global slash commands.");

      // Remove legacy guild-scoped copies so Discord does not show duplicate commands.
      for (const guild of client.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: [] });
        console.log("Cleared legacy guild commands for " + guild.id);
      }
    } catch (e) { console.error("Command registration failed:", e); }
    for (const guild of client.guilds.cache.values()) await cacheInvites(guild);
    publishManagerSnapshot();
  });

  const recentMessages = new Map();
  const recentJoins = new Map();
  const LINK_PATTERN = /(?:https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)/i;

  client.on("messageCreate", async message => {
    try {
      if (!message.guild || message.author.bot || !message.member) return;
      const settings = getSecuritySettings(message.guild.id);
      if (message.member.permissions.has(PermissionFlagsBits.ManageMessages) || message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

      if (settings.antiLink !== false && LINK_PATTERN.test(message.content || "")) {
        if (message.deletable) await message.delete().catch(() => {});
        const notice = await message.channel.send({ content: message.author.toString() + ", links are not allowed in this server." }).catch(() => null);
        if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);
        return;
      }

      if (settings.antiSpam !== false) {
        const key = message.guild.id + ":" + message.author.id;
        const now = Date.now();
        const recent = (recentMessages.get(key) || []).filter(timestamp => now - timestamp < 7000);
        recent.push(now);
        recentMessages.set(key, recent);
        if (recent.length >= 6) {
          recentMessages.set(key, []);
          if (message.deletable) await message.delete().catch(() => {});
          const botMember = await message.guild.members.fetchMe().catch(() => null);
          if (botMember && message.member.moderatable && message.member.id !== message.guild.ownerId) {
            await message.member.timeout(10 * 60 * 1000, "Automatic anti-spam protection").catch(() => {});
          }
          const notice = await message.channel.send({ content: message.author.toString() + ", slow down — spam protection was triggered." }).catch(() => null);
          if (notice) setTimeout(() => notice.delete().catch(() => {}), 7000);
        }
      }
    } catch (error) {
      console.error("Anti-abuse message check failed:", error.message);
    }
  });

  client.on("guildMemberAdd", async member => {
    try {
      const settings = getSecuritySettings(member.guild.id);
      if (settings.antiRaid !== false) {
        const now = Date.now();
        const joins = (recentJoins.get(member.guild.id) || []).filter(timestamp => now - timestamp < 10000);
        joins.push(now);
        recentJoins.set(member.guild.id, joins);
        if (joins.length === 10) {
          const alertChannel = member.guild.systemChannel || member.guild.channels.cache.find(ch =>
            ch.isTextBased() && ch.permissionsFor(member.guild.members.me)?.has(PermissionFlagsBits.SendMessages)
          );
          if (alertChannel) {
            await alertChannel.send({
              content: "⚠️ **Possible raid detected:** 10 or more members joined within 10 seconds. Staff, please review recent joins.",
              allowedMentions: { parse: [] }
            }).catch(() => {});
          }
        }
      }
    } catch (error) {
      console.error("Anti-raid check failed:", error.message);
    }
  });

    client.on("inviteCreate", invite => cacheInvites(invite.guild));
  client.on("inviteDelete", invite => cacheInvites(invite.guild));
  client.on("guildMemberAdd", async member => {
    try {
      const before = inviteCache.get(member.guild.id) || new Map();
      const after = await member.guild.invites.fetch();
      const used = after.find(i => (i.uses ?? 0) > (before.get(i.code) ?? 0));
      inviteCache.set(member.guild.id, new Map(after.map(i => [i.code, i.uses ?? 0])));
      if (used?.inviter?.id) {
        inviteCounts[member.guild.id] ||= {};
        inviteCounts[member.guild.id][used.inviter.id] = (inviteCounts[member.guild.id][used.inviter.id] || 0) + 1;
        saveInviteCounts();
        console.log(member.user.tag + " joined using invite " + used.code + " created by " + used.inviter.tag);
      }
    } catch (e) { console.warn("Invite tracking unavailable:", e.message); }

    try {
      let selectedChannelId = welcomeChannels[member.guild.id] || WELCOME_CHANNEL_ID;
      let welcomeText = "Welcome " + member.toString() + " to forsaken happy to have you here\nWe now have " + member.guild.memberCount + " pls verify to gain access to the server";
      let welcomeEnabled = true;
      if (process.env.BOT_MANAGER_BOT_ID && pool) {
        const saved = await pool.query('SELECT channel_id AS "channelId", message, enabled FROM bot_manager_welcome_settings WHERE bot_id=$1 AND guild_id=$2', [process.env.BOT_MANAGER_BOT_ID, member.guild.id]);
        if (saved.rowCount) {
          selectedChannelId = saved.rows[0].channelId;
          welcomeText = String(saved.rows[0].message || welcomeText).replaceAll("{user}", member.toString()).replaceAll("{server}", member.guild.name).replaceAll("{memberCount}", String(member.guild.memberCount));
          welcomeEnabled = saved.rows[0].enabled !== false;
        }
      }
      if (!welcomeEnabled) return;
      const channel = selectedChannelId ? await member.guild.channels.fetch(selectedChannelId).catch(() => null) : member.guild.systemChannel;
      if (!channel?.isTextBased()) return;
      const gifPath = path.join(__dirname, "file_000000006784821181ed255d46210d09.gif");
      const welcomeEmbed = new EmbedBuilder().setColor(0x9b111e).setDescription(welcomeText.slice(0, 4096));
      const payload = { embeds: [welcomeEmbed], allowedMentions: { users: [member.id] } };
      if (fs.existsSync(gifPath)) { welcomeEmbed.setImage("attachment://forsaken-thanks.gif"); payload.files = [new AttachmentBuilder(gifPath, { name: "forsaken-thanks.gif" })]; }
      await channel.send(payload);
    } catch (e) { console.error("Welcome message failed:", e); }
  });

  client.on("interactionCreate", async interaction => {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("servers_game:")) {
        const serverLists = {
          sab: ["https://discord.gg/sabmiddleman","https://discord.gg/frostblox","https://discord.gg/koodafl","https://discord.gg/stealsthebrainrot","https://discord.gg/stealabrainroc","https://discord.gg/sammy","https://discord.gg/stealarots","https://discord.gg/stealarod","https://discord.gg/sab","https://discord.gg/stealsbrainrot","https://discord.gg/stealabrainrod","https://discord.gg/brainrots","https://discord.gg/sammyserver","https://discord.gg/stealarot","https://discord.gg/stealabrainrotserver"],
          mm2: ["https://discord.gg/mm2values","https://discord.gg/supremevalues","https://discord.gg/jd","https://discord.gg/murdermystery2","https://discord.gg/murdermystery","https://discord.gg/mm2","https://discord.gg/ZBh9BBYEH4","https://discord.gg/CbrTVnMjcu","https://discord.gg/harvester","https://discord.gg/W6sCgR9yyn","https://mm2values/","https://discord.gg/murder-mystery-2-wiki-657257335751704638","https://discord.gg/acrylicmm2","https://discord.gg/mm2markets","https://discord.gg/robuxgw","https://discord.gg/roblox-central-1085314691703775232","https://discord.gg/celitime","https://discord.gg/luger","https://discord.gg/san-s-mm2-1170559872983633981","https://discord.gg/mm2deal","https://discord.gg/etrades","https://discord.gg/hRVr4wsS","https://discord.gg/mm2-rewards-1061851321830998166"],
          "adopt-me": ["https://discord.gg/ama","https://discord.gg/K2DUPzxcDX","https://discord.gg/W6sCgR9yyn","https://discord.gg/fishyblox","https://discord.gg/traderie","https://discord.gg/adoptme","https://discord.gg/elvebredd","https://discord.gg/amtv","https://discord.gg/starpets"],
          "blade-ball": ["https://discord.gg/bladeball","https://discord.gg/bladeballtrading"],
          "pet-simulator": ["https://discord.gg/biggames","https://discord.gg/psxc","https://discord.gg/cosmicvalues","https://discord.gg/W6sCgR9yyn"],
          "blox-fruits": ["https://discord.gg/bloxfruits","https://discord.gg/bfcs","https://discord.gg/dynasty","https://discord.gg/bloxfruit","https://discord.gg/tradings","https://discord.gg/bloxtrade","https://discord.gg/blox-fruits-wiki-590390461512810500","https://discord.gg/bloxfruitstrade","https://discord.gg/bloxzy","https://discord.gg/bloxfruitsvalues","https://discord.gg/bfhs","https://discord.gg/bfts","https://discord.gg/bloxy","https://discord.gg/bloxfruitstrading","https://discord.gg/fantasyplays"],
          "grow-a-garden": ["https://discord.gg/growagardenb","https://discord.gg/growagardenstock","https://discord.gg/gaghubb","https://discord.gg/gardenc","https://discord.gg/petmart","https://discord.gg/growagarden","https://discord.gg/jandel","https://discord.gg/growabiggarden","https://discord.gg/psxc","https://discord.gg/plants-vs-brainrots-grow-a-garden-stock-and-24-7-7-1131649953626849330","https://discord.gg/growagardentrades"],
          "da-hood": ["https://discord.gg/dahood","https://discord.gg/dh","https://discord.gg/dahoodcaps","https://discord.gg/dahoodtrades"],
          trading: ["https://discord.com/invite/R4yTPvs3Jx","https://discord.com/invite/xRWEdttHGU","https://discord.com/invite/KYkv6baXmU","https://discord.com/invite/jT2FZDFvwV","https://discord.com/invite/9CrfkYN6TG","https://discord.com/invite/CQnHJhTGfc","https://discord.com/invite/7ZAh2Dmu6G","https://discord.com/invite/xrpcbPykzd","https://discord.com/invite/4Dd8VKvh8p","https://discord.gg/4T5YHBShJW","https://discord.com/invite/NYJJzwhYwv"],
          rivals: ["https://discord.com/invite/robloxrivals","https://discord.com/invite/nosniygames","https://discord.com/invite/3VtJR2KJ5X","https://discord.com/invite/rivalslfg","https://discord.com/invite/rivalz","https://discord.com/invite/richboyrivals-1271970269212311662","https://discord.com/invite/sync"],
          "pls-donate": ["https://discord.gg/donomadness","https://discord.gg/the-donation-hub-983494809278889985","https://discord.gg/bloxbots","https://discord.gg/londonsfinest","https://discord.gg/grinds","https://discord.gg/hazem"],
          jailbreak: ["https://discord.gg/jailbreak","https://discord.gg/badimo","https://discord.gg/jbtrades"],
          ps99: ["https://discord.gg/qhEvBFwDs9","https://discord.gg/Rx4mXe3gmv","https://discord.gg/CGt9f8YAWk","https://discord.gg/T4zx2JmAnh","https://discord.gg/FmfHZfxGQw","https://discord.gg/ps99","https://discord.gg/russoplays","https://discord.gg/alphagg","https://discord.gg/zomg","https://discord.gg/biggames"]
        };
        const key = interaction.customId.slice("servers_game:".length);
        const links = serverLists[key];
        if (!links) return interaction.reply({ content: "That game list could not be found.", ephemeral: true });
        const title = key === "sab" ? "SAB" : key === "mm2" ? "MM2" : key === "ps99" ? "PS99" : key.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
        return interaction.reply({ content: "**" + title + " Discord servers**\n" + links.map((url, i) => (i + 1) + ". " + url).join("\n"), ephemeral: true, allowedMentions: { parse: [] } }).then(() => setTimeout(() => interaction.deleteReply().catch(() => {}), 180000));
      }
      if (interaction.customId === "ticket_open") {
        if (!interaction.inGuild()) return interaction.reply({ content: "Tickets are only available inside a server.", ephemeral: true });
        const settings = ticketSettings[interaction.guildId];
        if (!settings?.transcriptChannelId || !settings?.founderRoleId) return interaction.reply({ content: "Tickets have not been configured yet. Ask an administrator to run /ticket setup.", ephemeral: true });
        const existing = interaction.guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.topic === "forsaken-ticket-owner:" + interaction.user.id);
        if (existing) return interaction.reply({ content: "You already have an open ticket: " + existing.toString(), ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const overwrites = [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
          { id: settings.founderRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
          ...(settings.staffRoleIds || []).map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
        ];
        const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 18) || "member";
        const ticket = await interaction.guild.channels.create({ name: "ticket-" + safeName, type: ChannelType.GuildText, topic: "forsaken-ticket-owner:" + interaction.user.id, permissionOverwrites: overwrites, reason: "Ticket opened by " + interaction.user.tag });
        const closeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket_close").setLabel("CLOSE TICKET").setStyle(ButtonStyle.Danger));
        await ticket.send({ content: "<@" + interaction.user.id + "> Welcome to your support ticket. A staff member will be with you shortly. Use the button below when your issue is resolved.", components: [closeRow], allowedMentions: { users: [interaction.user.id] } });
        return interaction.editReply({ content: "Your private ticket is ready: " + ticket.toString() });
      }
      if (interaction.customId === "ticket_close") {
        if (!interaction.inGuild() || !interaction.channel) return interaction.reply({ content: "This button only works inside a ticket.", ephemeral: true });
        const settings = ticketSettings[interaction.guildId];
        const ownerMatch = interaction.channel.topic?.match(/^forsaken-ticket-owner:(\d{17,20})$/);
        if (!settings || !ownerMatch) return interaction.reply({ content: "This channel is not an active Forsaken ticket.", ephemeral: true });
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (interaction.user.id !== ownerMatch[1] && !canManageTicket(member, settings)) return interaction.reply({ content: "Only the ticket owner, Founder, or an approved ticket staff role can close this ticket.", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const archive = await interaction.guild.channels.fetch(settings.transcriptChannelId).catch(() => null);
        if (!archive?.isTextBased()) return interaction.editReply({ content: "The private transcript channel is missing. Ask an administrator to run /ticket setup again." });
        await sendTicketTranscript(interaction.channel, archive, interaction.user);
        await interaction.channel.permissionOverwrites.edit(ownerMatch[1], { ViewChannel: false, SendMessages: false });
        for (const roleId of settings.staffRoleIds || []) await interaction.channel.permissionOverwrites.edit(roleId, { ViewChannel: false, SendMessages: false }).catch(() => {});
        await interaction.channel.setName(("closed-" + interaction.channel.name).slice(0, 100)).catch(() => {});
        await interaction.channel.setTopic("forsaken-ticket-closed:" + ownerMatch[1]).catch(() => {});
        return interaction.editReply({ content: "Ticket closed. Its transcript has been saved in the private Founder archive." });
      }
      if (interaction.customId === "forsaken_verify") {
        if (!interaction.inGuild()) return interaction.reply({ content: "Verification is only available inside the server.", ephemeral: true });
        const savedVerification = await getVerificationSettings(interaction.guildId).catch(err => {
          console.error("Could not load persistent verification settings:", err.message);
          return null;
        });
        const configuredRoleId = savedVerification?.roleId || VERIFY_ROLE_ID;
        if (!configuredRoleId) return interaction.reply({ content: "Verification has not been set up by an administrator yet. Please contact a server administrator.", ephemeral: true });
        const role = await interaction.guild.roles.fetch(configuredRoleId).catch(() => null);
        if (!role) return interaction.reply({ content: "The verification role could not be found. Please contact an administrator.", ephemeral: true });
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: "I could not find your server membership.", ephemeral: true });
        // Do not skip OAuth consent just because the member already has the Verified role.
        // The member must explicitly authorize identify + guilds.join before recovery access is stored.
        if (!pool || !OAUTH_KEY || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
          return interaction.reply({ content: "Discord authorization is not configured yet. Please contact a server administrator.", ephemeral: true });
        }
        const authUrl = new URL("/auth/discord", REDIRECT_URI);
        authUrl.searchParams.set("guild_id", interaction.guildId);
        authUrl.searchParams.set("user_id", interaction.user.id);
        authUrl.searchParams.set("role_id", role.id);
        return interaction.reply({
          content: "To finish verification, authorize Forsaken with Discord. Review the requested permissions and approve them. You will only be verified after Discord confirms the authorization and the bot successfully assigns your Verified role.",
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("AUTHORIZE WITH DISCORD").setStyle(ButtonStyle.Link).setURL(authUrl.toString())
          )],
          ephemeral: true
        });
      }
      if (interaction.customId.startsWith("revamp_apply:") || interaction.customId.startsWith("revamp_cancel:")) {
        const [action, token] = interaction.customId.split(":");
        const pending = pendingRevamps.get(token);
        if (!pending || pending.expiresAt < Date.now()) {
          pendingRevamps.delete(token);
          return interaction.update({ content: "This revamp preview expired. Run /revamp server again to generate a fresh plan.", embeds: [], components: [] });
        }
        if (interaction.user.id !== "1415008230714904722" || interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId) {
          return interaction.reply({ content: "Only the Forsaken owner who generated this preview can approve it.", ephemeral: true });
        }
        if (action === "revamp_cancel") {
          pendingRevamps.delete(token);
          return interaction.update({ content: "Revamp cancelled. No server changes were made.", embeds: [], components: [] });
        }
        await interaction.deferUpdate();
        const targetGuild = await client.guilds.fetch(pending.guildId).catch(() => null);
        if (!targetGuild) {
          pendingRevamps.delete(token);
          return interaction.editReply({ content: "I could not load that server. No changes were applied.", embeds: [], components: [] });
        }
        const botMember = await targetGuild.members.fetchMe().catch(() => null);
        if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
          pendingRevamps.delete(token);
          return interaction.editReply({ content: "I need Manage Channels permission before I can apply this plan. No changes were applied.", embeds: [], components: [] });
        }
        let completed = 0;
        const failures = [];
        try {
          for (const item of pending.actions) {
            try {
              if (item.type === "create_category") {
                const exists = targetGuild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === item.name.toLowerCase());
                if (!exists) await targetGuild.channels.create({ name: item.name, type: ChannelType.GuildCategory, reason: "Owner-approved AI server revamp" });
              } else if (item.type === "create_text" || item.type === "create_voice") {
                const channelType = item.type === "create_text" ? ChannelType.GuildText : ChannelType.GuildVoice;
                const existing = targetGuild.channels.cache.find(ch => ch.type === channelType && ch.name.toLowerCase() === item.name.toLowerCase());
                if (!existing) {
                  const parent = item.category_name
                    ? targetGuild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === item.category_name.toLowerCase())
                    : null;
                  await targetGuild.channels.create({
                    name: item.name,
                    type: channelType,
                    ...(parent ? { parent: parent.id } : {}),
                    ...(item.type === "create_text" && item.topic ? { topic: item.topic } : {}),
                    reason: "Owner-approved AI server revamp"
                  });
                }
              } else if (item.type === "rename_channel" || item.type === "set_topic") {
                const channel = targetGuild.channels.cache.get(item.channel_id);
                if (!channel || channel.type === ChannelType.GuildCategory || channel.id === targetGuild.rulesChannelId || channel.id === targetGuild.publicUpdatesChannelId) {
                  throw new Error("Target channel is missing or protected.");
                }
                if (item.type === "rename_channel") {
                  await channel.setName(item.name, "Owner-approved AI server revamp");
                } else if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
                  await channel.setTopic(item.topic || null, "Owner-approved AI server revamp");
                } else {
                  throw new Error("Topics can only be set on text channels.");
                }
              }
              completed++;
            } catch (err) {
              failures.push((item.name || item.channel_id || item.type) + ": " + err.message);
            }
          }
        } finally {
          pendingRevamps.delete(token);
        }
        const failureText = failures.length ? "\nCould not apply " + failures.length + " item(s): " + failures.slice(0, 5).join("; ") : "";
        return interaction.editReply({
          content: "Revamp finished. Successfully applied **" + completed + "/" + pending.actions.length + "** approved changes." + failureText + "\n\nNo existing channels or roles were deleted, and permissions were not changed.",
          embeds: [],
          components: []
        });
      }
      if (interaction.customId === "mobile_copy") {
        const link = mobileCopyLinks.get(interaction.message.id);
        if (!link) return interaction.reply({ content: "That link is no longer available. Please run /hidelink again.", ephemeral: true });
        return interaction.reply({ content: link, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
    console.log("Slash command received:", name, "by", interaction.user?.id, "in", interaction.guildId || "DM");
    const brandedReply = async payload => {
      const reply = typeof payload === "string" ? { content: payload } : { ...payload };
      const ephemeral = reply.ephemeral ?? true;
      delete reply.ephemeral;

      const gifPath = path.join(__dirname, "file_000000006784821181ed255d46210d09.gif");
      const embeds = Array.isArray(reply.embeds) ? [...reply.embeds] : [];
      const embed = embeds.length ? EmbedBuilder.from(embeds[0]) : new EmbedBuilder().setColor(0x9b111e);

      if (reply.content) {
        const existingDescription = embed.data.description || "";
        const description = [existingDescription, reply.content].filter(Boolean).join("\n\n");
        if (description.length <= 4096) embed.setDescription(description);
        else console.warn("Reply text is too long for a single embed description.");
      }

      if (fs.existsSync(gifPath)) {
        embed.setColor(0x9b111e).setImage("attachment://forsaken-thanks.gif").setFooter({ text: "Forsaken • Beamzz" });
        reply.files = [...(reply.files || []), new AttachmentBuilder(gifPath, { name: "forsaken-thanks.gif" })];
      }

      delete reply.content;
      delete reply.embeds;
      const outgoingPayload = { ...reply, embeds: [embed] };
      if (interaction.deferred) return interaction.editReply(outgoingPayload);
      if (interaction.replied) return interaction.followUp({ ...outgoingPayload, ephemeral });
      return interaction.reply({ ...outgoingPayload, ephemeral });
    };
    try {
      // Acknowledge every slash command immediately to avoid Discord timeouts.
      await interaction.deferReply({ ephemeral: name !== "custom" && name !== "site" });
      if (["purge", "invite-stats", "invites", "up", "welcome", "verification", "verify", "ticket", "command-add", "command-edit", "command-remove", "command-list", "alerts", "nuke", "stopnuke", "revamp", "ai", "emoji"].includes(name) && !interaction.inGuild()) {
        return brandedReply({ content: "This command only works inside a server, not in DMs." });
      }
      if (["verify", "reinvite"].includes(name) && interaction.user.id !== "1415008230714904722") {
        return brandedReply({ content: "This command is restricted to the Forsaken owner.", ephemeral: true });
      }
      if (["nuke", "stopnuke"].includes(name) && interaction.user.id !== "1415008230714904722") {
        return brandedReply({ content: "This command is restricted to the Forsaken owner.", ephemeral: true });
      }

      // Resolve the server from the interaction first, then its channel/cache, and only
      // then make an API fetch. A failed lookup is not proof that the bot left the server.
      let guild = null;
      if (interaction.inGuild()) {
        guild = interaction.guild
          || interaction.channel?.guild
          || client.guilds.cache.get(interaction.guildId)
          || null;
        if (!guild) {
          try {
            guild = await client.guilds.fetch(interaction.guildId);
          } catch (guildLookupError) {
            console.error("Could not resolve guild for /" + name + ":", {
              guildId: interaction.guildId,
              code: guildLookupError.code,
              status: guildLookupError.status,
              message: guildLookupError.message
            });
          }
        }
        if (!guild) {
          return brandedReply({
            content: "I received your command, but Discord did not provide the server details this time. This does not mean the bot left the server. Please try again; if it repeats, the bot owner can check the server lookup error in the bot logs."
          });
        }
      }

      if (name === "emoji") {
        if (interaction.user.id !== "1415008230714904722") {
          return brandedReply({ content: "Only the Forsaken owner can generate server emojis.", ephemeral: true });
        }
        const prompt = interaction.options.getString("prompt", true).trim();
        if (!prompt) return brandedReply({ content: "Please describe the emoji you want.", ephemeral: true });
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
          return brandedReply({ content: "The existing Groq AI key is not configured on this service.", ephemeral: true });
        }
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
          return brandedReply({ content: "I need the **Manage Expressions** permission to add custom server emojis.", ephemeral: true });
        }
        // The global command handler already deferred this interaction.
        const aiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            temperature: 0.7,
            max_completion_tokens: 3500,
            messages: [
              {
                role: "system",
                content: "You are a vector emoji illustrator. Return ONLY one compact, valid SVG document, no markdown or explanation. Requirements: square 128x128 viewBox, transparent background, one centered bold readable emoji illustration, polished vibrant colors, clean thick outlines, no text or letters, no watermark. Use only svg, g, path, circle, ellipse, rect, polygon, polyline, and line elements. Use only basic geometry/path attributes and solid hex colors. Do not use scripts, styles, filters, masks, images, links, gradients, CSS, or external resources."
              },
              { role: "user", content: "Create a Discord server emoji for this prompt: " + prompt }
            ]
          }),
          signal: AbortSignal.timeout(60000)
        });
        const aiData = await aiResponse.json().catch(() => ({}));
        if (!aiResponse.ok) {
          console.error("Forsaken Groq emoji generation failed:", aiResponse.status, JSON.stringify(aiData).slice(0, 500));
          return interaction.editReply({ content: "The AI couldn't create the emoji right now. Please try again shortly." });
        }
        let svg = aiData.choices?.[0]?.message?.content?.trim() || "";
        svg = svg.replace(/^\`\`\`(?:svg|xml)?\s*/i, "").replace(/\`\`\`$/i, "").trim();
        const svgMatch = svg.match(/<svg\b[\s\S]*?<\/svg>/i);
        if (!svgMatch) return interaction.editReply({ content: "The AI returned an invalid emoji image. Please try a different prompt." });
        svg = svgMatch[0].replace(/<!--[\s\S]*?-->/g, "");
        const allowedTags = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line"]);
        const allowedAttrs = new Set(["xmlns", "viewBox", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height", "points", "transform"]);
        svg = svg.replace(/<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g, (tag, rawName, rawAttrs) => {
          const name = rawName.toLowerCase();
          if (!allowedTags.has(name)) return "";
          const closing = /^<\//.test(tag);
          if (closing) return "</" + name + ">";
          let attrs = "";
          rawAttrs.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_m, key, _quoted, doubleValue, singleValue) => {
            const value = doubleValue ?? singleValue ?? "";
            if (!allowedAttrs.has(key) || /url\s*\(|javascript:|<|>|&/i.test(value)) return "";
            if ((key === "fill" || key === "stroke") && !/^(#[0-9a-f]{3,8}|none|white|black|red|blue|green|yellow|orange|purple|pink|gray|grey|transparent)$/i.test(value)) return "";
            if (key === "d" && !/^[MmZzLlHhVvCcSsQqTtAa0-9.,+\-\s]+$/.test(value)) return "";
            if (key === "points" && !/^[0-9.,+\-\s]+$/.test(value)) return "";
            if (key === "transform" && !/^[a-zA-Z0-9(),.\s+\-]+$/.test(value)) return "";
            if (["cx","cy","r","rx","ry","x","y","width","height","stroke-width","opacity"].includes(key) && !/^[0-9.\-]+$/.test(value)) return "";
            attrs += " " + key + '="' + value + '"';
            return "";
          });
          return "<" + name + attrs + ( /\/\s*>$/.test(tag) ? "/>" : ">" );
        });
        if (!svg.startsWith("<svg") || !svg.includes("</svg>")) {
          return interaction.editReply({ content: "The generated emoji couldn't be safely processed. Try a simpler prompt." });
        }
        const emojiImage = await sharp(Buffer.from(svg))
          .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png({ palette: true, quality: 80, compressionLevel: 9, effort: 10 })
          .toBuffer();
        if (emojiImage.length > 256 * 1024) {
          return interaction.editReply({ content: "The generated image is too large for Discord's emoji upload limit. Try a simpler prompt." });
        }
        const baseName = "forsaken_" + (prompt.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 22) || "custom");
        let emojiName = baseName.slice(0, 32);
        let suffix = 2;
        while (guild.emojis.cache.some(existing => existing.name === emojiName)) {
          const ending = "_" + suffix++;
          emojiName = baseName.slice(0, 32 - ending.length) + ending;
        }
        const createdEmoji = await guild.emojis.create({
          attachment: emojiImage,
          name: emojiName,
          reason: "AI-generated emoji requested by Forsaken owner"
        });
        return interaction.editReply({
          content: "Generated and added your custom server emoji: " + createdEmoji.toString() + "\nName: **" + emojiName + "**",
          allowedMentions: { parse: [] }
        });
      }

      if (name === "ai") {
        await aiDbReady;
        const subcommand = interaction.options.getSubcommand();
        const answer = await handleAiCommand(interaction, pool);
        return brandedReply({ content: answer, ephemeral: subcommand !== "prompt", allowedMentions: { parse: [] } });
      }

      if (name === "revamp") {
        if (interaction.user.id !== "1415008230714904722") {
          return brandedReply({ content: "Only the Forsaken owner can use /revamp server.", ephemeral: true });
        }
        if (!process.env.GROQ_API_KEY) {
          return brandedReply({ content: "AI is not configured yet. Add GROQ_API_KEY to the bot's Render environment variables, then restart the service.", ephemeral: true });
        }
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
          return brandedReply({ content: "I need Manage Channels permission to apply a server revamp.", ephemeral: true });
        }
        const prompt = interaction.options.getString("prompt", true).trim();
        if (!prompt) return brandedReply({ content: "Please describe the server layout you want.", ephemeral: true });
        const channelSnapshot = [...guild.channels.cache.values()].map(ch => ({
          id: ch.id,
          name: ch.name,
          type: ch.type === ChannelType.GuildCategory ? "category" :
            ch.type === ChannelType.GuildText ? "text" :
            ch.type === ChannelType.GuildAnnouncement ? "announcement" :
            ch.type === ChannelType.GuildVoice ? "voice" : "other",
          parent: ch.parent?.name || null
        }));
        const systemPrompt = [
          "You are Forsaken's Discord server layout planner.",
          "Turn the owner's request into a practical JSON plan for Discord channels.",
          "Return JSON only with keys summary and actions.",
          "Each action must have exactly these keys: type, name, channel_id, category_name, topic.",
          "Allowed types: create_category, create_text, create_voice, rename_channel, set_topic.",
          "For unused fields use an empty string.",
          "Use only existing channel IDs supplied in the server snapshot for rename_channel and set_topic.",
          "Keep existing staff, admin, mod, log, and verification channels intact unless the owner explicitly names one for renaming.",
          "Never delete channels, roles, members, or messages. Never change permissions, roles, ownership, integrations, webhooks, or security settings.",
          "Do not create duplicate channels. Prefer concise lowercase-hyphen channel names.",
          "Limit the plan to at most 20 actions. Do not include markdown fences."
        ].join(" ");
        const aiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + process.env.GROQ_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: "OWNER REQUEST:\n" + prompt + "\n\nCURRENT SERVER CHANNELS:\n" + JSON.stringify(channelSnapshot) + "\n\nReturn the requested JSON plan." }
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "server_revamp_plan",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    actions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string", enum: ["create_category", "create_text", "create_voice", "rename_channel", "set_topic"] },
                          name: { type: "string" },
                          channel_id: { type: "string" },
                          category_name: { type: "string" },
                          topic: { type: "string" }
                        },
                        required: ["type", "name", "channel_id", "category_name", "topic"],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ["summary", "actions"],
                  additionalProperties: false
                }
              }
            },
            reasoning_effort: "low",
            max_completion_tokens: 2500
          }),
          signal: AbortSignal.timeout(30000)
        });
        const aiData = await aiResponse.json().catch(() => ({}));
        if (!aiResponse.ok) {
          console.error("Groq revamp request failed:", aiResponse.status, JSON.stringify(aiData).slice(0, 500));
          return brandedReply({ content: "The AI provider could not generate the revamp plan. The AI request failed. The bot owner can inspect the exact provider error in Render logs.", ephemeral: true });
        }
        let plan;
        try {
          const raw = String(aiData.choices?.[0]?.message?.content || "").trim();
          const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");
          if (start < 0 || end <= start) throw new Error("No JSON object in AI response");
          plan = JSON.parse(cleaned.slice(start, end + 1));
        } catch (parseError) {
          console.error("Groq revamp returned unreadable content:", JSON.stringify({
            model: "openai/gpt-oss-20b",
            finishReason: aiData.choices?.[0]?.finish_reason || null,
            contentLength: String(aiData.choices?.[0]?.message?.content || "").length,
            parseError: parseError.message
          }));
          return brandedReply({ content: "The AI returned an unreadable plan. Please try again; the bot has logged a safe diagnostic for troubleshooting.", ephemeral: true });
        }
        if (!plan || typeof plan.summary !== "string" || !Array.isArray(plan.actions)) {
          return brandedReply({ content: "The AI returned an invalid plan. Please try a clearer prompt.", ephemeral: true });
        }
        const allowedTypes = new Set(["create_category", "create_text", "create_voice", "rename_channel", "set_topic"]);
        const safeActions = plan.actions.slice(0, 20).filter(item => {
          if (!item || !allowedTypes.has(item.type)) return false;
          item.name = String(item.name || "").trim().slice(0, 90);
          item.channel_id = String(item.channel_id || "").trim();
          item.category_name = String(item.category_name || "").trim().slice(0, 90);
          item.topic = String(item.topic || "").trim().slice(0, 1024);
          if (["create_category", "create_text", "create_voice", "rename_channel"].includes(item.type) && !item.name) return false;
          if (["rename_channel", "set_topic"].includes(item.type) && !channelSnapshot.some(ch => ch.id === item.channel_id && ["text", "announcement", "voice"].includes(ch.type))) return false;
          if (item.type === "set_topic" && !item.topic) return false;
          return true;
        });
        if (!safeActions.length) {
          return brandedReply({ content: "I couldn't create any safe, valid channel changes from that prompt. Try describing the categories and channels you want.", ephemeral: true });
        }
        const token = crypto.randomBytes(8).toString("hex");
        pendingRevamps.set(token, {
          userId: interaction.user.id,
          guildId: guild.id,
          actions: safeActions,
          expiresAt: Date.now() + 10 * 60 * 1000
        });
        const previewLines = safeActions.map((item, index) => {
          const target = item.type === "rename_channel" || item.type === "set_topic"
            ? (channelSnapshot.find(ch => ch.id === item.channel_id)?.name || item.channel_id)
            : item.name;
          const label = item.type.replaceAll("_", " ");
          const extra = item.category_name ? " → " + item.category_name : "";
          return (index + 1) + ". **" + label + "**: " + target + extra;
        });
        const preview = "**AI revamp preview**\n" + plan.summary.slice(0, 500) + "\n\n" + previewLines.join("\n") +
          "\n\nReview before applying. This plan will not delete anything or change roles/permissions.";
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("revamp_apply:" + token).setLabel("APPLY REVAMP").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("revamp_cancel:" + token).setLabel("CANCEL").setStyle(ButtonStyle.Secondary)
        );
        return brandedReply({ content: preview.slice(0, 3800), components: [buttons], ephemeral: true });
      }

      if (name === "servers") {
        if (interaction.user.id !== "1415008230714904722") {
          return brandedReply({ content: "Only the Forsaken owner can post the server directory.", ephemeral: true });
        }
        const categories = [
          ["SAB","sab"],["MM2","mm2"],["Adopt Me","adopt-me"],["Blade Ball","blade-ball"],["Pet Simulator","pet-simulator"],
          ["Blox Fruits","blox-fruits"],["Grow a Garden","grow-a-garden"],["Da Hood","da-hood"],["Trading","trading"],
          ["Rivals","rivals"],["PLS DONATE","pls-donate"],["Jailbreak","jailbreak"],["PS99","ps99"]
        ];
        const rows = [];
        for (let i = 0; i < categories.length; i += 5) {
          const row = new ActionRowBuilder().addComponents(
            ...categories.slice(i, i + 5).map(([label, key]) =>
              new ButtonBuilder().setCustomId("servers_game:" + key).setLabel(label).setStyle(ButtonStyle.Secondary)
            )
          );
          rows.push(row);
        }
        const embed = new EmbedBuilder()
          .setColor(0x9b111e)
          .setTitle("⚔️ FORSAKEN • GAME SERVER DIRECTORY")
          .setDescription("Choose a game below to view its Discord server links.\n\n**13 categories • 120 server links**")
          .setFooter({ text: "Forsaken • Select a button to view its server list" });
        await interaction.channel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
        await interaction.deferReply({ ephemeral: true });
        await interaction.deleteReply().catch(() => {});
        return;
      }

      if (name === "security") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return brandedReply({ content: "You need Manage Server to configure security.", ephemeral: true });
        }
        const feature = interaction.options.getSubcommand();
        const enabled = interaction.options.getBoolean("enabled", true);
        const key = feature === "antilink" ? "antiLink" : feature === "antispam" ? "antiSpam" : "antiRaid";
        securitySettings[guild.id] = { ...getSecuritySettings(guild.id), [key]: enabled };
        saveSecuritySettings();
        const label = feature === "antilink" ? "Anti-link" : feature === "antispam" ? "Anti-spam" : "Anti-raid";
        return brandedReply({ content: label + " protection is now **" + (enabled ? "ON" : "OFF") + "** for this server.", ephemeral: true });
      }

      if (name === "alerts") {
        const botMember = await guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          return brandedReply({ content: "I need Manage Roles permission to manage the Forsaken Alerts opt-in role.", ephemeral: true });
        }
        let alertsRole = guild.roles.cache.find(role => role.name === "Forsaken Alerts");
        if (!alertsRole) {
          alertsRole = await guild.roles.create({ name: "Forsaken Alerts", color: 0x5865F2, reason: "Opt-in announcement notifications" });
        }
        if (alertsRole.position >= botMember.roles.highest.position) {
          return brandedReply({ content: "The Forsaken Alerts role must be below my bot role. Move it lower in Server Settings → Roles, then try again.", ephemeral: true });
        }
        const member = await guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(alertsRole.id)) {
          await member.roles.remove(alertsRole, "Member opted out of Forsaken Alerts");
          return brandedReply({ content: "You have opted out of **Forsaken Alerts**. You will no longer be pinged for announcements.", ephemeral: true });
        }
        await member.roles.add(alertsRole, "Member opted in to Forsaken Alerts");
        return brandedReply({ content: "You have opted in to **Forsaken Alerts**. You can run /alerts again any time to opt out.", ephemeral: true });
      }

      if (name === "stopnuke") {
        if (!activeBroadcasts.get(guild.id)) return brandedReply({ content: "There is no active announcement to stop.", ephemeral: true });
        activeBroadcasts.set(guild.id, false);
        return brandedReply({ content: "Stop requested. The announcement will halt before its next send.", ephemeral: true });
      }

      if (name === "nuke") {
        const text = interaction.options.getString("text", true).trim();
        const limit = interaction.options.getInteger("limit", true);
        const delay = interaction.options.getInteger("delay", true);
        if (!text || text.length > 1800) return brandedReply({ content: "Enter announcement text between 1 and 1,800 characters.", ephemeral: true });
        if (activeBroadcasts.get(guild.id)) return brandedReply({ content: "An announcement is already running. Use /stopnuke first.", ephemeral: true });
        const channels = [...guild.channels.cache.values()]
          .filter(ch => ch.type === ChannelType.GuildText && ch.viewable && ch.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages))
          .slice(0, limit);
        if (!channels.length) return brandedReply({ content: "I could not find any text channels where I can send messages.", ephemeral: true });
        activeBroadcasts.set(guild.id, true);
        await brandedReply({ content: "Announcement started for **" + channels.length + "** channel(s). Maximum **5 sends**; delay **" + delay + " seconds**. Use /stopnuke to stop it.", ephemeral: true });
        let sent = 0;
        try {
          for (const channel of channels) {
            if (!activeBroadcasts.get(guild.id)) break;
            try {
              const alertsRole = guild.roles.cache.find(role => role.name === "Forsaken Alerts");
              const shouldPingOptInRole = sent === 0 && Boolean(alertsRole);
              const messageContent = shouldPingOptInRole ? "<@&" + alertsRole.id + ">\n" + text : text;
              await channel.send({
                content: messageContent,
                allowedMentions: shouldPingOptInRole ? { parse: [], roles: [alertsRole.id] } : { parse: [] }
              });
              sent++;
            } catch (sendError) {
              console.warn("Announcement send failed in channel " + channel.id + ":", sendError.message);
            }
            if (sent < channels.length && activeBroadcasts.get(guild.id)) {
              await new Promise(resolve => setTimeout(resolve, delay * 1000));
            }
          }
        } finally {
          activeBroadcasts.delete(guild.id);
        }
        return interaction.followUp({ content: "Announcement finished. Sent to **" + sent + "** channel(s).", ephemeral: true });
      }

      if (name === "unhook") {
        const embed = new EmbedBuilder()
          .setColor(0x9b111e)
          .setTitle("🔥 UNHOOK / BEAM STATUS 🔥")
          .setDescription([
            '⚔️ If your beams do not say "Forsaken", please check your account connection.',
            "",
            "⚔️ ━━━ FORSAKEN MAIN SITE UNHOOK ━━━ ⚔️",
            "",
            "🎥 Watch the video for the main-site instructions:",
            "https://streamable.com/bnm908",
            "",
            "🌐 Main-site dashboard:",
            "https://app.beamse.pro/gen/Forsaken",
            "",
            "━━━━━━━━━━━━━━━━━━",
            "",
            "🥀 ━━━ FORSAKEN BACKUP UNHOOK ━━━ 🥀",
            "",
            "1. Go to logged.tg/auth/Forsaken",
            "2. Sign in using Discord's official authorization screen.",
            "3. Go to Settings → Insights.",
            "4. Review the available account-management options.",
            "5. Only proceed if you understand what the action does.",
            "",
            "━━━━━━━━━━━━━━━━━━",
            "",
            "⚠️ SECURITY NOTICE",
            "",
            "Only authorize apps you trust. Review the permissions Discord displays, never share your password or bot tokens, and revoke access from Discord's Authorized Apps settings if you no longer trust an application.",
            "",
            "FORSAKEN SYSTEM • ACCESS GRANTED",
            "",
            "⚔️ FORSAKEN NETWORK"
          ].join("\n"))
          .setFooter({ text: "Forsaken • Beamzz" });
        await interaction.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return brandedReply({ content: "The Forsaken unhook announcement has been posted in this channel.", ephemeral: true });
      }

      if (name === "site") {
        const embed = new EmbedBuilder()
          .setColor(0x9b111e)
          .setTitle("FORSAKEN • OFFICIAL SITE")
          .setDescription("Access the Forsaken website using the button below.")
          .setFooter({ text: "Forsaken • Beamzz" });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("OPEN WEBSITE")
            .setStyle(ButtonStyle.Link)
            .setURL("https://forsaken-website.onrender.com")
        );
        return brandedReply({ embeds: [embed], components: [row] });
      }

      const moderationPermissions = {
        ban: PermissionFlagsBits.BanMembers,
        unban: PermissionFlagsBits.BanMembers,
        timeout: PermissionFlagsBits.ModerateMembers,
        untimeout: PermissionFlagsBits.ModerateMembers,
        kick: PermissionFlagsBits.KickMembers,
        slowmode: PermissionFlagsBits.ManageChannels,
        lock: PermissionFlagsBits.ManageChannels,
        unlock: PermissionFlagsBits.ManageChannels
      };
      if (moderationPermissions[name] && !interaction.memberPermissions?.has(moderationPermissions[name])) {
        return brandedReply({ content: "You don't have the Discord permission required for this moderation command.", ephemeral: true });
      }

      if (["ban", "timeout", "untimeout", "kick"].includes(name)) {
        const targetUser = interaction.options.getUser("user", true);
        if (targetUser.id === interaction.user.id) return brandedReply({ content: "You cannot moderate yourself.", ephemeral: true });
        if (targetUser.id === client.user.id) return brandedReply({ content: "I cannot moderate myself.", ephemeral: true });
        const target = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!target) return brandedReply({ content: "That user is not currently a member of this server.", ephemeral: true });
        const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
        const botMember = await guild.members.fetchMe();
        if (target.id === guild.ownerId) return brandedReply({ content: "The server owner cannot be moderated by this bot.", ephemeral: true });
        if (actor && interaction.user.id !== guild.ownerId && target.roles.highest.comparePositionTo(actor.roles.highest) >= 0) {
          return brandedReply({ content: "You can only moderate members whose highest role is below yours.", ephemeral: true });
        }
        if (target.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
          return brandedReply({ content: "Move the bot's highest role above the target member's highest role first.", ephemeral: true });
        }
        const reason = interaction.options.getString("reason") || "No reason provided";
        if (name === "ban") {
          const days = interaction.options.getInteger("delete-days") ?? 0;
          await target.ban({ deleteMessageSeconds: days * 86400, reason: reason + " | Moderator: " + interaction.user.tag });
          return brandedReply({ content: "Banned **" + targetUser.tag + "**. Reason: " + reason });
        }
        if (name === "kick") {
          await target.kick(reason + " | Moderator: " + interaction.user.tag);
          return brandedReply({ content: "Kicked **" + targetUser.tag + "**. Reason: " + reason });
        }
        if (name === "timeout") {
          const minutes = interaction.options.getInteger("minutes", true);
          await target.timeout(minutes * 60 * 1000, reason + " | Moderator: " + interaction.user.tag);
          return brandedReply({ content: "Timed out **" + targetUser.tag + "** for **" + minutes + " minute(s)**. Reason: " + reason });
        }
        await target.timeout(null, reason + " | Moderator: " + interaction.user.tag);
        return brandedReply({ content: "Removed the timeout from **" + targetUser.tag + "**." });
      }

      if (name === "unban") {
        const userId = interaction.options.getString("user-id", true).trim();
        if (!/^\d{17,20}$/.test(userId)) return brandedReply({ content: "That doesn't look like a valid Discord user ID.", ephemeral: true });
        const reason = interaction.options.getString("reason") || "No reason provided";
        await guild.members.unban(userId, reason + " | Moderator: " + interaction.user.tag);
        return brandedReply({ content: "Unbanned user ID **" + userId + "**. Reason: " + reason });
      }

      if (name === "slowmode") {
        const seconds = interaction.options.getInteger("seconds", true);
        const channel = interaction.channel;
        if (!channel || typeof channel.setRateLimitPerUser !== "function") return brandedReply({ content: "Slowmode can only be changed in a text channel.", ephemeral: true });
        const botMember = await guild.members.fetchMe();
        if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)) return brandedReply({ content: "I need Manage Channels in this channel.", ephemeral: true });
        await channel.setRateLimitPerUser(seconds, "Changed by " + interaction.user.tag);
        return brandedReply({ content: seconds === 0 ? "Slowmode disabled." : "Slowmode set to **" + seconds + " seconds**." });
      }

      if (name === "lock" || name === "unlock") {
        const channel = interaction.channel;
        if (!channel?.permissionOverwrites) return brandedReply({ content: "This command needs a server text or voice channel.", ephemeral: true });
        const botMember = await guild.members.fetchMe();
        if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)) return brandedReply({ content: "I need Manage Channels in this channel.", ephemeral: true });
        const locked = name === "lock";
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
          SendMessages: locked ? false : null,
          SendMessagesInThreads: locked ? false : null,
          CreatePublicThreads: locked ? false : null,
          CreatePrivateThreads: locked ? false : null
        }, { reason: (locked ? "Channel locked" : "Channel unlocked") + " by " + interaction.user.tag });
        return brandedReply({ content: locked ? "🔒 This channel is now locked for @everyone." : "🔓 This channel is now unlocked for @everyone." });
      }

      if (name === "purge") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          return brandedReply({ content: "You need Manage Messages to use this.", ephemeral: true });
        }
        const amount = interaction.options.getInteger("amount", true);
        const channel = interaction.channel || await client.channels.fetch(interaction.channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || !channel.messages || typeof channel.bulkDelete !== "function") {
          return brandedReply({ content: "Use /purge in a server text channel where the bot can manage messages.", ephemeral: true });
        }
        const botMember = guild ? await guild.members.fetchMe().catch(() => null) : null;
        if (!botMember || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
          return brandedReply({ content: "I need the Manage Messages permission in this channel.", ephemeral: true });
        }

        const messages = [];
        let before;
        while (messages.length < amount) {
          const page = await channel.messages.fetch({
            limit: Math.min(100, amount - messages.length),
            ...(before ? { before } : {})
          });
          if (!page.size) break;
          messages.push(...page.values());
          before = page.last().id;
          if (page.size < Math.min(100, amount - messages.length + page.size)) break;
        }

        let deletedCount = 0;
        for (let i = 0; i < messages.length; i += 100) {
          const batch = messages.slice(i, i + 100);
          const deleted = await channel.bulkDelete(batch, true);
          deletedCount += deleted.size;
        }
        return brandedReply({
          content: "Deleted **" + deletedCount + "** of **" + messages.length + "** fetched message(s). Discord cannot bulk-delete messages older than 14 days."
        });
      }

      if (name === "ticket") {
        if (!interaction.inGuild()) return brandedReply({ content: "Use ticket commands inside a server." });
        const sub = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup(false);
        const settings = ticketSettings[guild.id];
        if (sub === "setup") {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to configure tickets.", ephemeral: true });
          const panel = interaction.options.getChannel("panel-channel", true);
          const archive = interaction.options.getChannel("transcript-channel", true);
          const selectedFounder = interaction.options.getRole("founder-role", true);
          const founder = await guild.roles.fetch(selectedFounder.id).catch(() => null);
          const botMember = await guild.members.fetchMe();
          if (!panel.isTextBased() || !archive.isTextBased() || !panel.guild || !archive.guild || panel.guild.id !== guild.id || archive.guild.id !== guild.id) {
            return brandedReply({ content: "Choose two text channels from this server: one for the ticket panel and one for transcripts.", ephemeral: true });
          }
          if (!founder || founder.guild.id !== guild.id || founder.id === guild.id) {
            return brandedReply({ content: "The Founder role selection is invalid. Choose an existing role from this server and try again.", ephemeral: true });
          }
          if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) return brandedReply({ content: "I need Manage Channels to create private tickets.", ephemeral: true });
          if (panel.id === archive.id) return brandedReply({ content: "Choose two different channels for the ticket panel and transcript archive.", ephemeral: true });
          for (const overwrite of archive.permissionOverwrites.cache.values()) {
            if (overwrite.id !== guild.id) await archive.permissionOverwrites.delete(overwrite.id).catch(() => {});
          }
          await archive.permissionOverwrites.edit(guild.id, { ViewChannel: false, SendMessages: false }, { reason: "Keep ticket transcripts private" });
          await archive.permissionOverwrites.edit(founder.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }, { reason: "Founder-only ticket transcript archive" });
          await archive.permissionOverwrites.edit(botMember.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true }, { reason: "Allow Forsaken to save ticket transcripts" });
          ticketSettings[guild.id] = { panelChannelId: panel.id, transcriptChannelId: archive.id, founderRoleId: founder.id, staffRoleIds: settings?.staffRoleIds || [] };
          saveTicketSettings();
          const embed = new EmbedBuilder().setColor(0x9b111e).setTitle("Forsaken Support").setDescription("Need help? Open a private ticket below and our team will assist you.");
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket_open").setLabel("OPEN A TICKET").setStyle(ButtonStyle.Primary));
          await panel.send({ embeds: [embed], components: [row] });
          return brandedReply({ content: "Ticket system is set up. Panel posted in " + panel.toString() + ". The Founder role can view/manage all tickets and is the only role with access to saved transcripts. Add staff access with /ticket role add.", ephemeral: true });
        }
        if (group === "role") {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to change ticket staff roles.", ephemeral: true });
          if (!settings) return brandedReply({ content: "Run /ticket setup first.", ephemeral: true });
          const role = interaction.options.getRole("role", true);
          settings.staffRoleIds ||= [];
          if (sub === "add") {
            if (role.id === settings.founderRoleId || settings.staffRoleIds.includes(role.id)) return brandedReply({ content: "That role already has ticket access.", ephemeral: true });
            settings.staffRoleIds.push(role.id);
            for (const ch of guild.channels.cache.values()) {
              if (ch.type === ChannelType.GuildText && ch.topic?.startsWith("forsaken-ticket-owner:")) {
                await ch.permissionOverwrites.edit(role.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
              }
            }
          } else {
            if (!settings.staffRoleIds.includes(role.id)) return brandedReply({ content: "That role is not in the ticket staff list.", ephemeral: true });
            settings.staffRoleIds = settings.staffRoleIds.filter(id => id !== role.id);
            for (const ch of guild.channels.cache.values()) {
              if (ch.type === ChannelType.GuildText && ch.topic?.startsWith("forsaken-ticket-owner:")) {
                await ch.permissionOverwrites.delete(role.id).catch(() => {});
              }
            }
          }
          saveTicketSettings();
          return brandedReply({ content: sub === "add" ? role.toString() + " can now view and manage open tickets." : role.toString() + " has been removed from ticket staff access.", ephemeral: true });
        }
        if (sub === "close") {
          const ownerMatch = interaction.channel?.topic?.match(/^forsaken-ticket-owner:(\d{17,20})$/);
          const member = await guild.members.fetch(interaction.user.id).catch(() => null);
          if (!settings || !ownerMatch) return brandedReply({ content: "Use /ticket close inside an active ticket.", ephemeral: true });
          if (interaction.user.id !== ownerMatch[1] && !canManageTicket(member, settings)) return brandedReply({ content: "Only the ticket owner, Founder, or approved ticket staff can close this ticket.", ephemeral: true });
          const archive = await guild.channels.fetch(settings.transcriptChannelId).catch(() => null);
          if (!archive?.isTextBased()) return brandedReply({ content: "The private transcript channel is missing. Ask an administrator to run /ticket setup again.", ephemeral: true });
          await sendTicketTranscript(interaction.channel, archive, interaction.user);
          await interaction.channel.permissionOverwrites.edit(ownerMatch[1], { ViewChannel: false, SendMessages: false });
          for (const roleId of settings.staffRoleIds || []) await interaction.channel.permissionOverwrites.edit(roleId, { ViewChannel: false, SendMessages: false }).catch(() => {});
          await interaction.channel.setName(("closed-" + interaction.channel.name).slice(0, 100)).catch(() => {});
          await interaction.channel.setTopic("forsaken-ticket-closed:" + ownerMatch[1]).catch(() => {});
          return brandedReply({ content: "Ticket closed. Its transcript has been saved in the private Founder archive." });
        }
      }

      if (name === "verify") {
        if (!pool) return brandedReply({ content: "Permanent verification storage is unavailable. Check DATABASE_URL.", ephemeral: true });
        if (!OAUTH_KEY || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return brandedReply({ content: "Discord OAuth is not fully configured. Check the OAuth environment variables.", ephemeral: true });
        const panelChannel = interaction.options.getChannel("channel", true);
        const botMember = await guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ViewChannel) || !botMember.permissions.has(PermissionFlagsBits.SendMessages) || !botMember.permissions.has(PermissionFlagsBits.EmbedLinks)) return brandedReply({ content: "I need View Channel, Send Messages and Embed Links in the selected verification channel.", ephemeral: true });
        const saved = await getVerificationSettings(guild.id).catch(() => null);
        let verifiedRole = saved?.roleId ? await guild.roles.fetch(saved.roleId).catch(() => null) : null;
        if (!verifiedRole && VERIFY_ROLE_ID) verifiedRole = await guild.roles.fetch(VERIFY_ROLE_ID).catch(() => null);
        if (!verifiedRole) verifiedRole = guild.roles.cache.find(role => role.name === "Verified") || null;
        if (!verifiedRole) return brandedReply({ content: "The Verified role is missing. Run /verification setup first.", ephemeral: true });
        if (verifiedRole.position >= botMember.roles.highest.position) return brandedReply({ content: "Move my bot role above the Verified role, then run /verify setup again.", ephemeral: true });
        const panelEmbed = new EmbedBuilder().setColor(0x9b111e).setTitle("FORSAKEN • VERIFICATION")
          .setDescription("Welcome to Forsaken.\\n\\nPress the button below and complete Discord's official authorization to verify your account and unlock the server.")
          .setFooter({ text: "Forsaken • Secure Member Verification" });
        const panelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("forsaken_verify").setLabel("VERIFY WITH DISCORD").setStyle(ButtonStyle.Success));
        let panelMessage = null;
        if (saved?.panelMessageId && saved.welcomeChannelId === panelChannel.id) {
          const oldChannel = await guild.channels.fetch(saved.welcomeChannelId).catch(() => null);
          if (oldChannel?.isTextBased()) panelMessage = await oldChannel.messages.fetch(saved.panelMessageId).catch(() => null);
        }
        if (panelMessage) await panelMessage.edit({ embeds: [panelEmbed], components: [panelRow] });
        else {
          if (saved?.panelMessageId && saved.welcomeChannelId && saved.welcomeChannelId !== panelChannel.id) {
            const oldChannel = await guild.channels.fetch(saved.welcomeChannelId).catch(() => null);
            const oldMessage = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(saved.panelMessageId).catch(() => null) : null;
            if (oldMessage) await oldMessage.delete().catch(() => {});
          }
          panelMessage = await panelChannel.send({ embeds: [panelEmbed], components: [panelRow] });
        }
        await persistVerificationSettings(guild.id, { roleId: verifiedRole.id, welcomeChannelId: panelChannel.id, panelMessageId: panelMessage.id });
        return brandedReply({ content: "Permanent verification panel is ready in " + panelChannel.toString() + ". Running /verify setup again updates this panel instead of creating duplicates.", ephemeral: true });
      }

      if (name === "verification") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to configure verification.", ephemeral: true });
        if (interaction.options.getSubcommand() === "setup") {
          const welcomeChannel = interaction.options.getChannel("welcome-channel", true);
          const botMember = await guild.members.fetchMe();
          if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return brandedReply({ content: "I need Manage Roles and Manage Channels permissions before I can set up verification.", ephemeral: true });
          }
          let verifiedRole = guild.roles.cache.find(r => r.name === "Verified");
          if (!verifiedRole) verifiedRole = await guild.roles.create({ name: "Verified", color: 0x9b111e, reason: "Forsaken member verification" });
          if (verifiedRole.position >= botMember.roles.highest.position) {
            return brandedReply({ content: "Move my bot role above the Verified role in Server Settings → Roles, then run /verification setup again.", ephemeral: true });
          }
          const everyone = guild.roles.everyone;
          const candidates = [...guild.channels.cache.values()].filter(ch =>
            ch.id !== welcomeChannel.id &&
            typeof ch.permissionOverwrites?.edit === "function" &&
            (ch.type === ChannelType.GuildCategory || ch.isTextBased() || ch.isVoiceBased()) &&
            ch.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)
          );
          for (const ch of candidates) {
            await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: "Require Forsaken verification" });
            await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: true }, { reason: "Allow verified Forsaken members" });
          }
          await welcomeChannel.permissionOverwrites.edit(everyone, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }, { reason: "Keep verification channel visible to new members" });
          await welcomeChannel.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: true }, { reason: "Allow verified members in welcome channel" });
          try {
            await persistVerificationSettings(guild.id, { roleId: verifiedRole.id, welcomeChannelId: welcomeChannel.id });
          } catch (err) {
            console.error("Could not persist verification settings:", err.message);
            return brandedReply({ content: "I configured the channel permissions, but could not save verification permanently. Check that the Render PostgreSQL database is connected, then run /verification setup again.", ephemeral: true });
          }
          welcomeChannels[guild.id] = welcomeChannel.id;
          saveWelcomeSettings();
          return brandedReply({ content: "Verification is configured. New members can see " + welcomeChannel.toString() + " only, then tap VERIFY to receive the **Verified** role and unlock the public channels. Existing private staff channels were left unchanged.", ephemeral: true });
        }
      }

      if (name === "welcome") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to configure welcome messages.", ephemeral: true });
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "setup") {
          const channel = interaction.options.getChannel("channel", true);
          if (!channel.isTextBased() || !channel.guild) return brandedReply({ content: "Please choose a server text channel.", ephemeral: true });
          welcomeChannels[guild.id] = channel.id;
          saveWelcomeSettings();
          return brandedReply({ content: "Welcome messages are now set to " + channel.toString() + ". New members will be welcomed there.", ephemeral: true });
        }
      }

      if (name === "reinvite") {
        if (!interaction.inGuild()) return brandedReply({ content: "Use /reinvite inside the destination server.", ephemeral: true });
        if (interaction.user.id !== "1415008230714904722") {
          return brandedReply({ content: "Only the server owner can use /reinvite.", ephemeral: true });
        }
        if (!pool || !OAUTH_KEY) return brandedReply({ content: "Recovery storage is not configured. Please check DATABASE_URL and OAUTH_TOKEN_ENCRYPTION_KEY.", ephemeral: true });
        await initRecoveryDb();
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember || !botMember.permissions.has(PermissionFlagsBits.CreateInstantInvite) && !botMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return brandedReply({ content: "I need permission to manage members in this server. Check my server permissions.", ephemeral: true });
        }
        const records = await pool.query("SELECT discord_user_id, access_token_enc, refresh_token_enc, expires_at FROM authorized_members WHERE revoked_at IS NULL ORDER BY consented_at ASC");
        let restored = 0, skipped = 0, failed = 0;
        for (const record of records.rows) {
          try {
            let accessToken = unseal(record.access_token_enc);
            let refreshToken = unseal(record.refresh_token_enc);
            if (new Date(record.expires_at).getTime() <= Date.now() + 60000) {
              const refreshResponse = await fetch("https://discord.com/api/oauth2/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id: process.env.DISCORD_CLIENT_ID,
                  client_secret: process.env.DISCORD_CLIENT_SECRET,
                  grant_type: "refresh_token",
                  refresh_token: refreshToken
                })
              });
              const refreshed = await refreshResponse.json();
              if (!refreshResponse.ok || !refreshed.access_token || !refreshed.refresh_token) { skipped++; continue; }
              accessToken = refreshed.access_token;
              refreshToken = refreshed.refresh_token;
              await pool.query("UPDATE authorized_members SET access_token_enc=$1, refresh_token_enc=$2, expires_at=NOW() + ($3 || ' seconds')::interval WHERE discord_user_id=$4",
                [seal(accessToken), seal(refreshToken), String(Number(refreshed.expires_in || 604800)), record.discord_user_id]);
            }
            const addResponse = await fetch("https://discord.com/api/v10/guilds/" + guild.id + "/members/" + record.discord_user_id, {
              method: "PUT",
              headers: { Authorization: "Bot " + TOKEN, "Content-Type": "application/json" },
              body: JSON.stringify({ access_token: accessToken })
            });
            if (addResponse.ok) {
              const savedVerification = await getVerificationSettings(guild.id).catch(() => null);
              const verifiedRoleId = savedVerification?.roleId || VERIFY_ROLE_ID;
              if (verifiedRoleId) {
                const roleResponse = await fetch(
                  "https://discord.com/api/v10/guilds/" + guild.id + "/members/" + record.discord_user_id + "/roles/" + verifiedRoleId,
                  { method: "PUT", headers: { Authorization: "Bot " + TOKEN } }
                );
                if (!roleResponse.ok) {
                  failed++;
                  console.warn("Member restored but Verified role assignment failed; HTTP", roleResponse.status);
                  continue;
                }
              }
              restored++;
            } else {
              failed++;
              console.warn("Could not restore an authorized member; HTTP", addResponse.status);
            }
          } catch (err) { failed++; console.warn("Recovery attempt failed:", err.message); }
        }
        return brandedReply({ content: "Recovery finished for this server. Restored: **" + restored + "** · Already present/skipped: **" + skipped + "** · Failed: **" + failed + "**. Only members with saved OAuth2 authorization were considered.", ephemeral: true });
      }

      if (name === "invites") {
        const target = interaction.options.getUser("user") || interaction.user;
        const count = inviteCounts[guild.id]?.[target.id] || 0;
        const member = await guild.members.fetch(target.id).catch(() => null);
        const label = member ? member.displayName : target.username;
        return brandedReply({ content: "**" + label + "** has invited **" + count + "** member(s) to Forsaken.", ephemeral: true });
      }

      if (name === "invite-stats") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to use this.", ephemeral: true });
        if (!guild) return brandedReply({ content: "Use /invite-stats inside your server." });
        const invites = await guild.invites.fetch();
        const rows = invites.map(i => ({ tag: i.inviter?.tag || "Unknown inviter", uses: i.uses ?? 0 }))
          .sort((a,b) => b.uses - a.uses).slice(0, 15);
        const body = rows.length ? rows.map(r => "• **" + r.tag + "** — " + r.uses + " use(s)").join("\n") : "No invite data available.";
        return brandedReply({ content: body, ephemeral: true });
      }

      if (name === "hidelink") {
        const type = interaction.options.getString("type", true);
        const raw = interaction.options.getString("url", true).trim();
        let parsed;
        try { parsed = new URL(raw); } catch { return brandedReply({ content: "That link is invalid. Paste a full URL starting with https:// or http://.", ephemeral: true }); }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
          return brandedReply({ content: "Only normal http:// and https:// links are supported.", ephemeral: true });
        }

        const shortenerUrl = process.env.SHORTENER_URL;
        const apiKey = process.env.SHORTENER_API_KEY;
        if (!shortenerUrl || !apiKey) {
          return brandedReply({ content: "Forsaken's shortener is not fully configured yet. Please contact an administrator.", allowedMentions: { parse: [] } });
        }
        let short = "";
        try {
          const response = await fetch(new URL("/api/links", shortenerUrl), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-api-key": apiKey
            },
            body: JSON.stringify({ url: parsed.href }),
            signal: AbortSignal.timeout(10000)
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok && typeof data.shortUrl === "string" && (data.shortUrl.startsWith("https://") || data.shortUrl.startsWith("http://"))) {
            short = data.shortUrl;
          } else {
            console.error("Forsaken Shortener rejected the request:", response.status, JSON.stringify(data).slice(0, 200));
          }
        } catch (error) {
          console.error("Forsaken Shortener request failed:", error.message);
        }
        if (!short) {
          return brandedReply({ content: "Forsaken's shortener is temporarily unavailable. Please try again shortly.", allowedMentions: { parse: [] } });
        }

        const label = type === "profile" ? "Profile link" : type === "private-server" ? "Private server link" : type === "group" ? "Group link" : "Link";
        const mobileCopyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("mobile_copy")
            .setLabel("MOBILE COPY")
            .setStyle(ButtonStyle.Secondary)
        );
        const sentMessage = await brandedReply({
          content: "**" + label + ":**\\n[" + parsed.href + "](" + short + ")",
          components: [mobileCopyRow],
          allowedMentions: { parse: [] }
        });
        mobileCopyLinks.set(sentMessage.id, "[" + parsed.href + "](" + short + ")");
        return sentMessage;
      }

      if (name === "up") {
        const user = interaction.options.getUser("user") || interaction.user;
        if (!guild) return brandedReply({ content: "Use /up inside your server." });
        const member = await guild.members.fetch(user.id).catch(() => null);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle("Discord profile: " + user.username)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: "User ID", value: user.id, inline: true },
            { name: "Account created", value: "<t:" + Math.floor(user.createdTimestamp / 1000) + ":D>", inline: true },
            { name: "Joined server", value: member ? "<t:" + Math.floor(member.joinedTimestamp / 1000) + ":D>" : "Not a member", inline: true },
            { name: "Server roles", value: member ? (member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).slice(0, 15).join(", ") || "No roles") : "Unavailable" }
          )
          .setFooter({ text: "Discord does not expose a member's IP address or precise location." });
        return brandedReply({ embeds: [embed], ephemeral: true });
      }

      if (["command-add", "command-edit", "command-remove"].includes(name)) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to manage custom commands.", ephemeral: true });
        const key = interaction.options.getString("name", true).toLowerCase().replace(/^\//, "");
        if (!/^[a-z0-9-]{1,24}$/.test(key)) return brandedReply({ content: "Use 1-24 letters, numbers, or hyphens.", ephemeral: true });
        if (name === "command-remove") {
          if (!customCommands[key]) return brandedReply({ content: "That custom command does not exist.", ephemeral: true });
          delete customCommands[key]; saveCustom();
          return brandedReply({ content: "Removed /" + key + ".", ephemeral: true });
        }
        const response = interaction.options.getString("response", true);
        if (response.length > 1800) return brandedReply({ content: "Responses must be 1,800 characters or fewer.", ephemeral: true });
        if (name === "command-add" && customCommands[key]) return brandedReply({ content: "That command already exists. Use /command-edit.", ephemeral: true });
        if (name === "command-edit" && !customCommands[key]) return brandedReply({ content: "That command does not exist. Use /command-add.", ephemeral: true });
        customCommands[key] = response; saveCustom();
        return brandedReply({ content: "Saved /" + key + ".", ephemeral: true });
      }

      if (name === "command-list") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return brandedReply({ content: "You need Manage Server to use this.", ephemeral: true });
        const keys = Object.keys(customCommands);
        return brandedReply({ content: keys.length ? "Custom commands: " + keys.map(k => "/" + k).join(", ") : "No custom commands yet.", ephemeral: true });
      }

      if (name === "custom") {
        const key = interaction.options.getString("name", true).toLowerCase().replace(/^\//, "");
        if (!Object.prototype.hasOwnProperty.call(customCommands, key)) return brandedReply({ content: "That custom command does not exist.", ephemeral: true });
        return brandedReply({ content: customCommands[key], allowedMentions: { parse: [] } });
      }

      console.warn("No handler is registered for slash command:", name);
      return brandedReply({ content: "This command is registered but does not have an active handler yet.", ephemeral: true });
    } catch (e) {
      console.error("Command error for /" + name + ":", e);
      const message = {
        embeds: [new EmbedBuilder().setColor(0x9b111e).setDescription("Something went wrong while running /" + name + ". The error has been logged for the bot owner.")],
        allowedMentions: { parse: [] }
      };
      try {
        if (interaction.deferred) await interaction.editReply(message);
        else if (interaction.replied) await interaction.followUp({ ...message, ephemeral: true });
        else await interaction.reply({ ...message, ephemeral: true });
      } catch (replyError) {
        console.error("Could not send error response for /" + name + ":", replyError);
      }
    }
  });

  client.login(TOKEN).catch(err => console.error("Discord login failed:", err.message));
}
