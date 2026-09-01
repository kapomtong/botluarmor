/* ---------------------- CLIENT ENDPOINTS ---------------------- */

app.post('/api/verify', requireClientSecret, async (req, res) => {
  try {
    const { key_code, hwid } = req.body || {};

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

    if (keyRow.status === 'revoked') {
      return res.status(403).json({ success: false, error: 'Key revoked' });
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
      return res
        .status(403)
        .json({ success: false, error: 'User not found. Please redeem a key first.' });
    }

    if (user.is_blacklisted) {
      return res.status(403).json({
        success: false,
        error: 'Banned',
        reason: user.ban_reason || 'No reason provided',
      });
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
      const { error: updateErr } = await supabase
        .from('users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('discord_id', discordId);
      if (updateErr) throw updateErr;
    }

    await writeLog(discordId, 'EXECUTE_SCRIPT', req.ip);

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
    const { key_code, discord_id } = req.body || {};

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

    // .eq('status', 'unused') กัน race condition กรณีมีคนกด redeem key เดียวกันพร้อมกัน
    const { data: claimed, error: updateKeyErr } = await supabase
      .from('keys')
      .update({
        status: 'active',
        used_by_discord_id: discord_id,
        expires_at: expiresAt,
      })
      .eq('id', key.id)
      .eq('status', 'unused')
      .select()
      .maybeSingle();

    if (updateKeyErr) throw updateKeyErr;
    if (!claimed) {
      return res.status(409).json({ success: false, error: 'Key was just claimed by someone else' });
    }

    const { error: upsertErr } = await supabase.from('users').upsert(
      {
        discord_id,
        is_blacklisted: false,
        hwid_resets_left: 3,
        last_login_at: null,
      },
      { onConflict: 'discord_id', ignoreDuplicates: false }
    );

    if (upsertErr) throw upsertErr;

    await writeLog(discord_id, 'REDEEM_KEY', req.ip);

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
    const { discord_id } = req.body || {};

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
    if ((user.hwid_resets_left ?? 0) <= 0) {
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

    await writeLog(discord_id, 'RESET_HWID', req.ip);

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
    const { key_code, hwid } = req.body || {};

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
    if (keyRow.status !== 'active') {
      return res.status(403).json({ success: false, error: `Key is ${keyRow.status}` });
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
    const { discord_id } = req.body || {};

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
      return res
        .status(403)
        .json({ success: false, error: 'User not found. Please redeem a key first.' });
    }
    if (user.is_blacklisted) {
      return res.status(403).json({
        success: false,
        error: 'Banned',
        reason: user.ban_reason || 'No reason provided',
      });
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
      return res
        .status(403)
        .json({ success: false, error: 'No active key found. Please redeem a key first.' });
    }

    if (activeKey.duration_days !== -1 && activeKey.expires_at) {
      const isExpired = new Date(activeKey.expires_at) < new Date();
      if (isExpired) {
        await supabase.from('keys').update({ status: 'expired' }).eq('id', activeKey.id);
        return res.status(403).json({ success: false, error: 'Key expired' });
      }
    }

    await writeLog(discord_id, 'GET_SCRIPT', req.ip);

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

/* ---------------------- ADMIN ENDPOINTS ---------------------- */

app.post('/api/admin/generate-key', requireAdminKey, async (req, res) => {
  try {
    const { duration_days, quantity } = req.body || {};

    if (duration_days === undefined || duration_days === null) {
      return res
        .status(400)
        .json({ success: false, error: 'Missing duration_days (-1 = lifetime)' });
    }

    const duration = Number(duration_days);
    if (!Number.isInteger(duration) || (duration !== -1 && duration < 1)) {
      return res
        .status(400)
        .json({ success: false, error: 'duration_days ต้องเป็น -1 (lifetime) หรือจำนวนเต็ม >= 1' });
    }

    const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 100);
    const newKeys = Array.from({ length: qty }, () => ({
      key_code: generateKeyCode(),
      duration_days: duration,
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
    const { discord_id, reason, banned } = req.body || {};

    if (!discord_id || typeof banned !== 'boolean') {
      return res
        .status(400)
        .json({ success: false, error: 'Missing discord_id or banned (boolean)' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        is_blacklisted: banned,
        ban_reason: banned ? reason || 'No reason provided' : null,
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
    const { key_id } = req.body || {};

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
    const { discord_id } = req.body || {};

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

    await writeLog(discord_id, 'ADMIN_FORCE_RESET_HWID', req.ip);

    return res.json({ success: true, message: 'HWID force reset', user: data });
  } catch (err) {
    console.error('admin/force-reset-hwid error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/admin/kick', requireAdminKey, async (req, res) => {
  try {
    const { discord_id, message } = req.body || {};

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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot_ready: Boolean(client?.isReady?.()),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// Express error handler ตัวสุดท้าย กัน error จาก middleware ทำ process ตาย
app.use((err, req, res, next) => {
  console.error('[express error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[api] Key System API is running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] พอร์ต ${PORT} ถูกใช้งานอยู่แล้ว`);
  } else {
    console.error('[FATAL] HTTP server error:', err);
  }
  process.exit(1);
});

/* ============================================================
   4) DISCORD BOT
   ============================================================ */

const API_URL = process.env.API_URL.replace(/\/+$/, '');
const CLIENT_SHARED_SECRET = process.env.CLIENT_SHARED_SECRET;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID; // optional

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function callApi(endpoint, body, useAdminKey = false) {
  try {
    const headers = useAdminKey
      ? { 'x-admin-key': ADMIN_API_KEY }
      : { 'x-client-secret': CLIENT_SHARED_SECRET };

    const res = await axios.post(`${API_URL}${endpoint}`, body, {
      headers,
      timeout: 10000,
    });
    return { ok: true, data: res.data };
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return { ok: false, error: 'API timeout (เกิน 10 วินาที)' };
    }
    if (err.code === 'ECONNREFUSED') {
      return { ok: false, error: `เชื่อมต่อ API ไม่ได้ (${API_URL}) — ตรวจสอบ API_URL` };
    }
    const errMsg = err.response?.data?.error || err.message || 'Unknown error';
    return { ok: false, error: errMsg, status: err.response?.status };
  }
}

/* ---------------------- SLASH COMMAND REGISTRATION ---------------------- */

const commands = [
  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('ส่ง control panel ของ key system ลงในห้องนี้')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('สร้าง key ใหม่')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addIntegerOption((option) =>
      option
        .setName('duration')
        .setDescription('จำนวนวัน (ใส่ -1 = lifetime)')
        .setRequired(true)
        .setMinValue(-1)
    )
    .addIntegerOption((option) =>
      option
        .setName('quantity')
        .setDescription('จำนวน key ที่ต้องการ (1-100)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(100)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
        { body: commands }
      );
      console.log(`[bot] ลงทะเบียน ${commands.length} คำสั่งใน guild ${DISCORD_GUILD_ID} (ขึ้นทันที)`);
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
      console.log(`[bot] ลงทะเบียน ${commands.length} คำสั่งแบบ global (อาจใช้เวลาถึง 1 ชม.)`);
    }
  } catch (err) {
    // ไม่ exit เพราะบอทยังทำงานกับปุ่ม/modal ได้แม้ลงทะเบียนพลาด
    console.error('[bot] ลงทะเบียน slash command ไม่สำเร็จ:', err.message);
    if (err.status === 401) console.error('  → DISCORD_TOKEN ไม่ถูกต้อง');
    if (err.status === 403) console.error('  → บอทไม่ได้อยู่ในเซิร์ฟเวอร์ หรือขาด scope applications.commands');
    if (err.status === 404) console.error('  → DISCORD_CLIENT_ID หรือ DISCORD_GUILD_ID ไม่ถูกต้อง');
  }
}

/* ---------------------- LIFECYCLE EVENTS ---------------------- */

// discord.js v14 ใช้ 'ready', v15 ใช้ 'clientReady'
// Events.ClientReady จะให้ค่าที่ถูกต้องตามเวอร์ชันที่ติดตั้งอยู่
const READY_EVENT = Events.ClientReady ?? 'ready';

client.once(READY_EVENT, async () => {
  console.log(`[bot] Logged in as ${client.user.tag} (${client.user.id})`);
  console.log(`[bot] อยู่ใน ${client.guilds.cache.size} เซิร์ฟเวอร์`);
  await registerCommands();
});

client.on('error', (err) => console.error('[bot] client error:', err));
client.on('shardError', (err) => console.error('[bot] shard error:', err));
client.on('warn', (msg) => console.warn('[bot] warn:', msg));
client.on('invalidated', () => {
  console.error('[FATAL] session ถูก invalidate โดย Discord — กำลังปิด process');
  process.exit(1);
});

/* ---------------------- INTERACTION HANDLER ---------------------- */

client.on(Events.InteractionCreate ?? 'interactionCreate', async (interaction) => {
  try {
    /* ---- /setup-panel ---- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-panel') {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: '❌ ใช้คำสั่งนี้ในเซิร์ฟเวอร์เท่านั้น',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '❌ This command is for Admins only',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.channel;
      if (!channel?.isTextBased()) {
        return interaction.reply({
          content: '❌ ห้องนี้ส่งข้อความไม่ได้',
          flags: MessageFlags.Ephemeral,
        });
      }

      const me = interaction.guild?.members?.me;
      const perms = me ? channel.permissionsFor(me) : null;
      const needed = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ];
      if (!perms?.has(needed)) {
        return interaction.reply({
          content: '❌ บอทขาดสิทธิ์ในห้องนี้ ต้องมี: View Channel, Send Messages, Embed Links',
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
            '📜 **Get Script** — Get your loader with the key filled in',
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

      try {
        await channel.send({ embeds: [panelEmbed], components: [row] });
      } catch (err) {
        console.error('setup-panel send error:', err);
        return interaction.reply({
          content: `❌ ส่ง panel ไม่สำเร็จ: \`${err.message}\``,
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        content: '✅ Control panel sent successfully',
        flags: MessageFlags.Ephemeral,
      });
    }

    /* ---- /genkey ---- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'genkey') {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '❌ This command is for Admins only',
          flags: MessageFlags.Ephemeral,
        });
      }

      const duration = interaction.options.getInteger('duration', true);
      const quantity = interaction.options.getInteger('quantity') ?? 1;

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

      const generated = result.data?.keys ?? [];
      const keysList = generated.map((k) => `\`${k}\``).join('\n');
      const durationText = duration === -1 ? 'Lifetime (no expiration)' : `${duration} day(s)`;

      const genEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Key(s) Generated Successfully')
        .addFields(
          { name: 'Quantity', value: `${generated.length} key(s)`, inline: true },
          { name: 'Duration', value: durationText, inline: true },
          // ตัดที่ 1024 ตัวอักษร เพราะเป็นลิมิตของ embed field
          { name: 'Key List', value: keysList.slice(0, 1024) || '-' }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [genEmbed] });
    }

    /* ---- ปุ่ม Redeem Key → เปิด modal ---- */
    if (interaction.isButton() && interaction.customId === 'redeem_key_button') {
      const modal = new ModalBuilder().setCustomId('redeem_key_modal').setTitle('🔑 Redeem Key');

      const keyInput = new TextInputBuilder()
        .setCustomId('key_code_input')
        .setLabel('Enter your key code')
        .setPlaceholder('e.g. KEY-XXXX-YYYY-ZZZZ')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(64);

      modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
      return interaction.showModal(modal);
    }

    /* ---- Modal submit: redeem ---- */
    if (interaction.isModalSubmit() && interaction.customId === 'redeem_key_modal') {
      const keyCode = interaction.fields.getTextInputValue('key_code_input').trim();
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/redeem', {
        key_code: keyCode,
        discord_id: discordId,
      });

      if (!result.ok) {
        return interaction.editReply({ content: `❌ Redeem failed: \`${result.error}\`` });
      }

      const rawExpires = result.data?.expires_at;
      let expiresText = 'Unknown';
      if (rawExpires === 'lifetime') {
        expiresText = 'Lifetime';
      } else if (rawExpires) {
        const parsed = new Date(rawExpires);
        expiresText = Number.isNaN(parsed.getTime())
          ? String(rawExpires)
          : `<t:${Math.floor(parsed.getTime() / 1000)}:F>`;
      }

      const successEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Redeem Successful!')
        .setDescription(`Key \`${keyCode}\` has been activated successfully`)
        .addFields({ name: 'Expires', value: expiresText })
        .setTimestamp();

      return interaction.editReply({ embeds: [successEmbed] });
    }

    /* ---- ปุ่ม Reset HWID ---- */
    if (interaction.isButton() && interaction.customId === 'reset_hwid_button') {
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/reset-hwid', { discord_id: discordId });

      if (!result.ok) {
        return interaction.editReply({ content: `❌ HWID reset failed: \`${result.error}\`` });
      }

      const resetEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('✅ HWID Reset Successful')
        .setDescription(
          'Your old HWID has been cleared. Next time you run the script, a new HWID will be bound automatically.'
        )
        .addFields({ name: 'Resets Left', value: `${result.data?.resets_left ?? '?'} time(s)` })
        .setTimestamp();

      return interaction.editReply({ embeds: [resetEmbed] });
    }

    /* ---- ปุ่ม Get Script ---- */
    if (interaction.isButton() && interaction.customId === 'get_script_button') {
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/get-script', { discord_id: discordId });

      if (!result.ok) {
        return interaction.editReply({ content: `❌ Failed to get script: \`${result.error}\`` });
      }

      const rawExpires = result.data?.expires_at;
      let expiresText = 'Unknown';
      if (rawExpires === 'lifetime') {
        expiresText = 'Lifetime';
      } else if (rawExpires) {
        const parsed = new Date(rawExpires);
        expiresText = Number.isNaN(parsed.getTime())
          ? String(rawExpires)
          : `<t:${Math.floor(parsed.getTime() / 1000)}:F>`;
      }

      const scriptSnippet = [
        `getgenv().Key = "${result.data.key_code}"`,
        `loadstring(game:HttpGet("${result.data.loader_url}"))()`,
      ].join('\n');

      const scriptEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📜 Your Script')
        .setDescription(
          'Access verified. Your key has been inserted automatically. Copy the code below and paste it into your executor.'
        )
        .addFields({ name: 'Expires', value: expiresText })
        .setTimestamp();

      return interaction.editReply({
        embeds: [scriptEmbed],
        content: `\`\`\`lua\n${scriptSnippet}\n\`\`\``,
      });
    }
  } catch (err) {
    console.error('interaction error:', err);

    // 10062 = Unknown interaction (หมดอายุ 3 วินาที) ตอบกลับไม่ได้แล้ว ข้ามไป
    if (err.code === 10062) return;

    const errorMsg = {
      content: '⚠️ Something went wrong. Please try again.',
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMsg).catch(() => {});
    } else {
      await interaction.reply(errorMsg).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('[FATAL] Discord login ไม่สำเร็จ:', err.message);
  console.error('เช็ค: 1) DISCORD_TOKEN ถูกต้องและยังไม่ถูก reset');
  console.error('      2) intents ใน Developer Portal ตรงกับที่โค้ดขอ');
  console.error('      3) เครื่องเชื่อมต่ออินเทอร์เน็ต / ไม่ถูก firewall บล็อก');
  process.exit(1);
});

/* ---------------------- GRACEFUL SHUTDOWN ---------------------- */

async function shutdown(signal) {
  console.log(`[shutdown] ได้รับ ${signal} กำลังปิดอย่างปลอดภัย`);
  try {
    await client.destroy();
  } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
