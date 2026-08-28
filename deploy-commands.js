/**
 * ==========================================================
 *  deploy-commands.js
 * ==========================================================
 * ใช้สำหรับลงทะเบียน Slash Commands กับ Discord
 * รันแค่ตอน setup ครั้งแรก หรือทุกครั้งที่แก้ไข/เพิ่มคำสั่งใหม่
 *
 * วิธีรัน: node deploy-commands.js
 * ==========================================================
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('(Admin) ส่ง Control Panel สำหรับ Redeem Key / Reset HWID'),

  new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('(Admin) สร้างคีย์ใหม่')
    .addNumberOption((option) =>
      option
        .setName('duration')
        .setDescription('จำนวนวันใช้งาน (-1 = Lifetime)')
        .setRequired(true)
    )
    .addNumberOption((option) =>
      option
        .setName('quantity')
        .setDescription('จำนวนคีย์ที่ต้องการสร้าง (ค่าเริ่มต้น = 1)')
        .setRequired(false)
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('⏳ กำลังลงทะเบียน Slash Commands...');

    if (process.env.GUILD_ID) {
      // ลงทะเบียนเฉพาะเซิร์ฟเวอร์เดียว (อัปเดตทันที เหมาะตอนพัฒนา/ทดสอบ)
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`✅ ลงทะเบียนสำเร็จสำหรับ Guild: ${process.env.GUILD_ID}`);
    } else {
      // ลงทะเบียนแบบ Global (ใช้ได้ทุกเซิร์ฟเวอร์ที่เชิญบอทเข้าไป แต่ใช้เวลาซิงค์ ~1 ชม.)
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
        body: commands,
      });
      console.log('✅ ลงทะเบียนสำเร็จแบบ Global (รอซิงค์ประมาณ 1 ชั่วโมง)');
    }
  } catch (err) {
    console.error('❌ ลงทะเบียนไม่สำเร็จ:', err);
  }
})();
