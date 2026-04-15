const express = require("express");
const { OpenAI } = require("openai");
const composioLib = require("composio-core");
const axios = require("axios");
// ─────────────────────────────────────────────────────────────────────────────
// GAIA NATIVE TOOLS (inline)
// ─────────────────────────────────────────────────────────────────────────────

function _getNativeVersionPath(properties) {
    const v = (properties.app_version || "").trim();
    return v ? `${v}/` : "";
}

const NATIVE_TOOL_DEFINITIONS = [
    {
        type: "function",
        function: {
            name: "GAIA_LIST_FIELDS",
            description: "Bir tablonun (sheet) tüm custom field'larını listeler. GAIA_CREATE_OBJECT veya GAIA_MODIFY_OBJECT çağrısından önce hangi field'ların mevcut olduğunu öğrenmek için kullan.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: { type: "string", description: "Organizasyonun benzersiz ID'si" },
                    sheet: { type: "string", description: "Field listesi alınacak tablo adı" }
                },
                required: ["organisation_id", "sheet"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "GAIA_SEARCH_OBJECT",
            description: "Gaia'da belirtilen tabloda kayıt arar. Eğer unique_id biliniyorsa sadece onunla sorgula. Metin alanları 'key':'value', sayısal alanlar 'key':value formatında jsonarray constraint kullanır.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: { type: "string" },
                    sheet: { type: "string" },
                    unique_id: { type: "string", description: "Bubble _id. Biliniyorsa sadece bu yeterli." },
                    referencevalue: { type: "string" },
                    search_fields: { type: "object", additionalProperties: true },
                    cursor: { type: "number" },
                    limit: { type: "number" }
                },
                required: ["organisation_id", "sheet"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "GAIA_CREATE_OBJECT",
            description: "Gaia'da belirtilen tabloya yeni bir kayıt oluşturur. Önce GAIA_LIST_FIELDS ile field'ları öğren.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: { type: "string" },
                    sheet: { type: "string" },
                    referencevalue: { type: "string" },
                    action: { type: "string" },
                    fields: { type: "object", additionalProperties: true }
                },
                required: ["organisation_id", "sheet", "fields"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "GAIA_MODIFY_OBJECT",
            description: "Gaia'da bir kaydı arar ve günceller. Kayıt bulunamazsa NotAvailable:true ile yeni kayıt oluşturur — asla hata döndürmez.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: { type: "string" },
                    sheet: { type: "string" },
                    fieldtosearch: { type: "string", enum: ["uniqueid", "reference"] },
                    search_value: { type: "string" },
                    action: { type: "string" },
                    fields: { type: "object", additionalProperties: true }
                },
                required: ["organisation_id", "sheet", "fieldtosearch", "search_value", "fields"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "GAIA_UPLOAD_FILE",
            description: "Gaia'da bir objenin file field'ına dosya yükler. Önce GAIA_LIST_FIELDS ile customfield_id'yi öğren.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: { type: "string" },
                    sheet: { type: "string" },
                    customfield_id: { type: "string" },
                    search_type: { type: "string" },
                    object_search_value: { type: "string" },
                    filename: { type: "string" },
                    content: { type: "string" },
                    private: { type: "boolean" }
                },
                required: ["organisation_id", "customfield_id", "search_type", "object_search_value", "filename", "content"]
            }
        }
    }
];

const _NATIVE_HANDLERS = {

    GAIA_LIST_FIELDS: async (args, properties) => {
        const token = properties.bubble_api_key || "";
        const vp = _getNativeVersionPath(properties);
        const res = await axios.post(
            `https://geit-prototip.bubbleapps.io/${vp}api/1.1/wf/customfield`,
            { organisation_id: args.organisation_id, sheet: args.sheet },
            { headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
        );
        return { success: true, sheet: args.sheet, fields: res.data };
    },

    GAIA_SEARCH_OBJECT: async (args, properties) => {
        const token = properties.bubble_api_key || "";
        const vp = _getNativeVersionPath(properties);
        if (args.unique_id) {
            const res = await axios.get(
                `https://gaiasphere.io/${vp}api/1.1/obj/Object/${args.unique_id}`,
                { headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
            );
            return { success: true, count: 1, remaining: 0, results: [res.data.response || res.data] };
        }
        const constraints = [
            { key: "organisation_id", constraint_type: "equals", value: args.organisation_id },
            { key: "sheet", constraint_type: "equals", value: args.sheet }
        ];
        if (args.referencevalue) constraints.push({ key: "referedeğer", constraint_type: "equals", value: args.referencevalue });
        if (args.search_fields) {
            for (const [key, value] of Object.entries(args.search_fields)) {
                constraints.push({ key: "jsonarray", constraint_type: "contains", value: typeof value === "number" ? `"${key}":${value}` : `"${key}":"${value}"` });
            }
        }
        const res = await axios.get(
            `https://gaiasphere.io/${vp}api/1.1/obj/Object`,
            { params: { constraints: JSON.stringify(constraints), cursor: args.cursor || 0, limit: Math.min(args.limit || 10, 100) }, headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
        );
        const data = res.data.response || res.data;
        return { success: true, count: data.count || 0, remaining: data.remaining || 0, results: data.results || [] };
    },

    GAIA_CREATE_OBJECT: async (args, properties) => {
        const token = properties.bubble_api_key || "";
        const vp = _getNativeVersionPath(properties);
        const keyValuePairs = Object.entries(args.fields || {}).map(([key, value]) => ({ key, value }));
        const res = await axios.post(
            `https://gaiasphere.io/${vp}api/1.1/wf/apicreateobject`,
            { sheet: args.sheet, organisation_id: args.organisation_id, action: args.action || "", referencevalue: args.referencevalue || "", keyValuePairs },
            { headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
        );
        return { success: true, result: res.data };
    },

    GAIA_MODIFY_OBJECT: async (args, properties) => {
        const token = properties.bubble_api_key || "";
        const vp = _getNativeVersionPath(properties);
        const constraints = [
            { key: "organisation_id", constraint_type: "equals", value: args.organisation_id },
            { key: "sheet", constraint_type: "equals", value: args.sheet },
            args.fieldtosearch === "uniqueid"
                ? { key: "_id", constraint_type: "equals", value: args.search_value }
                : { key: "referedeğer", constraint_type: "equals", value: args.search_value }
        ];
        let foundId = null;
        try {
            const sr = await axios.get(
                `https://gaiasphere.io/${vp}api/1.1/obj/Object`,
                { params: { constraints: JSON.stringify(constraints), cursor: 0, limit: 1 }, headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
            );
            const d = sr.data.response || sr.data;
            if ((d.results || []).length > 0) foundId = d.results[0]._id;
        } catch (e) {}
        const keyValuePairs = Object.entries(args.fields || {}).map(([key, value]) => ({ key, value }));
        if (foundId) {
            const res = await axios.post(
                `https://gaiasphere.io/${vp}api/1.1/wf/apimodifyobject`,
                { sheet: args.sheet, organisation_id: args.organisation_id, object_id: foundId, action: args.action || "", keyValuePairs },
                { headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
            );
            return { success: true, operation: "modified", object_id: foundId, result: res.data };
        } else {
            const res = await axios.post(
                `https://gaiasphere.io/${vp}api/1.1/wf/apicreateobject`,
                { sheet: args.sheet, organisation_id: args.organisation_id, action: args.action || "", referencevalue: args.fieldtosearch === "reference" ? args.search_value : "", keyValuePairs: [...keyValuePairs, { key: "NotAvailable", value: true }] },
                { headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 15000 }
            );
            return { success: true, operation: "created_not_available", note: "Kayıt bulunamadı, NotAvailable:true ile yeni kayıt oluşturuldu.", result: res.data };
        }
    },

    GAIA_UPLOAD_FILE: async (args, properties) => {
        const token = properties.bubble_api_key || "";
        const vp = _getNativeVersionPath(properties);
        const res = await axios.post(
            `https://gaiasphere.io/${vp}api/1.1/wf/uploadfile`,
            { key_file: { filename: args.filename, contents: args.content, private: args.private || false }, customfield_id: args.customfield_id, organisation_id: args.organisation_id, object_search_value: args.object_search_value, search_type: args.search_type },
            { headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${token}` }, timeout: 30000 }
        );
        return { success: true, result: res.data };
    }
};

function isNativeTool(toolName) {
    return Object.prototype.hasOwnProperty.call(_NATIVE_HANDLERS, toolName);
}

async function handleNativeTool(toolName, args, properties) {
    const handler = _NATIVE_HANDLERS[toolName];
    if (!handler) throw new Error(`Native tool bulunamadı: ${toolName}`);
    const result = await handler(args, properties);
    return typeof result === "string" ? result : JSON.stringify(result);
}

// ─── GAIA SYSTEM PROMPT BLOĞU ────────────────────────────────────────────────
// Her agent çalışmasına otomatik eklenir. Bubble'dan gelen system_message'ın sonuna eklenir.
const GAIA_SYSTEM_BLOCK = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GAIA NATIVE TOOLS — ZORUNLU KULLANIM KURALLARI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sana aşağıdaki GAIA native tool'ları verilmiştir. Bu tool'lar, Gaia platformundaki veritabanı işlemlerini (kayıt arama, oluşturma, güncelleme, dosya yükleme) gerçekleştirir.

MEVCUT GAIA NATIVE TOOL'LAR:
• GAIA_LIST_FIELDS       → Bir tablonun custom field'larını listeler. CREATE/MODIFY/UPLOAD öncesi mutlaka çağır.
• GAIA_SEARCH_OBJECT     → Tabloda kayıt arar (unique_id, referans veya jsonarray field'larıyla).
• GAIA_CREATE_OBJECT     → Tabloya yeni kayıt oluşturur.
• GAIA_MODIFY_OBJECT     → Mevcut kaydı günceller; kayıt yoksa NotAvailable:true ile oluşturur (asla hata vermez).
• GAIA_UPLOAD_FILE       → Bir objenin belirtilen file field'ına dosya yükler (obje olmadan upload yapılamaz).

⚠️  ÇIKAN OTOMASYONDAKİ ZORUNLU SON ADIM — "GAIA'YA GERİ DÖN" KURALI:
Her otomasyon akışının MUTLAKA son adımı olarak Gaia'ya veri yazılmalıdır.
- Dış servislerden (e-posta, takvim, CRM, vs.) veri çeksen bile → sonucu Gaia'ya kaydet.
- Yeni veri oluştuysa → GAIA_CREATE_OBJECT ile Gaia'ya yaz.
- Mevcut bir kayıt güncellendiyse → GAIA_MODIFY_OBJECT ile Gaia'ya yaz.
- Dosya içeren bir adım varsa → önce objeyi bul/oluştur, sonra GAIA_UPLOAD_FILE ile dosyayı o objeye yükle.
- "Gaia dışı" bir otomasyon olsa dahi → en az bir Gaia kaydı oluşturulmalı veya güncellenmelidir.
- ASLA "işlem tamamlandı, Gaia'ya yazmaya gerek yok" deme. Her çıktı Gaia'da iz bırakır.

AKIŞ ÖRNEĞİ (dosya içeren otomasyon):
1. GAIA_LIST_FIELDS → hangi field'ın file tipi olduğunu öğren
2. GAIA_SEARCH_OBJECT → ilgili obje var mı kontrol et
3. Yoksa → GAIA_CREATE_OBJECT ile oluştur
4. Dış servisten dosyayı al / oluştur
5. GAIA_UPLOAD_FILE → dosyayı objenin file field'ına yükle  ← SON ADIM MUTLAKA BU

AKIŞ ÖRNEĞİ (veri toplayan otomasyon):
1. Dış servis tool'larıyla veriyi çek (e-posta oku, takvim sorgula, vs.)
2. GAIA_LIST_FIELDS → hedef tablonun field'larını öğren
3. GAIA_MODIFY_OBJECT veya GAIA_CREATE_OBJECT → veriyi Gaia'ya yaz  ← SON ADIM MUTLAKA BU

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

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

    let debugLogs = [];
    const log = (msg) => { debugLogs.push(msg); console.log(msg); };

    try {
        log("════════════════════════════════════");
        log("▶ AJAN BAŞLATILDI");
        log(`[TEMP] user_id        : ${properties.user_id}`);
        log(`[TEMP] assistant_id   : ${properties.assistant_id}`);
        log(`[TEMP] object_id      : ${properties.object_id}`);
        log(`[TEMP] model          : ${properties.model}`);
        log(`[TEMP] action_type    : ${properties.action_type}`);
        log(`[TEMP] tools_list     : ${properties.tools_list}`);
        log(`[TEMP] trigger_payload: ${properties.trigger_payload ? "VAR (" + String(properties.trigger_payload).slice(0,80) + "...)" : "YOK"}`);
        log(`[TEMP] user_content   : ${properties.user_content ? "VAR (" + String(properties.user_content).slice(0,80) + "...)" : "YOK"}`);
        log(`[TEMP] system_message : ${properties.system_message ? "VAR (" + String(properties.system_message).slice(0,80) + "...)" : "YOK"}`);
        log(`[TEMP] bubble_api_key : ${properties.bubble_api_key ? "VAR" : "YOK"}`);
        log(`[TEMP] openai_api_key : ${properties.openai_api_key ? "VAR" : "YOK"}`);
        log(`[TEMP] composio_key   : ${properties.composio_api_key ? "VAR" : "YOK"}`);
        log(`[TEMP] webhook_url    : ${properties.bubble_webhook_url}`);
        log("════════════════════════════════════");

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
        // BÖLÜM 1: AUTH KONTROLÜ (sadece MCP app varsa)
        // -------------------------
        let tools = [];
        if (requiredApps.size > 0) {
            log(`[TEMP] Composio auth kontrolü: ${Array.from(requiredApps).join(', ')}`);
            log(`[TEMP] composio obj keys: ${Object.keys(composio).join(', ')}`);
            log(`[TEMP] getEntity tipi: ${typeof composio.getEntity} | client var mı: ${!!composio.client}`);

            let entity;
            try {
                log(`[TEMP] getEntity çağrılıyor, user_id: ${properties.user_id}`);
                if (typeof composio.getEntity === "function") {
                    entity = await composio.getEntity(properties.user_id);
                } else if (composio.client && typeof composio.client.getEntity === "function") {
                    entity = await composio.client.getEntity(properties.user_id);
                } else {
                    throw new Error("getEntity fonksiyonu bulunamadı.");
                }
                log(`[TEMP] getEntity başarılı, entity keys: ${Object.keys(entity || {}).join(', ')}`);
            } catch (entityErr) {
                log(`[TEMP] HATA: getEntity başarısız: ${entityErr.message}`);
                throw entityErr;
            }

            const missingAuths = [];
            for (const appName of requiredApps) {
                try {
                    log(`[TEMP] getConnection çağrılıyor: ${appName}`);
                    await entity.getConnection({ appName: appName });
                    log(`[TEMP] getConnection başarılı: ${appName} bağlı`);
                } catch (e) {
                    log(`[TEMP] getConnection başarısız (${appName}): ${e.message} — initiateConnection deneniyor`);
                    try {
                        let integration = await entity.initiateConnection({ appName: appName, redirectUri: "https://yourdomain.com/" });
                        log(`[TEMP] initiateConnection başarılı: ${appName}, url: ${integration.redirectUrl || integration.redirectUri}`);
                        missingAuths.push({
                            app_name: appName.toUpperCase(),
                            auth_url: integration.redirectUrl || integration.redirectUri
                        });
                    } catch (initErr) {
                        log(`[TEMP] initiateConnection HATA (${appName}): ${initErr.message}`);
                    }
                }
            }

            if (missingAuths.length > 0) {
                log(`[TEMP] AUTH_REQUIRED → direkt plugin'e dönülüyor`);
                return res.json({
                    status: "AUTH_REQUIRED",
                    auth_url: missingAuths[0].auth_url,
                    app_name: missingAuths[0].app_name,
                    auth_required_list: missingAuths.map(a => a.auth_url),
                    final_json: "",
                    action_type: properties.action_type || "",
                    debug_log: debugLogs.join(' | ')
                });
            }

            log(`[TEMP] Tüm auth tamam, Composio tools çekiliyor...`);
            log(`[TEMP] getTools tipi: ${typeof composio.getTools} | get_tools tipi: ${typeof composio.get_tools}`);
            if (typeof composio.getTools === "function") {
                tools = await composio.getTools({ apps: Array.from(requiredApps) });
            } else if (typeof composio.get_tools === "function") {
                tools = await composio.get_tools({ apps: Array.from(requiredApps) });
            }
            log(`[TEMP] Composio tools yüklendi: ${tools.length} adet`);
        } else {
            log("[TEMP] MCP app yok, Composio atlanıyor.");
        }

        // Auth tamam → PROCESSING döndür, ajan arka planda devam eder
        res.json({ status: "PROCESSING", message: "Ajan başlatıldı, arka plan süreci devraldı." });
        log("▶ PROCESSING döndürüldü, LLM döngüsü başlıyor...");

        const modelName = properties.model || "gpt-5.4";

        // trigger_payload varsa agent'a inject edilecek kullanıcı mesajını hazırla
        let triggerUserMessage = null;
        const rawTriggerPayload = properties.trigger_payload;
        if (rawTriggerPayload && String(rawTriggerPayload).trim() !== "") {
            let triggerData = rawTriggerPayload;
            // JSON string ise parse edip pretty-print yapalım
            try {
                const parsed = typeof rawTriggerPayload === 'string' ? JSON.parse(rawTriggerPayload) : rawTriggerPayload;
                triggerData = JSON.stringify(parsed, null, 2);
            } catch (e) {
                triggerData = String(rawTriggerPayload);
            }
            triggerUserMessage = {
                role: "user",
                content: `[TRIGGER EVENT DATA]\nThis automation was started by an external trigger. The following data was received from the trigger event — process it according to your instructions:\n\n${triggerData}`
            };
            log("Trigger payload algılandı, agent'a inject ediliyor.");
        }

        let messagesArray = [];
        const rawUserContent = properties.user_content;
        try {
            if (!rawUserContent || String(rawUserContent).trim() === "") throw new Error("empty");
            messagesArray = typeof rawUserContent === 'string' ? JSON.parse(rawUserContent) : rawUserContent;
            if (!Array.isArray(messagesArray)) throw new Error("not array");
        } catch (e) {
            // user_content boş veya düz string → basit yapı kur
            messagesArray = [];
            if (rawUserContent && typeof rawUserContent === 'string' && !rawUserContent.trim().startsWith('[')) {
                messagesArray.push({ role: "user", content: rawUserContent });
            }
        }

        // System mesajı yoksa başa ekle
        if (!messagesArray.some(m => m.role === 'system')) {
            messagesArray.unshift({ role: "system", content: properties.system_message || "" });
        }

        // Trigger payload varsa system'den hemen sonraya ekle
        if (triggerUserMessage) {
            const sysIdx = messagesArray.findIndex(m => m.role === 'system');
            messagesArray.splice(sysIdx + 1, 0, triggerUserMessage);
        }

        // Hiç user mesajı yoksa (ne user_content ne trigger) boş bir mesaj ekle — OpenAI hata vermesin
        if (!messagesArray.some(m => m.role === 'user')) {
            messagesArray.push({ role: "user", content: "Görevi talimatlarına göre gerçekleştir." });
        }

        log(`[TEMP] Mesaj dizisi hazır: ${messagesArray.length} mesaj (${messagesArray.map(m=>m.role).join(', ')})`);

        let chatParams = { model: modelName, messages: messagesArray };
        // Responses API: reasoning.effort | Chat Completions API: reasoning_effort
        if (properties.effort) {
            chatParams.reasoning_effort = properties.effort;   // Chat Completions fallback
            chatParams.reasoning = { effort: properties.effort }; // Responses API
        }

        // Native tool tanımlarını composio tools'a ekle
        tools = [...(tools || []), ...NATIVE_TOOL_DEFINITIONS];
        log(`[TEMP] Toplam tool sayısı: ${tools.length} (${tools.map(t=>t.function?.name||t.name).join(', ')})`);

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
        
        // JSON Schema - response_format üzerinden enforce et, system message'a dokunma
        if (properties.json_schema && String(properties.json_schema).trim() !== "") {
            let schemaStr = typeof properties.json_schema === 'string' ? properties.json_schema.trim() : JSON.stringify(properties.json_schema);
            if (!schemaStr.startsWith("{") && !schemaStr.startsWith("[")) {
                schemaStr = `{\n${schemaStr}\n}`;
            }
            // Unescaped newline/CR karakterleri JSON.parse'ı kırıyor, temizle
            schemaStr = schemaStr.replace(/[\r\n]+/g, ' ');

            let schemaObj = null;
            try { schemaObj = JSON.parse(schemaStr); } catch(e) { log("UYARI: json_schema parse edilemedi, json_object moduna düşüldü. Hata: " + e.message); }

            if (schemaObj) {
                chatParams.response_format = {
                    type: "json_schema",
                    json_schema: {
                        name: properties.schema_name || "response",
                        strict: false,
                        schema: {
                            type: "object",
                            properties: schemaObj
                        }
                    }
                };
            } else {
                // Fallback: json_object - Responses API "json" kelimesini mesajda zorunlu kılıyor
                chatParams.response_format = { type: "json_object" };
                if (chatParams.messages.length > 0 && chatParams.messages[0].role === "system") {
                    chatParams.messages[0].content += "\n\nRespond using JSON format only.";
                }
            }
        }
        
        // -------------------------
        // BÖLÜM 3: LLM DÖNGÜSÜ
        // -------------------------
        let finalContent = "";
        let runCount = 0;
        const maxRuns = 15; // Node.JS olduğu için döngü sayısını esnetebiliriz!

        log("════════════════════════════════════");
        log("▶ LLM DÖNGÜSÜ BAŞLIYOR");
        log(`[TEMP] model: ${modelName} | maxRuns: ${maxRuns}`);
        log(`[TEMP] İlk prompt (ilk 500 char): ${JSON.stringify(chatParams.messages).substring(0, 500)}`);
        log("════════════════════════════════════");

        while (runCount < maxRuns) {
            runCount++;
            log(`[TEMP] ── Döngü #${runCount} başladı ──`);
            let response;
            let usedResponsesAPI = false;

            try {
                log(`[TEMP] OpenAI API çağrısı yapılıyor... (responses API: ${!!(openai.responses && typeof openai.responses.create === 'function')})`);
                if (openai.responses && typeof openai.responses.create === 'function') {
                    // input_image/input_text gibi content part'ları tek bir user message altında grupla
                    const groupedMessages = [];
                    let pendingParts = [];
                    for (const msg of chatParams.messages) {
                        if (!msg) continue;
                        if (msg.type && msg.type.startsWith("input_")) {
                            pendingParts.push(msg);
                        } else {
                            if (pendingParts.length > 0) {
                                groupedMessages.push({ role: "user", content: pendingParts });
                                pendingParts = [];
                            }
                            groupedMessages.push(msg);
                        }
                    }
                    if (pendingParts.length > 0) {
                        groupedMessages.push({ role: "user", content: pendingParts });
                    }

                    const responsesInput = [];
                    for (const msg of groupedMessages) {
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
                    // Chat Completions'da json_schema, { type, json_schema: { name, strict, schema } } formatindayken
                    // Responses API bunu flatten bekler: { type, name, strict, schema }
                    if (payload.response_format) {
                        payload.text = payload.text || {};
                        const rf = payload.response_format;
                        if (rf.type === "json_schema" && rf.json_schema) {
                            payload.text.format = {
                                type: "json_schema",
                                name: rf.json_schema.name,
                                strict: rf.json_schema.strict,
                                schema: rf.json_schema.schema
                            };
                        } else {
                            payload.text.format = rf;
                        }
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
                log(`[TEMP] OpenAI API HATA (#${runCount}): ${e.message}`);
                throw new Error("API Çağrısı Başarısız: " + e.message);
            }
            log(`[TEMP] OpenAI yanıtı alındı (#${runCount}), usedResponsesAPI: ${usedResponsesAPI}`);
            
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
            
            log(`[TEMP] assistantContent (ilk 200): ${assistantContent.substring(0, 200)}`);
            log(`[TEMP] toolCalls sayısı: ${toolCalls.length}${toolCalls.length > 0 ? ' → ' + toolCalls.map(t => t.function?.name).join(', ') : ''}`);
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

                        log(`[TEMP] Tool çağrısı: ${toolCall.function.name} | args: ${String(toolCall.function.arguments).slice(0,150)}`);
                        if (isNativeTool(toolCall.function.name)) {
                            // ── NATIVE TOOL ──────────────────────────────────
                            log(`[NATIVE] ${toolCall.function.name} çalıştırılıyor`);
                            let toolArgs = {};
                            try { toolArgs = JSON.parse(toolCall.function.arguments); } catch(e) {}
                            res = await handleNativeTool(toolCall.function.name, toolArgs, properties);
                            log(`[TEMP] Native tool sonucu: ${String(res).slice(0,150)}`);
                        } else {
                            // ── COMPOSIO TOOL ────────────────────────────────
                            log(`[TEMP] Composio tool çağrılıyor: ${toolCall.function.name}`);
                            if (typeof composio.handleToolCall === "function") {
                                callOutput = await composio.handleToolCall(simulatedResponse, properties.user_id);
                            } else if (typeof composio.handle_tool_call === "function") {
                                callOutput = await composio.handle_tool_call(simulatedResponse, properties.user_id);
                            } else {
                                throw new Error("handleToolCall bulunamadi.");
                            }
                            if (Array.isArray(callOutput) && callOutput.length > 0) {
                                res = callOutput[0].content || JSON.stringify(callOutput[0]);
                            } else {
                                res = JSON.stringify(callOutput);
                            }
                            log(`[TEMP] Composio tool sonucu: ${String(res).slice(0,150)}`);
                        }

                    } catch(err) {
                        log(`[TEMP] Tool HATA (${toolCall.function.name}): ${err.message}`);
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
            action_type: properties.action_type || "",
            user_id: properties.user_id || "",
            assistant_id: properties.assistant_id || "",
            screen_id: properties.screen_id || "",
            stage_start_time: properties.stage_start_time || "",
            object_id: properties.object_id || "",
            debug_log: debugLogs.join(' | ')
        };
        
        log("════════════════════════════════════");
        log("▶ BUBBLE WEBHOOK GÖNDERILIYOR");
        log(`[TEMP] Webhook URL: ${properties.bubble_webhook_url}`);
        log(`[TEMP] final_json (ilk 200): ${String(successPayload.final_json || "").slice(0,200)}`);
        log(`[TEMP] status: ${successPayload.status}`);
        const webhookRes = await axios.post(properties.bubble_webhook_url, successPayload);
        log(`▶ WEBHOOK TAMAM — HTTP: ${webhookRes.status}`);
        log("════════════════════════════════════");

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
                action_type: properties.action_type || "",
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

// -------------------------
// /initialize - Auth Kontrolü (Agent çalıştırmadan)
// -------------------------
app.post("/initialize", async (req, res) => {
    const properties = req.body;

    const SECURE_API_KEY = process.env.ADMIN_API_KEY || "gaia_secure_render_key_2026";
    if (!properties.admin_api_key || properties.admin_api_key !== SECURE_API_KEY) {
        return res.status(401).json({ status: "UNAUTHORIZED", message: "Geçersiz veya eksik Admin API Key!" });
    }

    try {
        let composio;
        if (typeof composioLib.OpenAIToolSet === "function") {
            composio = new composioLib.OpenAIToolSet({ apiKey: properties.composio_api_key, entityId: properties.user_id });
        } else if (typeof composioLib.ComposioToolSet === "function") {
            composio = new composioLib.ComposioToolSet({ apiKey: properties.composio_api_key, entityId: properties.user_id });
        } else {
            composio = new composioLib.Composio({ apiKey: properties.composio_api_key });
        }

        // Hangi app'lerin gerektiğini tools_list'ten çıkar
        let requestedToolsList = [];
        const rawTools = properties.tools_list;
        if (rawTools && rawTools.length > 5) {
            try {
                const parsedArray = typeof rawTools === 'string' ? JSON.parse(rawTools) : rawTools;
                requestedToolsList = parsedArray.map(t => typeof t === 'object' ? t.type : t);
            } catch(e) {}
        }
        const requiredApps = new Set();
        requestedToolsList.forEach(tool => {
            if (tool && tool.includes("mcp_")) requiredApps.add(tool.split("mcp_")[1].toLowerCase());
        });

        let entity;
        if (typeof composio.getEntity === "function") {
            entity = await composio.getEntity(properties.user_id);
        } else if (composio.client && typeof composio.client.getEntity === "function") {
            entity = await composio.client.getEntity(properties.user_id);
        } else {
            return res.status(500).json({ status: "ERROR", message: "getEntity bulunamadı." });
        }

        // Tüm app'lerin auth durumunu kontrol et
        const missingAuths = [];
        for (const appName of requiredApps) {
            try {
                await entity.getConnection({ appName: appName });
            } catch (e) {
                try {
                    let integration = await entity.initiateConnection({ appName: appName, redirectUri: "https://yourdomain.com/" });
                    missingAuths.push({
                        app_name: appName.toUpperCase(),
                        auth_url: integration.redirectUrl || integration.redirectUri
                    });
                } catch (initErr) {
                    missingAuths.push({ app_name: appName.toUpperCase(), auth_url: "" });
                }
            }
        }

        // json_schema'dan tüm key'leri boş değerlerle final_json listesi oluştur
        let initFinalJson = [];
        if (properties.json_schema && String(properties.json_schema).trim() !== "") {
            try {
                let schemaStr = typeof properties.json_schema === 'string' ? properties.json_schema.trim() : JSON.stringify(properties.json_schema);
                if (!schemaStr.startsWith("{") && !schemaStr.startsWith("[")) schemaStr = `{\n${schemaStr}\n}`;
                schemaStr = schemaStr.replace(/[\r\n]+/g, ' ');
                const schemaObj = JSON.parse(schemaStr);
                for (const key of Object.keys(schemaObj)) {
                    initFinalJson.push(`"${key}":""`);
                }
            } catch(e) {}
        }

        // Bubble webhook'una boş ama tam formatlı payload gönder (field type initialization için)
        if (properties.bubble_webhook_url) {
            const initPayload = {
                status: "INIT",
                final_json: initFinalJson,
                predicted_action: "",
                photopayload: "",
                error_message: "",
                auth_url: missingAuths.length > 0 ? missingAuths[0].auth_url : "",
                app_name: missingAuths.length > 0 ? missingAuths[0].app_name : "",
                auth_required_list: missingAuths.map(a => a.auth_url),
                action_type: properties.action_type || "",
                user_id: properties.user_id || "",
                assistant_id: properties.assistant_id || "",
                screen_id: properties.screen_id || "",
                stage_start_time: properties.stage_start_time || "",
                object_id: properties.object_id || "",
                debug_log: "INIT"
            };
            await axios.post(properties.bubble_webhook_url, initPayload).catch(e => {});
        }

        if (missingAuths.length > 0) {
            return res.json({
                status: "AUTH_REQUIRED",
                auth_required_list: missingAuths,
                auth_required_text: missingAuths.map(a => a.auth_url).join("\n"),
                app_names: missingAuths.map(a => a.app_name).join(", "),
                first_auth_url: missingAuths[0].auth_url,
                first_app_name: missingAuths[0].app_name
            });
        }

        return res.json({
            status: "OK",
            message: "Tüm yetkiler mevcut, agent çalıştırılabilir.",
            auth_required_list: [],
            auth_required_text: "",
            app_names: "",
            first_auth_url: "",
            first_app_name: ""
        });

    } catch (err) {
        return res.status(500).json({ status: "ERROR", message: err.message });
    }
});

// -------------------------
// /manage-triggers - Trigger Yönetimi (UI'dan gelen yapılandırma istekleri için)
// -------------------------
app.post("/manage-triggers", async (req, res) => {
    const properties = req.body;

    const SECURE_API_KEY = process.env.ADMIN_API_KEY || "gaia_secure_render_key_2026";
    if (!properties.admin_api_key || properties.admin_api_key !== SECURE_API_KEY) {
        return res.status(401).json({ status: "UNAUTHORIZED", message: "Geçersiz veya eksik Admin API Key!" });
    }

    try {
        // Bubble'dan gelecek parametreler
        const { action_type, trigger_slug, trigger_instance_id, trigger_config, composio_api_key, connected_account_id, user_id } = properties;

        if (!composio_api_key) {
            return res.status(400).json({ status: "ERROR", message: "Composio API Key eksik" });
        }

        const baseURL = "https://backend.composio.dev/api/v3/trigger_instances";
        const headers = {
            "x-api-key": composio_api_key,
            "Content-Type": "application/json"
        };
        
        let axiosResponse;

        // action_type değerine göre (create, list, enable, disable, delete) Composio API tetiklenir
        switch (action_type) {
            case "create":
            case "upsert":
                // Yeni bir tetikleyici oluştur
                let parsedConfig = {};
                try {
                    parsedConfig = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : (trigger_config || {});
                } catch(e) { /* ignore parse error or fallback to string */ }
                
                axiosResponse = await axios.post(`${baseURL}/${trigger_slug}/upsert`, {
                    connected_account_id: connected_account_id,
                    trigger_config: parsedConfig
                }, { headers });
                break;
                
            case "list":
                // Aktif tetikleyicileri listele
                let listUrl = `${baseURL}/active?`;
                if (connected_account_id) listUrl += `connected_account_id=${connected_account_id}&`;
                if (user_id) listUrl += `user_id=${user_id}&entity_id=${user_id}`; // Her iki olası ismi de ekliyoruz
                
                axiosResponse = await axios.get(listUrl, { headers });

                // GÜVENLİK FİLTRESİ: Gelen listede herkesin trigger'ı varsa, sadece bu user_id'ye ait olanları döndür.
                if (user_id && axiosResponse.data && Array.isArray(axiosResponse.data.items)) {
                    axiosResponse.data.items = axiosResponse.data.items.filter(t => t.user_id === user_id || t.entity_id === user_id);
                }
                break;
                
            case "enable":
                // Tetikleyiciyi aktifleştir
                axiosResponse = await axios.patch(`${baseURL}/manage/${trigger_instance_id}`, { status: "ENABLED" }, { headers });
                break;
                
            case "disable":
                // Tetikleyiciyi devre dışı bırak
                axiosResponse = await axios.patch(`${baseURL}/manage/${trigger_instance_id}`, { status: "DISABLED" }, { headers });
                break;
                
            case "delete":
                // Tetikleyiciyi tamamen sil
                axiosResponse = await axios.delete(`${baseURL}/manage/${trigger_instance_id}`, { headers });
                break;
                
            default:
                return res.status(400).json({ status: "ERROR", message: "Geçersiz action_type. Kullanılabilecekler: create, list, enable, disable, delete" });
        }

        // Başarılı yanıt
        return res.json({
            status: "SUCCESS",
            action: action_type,
            data: axiosResponse.data
        });

    } catch (err) {
        console.error("Trigger Yönetimi Hatası:", err?.response?.data || err.message);
        const errorMsg = err.response && err.response.data && err.response.data.message ? err.response.data.message : err.message;
        return res.status(500).json({ 
            status: "ERROR", 
            message: errorMsg,
            details: err.response?.data
        });
    }
});

// Sunucuyu Başlat
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Ajan sunucusu ${PORT} portunda dinleniyor...`);
});
