local HttpService = game:GetService("HttpService")
local userKey = getgenv().Key or ""
local playerHWID = game:GetService("RbxAnalyticsService"):GetClientId()

local req = (syn and syn.request) or (http and http.request) or http_request or request
if not req then return warn("Executor ไม่รองรับ HTTP Request") end

local response = req({
    Url = "https://botluarmor-api.onrender.com/api/verify",
    Method = "POST",
    Headers = {
        ["Content-Type"] = "application/json",
        ["x-client-secret"] = "410011218fc0c121022833fd0527832fc67880712d4870179a85073531623ec9" -- ต้องตรงกับใน .env บน Render
    },
    Body = HttpService:JSONEncode({
        key_code = tostring(userKey), -- ส่ง Key ไปเช็ก
        hwid = tostring(playerHWID)
    })
})

if response and response.Body then
    local data = HttpService:JSONDecode(response.Body)
    if data.success then
        -- คีย์ถูกต้อง -> Render จะส่งลิงก์ Pastebin (https://pastebin.com/raw/hnJ98rZt) มารันให้อัตโนมัติ
        loadstring(game:HttpGet(data.script))()
    else
        game:GetService("StarterGui"):SetCore("SendNotification", {
            Title = "Key System",
            Text = data.error or "คีย์ไม่ถูกต้องหรือหมดอายุ",
            Duration = 5
        })
    end
end
