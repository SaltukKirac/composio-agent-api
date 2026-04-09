const express = require("express");
const { OpenAI } = require("openai");
const composioLib = require("composio-core");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post("/run-agent", async (req, res) => {
    // Kurallar: Vercel gibi Serverless ortamlar "res.json()" komutu verildiği an işlemi keser.
    // Bu kod eğer Render, Railway veya kalıcı bir VPS Node.js üzerinde çalıştırılırsa,
    // res.json() sonrası bile işlem arka planda saatlerce güvenle devam eder.
    res.json({ status: "PROCESSING", message: "Ajan başlatıldı, arka plan süreci devraldı." });
    
    // Bubble'dan Gelen Parametreler
    const properties = req.body;
    let debugLogs = [];
    const log = (msg) => {
        debugLogs.push(msg);
        console.log(msg);
    };

    try {
        log("1. Servis Başlatıldı. C-Core yüklendi.");
        const openai = new OpenAI({ apiKey: properties.openai_api_key });
        
        let composio;
        if (typeof composioLib.OpenAIToolSet === "function") {
            composio = new composioLib.OpenAIToolSet({ apiKey: properties.composio_api_key, entityId: properties.user_id });
        } else if (typeof composioLib.ComposioToolSet === "function") {
            composio = new composioLib.ComposioToolSet({ apiKey: properties.composio_api_key, entityId: properties.user_id });
        } else {
            composio = new composioLib.Composio({ apiKey: properties.composio_api_key });
        }

        // Tools Listesini Çözümle
        let requestedToolsList = [];
        const rawTools = properties.tools_list; 
        if (rawTools && rawTools.length > 5) {
            try {
                const parsedArray = typeof rawTools === 'string' ? JSON.parse(rawTools) : rawTools;
                requestedToolsList = parsedArray.map(t => typeof t === 'object' ? t.type : t);
            } catch(e) { log("UYARI: tools_list hatali."); }
        }

        const requiredApps = new Set();
        requestedToolsList.forEach(tool => {
            if(tool && tool.includes("mcp_")) requiredApps.add(tool.split("mcp_")[1].toLowerCase());
        });

        // -------------------------
        // BÖLÜM 1: AUTH KONTROLÜ
        // -------------------------
        let entity;
        if (typeof composio.getEntity === "function") {
            entity = await composio.getEntity(properties.user_id);
        } else if (composio.client && typeof composio.client.getEntity === "function") {
            entity = await composio.client.getEntity(properties.user_id);
        } else {
            throw new Error("getEntity fonksiyonu bulunamadı. Composio başlatılamadı.");
        }
        
        for (const appName of requiredApps) {
            try {
                await entity.getConnection({ appName: appName });
            } catch (e) {
                let integration = await entity.initiateConnection({ appName: appName, redirectUri: "https://yourdomain.com/" });
                
                // Auth Eksik - Bubble'ın Webhook URL'sine sonucu gönder ve iptal et
                await axios.post(properties.bubble_webhook_url, {
                    status: "AUTH_REQUIRED",
                    auth_url: integration.redirectUrl || integration.redirectUri,
                    app_name: appName.toUpperCase(),
                    final_json: "",
                    debug_log: debugLogs.join(' | ')
                });
                return; // Arka plan işlemini sonlandır
            }
        }

        log("Tüm yetkiler tamam. LLM Döngüsü Başlatılıyor...");
        
        // -------------------------
        // BÖLÜM 2: AJAN HAZIRLIK
        // -------------------------
        let tools = [];
        if (requiredApps.size > 0) {
            if (typeof composio.getTools === "function") {
                tools = await composio.getTools({ apps: Array.from(requiredApps) });
            } else if (typeof composio.get_tools === "function") {
                tools = await composio.get_tools({ apps: Array.from(requiredApps) });
            }
        }
        
        const modelName = properties.model || "gpt-5.4";
        let messagesArray = [];
        try {
            messagesArray = typeof properties.user_content === 'string' ? JSON.parse(properties.user_content) : properties.user_content;
        } catch (e) {
            messagesArray = [
                { role: "system", content: properties.system_message || "" },
                { role: "user", content: properties.user_content || "" }
            ];
        }

        let chatParams = { model: modelName, messages: messagesArray };
        if (properties.effort) chatParams.reasoning_effort = properties.effort;
        if (tools && tools.length > 0) chatParams.tools = tools;

        // JSON Schema Check
        if (properties.json_schema) {
            try {
                const schemaObj = typeof properties.json_schema === 'string' ? JSON.parse(properties.json_schema) : properties.json_schema;
                if (properties.required_fields) schemaObj.required = properties.required_fields.split(',').map(item => item.trim());
                chatParams.response_format = { type: "json_schema", json_schema: { name: "gaia_schema", strict: false, schema: schemaObj } };
            } catch (e) { log("UYARI: json_schema hatali"); }
        }
        
        // -------------------------
        // BÖLÜM 3: LLM DÖNGÜSÜ
        // -------------------------
        let finalContent = "";
        let runCount = 0;
        const maxRuns = 15; // Node.JS olduğu için döngü sayısını esnetebiliriz!

        while (runCount < maxRuns) {
            runCount++;
            let response;
            let usedResponsesAPI = false;
            
            try {
                if (openai.responses && typeof openai.responses.create === 'function') {
                    const responsesInput = [];
                    for (const msg of chatParams.messages) {
                        if (!msg) continue;
                        const role = (msg.role || "").toLowerCase();
                        
                        if (role === "system" || role === "user" || role === "developer") {
                            responsesInput.push({
                                type: "message",
                                role: role === "system" ? "developer" : role,
                                content: msg.content !== undefined ? msg.content : (msg.text || JSON.stringify(msg))
                            });
                        } else if (role === "assistant") {
                            if (msg.tool_calls && msg.tool_calls.length > 0) {
                                for (const tc of msg.tool_calls) {
                                    responsesInput.push({
                                        type: "function_call",
                                        call_id: tc.id,
                                        name: tc.function.name,
                                        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {})
                                    });
                                }
                            }
                            if (msg.content) responsesInput.push({ type: "message", role: "assistant", content: msg.content });
                        } else if (role === "tool") {
                            responsesInput.push({
                                type: "function_call_output",
                                call_id: msg.tool_call_id,
                                output: typeof msg.content === 'object' ? JSON.stringify(msg.content) : String(msg.content)
                            });
                        } else {
                            responsesInput.push({ type: "message", role: "user", content: typeof msg === 'object' ? JSON.stringify(msg) : String(msg) });
                        }
                    }

                    let mappedTools = [];
                    if (chatParams.tools) {
                        mappedTools = chatParams.tools.map(tool => {
                            if (tool.type === "function" && tool.function) {
                                return { type: "function", name: tool.function.name, description: tool.function.description || "", parameters: tool.function.parameters || {} };
                            }
                            return tool;
                        });
                    }

                    const payload = { ...chatParams, input: responsesInput };
                    if (mappedTools.length > 0) payload.tools = mappedTools;
                    delete payload.messages; 
                    
                    response = await openai.responses.create(payload);
                    usedResponsesAPI = true;
                    log(`Responses API kullanıldı (Döngü: ${runCount}).`);
                } else if (openai.chat && typeof openai.chat.completions.create === 'function') {
                    response = await openai.chat.completions.create(chatParams);
                } else {
                    throw new Error("OpenAI kütüphanesi uyumsuz.");
                }
            } catch(e) {
                throw new Error("API Çağrısı Başarısız: " + e.message);
            }
            
            let toolCalls = [];
            let assistantContent = "";

            if (usedResponsesAPI) {
                if (response.output && Array.isArray(response.output)) {
                    for (const item of response.output) {
                        if (item.type === "function_call" || item.type === "function") {
                            const funcName = item.name || (item.function && item.function.name);
                            toolCalls.push({
                                id: item.id || item.call_id || "call_" + Math.random().toString(36).substr(2, 9),
                                type: "function",
                                function: { name: funcName, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) }
                            });
                        } else if (item.type === "text" || item.type === "output_text" || item.type === "message") {
                            assistantContent += (item.text || item.output_text || item.content) + "\n";
                        }
                    }
                } 
                else if (response.choices && response.choices[0] && response.choices[0].message) {
                    toolCalls = response.choices[0].message.tool_calls || [];
                    assistantContent = response.choices[0].message.content || "";
                } else {
                    assistantContent = response.output_text || response.content || "";
                }
            } else {
                toolCalls = response.choices[0].message.tool_calls || [];
                assistantContent = response.choices[0].message.content || "";
            }
            
            // Tool çağrısı kurgusu
            if (toolCalls && toolCalls.length > 0) {
                chatParams.messages.push({ role: "assistant", content: assistantContent || null, tool_calls: toolCalls });
                
                for (const toolCall of toolCalls) {
                    log(`>>> LLM Tool Çağırdı: ${toolCall.function.name}`);
                    let res = "";
                    try {
                        if (typeof composio.handleToolCall === "function") {
                            res = await composio.handleToolCall(toolCall, properties.user_id);
                        } else if (typeof composio.handle_tool_call === "function") {
                            res = await composio.handle_tool_call(toolCall, properties.user_id);
                        } else { res = "Hata: handleToolCall bulunamadi."; }
                    } catch(err) { res = "Hata oluştu: " + err.message; }
                    
                    const resStr = typeof res === 'object' ? JSON.stringify(res) : String(res);
                    log(`<<< Tool Sonucu: ` + resStr.substring(0, 150));
                    
                    chatParams.messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                        content: resStr
                    });
                }
            } else {
                finalContent = (assistantContent || "").trim();
                break; // Döngü bitti!
            }
        }
        
        // -------------------------
        // BÖLÜM 4: BUBBLE'A SONUCU GÖNDER
        // -------------------------
        // Tüm alanların standart olarak hep yollanması (Bubble "Detect Data" Initialize hatasız eşleşsin diye)
        const successPayload = {
            status: "SUCCESS",
            final_json: finalContent || "",
            error_message: "",
            auth_url: "",
            app_name: "",
            debug_log: debugLogs.join(' | ')
        };
        
        await axios.post(properties.bubble_webhook_url, successPayload);
        log("Başarı: Bubble webhook'una data postlandı.");

    } catch (err) {
        log("HATA: " + err.message);
        // Hata durumunda dahi Bubble'a tıpatıp aynı formattaki objeyi atıyoruz (Crash önlemi)
        if (properties.bubble_webhook_url) {
            const errorPayload = {
                status: "ERROR",
                final_json: "",
                error_message: err.message || "Unknown error",
                auth_url: "",
                app_name: "",
                debug_log: debugLogs.join(' | ')
            };
            await axios.post(properties.bubble_webhook_url, errorPayload).catch(e => console.log("Webhook ulaşılamadı."));
        }
    }
});

// Sunucuyu Başlat
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Ajan sunucusu ${PORT} portunda dinleniyor...`);
});
