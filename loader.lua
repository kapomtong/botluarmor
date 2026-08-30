-- 1. ดึงบริการ HttpService เพื่อใช้งาน JSONEncode/JSONDecode
local HttpService = game:GetService("HttpService")

-- 2. & 3. รับค่า Key และดึง HWID
local userKey = getgenv().Key or ""
local playerHWID = game:GetService("RbxAnalyticsService"):GetClientId()

-- กำหนดฟังก์ชัน request ให้รองรับ Executor หลายๆ ตัว
local req = (syn and syn.request) or (http and http.request) or http_request or request

if not req then
    game:GetService("StarterGui"):SetCore("SendNotification", {
        Title = "System Error",
        Text = "Executor ของคุณไม่รองรับการส่ง HTTP Request",
        Duration = 5
    })
    return
end

-- 4. & 5. ยิง POST Request พร้อม Headers และ Body
local response = req({
    Url = "https://botluarmor-api.onrender.com/api/verify",
    Method = "POST",
    Headers = {
        ["Content-Type"] = "application/json",
        ["x-client-secret"] = "410011218fc0c121022833fd0527832fc67880712d4870179a85073531623ec9" -- อย่าลืมเปลี่ยนค่าตรงนี้นะครับ
    },
    Body = HttpService:JSONEncode({
        discord_id = tostring(userKey), -- ส่งคีย์เข้าไปในฟิลด์ discord_id
        hwid = tostring(playerHWID)
    })
})

-- 6. ตรวจสอบ Response และจัดการการทำงาน
if response and response.Body then
    local success, data = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)

    if success and data then
        if data.success == true then
            -- กรณีที่ผ่าน (success เป็น true) ให้รันสคริปต์
            loadstring(game:HttpGet(data.script))()
        else
            -- กรณีที่ไม่ผ่าน ให้ส่ง Notification แจ้งเตือนข้อผิดพลาด
            game:GetService("StarterGui"):SetCore("SendNotification", {
                Title = "Key System",
                Text = tostring(data.error or "การยืนยันสิทธิ์ล้มเหลว"),
                Duration = 5
            })
        end
    else
        warn("[Loader] ไม่สามารถอ่านข้อมูล JSON จากเซิร์ฟเวอร์ได้")
    end
else
    warn("[Loader] ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ API ได้")
end
