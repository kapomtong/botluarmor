/**
 * ==========================================================
 *  Key System Discord Bot - bot.js  (discord.js v14)
 * ==========================================================
 * ฟีเจอร์:
 *   /setup-panel   -> (Admin) ส่ง Control Panel พร้อมปุ่ม Redeem Key / Reset HWID
 *   /genkey        -> (Admin) สร้างคีย์ใหม่ผ่าน Backend API
 *
 * วิธีรัน:
 *   1. npm init -y
 *   2. npm install discord.js axios dotenv
 *   3. สร้างไฟล์ .env ตามตัวอย่างด้านล่าง (bot.env.example)
 *   4. รัน deploy-commands.js ก่อน 1 ครั้ง เพื่อลงทะเบียน slash command
 *   5. node bot.js
 * ==========================================================
 */

require('dotenv').config();
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

const API_URL = process.env.API_URL;
const CLIENT_SHARED_SECRET = process.env.CLIENT_SHARED_SECRET;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ---------- Helper: เช็กว่าเป็น Admin ไหม (ใช้สิทธิ์ Discord permission "Manage Server") ----------
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

// ---------- Helper: เรียก Backend API ----------
async function callApi(endpoint, body, useAdminKey = false) {
  try {
    const headers = useAdminKey
      ? { 'x-admin-key': ADMIN_API_KEY }
      : { 'x-client-secret': CLIENT_SHARED_SECRET };

    const res = await axios.post(`${API_URL}${endpoint}`, body, { headers });
    return { ok: true, data: res.data };
  } catch (err) {
    const errMsg =
      err.response?.data?.error || err.message || 'Unknown error';
    return { ok: false, error: errMsg, status: err.response?.status };
  }
}

// ---------- Bot Ready ----------
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---------- Interaction Handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // ===================================================
    // 1. Slash Command: /setup-panel
    // ===================================================
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-panel') {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '❌ คำสั่งนี้ใช้ได้เฉพาะ Admin เท่านั้น',
          flags: MessageFlags.Ephemeral,
        });
      }

      const panelEmbed = new EmbedBuilder()
        .setColor(0x2f3136)
        .setTitle('🔐 ระบบจัดการ Key System')
        .setDescription(
          [
            'ยินดีต้อนรับเข้าสู่ระบบจัดการคีย์ของเรา!',
            '',
            '🔑 **Redeem Key** — กรอกคีย์ของคุณเพื่อเปิดใช้งานสิทธิ์',
            '🔄 **Reset HWID** — รีเซ็ตรหัสเครื่องเมื่อเปลี่ยนคอมพิวเตอร์ใหม่',
            '',
            '> กดปุ่มด้านล่างเพื่อเริ่มใช้งาน',
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
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.channel.send({ embeds: [panelEmbed], components: [row] });
      return interaction.reply({
        content: '✅ ส่ง Control Panel เรียบร้อยแล้ว',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ===================================================
    // 2. Slash Command: /genkey
    // ===================================================
    if (interaction.isChatInputCommand() && interaction.commandName === 'genkey') {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '❌ คำสั่งนี้ใช้ได้เฉพาะ Admin เท่านั้น',
          flags: MessageFlags.Ephemeral,
        });
      }

      const duration = interaction.options.getNumber('duration');
      const quantity = interaction.options.getNumber('quantity') ?? 1;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi(
        '/api/admin/generate-key',
        { duration_days: duration, quantity },
        true // ใช้ admin key
      );

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ สร้างคีย์ไม่สำเร็จ: \`${result.error}\``,
        });
      }

      const keysList = result.data.keys.map((k) => `\`${k}\``).join('\n');
      const durationText = duration === -1 ? 'Lifetime (ไม่มีวันหมดอายุ)' : `${duration} วัน`;

      const genEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ สร้างคีย์สำเร็จ')
        .addFields(
          { name: 'จำนวน', value: `${quantity} คีย์`, inline: true },
          { name: 'ระยะเวลา', value: durationText, inline: true },
          { name: 'รายการคีย์', value: keysList || '-' }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [genEmbed] });
    }

    // ===================================================
    // 3. Button: Redeem Key -> เปิด Modal
    // ===================================================
    if (interaction.isButton() && interaction.customId === 'redeem_key_button') {
      const modal = new ModalBuilder()
        .setCustomId('redeem_key_modal')
        .setTitle('🔑 Redeem Key');

      const keyInput = new TextInputBuilder()
        .setCustomId('key_code_input')
        .setLabel('กรอก Key Code ของคุณ')
        .setPlaceholder('เช่น KEY-XXXX-YYYY-ZZZZ')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
      return interaction.showModal(modal);
    }

    // ===================================================
    // 4. Modal Submit: Redeem Key
    // ===================================================
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
          content: `❌ Redeem ไม่สำเร็จ: \`${result.error}\``,
        });
      }

      const expiresText =
        result.data.expires_at === 'lifetime'
          ? 'ตลอดชีพ (Lifetime)'
          : new Date(result.data.expires_at).toLocaleString('th-TH');

      const successEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Redeem สำเร็จ!')
        .setDescription(`คีย์ \`${keyCode}\` ถูกเปิดใช้งานเรียบร้อยแล้ว`)
        .addFields({ name: 'หมดอายุ', value: expiresText })
        .setTimestamp();

      return interaction.editReply({ embeds: [successEmbed] });
    }

    // ===================================================
    // 5. Button: Reset HWID -> เรียก API ทันที
    // ===================================================
    if (interaction.isButton() && interaction.customId === 'reset_hwid_button') {
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/reset-hwid', { discord_id: discordId });

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ รีเซ็ต HWID ไม่สำเร็จ: \`${result.error}\``,
        });
      }

      const resetEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('✅ รีเซ็ต HWID สำเร็จ')
        .setDescription('รหัสเครื่องเดิมถูกลบแล้ว ครั้งต่อไปที่รันสคริปต์ระบบจะผูก HWID ใหม่ให้อัตโนมัติ')
        .addFields({ name: 'สิทธิ์รีเซ็ตที่เหลือ', value: `${result.data.resets_left} ครั้ง` })
        .setTimestamp();

      return interaction.editReply({ embeds: [resetEmbed] });
    }
  } catch (err) {
    console.error('interaction error:', err);
    const errorMsg = { content: '⚠️ เกิดข้อผิดพลาดบางอย่าง กรุณาลองใหม่อีกครั้ง', flags: MessageFlags.Ephemeral };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMsg).catch(() => {});
    } else {
      await interaction.reply(errorMsg).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
