/**
 * ==========================================================
 *  Key System Backend API - server.js
 * ==========================================================
 * รวมทุก endpoint ไว้ในไฟล์เดียวสำหรับเริ่มต้นระบบ
 *
 * Endpoints:
 *   POST /api/verify              -> สคริปต์ Roblox เรียกตอนรันเกม
 *   POST /api/redeem              -> บอท Discord / เว็บ เรียกตอน user redeem key
 *   POST /api/reset-hwid          -> บอท Discord / เว็บ เรียกตอน user รีเซ็ต HWID
 *   POST /api/admin/generate-key  -> Admin เรียกตอนสร้างคีย์ใหม่
 *
 * วิธีรัน:
 *   1. npm init -y
 *   2. npm install express @supabase/supabase-js dotenv express-rate-limit
 *   3. สร้างไฟล์ .env ตามตัวอย่าง .env.example
 *   4. node server.js
 * ==========================================================
 */

require('dotenv').config();
const ws = require('ws');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

// ---------- 1. Setup พื้นฐาน ----------

const app = express();
app.use(express.json());

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

app.post('/api/verify', requireClientSecret, async (req, res) => {
  try {
    const { discord_id, hwid } = req.body;

    if (!discord_id || !hwid) {
      return res.status(400).json({ success: false, error: 'Missing discord_id or hwid' });
    }

    // 1. ดึงข้อมูล user
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discord_id)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(403).json({ success: false, error: 'User not found. Please redeem a key first.' });
    }

    // 2. เช็กแบน
    if (user.is_blacklisted) {
      return res.status(403).json({ success: false, error: 'Banned', reason: user.ban_reason || 'No reason provided' });
    }

    // 3. เช็ก HWID
    if (!user.hwid) {
      // ยังไม่เคยผูก HWID -> ผูกให้เลยในครั้งแรก
      const { error: updateErr } = await supabase
        .from('users')
        .update({ hwid, last_login_at: new Date().toISOString() })
        .eq('discord_id', discord_id);
      if (updateErr) throw updateErr;
    } else if (user.hwid !== hwid) {
      return res.status(403).json({ success: false, error: 'HWID Mismatch' });
    } else {
      // อัปเดตเวลาล็อกอินล่าสุด
      await supabase
        .from('users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('discord_id', discord_id);
    }

    // 4. เช็กวันหมดอายุ (ผ่านตาราง keys ที่ user คนนี้ redeem ไว้ล่าสุด)
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
      return res.status(403).json({ success: false, error: 'No active key found' });
    }

    if (activeKey.duration_days !== -1 && activeKey.expires_at) {
      const isExpired = new Date(activeKey.expires_at) < new Date();
      if (isExpired) {
        await supabase.from('keys').update({ status: 'expired' }).eq('id', activeKey.id);
        return res.status(403).json({ success: false, error: 'Key expired' });
      }
    }

    // บันทึก log
    await supabase.from('execution_logs').insert({
      discord_id,
      action_type: 'EXECUTE_SCRIPT',
      ip_address: req.ip,
    });

    // ผ่านทุกเงื่อนไข -> ส่ง "โค้ดจริง" กลับไปให้เกมโหลด
    // (แนะนำเก็บโค้ดจริงไว้เป็นไฟล์/DB แยก ไม่ควร hardcode ในนี้)
    return res.json({
      success: true,
      message: 'Access granted',
      script: process.env.PROTECTED_SCRIPT_URL || 'https://your-cdn.com/protected/main.lua',
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

// ---------- 7. Health check (เอาไว้เช็กว่า server รันอยู่ไหม) ----------

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Key System API is running' });
});

// ---------- 8. Start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Key System API is running on port ${PORT}`);
});