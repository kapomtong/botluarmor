/**
 * ==========================================================
 *  Key System - server.js (รวม Backend API + Discord Bot)
 * ==========================================================
 * ไฟล์นี้รวม server.js (Backend API) และ bot.js (Discord Bot)
 * เข้าด้วยกัน รันด้วยคำสั่งเดียว: node server.js
 *
 * Endpoints:
 *   POST /api/verify              -> สคริปต์ Roblox เรียกตอนรันเกม
 *   POST /api/redeem              -> บอท Discord / เว็บ เรียกตอน user redeem key
 *   POST /api/reset-hwid          -> บอท Discord / เว็บ เรียกตอน user รีเซ็ต HWID
 *   POST /api/admin/generate-key  -> Admin เรียกตอนสร้างคีย์ใหม่
 *
 * Discord Bot ฟีเจอร์:
 *   /setup-panel   -> (Admin) ส่ง Control Panel พร้อมปุ่ม Redeem Key / Reset HWID
 *   /genkey        -> (Admin) สร้างคีย์ใหม่ผ่าน Backend API
 *
 * วิธีรัน:
 *   1. npm init -y
 *   2. npm install express @supabase/supabase-js dotenv express-rate-limit ws discord.js axios
 *   3. สร้างไฟล์ .env ตามตัวอย่าง .env.example (รวม config ของทั้ง server และ bot)
 *   4. รัน deploy-commands.js ก่อน 1 ครั้ง เพื่อลงทะเบียน slash command ของบอท
 *   5. node server.js
 * ==========================================================
 */

require('dotenv').config();
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

// ==========================================================
//  ส่วนที่ 1: Backend API (เดิมคือ server.js)
// ==========================================================

// ---------- 1. Setup พื้นฐาน ----------

const app = express();
app.use(express.json());
app.use(express.static('public')); // เสิร์ฟหน้า admin dashboard (public/index.html)

// ใช้ Service Role Key เท่านั้นฝั่ง backend (ห้ามฝังใน Roblox/เว็บ/บอทเด็ดขาด)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

// กัน brute-force / สแปมยิง API ถี่เกินไป
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 นาที
  max: 30,             // สูงสุด 30 ครั้งต่อ IP ต่อนาที
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});
app.use(apiLimiter);

// Middleware เช็กสิทธิ์ Admin (ใช้กับ endpoint ที่ละเอียดอ่อน เช่น generate-key)
function requireAdminKey(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// Middleware เช็ก Secret กลาง ที่ให้เฉพาะ bot/เว็บ/เกมของเราเรียกได้ (กันคนภายนอกยิง API มั่ว)
function requireClientSecret(req, res, next) {
  const clientSecret = req.headers['x-client-secret'];
  if (!clientSecret || clientSecret !== process.env.CLIENT_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized client' });
  }
  next();
}

// ---------- 2. Helper functions ----------

function generateKeyCode() {
  const segment = () =>
    Math.random().toString(36).substring(2, 6).toUpperCase();
  return `KEY-${segment()}-${segment()}-${segment()}`;
}

// ---------- 3. POST /api/verify ----------
// สคริปต์ Roblox เรียกทุกครั้งที่ผู้เล่นรันเกม เพื่อเช็กว่าอนุญาตให้รันสคริปต์จริงไหม
// ตรวจสอบผ่าน key_code แทน discord_id (ต้อง redeem ผูกกับ discord ไว้ก่อนแล้ว)

app.post('/api/verify', requireClientSecret, async (req, res) => {
  try {
    const { key_code, hwid } = req.body;

    if (!key_code || !hwid) {
      return res.status(400).json({ success: false, error: 'Missing key_code or hwid' });
    }

    // 1. หา key จาก key_code
    const { data: keyRow, error: keyErr } = await supabase
      .from('keys')
      .select('*')
      .eq('key_code', key_code)
      .maybeSingle();

    if (keyErr) throw keyErr;
    if (!keyRow) {
      return res.status(404).json({ success: false, error: 'Invalid Key' });
    }

    // 2. เช็กวันหมดอายุ
    if (keyRow.duration_days !== -1 && keyRow.expires_at) {
      const isExpired = new Date(keyRow.expires_at) < new Date();
      if (isExpired) {
        await supabase.from('keys').update({ status: 'expired' }).eq('id', keyRow.id);
        return res.status(403).json({ success: false, error: 'Key expired' });
      }
    }

    // 3. เช็กว่าคีย์ถูก redeem ผูกกับ discord แล้วหรือยัง
    if (!keyRow.used_by_discord_id) {
      return res.status(403).json({ success: false, error: 'Please redeem key first' });
    }

    const discordId = keyRow.used_by_discord_id;

    // 4. ดึงข้อมูล user ที่ผูกกับคีย์นี้
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discordId)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(403).json({ success: false, error: 'User not found. Please redeem a key first.' });
    }

    // 5. เช็กแบน
    if (user.is_blacklisted) {
      return res.status(403).json({ success: false, error: 'Banned', reason: user.ban_reason || 'No reason provided' });
    }

    // 6. เช็ก HWID
    if (!user.hwid) {
      // ยังไม่เคยผูก HWID -> ผูกให้เลยในครั้งแรก
      const { error: updateErr } = await supabase
        .from('users')
        .update({ hwid, last_login_at: new Date().toISOString() })
        .eq('discord_id', discordId);
      if (updateErr) throw updateErr;
    } else if (user.hwid !== hwid) {
      return res.status(403).json({ success: false, error: 'HWID Mismatch' });
    } else {
      // อัปเดตเวลาล็อกอินล่าสุด
      await supabase
        .from('users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('discord_id', discordId);
    }

    // บันทึก log
    await supabase.from('execution_logs').insert({
      discord_id: discordId,
      action_type: 'EXECUTE_SCRIPT',
      ip_address: req.ip,
    });

    // ผ่านทุกเงื่อนไข -> ส่ง "โค้ดจริง" กลับไปให้เกมโหลด
    // (แนะนำเก็บโค้ดจริงไว้เป็นไฟล์/DB แยก ไม่ควร hardcode ในนี้)
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

// ---------- 4. POST /api/redeem ----------
// บอท Discord หรือหน้าเว็บ เรียกตอน user เอาคีย์มาใช้งาน

app.post('/api/redeem', requireClientSecret, async (req, res) => {
  try {
    const { key_code, discord_id } = req.body;

    if (!key_code || !discord_id) {
      return res.status(400).json({ success: false, error: 'Missing key_code or discord_id' });
    }

    // 1. หา key
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

    // 2. คำนวณวันหมดอายุ
    const now = new Date();
    const expiresAt =
      key.duration_days === -1
        ? null // lifetime
        : new Date(now.getTime() + key.duration_days * 24 * 60 * 60 * 1000).toISOString();

    // 3. อัปเดตสถานะ key
    const { error: updateKeyErr } = await supabase
      .from('keys')
      .update({
        status: 'active',
        used_by_discord_id: discord_id,
        expires_at: expiresAt,
      })
      .eq('id', key.id);

    if (updateKeyErr) throw updateKeyErr;

    // 4. upsert ลงตาราง users
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

    // 5. log
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

// ---------- 5. POST /api/reset-hwid ----------
// บอท Discord หรือหน้าเว็บ เรียกตอน user ขอรีเซ็ต HWID

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

// ---------- 5a2. POST /api/heartbeat ----------
// รับสัญญาณ "ยังออนไลน์อยู่" จาก client (ต้องมี key_code + hwid ที่ verify ผ่านแล้วเท่านั้น)
// อัปเดต is_online / last_heartbeat และตอบกลับสถานะ force_kick ให้ client เช็คเอง

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

    // ถ้าแอดมินสั่งเตะไว้ -> ตอบกลับ kick:true แล้วเคลียร์ค่า force_kick ทันที (สั่งครั้งเดียวพอ)
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

// ---------- 5b. POST /api/get-script ----------
// บอท Discord เรียกตอน user กดปุ่ม "Get Script"
// เช็คสิทธิ์ก่อนเสมอ (ไม่แบน / มีคีย์ active / ยังไม่หมดอายุ) แล้วค่อยส่งคีย์กลับไปให้บอทใส่ให้ลูกค้า

app.post('/api/get-script', requireClientSecret, async (req, res) => {
  try {
    const { discord_id } = req.body;

    if (!discord_id) {
      return res.status(400).json({ success: false, error: 'Missing discord_id' });
    }

    // 1. เช็ก user + สถานะแบน
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

    // 2. หาคีย์ active ล่าสุดของ user คนนี้
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

    // 3. เช็กวันหมดอายุ
    if (activeKey.duration_days !== -1 && activeKey.expires_at) {
      const isExpired = new Date(activeKey.expires_at) < new Date();
      if (isExpired) {
        await supabase.from('keys').update({ status: 'expired' }).eq('id', activeKey.id);
        return res.status(403).json({ success: false, error: 'Key expired' });
      }
    }

    // log
    await supabase.from('execution_logs').insert({
      discord_id,
      action_type: 'GET_SCRIPT',
      ip_address: req.ip,
    });

    // 4. ผ่านทุกเงื่อนไข -> ส่งคีย์ของ user คนนี้กลับไปให้บอทประกอบสคริปต์
    return res.json({
      success: true,
      key_code: activeKey.key_code,
      expires_at: activeKey.duration_days === -1 ? 'lifetime' : activeKey.expires_at,
      loader_url:
        process.env.LOADER_SCRIPT_URL ||
        'https://pastebin.com/raw/5Qhj3iPb',
    });
  } catch (err) {
    console.error('get-script error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ---------- 6. POST /api/admin/generate-key ----------
// เฉพาะ Admin เรียกได้ (ต้องแนบ x-admin-key ที่ถูกต้อง)

app.post('/api/admin/generate-key', requireAdminKey, async (req, res) => {
  try {
    const { duration_days, quantity } = req.body;

    if (duration_days === undefined) {
      return res.status(400).json({ success: false, error: 'Missing duration_days (-1 = lifetime)' });
    }

    const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 100); // จำกัดไม่เกินครั้งละ 100 คีย์
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

// ---------- 6b. GET /api/admin/keys ----------
// ดึงข้อมูลคีย์ทั้งหมด เรียงจากล่าสุด

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

// ---------- 6c. GET /api/admin/users ----------
// ดึงข้อมูลผู้ใช้ทั้งหมด

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

// ---------- 6d. POST /api/admin/ban ----------
// แบน / ปลดแบน user (รับ discord_id, reason, และ banned: true/false)

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

// ---------- 6e. POST /api/admin/revoke-key ----------
// เปลี่ยนสถานะคีย์เป็น 'revoked' (รับ key_id)

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

// ---------- 6f. POST /api/admin/force-reset-hwid ----------
// บังคับรีเซ็ต HWID ของ user ทันที โดยไม่หักโควตา resets_left ของ user

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

// ---------- 6g. POST /api/admin/kick ----------
// ตั้งสถานะ force_kick ให้ user คนนั้น พร้อมข้อความ (client จะเห็นตอนส่ง heartbeat รอบถัดไป)

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

// ---------- 7. Health check (เอาไว้เช็กว่า server รันอยู่ไหม) ----------

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Key System API is running' });
});

// ---------- 8. Start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Key System API is running on port ${PORT}`);
});

// ==========================================================
//  ส่วนที่ 2: Discord Bot (เดิมคือ bot.js)
// ==========================================================

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
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('get_script_button')
          .setLabel('Get Script')
          .setEmoji('📜')
          .setStyle(ButtonStyle.Secondary)
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
    // ===================================================
    // 6. Button: Get Script -> เชคสิทธิ์ก่อน แล้วประกอบสคริปต์ + ใส่คีย์ลูกค้าให้อัตโนมัติ
    // ===================================================
    if (interaction.isButton() && interaction.customId === 'get_script_button') {
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await callApi('/api/get-script', { discord_id: discordId });

      if (!result.ok) {
        return interaction.editReply({
          content: `❌ ดึงสคริปต์ไม่สำเร็จ: \`${result.error}\``,
        });
      }

      const expiresText =
        result.data.expires_at === 'lifetime'
          ? 'ตลอดชีพ (Lifetime)'
          : new Date(result.data.expires_at).toLocaleString('th-TH');

      const scriptSnippet = [
        `getgenv().Key = "${result.data.key_code}"`,
        `loadstring(game:HttpGet("${result.data.loader_url}"))()`,
      ].join('\n');

      const scriptEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📜 สคริปต์ของคุณ')
        .setDescription('ระบบเชคสิทธิ์ผ่านแล้ว คีย์ของคุณถูกใส่ให้อัตโนมัติ คัดลอกโค้ดด้านล่างไปวางใน Executor ได้เลย')
        .addFields({ name: 'หมดอายุ', value: expiresText })
        .setTimestamp();

      return interaction.editReply({
        embeds: [scriptEmbed],
        content: `\`\`\`lua\n${scriptSnippet}\n\`\`\``,
      });
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
