local response = req({
    Url = "https://botluarmor-api.onrender.com/api/verify",
    Method = "POST",
    Headers = {
        ["Content-Type"] = "application/json",
        ["x-client-secret"] = "410011218fc0c121022833fd0527832fc67880712d4870179a85073531623ec9" -- ใส่ CLIENT_SHARED_SECRET ให้ตรงกับใน .env
    },
    Body = HttpService:JSONEncode({
        discord_id = userKey, -- ส่งค่า Key ไปในช่อง discord_id เพื่อให้ตรงกับที่ server.js รอรับ
        hwid = playerHWID
    })
})
