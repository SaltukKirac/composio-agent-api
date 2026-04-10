const express = require("express");
const { OpenAI } = require("openai");
const composioLib = require("composio-core");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post("/run-agent", async (req, res) => {
    // Bubble'dan Gelen Parametreler
    const properties = req.body;
    
    // GÜVENLİK: Sadece yetkili (Admin API Key'i eşleşen) istekleri kabul et
    const SECURE_API_KEY = process.env.ADMIN_API_KEY || "gaia_secure_render_key_2026"; // Bunu dilerseniz kendi özel anahtarınızla değiştirin
    if (!properties.admin_api_key || properties.admin_api_key !== SECURE_API_KEY) {
        return res.status(401).json({ status: "UNAUTHORIZED", message: "Geçersiz veya eksik Admin API Key!" });
    }

    // Kurallar: Vercel gibi Serverless ortamlar "res.json()" komutu verildiği an işlemi keser.
    // Bu kod eğer Render, Railway veya kalıcı bir VPS Node.js üzerinde çalıştırılırsa,
    // res.json() sonrası bile işlem arka planda saatlerce güvenle devam eder.
    res.json({ status: "PROCESSING", message: "Ajan başlatıldı, arka plan süreci devraldı." });
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
            // Eger JSON icinden gelse bile en basta bir 'system' mesaji yoksa (SADECE input_text arrayi ise), system_message'i ekle gitsin!
            if (!messagesArray.some(m => m.role === 'system')) {
                messagesArray.unshift({ role: "system", content: properties.system_message || "" });
            }
        } catch (e) {
            messagesArray = [
                { role: "system", content: properties.system_message || "" },
                { role: "user", content: properties.user_content || "" }
            ];
        }

        let chatParams = { model: modelName, messages: messagesArray };
        if (properties.effort) chatParams.reasoning_effort = properties.effort;
        
        // Araçları payload'a ekle!
        if (tools && tools.length > 0) {
            chatParams.tools = tools;
        }

        // --- ZORUNLU TOOL SEÇİMİ (TOOL CHOICE) ---
        // Sadece tools dizisinde gerçekten araç varsa 'required' zorunluluğunu gönder,
        // aksi takdirde OpenAI 'tools yok ama required demişsin' diye 400 hatası verir!
        if (properties.tool_choice && chatParams.tools && chatParams.tools.length > 0) {
            const tChoice = properties.tool_choice.trim();
            if (tChoice.toLowerCase() === "required" || tChoice.toLowerCase() === "auto" || tChoice.toLowerCase() === "none") {
                chatParams.tool_choice = tChoice.toLowerCase();
            } else if (tChoice !== "") {
                chatParams.tool_choice = { type: "function", function: { name: tChoice } };
            }
        }
        
        // JSON Schema Check - Obje Üretip Kodla Diziye Çevirme (En Stabil Yol)
        if (properties.json_schema && String(properties.json_schema).trim() !== "") {
            chatParams.response_format = { type: "json_object" };
            
            let schemaStr = typeof properties.json_schema === 'string' ? properties.json_schema.trim() : JSON.stringify(properties.json_schema);
            if (!schemaStr.startsWith("{") && !schemaStr.startsWith("[")) {
                schemaStr = `{\n${schemaStr}\n}`;
            }

            const schemaInst = "\n\nCRITICAL KURAL: Eğer mesajda veya talimatta bir işlem (örneğin mail at, oluştur vs) isteniyorsa, ÖNCE GEREKLİ MCP ARAÇLARINI (Tools) KULLAN. İşi gerçekte yapıp tamamlamadan sakın cevap verme!\nARAÇLARI KULLANIP İŞİ BİTİRDİKTEN SONRA nihai sonucunu SADECE saf bir DÜZ JSON OBJESİ ({}) formatında ver. Aşağıdaki yapıya birebir uy. Asla array dönme, düz obje dön:\n" + schemaStr;
            
            if (chatParams.messages.length > 0 && chatParams.messages[0].role === "system") {
                chatParams.messages[0].content += schemaInst;
            } else {
                chatParams.messages.unshift({ role: "system", content: schemaInst });
            }
        }
        
        // -------------------------
        // BÖLÜM 3: LLM DÖNGÜSÜ
        // -------------------------
        let finalContent = "";
        let runCount = 0;
        const maxRuns = 15; // Node.JS olduğu için döngü sayısını esnetebiliriz!

        log("--- Ajanın Beynine Giden İlk Prompt ---");
        log(JSON.stringify(chatParams.messages).substring(0, 400));

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

                    // OpenAI Responses API Güncellemesi: 'response_format' artik 'text.format' altina tasinmistir!
                    if (payload.response_format) {
                        payload.text = payload.text || {};
                        payload.text.format = payload.response_format;
                        delete payload.response_format;
                    }
                    
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
                            let textContent = item.text || item.output_text || item.content || "";
                            if (Array.isArray(textContent)) {
                                textContent = textContent.map(i => i.text || i.content || JSON.stringify(i)).join("\n");
                            } else if (typeof textContent === 'object' && textContent.text) {
                                textContent = textContent.text;
                            } else if (typeof textContent === 'object' && textContent.content) {
                                textContent = textContent.content;
                            }
                            assistantContent += (typeof textContent === 'object' ? JSON.stringify(textContent) : String(textContent)) + "\n";
                        }
                    }
                } 
                else if (response.choices && response.choices[0] && response.choices[0].message) {
                    toolCalls = response.choices[0].message.tool_calls || [];
                    let chatMsgContent = response.choices[0].message.content || "";
                    if (Array.isArray(chatMsgContent)) chatMsgContent = chatMsgContent.map(i => i.text || JSON.stringify(i)).join("\n");
                    assistantContent = typeof chatMsgContent === 'object' ? JSON.stringify(chatMsgContent) : chatMsgContent;
                } else {
                    let fallBackContent = response.output_text || response.content || "";
                    if (Array.isArray(fallBackContent)) fallBackContent = fallBackContent.map(i => i.text || JSON.stringify(i)).join("\n");
                    assistantContent = typeof fallBackContent === 'object' ? JSON.stringify(fallBackContent) : fallBackContent;
                }
            } else {
                toolCalls = response.choices[0].message.tool_calls || [];
                let chatMsgContent = response.choices[0].message.content || "";
                if (Array.isArray(chatMsgContent)) chatMsgContent = chatMsgContent.map(i => i.text || JSON.stringify(i)).join("\n");
                assistantContent = typeof chatMsgContent === 'object' ? JSON.stringify(chatMsgContent) : chatMsgContent;
            }
            
            log(`[ROBOTUN BU DÖNGÜDEKİ CEVABI]: ${assistantContent.substring(0, 200)}... (Tool İsteği Var Mı: ${toolCalls.length > 0})`);

            
            // Tool çağrısı kurgusu
            if (toolCalls && toolCalls.length > 0) {
                // OpenAI'ın sonsuz döngüye girmemesi için zorunlu tool çağrısını iptal et (artık görevi yaptı)
                if (chatParams.tool_choice === "required") {
                    delete chatParams.tool_choice;
                }
                chatParams.messages.push({ role: "assistant", content: assistantContent || null, tool_calls: toolCalls });
                
                for (const toolCall of toolCalls) {
                    log(`>>> LLM Tool Çağırdı: ${toolCall.function.name}`);
                    let res = "";
                    try {
                        // MİMARİ ÇÖZÜM: LLM'in zorunlu sanıp boş string ("" veya [""]) olarak gönderdiği parametreleri temizleme.
                        // Bu eklenti sayesinde Composio'nun olmayan dosya eklerini Node.JS fs ile okumaya çalışıp crash olmasını engelliyoruz.
                        try {
                            let argsObj = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;
                            let modified = false;
                            for (let key in argsObj) {
                                if (argsObj[key] === "" || (Array.isArray(argsObj[key]) && argsObj[key].length === 1 && argsObj[key][0] === "")) {
                                    delete argsObj[key];
                                    modified = true;
                                }
                            }
                            if (modified) {
                                toolCall.function.arguments = JSON.stringify(argsObj);
                            }
                        } catch (e) { /* JSON Parse hatasını yut */ }

                        // Composio 0.5.x SDK'sı, çıplak bir Tool nesnesi yerine 
                        // komple bir OpenAI chatCompletion objesi beklemesi hatası ('choices is not iterable') çözümü:
                        const simulatedResponse = {
                            choices: [{
                                message: { role: "assistant", content: null, tool_calls: [toolCall] }
                            }]
                        };

                        let callOutput;
                        if (typeof composio.handleToolCall === "function") {
                            callOutput = await composio.handleToolCall(simulatedResponse, properties.user_id);
                        } else if (typeof composio.handle_tool_call === "function") {
                            callOutput = await composio.handle_tool_call(simulatedResponse, properties.user_id);
                        } else { 
                            throw new Error("handleToolCall bulunamadi."); 
                        }

                        // Composio geriye genellikle [{role: "tool", content: "..."}] dizisi döner.
                        if (Array.isArray(callOutput) && callOutput.length > 0) {
                            res = callOutput[0].content || JSON.stringify(callOutput[0]);
                        } else {
                            res = JSON.stringify(callOutput);
                        }

                    } catch(err) { 
                        res = "Hata oluştu: " + err.message; 
                    }
                    
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
        
        let parsedFinalObject = finalContent || "";
        let predictedActionObj = null;
        let generatedPhotosArray = [];
        
        // --- PHOTO PAYLOAD (AI IMAGE DETECTION) ---
        // Eğer LLM bir tool kullandıysa ve bu tool (örn. image_generate) resim URL'si VEYA Base64 text döndürdüyse:
        try {
            for (const msg of chatParams.messages) {
                if (msg.role === "tool" && msg.content) {
                    
                    // 1) RAW BASE64 KONTROLÜ (Veri zaten base64 gelmişse)
                    // Örn: "base64": "iVBO...", veya "data:image/png;base64,iVBOR..."
                    const base64Match = msg.content.match(/(?:base64["']?\s*:\s*["']|data:image\/[a-zA-Z]+;base64,)([^"'\\]{100,})/i);
                    if (base64Match && base64Match[1]) {
                        log(`[AI-IMG] Doğrudan Base64 verisi yakalandı!`);
                        generatedPhotosArray.push({
                            customFieldName: "ai_generated_image", 
                            base64: base64Match[1]
                        });
                        continue; // Resmi bulduk, diğer URL taramasına geçmeye gerek yok.
                    }

                    // 2) URL KONTROLÜ (Eğer base64 yoksa url var mı?)
                    const urlMatch = msg.content.match(/https?:\/\/[^\s"'<>]+/g);
                    if (urlMatch) {
                        for (const url of urlMatch) {
                            if (url.includes("image") || url.includes("dalle") || url.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
                                log(`[AI-IMG] Resim URL bulundu, indiriliyor: ${url.substring(0, 50)}...`);
                                try {
                                    const imgRes = await axios.get(url, { responseType: 'arraybuffer' });
                                    const b64 = Buffer.from(imgRes.data, 'binary').toString('base64');
                                    generatedPhotosArray.push({
                                        customFieldName: "ai_generated_image", 
                                        base64: b64
                                    });
                                } catch (e) {
                                    log(`[AI-IMGHATA] Resim URL den indirilemedi: ${e.message}`);
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) { log("Photo extraction error: " + e); }

        try {
            // GPT'den dönen temiz JSON Objesini yakalama ve listeye çevirme:
            let tempJSON = JSON.parse(parsedFinalObject);
            
            if (typeof tempJSON === 'object' && !Array.isArray(tempJSON)) {
                
                let mappedList = [];
                for (let key in tempJSON) {
                    if (key.trim().toLowerCase() === "predictedaction") {
                        predictedActionObj = tempJSON[key];
                        continue;
                    }
                    let val = tempJSON[key];
                    if (val === null || val === undefined) val = ""; 
                    // İstenen o "key":"value" (tam stringleşmiş) şeklini kuruyoruz:
                    let valStr = typeof val === 'object' ? JSON.stringify(val) : JSON.stringify(val);
                    mappedList.push(`"${key}":${valStr}`);
                }
                parsedFinalObject = mappedList; // Native dizi (List of Texts)
            } else if (Array.isArray(tempJSON)) {
                parsedFinalObject = tempJSON;
            }
        } catch (e) {
            // Düz metinse string olarak kalır.
        }

        // Tüm alanların standart olarak hep yollanması (Yeni Parametrelerle Birlikte)
        const successPayload = {
            status: "SUCCESS",
            final_json: parsedFinalObject,
            predicted_action: predictedActionObj ? JSON.stringify(predictedActionObj) : "",
            photopayload: generatedPhotosArray.length > 0 ? JSON.stringify(generatedPhotosArray) : "",
            error_message: "",
            auth_url: "",
            app_name: "",
            user_id: properties.user_id || "", 
            assistant_id: properties.assistant_id || "",
            screen_id: properties.screen_id || "",
            stage_start_time: properties.stage_start_time || "",
            object_id: properties.object_id || "",
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
                predicted_action: "",
                photopayload: "",
                error_message: err.message || "Unknown error",
                auth_url: "",
                app_name: "",
                user_id: properties.user_id || "", 
                assistant_id: properties.assistant_id || "",
                screen_id: properties.screen_id || "",
                stage_start_time: properties.stage_start_time || "",
                object_id: properties.object_id || "",
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
