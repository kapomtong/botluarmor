require('dotenv').config();

// ตรวจสอบค่าที่จำเป็นก่อนเริ่มเซิร์ฟเวอร์และ Discord client
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLIENT_SHARED_SECRET',
  'ADMIN_API_KEY',
  'DISCORD_TOKEN',
  'API_URL',
];

const missingEnv = REQUIRED_ENV.filter((name) => !String(process.env[name] || '').trim());
if (missingEnv.length > 0) {
  console.error(`[STARTUP ERROR] Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const ws = require('ws');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const axios = require('axios');

const app = express();

// Render ทำหน้าที่เป็น reverse proxy และส่ง X-Forwarded-For มาให้ Express
// กำหนดเป็น 1 hop เพื่อให้ express-rate-limit อ่าน IP จริงได้อย่างถูกต้อง
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});
app.use(apiLimiter);

function requireAdminKey(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

function requireClientSecret(req, res, next) {
  const clientSecret = req.headers['x-client-secret'];
  if (!clientSecret || clientSecret !== process.env.CLIENT_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized client' });
  }
  next();
}

function generateKeyCode() {
  const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `KEY-${segment()}-${segment()}-${segment()}`;
}

app.post('/api/verify', requireClientSecret, async (req, res) => {
  try {
    const { key_code, hwid } = req.body;

    if (!key_code || !hwid) {
      return res.status(400).json({ success: false, error: 'Missing key_code or hwid' });
    }

    const { data: keyRow, error: keyErr } = await supabase
      .from('keys')
      .select('*')
      .eq('key_code', key_code)
      .maybeSingle();

    if (keyErr) throw keyErr;
    if (!keyRow) {
      return res.status(404).json({ success: false, error: 'Invalid Key' });
    }

    if (keyRow.duration_days !== -1 && keyRow.expires_at) {
      const isExpired = new Date(keyRow.expires_at) < new Date();
      if (isExpired) {
        await supabase.from('keys').update({ status: 'expired' }).eq('id', keyRow.id);
        return res.status(403).json({ success: false, error: 'Key expired' });
      }
    }

    if (!keyRow.used_by_discord_id) {
      return res.status(403).json({ success: false, error: 'Please redeem key first' });
    }

    const discordId = keyRow.used_by_discord_id;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discordId)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(403).json({ success: false, error: 'User not found. Please redeem a key first.' });
    }

    if (user.is_blacklisted) {
      return res.status(403).json({ success: false, error: 'Banned', reason: user.ban_reason || 'No reason provided' });
    }

    if (!user.hwid) {
      const { error: updateErr } = await supabase
        .from('users')
        .update({ hwid, last_login_at: new Date().toISOString() })
        .eq('discord_id', discordId);
      if (updateErr) throw updateErr;
    } else if (user.hwid !== hwid) {
      return res.status(403).json({ success: false, error: 'HWID Mismatch' });
    } else {
      await supabase
        .from('users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('discord_id', discordId);
    }

    await supabase.from('execution_logs').insert({
      discord_id: discordId,
      action_type: 'EXECUTE_SCRIPT',
      ip_address: req.ip,
    });

    return res.json({
      success: true,
      message: 'Access granted',
      script: process.env.PROTECTED_SCRIPT_URL || 'https://pastebin.com/raw/hnJ98rZt',
    });
  } catch (err) {
    console.error('verify error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/redeem', requireClientSecret, async (req, res) => {
  try {
    const { key_code, discord_id } = req.body;

    if (!key_code || !discord_id) {
      return res.status(400).json({ success: false, error: 'Missing key_code or discord_id' });
    }

    const { data: key, error: keyErr } = await supabase
      .from('keys')
      .select('*')
      .eq('key_code', key_code)
      .maybeSingle();

    if (keyErr) throw keyErr;
    if (!key) {
      return res.status(404).json({ success: false, error: 'Invalid key' });
    }
    if (key.status !== 'unused') {
      return res.status(400).json({ success: false, error: `Key already ${key.status}` });
    }

    const now = new Date();
    const expiresAt =
      key.duration_days === -1
        ? null
        : new Date(now.getTime() + key.duration_days * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateKeyErr } = await supabase
      .from('keys')
      .update({
        status: 'active',
        used_by_discord_id: discord_id,
        expires_at: expiresAt,
      })
      .eq('id', key.id);

    if (updateKeyErr) throw updateKeyErr;

    const { error: upsertErr } = await supabase
      .from('users')
      .upsert(
        {
          discord_id,
          is_blacklisted: false,
          hwid_resets_left: 3,
          last_login_at: null,
        },
        { onConflict: 'discord_id', ignoreDuplicates: false }
      );

    if (upsertErr) throw upsertErr;

    await supabase.from('execution_logs').insert({
      discord_id,
      action_type: 'REDEEM_KEY',
      ip_address: req.ip,
    });

    return res.json({
      success: true,
      message: 'Key redeemed successfully',
      expires_at: expiresAt || 'lifetime',
    });
  } catch (err) {
    console.error('redeem error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/reset-hwid', requireClientSecret, async (req, res) => {
  try {
    const { discord_id } = req.body;

    if (!discord_id) {
      return res.status(400).json({ success: false, error: 'Missing discord_id' });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discord_id)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (user.is_blacklisted) {
      return res.status(403).json({ success: false, error: 'Banned users cannot reset HWID' });
    }
    if (user.hwid_resets_left <= 0) {
      return res.status(400).json({ success: false, error: 'No HWID resets left' });
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({
        hwid: null,
        hwid_resets_left: user.hwid_resets_left - 1,
      })
      .eq('discord_id', discord_id);

    if (updateErr) throw updateErr;

    await supabase.from('execution_logs').insert({
      discord_id,
      action_type: 'RESET_HWID',
      ip_address: req.ip,
    });

    return res.json({
      success: true,
      message: 'HWID reset successfully',
      resets_left: user.hwid_resets_left - 1,
    });
  } catch (err) {
    console.error('reset-hwid error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/heartbeat', requireClientSecret, async (req, res) => {
  try {
    const { key_code, hwid } = req.body;

    if (!key_code || !hwid) {
      return res.status(400).json({ success: false, error: 'Missing key_code or hwid' });
    }

    const { data: keyRow, error: keyErr } = await supabase
      .from('keys')
      .select('used_by_discord_id, status')
      .eq('key_code', key_code)
      .maybeSingle();

    if (keyErr) throw keyErr;
    if (!keyRow || !keyRow.used_by_discord_id) {
      return res.status(403).json({ success: false, error: 'Invalid or unredeemed key' });
    }

    const discordId = keyRow.used_by_discord_id;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discordId)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(403).json({ success: false, error: 'User not found' });
    }
    if (user.is_blacklisted) {
      return res.status(403).json({ success: false, error: 'Banned' });
    }
    if (user.hwid && user.hwid !== hwid) {
      return res.status(403).json({ success: false, error: 'HWID Mismatch' });
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({ is_online: true, last_heartbeat: new Date().toISOString() })
      .eq('discord_id', discordId);

    if (updateErr) throw updateErr;

    if (user.force_kick) {
      await supabase
        .from('users')
        .update({ force_kick: false, is_online: false })
        .eq('discord_id', discordId);

      return res.json({
        success: true,
        kick: true,
        kick_message: user.kick_message || 'You have been disconnected by an admin.',
      });
    }

    return res.json({ success: true, kick: false });
  } catch (err) {
    console.error('heartbeat error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/get-script', requireClientSecret, async (req, res) => {
  try {
    const { discord_id } = req.body;

    if (!discord_id) {
      return res.status(400).json({ success: false, error: 'Missing discord_id' });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discord_id)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(403).json({ success: false, error: 'User not found. Please redeem a key first.' });
    }
    if (user.is_blacklisted) {
      return res.status(403).json({ success: false, error: 'Banned', reason: user.ban_reason || 'No reason provided' });
    }

    const { data: activeKey, error: keyErr } = await supabase
      .from('keys')
      .select('*')
      .eq('used_by_discord_id', discord_id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (keyErr) throw keyErr;
    if (!activeKey) {
      return res.status(403).json({ success: false, error: 'No active key found. Please redeem a key first.' });
    }

    if (activeKey.duration_days !== -1 && activeKey.expires_at) {
      const isExpired = new Date(activeKey.expires_at) < new Date();
      if (isExpired) {
        await supabase.from('keys').update({ status: 'expired' }).eq('id', activeKey.id);
        return res.status(403).json({ success: false, error: 'Key expired' });
      }
    }

    await supabase.from('execution_logs').insert({
      discord_id,
      action_type: 'GET_SCRIPT',
      ip_address: req.ip,
    });

    return res.json({
      success: true,
      key_code: activeKey.key_code,
      expires_at: activeKey.duration_days === -1 ? 'lifetime' : activeKey.expires_at,
      loader_url: process.env.LOADER_SCRIPT_URL || 'https://pastebin.com/raw/5Qhj3iPb',
    });
  } catch (err) {
    console.error('get-script error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/admin/generate-key', requireAdminKey, async (req, res) => {
  try {
    const { duration_days, quantity } = req.body;

    if (duration_days === undefined) {
      return res.status(400).json({ success: false, error: 'Missing duration_days (-1 = lifetime)' });
    }

    const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 100);
    const newKeys = Array.from({ length: qty }, () => ({
      key_code: generateKeyCode(),
      duration_days,
      status: 'unused',
    }));

    const { data, error } = await supabase.from('keys').insert(newKeys).select();

    if (error) throw error;

    return res.json({
      success: true,
      message: `${qty} key(s) generated`,
      keys: data.map((k) => k.key_code),
    });
  } catch (err) {
    console.error('generate-key error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/admin/keys', requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('keys')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ success: true, keys: data });
  } catch (err) {
    console.error('admin/keys error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/admin/users', requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('last_login_at', { ascending: false });

    if (error) throw error;

    return res.json({ success: true, users: data });
  } catch (err) {
    console.error('admin/users error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/admin/ban', requireAdminKey, async (req, res) => {
  try {
    const { discord_id, reason, banned } = req.body;

    if (!discord_id || typeof banned !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Missing discord_id or banned (boolean)' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        is_blacklisted: banned,
        ban_reason: banned ? (reason || 'No reason provided') : null,
      })
      .eq('discord_id', discord_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({
      success: true,
      message: banned ? 'User banned' : 'User unbanned',
      user: data,
    });
  } catch (err) {
    console.error('admin/ban error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/admin/revoke-key', requireAdminKey, async (req, res) => {
  try {
    const { key_id } = req.body;

    if (!key_id) {
      return res.status(400).json({ success: false, error: 'Missing key_id' });
    }

    const { data, error } = await supabase
      .from('keys')
      .update({ status: 'revoked' })
      .eq('id', key_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'Key not found' });
    }

    return res.json({ success: true, message: 'Key revoked', key: data });
  } catch (err) {
    console.error('admin/revoke-key error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/admin/force-reset-hwid', requireAdminKey, async (req, res) => {
  try {
    const { discord_id } = req.body;

    if (!discord_id) {
      return res.status(400).json({ success: false, error: 'Missing discord_id' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ hwid: null })
      .eq('discord_id', discord_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await supabase.from('execution_logs').insert({
      discord_id,
      action_type: 'ADMIN_FORCE_RESET_HWID',
      ip_address: req.ip,
    });

    return res.json({ success: true, message: 'HWID force reset', user: data });
  } catch (err) {
    console.error('admin/force-reset-hwid error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/admin/kick', requireAdminKey, async (req, res) => {
  try {
    const { discord_id, message } = req.body;

    if (!discord_id) {
      return res.status(400).json({ success: false, error: 'Missing discord_id' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        force_kick: true,
        kick_message: message || 'You have been disconnected by an admin.',
      })
      .eq('discord_id', discord_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({ success: true, message: 'Kick requested', user: data });
  } catch (err) {
    console.error('admin/kick error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Key System API is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Key System API is running on port ${PORT}`);
});

const API_URL = String(process.env.API_URL).trim().replace(/\/$/, '');
const CLIENT_SHARED_SECRET = String(process.env.CLIENT_SHARED_SECRET).trim();
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY).trim();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function callApi(endpoint, body, useAdminKey = false) {
  try {
    const headers = useAdminKey
      ? { 'x-admin-key': ADMIN_API_KEY }
      : { 'x-client-secret': CLIENT_SHARED_SECRET };

    const res = await axios.post(`${API_URL}${endpoint}`, body, { headers });
    return { ok: true, data: res.data };
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message || 'Unknown error';
    return { ok: false, error: errMsg, status: err.response?.status };
  }
}

client.once('ready', () => {
  console.log(`✅ Discord bot online as ${client.user.tag} (${client.user.id})`);
  console.log(`🌐 API endpoint: ${API_URL}`);
});

client.on('error', (error) => {
  console.error('[DISCORD CLIENT ERROR]', error);
});

client.on('shardError', (error) => {
  console.error('[DISCORD SHARD ERROR]', error);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-panel') {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '❌ This command is for Admins only',
          flags: MessageFlags.Ephemeral,
        });
      }

      const panelEmbed = new EmbedBuilder()
        .setColor(0x2f3136)
        .setTitle('🔐 Key System Management')
        .setDescription(
          [
            'Welcome to our key management system!',
            '',
            '🔑 **Redeem Key** — Enter your key to activate access',
            '🔄 **Reset HWID** — Reset your hardware ID when switching computers',
            '',
            '> Click a button below to get started',
          ].join('\n')
        )
        .setFooter({ text: 'Key System • Powered by Backend API' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('redeem_key_button')
          .setLabel('Redeem Key')
          .setEmoji('🔑')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('reset_hwid_button')
          .setLabel('Reset HWID')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('get_script_button')
          .setLabel('Get Script')
          .setEmoji('📜')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.channel.send({ embeds: [panelEmbed], components: [row] });
      return interaction.reply({
        content: '✅ Control panel sent successfully',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'genkey') {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '❌ This command is for Admins only',
          flags: MessageFlags.Ephemeral,
        });
      }

      const duration = interaction.options.getNumber('duration');
      const quantity = interaction.options.getNumber('quantity') ?? 1;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi(
        '/api/admin/generate-key',
        { duration_days: duration, quantity },
        true
      );

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ Failed to generate key: \`${result.error}\``,
        });
      }

      const keysList = result.data.keys.map((k) => `\`${k}\``).join('\n');
      const durationText = duration === -1 ? 'Lifetime (no expiration)' : `${duration} day(s)`;

      const genEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Key(s) Generated Successfully')
        .addFields(
          { name: 'Quantity', value: `${quantity} key(s)`, inline: true },
          { name: 'Duration', value: durationText, inline: true },
          { name: 'Key List', value: keysList || '-' }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [genEmbed] });
    }

    if (interaction.isButton() && interaction.customId === 'redeem_key_button') {
      const modal = new ModalBuilder()
        .setCustomId('redeem_key_modal')
        .setTitle('🔑 Redeem Key');

      const keyInput = new TextInputBuilder()
        .setCustomId('key_code_input')
        .setLabel('Enter your key code')
        .setPlaceholder('e.g. KEY-XXXX-YYYY-ZZZZ')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'redeem_key_modal') {
      const keyCode = interaction.fields.getTextInputValue('key_code_input').trim();
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/redeem', {
        key_code: keyCode,
        discord_id: discordId,
      });

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ Redeem failed: \`${result.error}\``,
        });
      }

      const expiresText =
        result.data.expires_at === 'lifetime'
          ? 'Lifetime'
          : new Date(result.data.expires_at).toLocaleString('en-US');

      const successEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Redeem Successful!')
        .setDescription(`Key \`${keyCode}\` has been activated successfully`)
        .addFields({ name: 'Expires', value: expiresText })
        .setTimestamp();

      return interaction.editReply({ embeds: [successEmbed] });
    }

    if (interaction.isButton() && interaction.customId === 'reset_hwid_button') {
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/reset-hwid', { discord_id: discordId });

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ HWID reset failed: \`${result.error}\``,
        });
      }

      const resetEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('✅ HWID Reset Successful')
        .setDescription('Your old HWID has been cleared. Next time you run the script, a new HWID will be bound automatically.')
        .addFields({ name: 'Resets Left', value: `${result.data.resets_left} time(s)` })
        .setTimestamp();

      return interaction.editReply({ embeds: [resetEmbed] });
    }

    if (interaction.isButton() && interaction.customId === 'get_script_button') {
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/get-script', { discord_id: discordId });

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ Failed to get script: \`${result.error}\``,
        });
      }

      const expiresText =
        result.data.expires_at === 'lifetime'
          ? 'Lifetime'
          : new Date(result.data.expires_at).toLocaleString('en-US');

      const scriptSnippet = [
        `getgenv().Key = "${result.data.key_code}"`,
        `loadstring(game:HttpGet("${result.data.loader_url}"))()`,
      ].join('\n');

      const scriptEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📜 Your Script')
        .setDescription('Access verified. Your key has been inserted automatically. Copy the code below and paste it into your executor.')
        .addFields({ name: 'Expires', value: expiresText })
        .setTimestamp();

      return interaction.editReply({
        embeds: [scriptEmbed],
        content: `\`\`\`lua\n${scriptSnippet}\n\`\`\``,
      });
    }
  } catch (err) {
    console.error('interaction error:', err);
    const errorMsg = { content: '⚠️ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMsg).catch(() => {});
    } else {
      await interaction.reply(errorMsg).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

client.login(String(process.env.DISCORD_TOKEN).trim()).catch((error) => {
  console.error('[DISCORD LOGIN FAILED]', error);
  process.exitCode = 1;
});
