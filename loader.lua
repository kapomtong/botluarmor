app.post('/api/verify', requireClientSecret, async (req, res) => {
  try {
    const { key_code, hwid } = req.body;

    // เช็กว่ามีการส่ง key_code และ hwid มาไหม
    if (!key_code || !hwid) {
      return res.status(400).json({ success: false, error: 'Missing key_code or hwid' });
    }

    // 1. ค้นหาคีย์จาก Database ด้วย key_code
    const { data: activeKey, error: keyErr } = await supabase
      .from('keys')
      .select('*')
      .eq('key_code', key_code)
      .maybeSingle();

    if (!activeKey) {
      return res.status(403).json({ success: false, error: 'คีย์ไม่ถูกต้อง หรือยังไม่ถูกสร้าง' });
    }

    // 2. เช็กว่าคีย์ถูก Redeem ผูกกับ Discord ID หรือยัง (กรณีที่ระบบบังคับ)
    if (!activeKey.used_by_discord_id) {
      return res.status(403).json({ success: false, error: 'ให้ redeem ก่อน' });
    }

    // ผ่านทุกเงื่อนไข -> ส่งลิงก์ Pastebin ให้ดึงสคริปต์มารัน
    return res.json({
      success: true,
      message: 'Access granted',
      script: 'https://pastebin.com/raw/hnJ98rZt',
    });
  } catch (err) {
    console.error('verify error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});
