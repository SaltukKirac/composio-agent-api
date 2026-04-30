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
    // GAIA_UPLOAD_FILE kaldırıldı — Gaia görev bazlı sistemde file çıktısı olan her görevin
    // o file tipi custom field'ı zaten tanımlıdır. File/image çıktısı photopayload (filepayload)
    // mekanizmasıyla form elementine gelir, form onu ilgili field'a uygular. Ayrı upload tool'una gerek yok.
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

    // GAIA_UPLOAD_FILE handler kaldırıldı — bkz. NATIVE_TOOL_DEFINITIONS açıklaması
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
• GAIA_LIST_FIELDS       → Bir tablonun custom field'larını listeler. CREATE/MODIFY öncesi mutlaka çağır.
• GAIA_SEARCH_OBJECT     → Tabloda kayıt arar (unique_id, referans veya jsonarray field'larıyla).
• GAIA_CREATE_OBJECT     → Tabloya yeni kayıt oluşturur.
• GAIA_MODIFY_OBJECT     → Mevcut kaydı günceller; kayıt yoksa NotAvailable:true ile oluşturur (asla hata vermez).

⚠️  DOSYA / GÖRSEL ÇIKTISI HAKKINDA:
Görev bir dosya veya görsel üretiyorsa (PDF, image, vb.), bu çıktıyı JSON field'ı olarak döndür.
File/image içerikli field'lar sistem tarafından otomatik yüklenir — ayrıca upload tool çağrısı yapma.

⚠️  ÇIKAN OTOMASYONDAKİ ZORUNLU SON ADIM — "GAIA'YA GERİ DÖN" KURALI:
Her otomasyon akışının MUTLAKA son adımı olarak Gaia'ya veri yazılmalıdır.
- Dış servislerden (e-posta, takvim, CRM, vs.) veri çeksen bile → sonucu Gaia'ya kaydet.
- Yeni veri oluştuysa → GAIA_CREATE_OBJECT ile Gaia'ya yaz.
- Mevcut bir kayıt güncellendiyse → GAIA_MODIFY_OBJECT ile Gaia'ya yaz.
- "Gaia dışı" bir otomasyon olsa dahi → en az bir Gaia kaydı oluşturulmalı veya güncellenmelidir.
- ASLA "işlem tamamlandı, Gaia'ya yazmaya gerek yok" deme. Her çıktı Gaia'da iz bırakır.

AKIŞ ÖRNEĞİ (veri toplayan otomasyon):
1. Dış servis tool'larıyla veriyi çek (e-posta oku, takvim sorgula, vs.)
2. GAIA_LIST_FIELDS → hedef tablonun field'larını öğren
3. GAIA_MODIFY_OBJECT veya GAIA_CREATE_OBJECT → veriyi Gaia'ya yaz  ← SON ADIM MUTLAKA BU

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ÇIKTI FORMATI — ZORUNLU İKİ EK ALAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Her çalışmanın sonunda, JSON çıktına veya son mesajına MUTLAKA şu iki alanı ekle:

"configuration_notes_to_myself": "<SADECE gelecekte kullanacağın ID'ler, URL'ler, resource adları — key=value formatında, kısa ve öz. Örnek: template_doc_id=1GYz..., spreadsheet_id=1Bxi...>"

⚠️ DAVRANIŞ KURALI:
• Bu alanı BOŞ bırakırsan mevcut not KORUNUR — değişmez. Bunu kasıtlı kullan: sadece yeni bir değer sakladığında dolu gönder.
• Dolu gönderirsen eski notun ÜZERİNE YAZILIR. Mevcut notu silmek istemiyorsan eski değerleri de dahil et.
• Sadece ileride referans vereceğin değerleri yaz — ne yaptığının açıklamasını değil.

"notes_to_user": "<Kullanıcıya yönelik özet: ne yaptın, ne konfigüre ettin, kullanıcının bilmesi gereken bir şey var mı, bir sonraki adım ne olmalı?>"

⚠️ KISMI SORUMLULUK — OTOMASYONu SADECE TAMAMLAMAK DEĞİL, KONFİGÜRE ETMEK DE OLABILIR:
Sana bir otomasyon kurma veya düzenleme görevi verilebilir. Bu durumda görevin:
1. Kullanıcının isteğini anlamak
2. Gerekli ön konfigürasyonları yapmak (örn. WhatsApp şablonu oluştur, webhook kur, API bağlantısı test et)
3. Elde ettiğin ID/URL değerlerini configuration_notes_to_myself'e yaz (key=value, sadece ileride kullanacakların)
4. Kullanıcıya ne yaptığını notes_to_user'da açıkla

ÖRNEK SENARYO — WhatsApp şablon gerektiren otomasyon:
• Kullanıcı: "Yeni müşteri kayıt olunca WhatsApp mesajı at"
• Sen: Composio üzerinden WhatsApp şablonu oluştur → template_id = "waba_12345" al
• configuration_notes_to_myself: "template_id=waba_12345"   ← sadece ID, açıklama yok
• Otomasyon tetiklendiğinde bu not sana iletilir → template_id'yi bilirsin, tekrar oluşturmazsın.

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

        // ── OpenAI Native Tool tanımları (Responses API built-in) ───────────────
        // Chat Completions API bu tool'ları desteklemez — sadece Responses API'de çalışır.
        const OPENAI_NATIVE_TOOL_IDS = new Set(['code_interpreter','web_search','web_search_preview','image_generation','file_search']);
        const OPENAI_NATIVE_TOOL_MAP = {
            code_interpreter:  { type: 'code_interpreter', container: { type: 'auto' } },
            web_search:        { type: 'web_search_preview' },
            web_search_preview:{ type: 'web_search_preview' },
            image_generation:  { type: 'image_generation' },
            file_search:       { type: 'file_search', vector_store_ids: properties.vector_store_ids ? (Array.isArray(properties.vector_store_ids) ? properties.vector_store_ids : [properties.vector_store_ids]) : [] }
        };

        // Tools Listesini Çözümle
        // Format A (eski): ["mcp_gmail", "mcp_elevenlabs"]
        // Format B (yeni): [{"type":"GMAIL_CREATE_EMAIL_DRAFT","app":"gmail","display_name":"..."}]
        // Format C (native): [{"type":"code_interpreter"}, {"type":"web_search"}, {"type":"image_generation"}]
        const requiredApps     = new Set();  // Composio app slugs
        const requestedActions = [];         // Composio action slugs
        const nativeToolDefs   = [];         // OpenAI native tool definitions

        const rawTools = properties.tools_list;
        if (rawTools && rawTools.length > 5) {
            try {
                const parsedArray = typeof rawTools === 'string' ? JSON.parse(rawTools) : rawTools;
                parsedArray.forEach(t => {
                    const typeStr = (typeof t === 'object' ? t.type : t) || '';
                    const typeLow = typeStr.toLowerCase();

                    // Format C: OpenAI native tool
                    if (OPENAI_NATIVE_TOOL_IDS.has(typeLow)) {
                        const def = OPENAI_NATIVE_TOOL_MAP[typeLow];
                        if (def && !nativeToolDefs.find(d => d.type === def.type)) nativeToolDefs.push(def);
                        return;
                    }

                    if (typeof t === 'object' && t !== null) {
                        // Format B: Composio action
                        if (t.app) requiredApps.add(t.app.toLowerCase());
                        if (typeStr && !typeLow.startsWith('mcp_')) requestedActions.push(typeStr);
                        else if (typeLow.startsWith('mcp_')) requiredApps.add(typeLow.split("mcp_")[1]);
                    } else if (typeof t === 'string') {
                        // Format A
                        if (t.includes("mcp_")) requiredApps.add(t.split("mcp_")[1].toLowerCase());
                        else if (t.length > 2) requestedActions.push(t);
                    }
                });
            } catch(e) { log("UYARI: tools_list parse hatali: " + e.message); }
        }
        log(`[TEMP] requiredApps: ${[...requiredApps].join(', ')} | requestedActions: ${requestedActions.slice(0,5).join(', ')}${requestedActions.length > 5 ? '...' : ''} | nativeTools: ${nativeToolDefs.map(d=>d.type).join(', ')}`);

        // ── FILE FIELDS — json_schema'dan otomatik tespit ──────────────────────────────
        // Kullanıcı json_schema'da dosya çıktısı olan field'ları "type": "file" olarak işaretler.
        // Örn: {"fatura_pdf": {"type": "file"}, "ozet": {"type": "string"}}
        // Burası: (1) bu field'ları fileFieldsSet'e ekler, (2) schema'dan temizler (OpenAI'ya gitmesin).
        // Tespit schema parsing'den SONRA yapılacak — şimdi sadece Set'i oluştur.
        // NOT: sadece image/pdf değil, tüm dosya türleri için geçerlidir.
        const fileFieldsSet = new Set(); // json_schema parsing'de doldurulacak (aşağıda)

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
                if (requestedActions.length > 0) {
                    // Spesifik action sluglar varsa onları yükle (daha verimli — sadece seçilen tools)
                    tools = await composio.getTools({ actions: requestedActions });
                    log(`[TEMP] Composio tools (actions) yüklendi: ${tools.length} adet`);
                }
                if (tools.length === 0 && requiredApps.size > 0) {
                    // Fallback: tüm app araçlarını yükle (eski format veya actions boş geldiyse)
                    tools = await composio.getTools({ apps: Array.from(requiredApps) });
                    log(`[TEMP] Composio tools (apps fallback) yüklendi: ${tools.length} adet`);
                }
            } else if (typeof composio.get_tools === "function") {
                tools = requestedActions.length > 0
                    ? await composio.get_tools({ actions: requestedActions })
                    : await composio.get_tools({ apps: Array.from(requiredApps) });
                log(`[TEMP] Composio tools (get_tools) yüklendi: ${tools.length} adet`);
            }
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

        // Önceki çalışmadan gelen konfigürasyon notları — agent'a "geçmişini" ver
        // Bubble'da kayıtlı configuration_notes_to_myself bir önceki çalışmadan iletiliyor
        const prevConfigNotes = (properties.configuration_notes_to_myself || "").trim();
        if (prevConfigNotes) {
            log(`[CONFIG-NOTES] Önceki konfigürasyon notları agent'a iletiliyor (${prevConfigNotes.length} karakter)`);
            // Trigger/user mesajından hemen sonra, bir "assistant" sesi gibi değil,
            // system bağlamı olarak inject et
            const insertIdx = messagesArray.findIndex(m => m.role !== 'system') ?? messagesArray.length;
            messagesArray.splice(insertIdx, 0, {
                role: "user",
                content: `[GEÇMİŞ KONFİGÜRASYON NOTLARIM]\nBu otomasyonu daha önce kurdum. O çalışmadan kendime bıraktığım notlar:\n\n${prevConfigNotes}\n\nBu notları referans alarak görevi tamamla.`
            });
        }

        // Hiç user mesajı yoksa (ne user_content ne trigger ne config notes) boş mesaj ekle
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

        // GAIA Native tool tanımlarını ekle (her zaman)
        tools = [...(tools || []), ...NATIVE_TOOL_DEFINITIONS];

        // OpenAI built-in tool'ları ekle — sadece Responses API'de çalışır
        // Chat Completions'da ignore edilir (mappedTools filter'ı yakalar)
        if (nativeToolDefs.length > 0) {
            tools = [...tools, ...nativeToolDefs];
            log(`[TEMP] OpenAI native tools eklendi: ${nativeToolDefs.map(d=>d.type).join(', ')}`);
        }

        log(`[TEMP] Toplam tool sayısı: ${tools.length} (${tools.map(t=>t.function?.name||t.type||t.name).join(', ')})`);

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
        
        // JSON Schema — response_format enforce + FILE FIELD TESPİTİ
        // "type": "file" olan field'lar → fileFieldsSet'e alınır, schema'dan çıkarılır.
        // Kullanıcı json_schema'ya dosya çıktısı için: {"fatura_pdf": {"type": "file"}}
        // Bu tip OpenAI'ya gönderilmez; sistem otomatik olarak file payload akışına sokar.
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
                // FORMAT DETECT: Düz properties map mi, yoksa tam schema objesi mi?
                // Format A (düz): {"field1": {"type":"string"}, "file_out": {"type":"file"}, "required": [...]}
                // Format B (tam):  {"type":"object", "properties": {...}, "required": [...]}
                let rawProperties = schemaObj;
                let rawRequired   = null;

                if (schemaObj.type === 'object' && schemaObj.properties && typeof schemaObj.properties === 'object') {
                    // Format B — tam JSON Schema
                    rawProperties = schemaObj.properties;
                    rawRequired   = Array.isArray(schemaObj.required) ? schemaObj.required : null;
                } else if (Array.isArray(schemaObj.required)) {
                    // Format A — düz map ama "required" key'i var
                    rawRequired   = schemaObj.required;
                    const { required: _r, ...rest } = schemaObj;
                    rawProperties = rest;
                }

                // FILE FIELD TESPİTİ: type:"file" olan key'leri ayır, schema'dan ve required'dan temizle
                // Desteklenen formatlar:
                //   "type": "file"              → tek string
                //   "type": ["file", "null"]    → nullable array (AI'ın ürettiği format)
                //   "type": ["string","file"]   → mix array
                const _isFileType = (t) => {
                    if (!t) return false;
                    if (Array.isArray(t)) return t.some(x => String(x).toLowerCase() === 'file');
                    return String(t).toLowerCase() === 'file';
                };
                const cleanSchemaObj = {};
                for (const [k, v] of Object.entries(rawProperties)) {
                    if (v && typeof v === 'object' && _isFileType(v.type)) {
                        fileFieldsSet.add(k);
                        log(`[FILE-FIELDS] Schema'dan tespit: "${k}" (type=${JSON.stringify(v.type)}) → file payload'a yönlendirilecek`);
                    } else {
                        cleanSchemaObj[k] = v;
                    }
                }

                // required array'den de file field'larını çıkar
                const cleanRequired = rawRequired
                    ? rawRequired.filter(k => !fileFieldsSet.has(k))
                    : null;

                if (fileFieldsSet.size > 0) {
                    log(`[FILE-FIELDS] Toplam ${fileFieldsSet.size} dosya field'ı schema'dan ayrıldı: ${[...fileFieldsSet].join(', ')}`);
                    if (rawRequired) log(`[FILE-FIELDS] required array temizlendi: [${rawRequired.join(',')}] → [${(cleanRequired||[]).join(',')}]`);
                }

                // Temiz schema objesi — required sadece dolu ise eklenir
                const finalSchema = { type: "object", properties: cleanSchemaObj };
                if (cleanRequired && cleanRequired.length > 0) finalSchema.required = cleanRequired;

                // OpenAI schema sanitizer — Responses API'nin kabul etmediği formatları düzelt:
                //   • type array ["string","null"] → anyOf: [{type:"string"},{type:"null"}]
                //   • type array ["null"] veya boş → type:"string" (fallback)
                //   • unknown type ("file" vb.) zaten yukarıda çıkarıldı
                const _sanitizeSchemaNode = (node) => {
                    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
                    const out = {};
                    for (const [key, val] of Object.entries(node)) {
                        if (key === 'type' && Array.isArray(val)) {
                            // Array type → anyOf dönüştür
                            const types = val.filter(t => typeof t === 'string' && t !== 'file');
                            if (types.length === 0) {
                                out['type'] = 'string'; // tamamen boş kaldıysa fallback
                            } else if (types.length === 1) {
                                out['type'] = types[0]; // tek eleman → düz string
                            } else {
                                // Birden fazla tip → anyOf
                                out['anyOf'] = types.map(t => ({ type: t }));
                                // 'type' key'ini EKLEME — anyOf ile çakışır
                                continue;
                            }
                        } else if (key === 'properties' && val && typeof val === 'object') {
                            out[key] = {};
                            for (const [pk, pv] of Object.entries(val)) {
                                out[key][pk] = _sanitizeSchemaNode(pv);
                            }
                        } else if (key === 'items' && val && typeof val === 'object') {
                            out[key] = _sanitizeSchemaNode(val);
                        } else {
                            out[key] = val;
                        }
                    }
                    return out;
                };
                const sanitizedSchema = _sanitizeSchemaNode(finalSchema);

                chatParams.response_format = {
                    type: "json_schema",
                    json_schema: {
                        name: properties.schema_name || "response",
                        strict: false,
                        schema: sanitizedSchema
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
        
        // FILE PAYLOAD SYSTEM — schema'dan tespit edilen file field'lar için agent talimatı
        // (json_schema parsing'den sonra çalışır — fileFieldsSet dolu olduğu garantili)
        // NOT: sadece image/pdf değil, tüm dosya türleri bu sistemi kullanır
        if (fileFieldsSet.size > 0) {
            const fileFieldList = [...fileFieldsSet].map(k => `  • "${k}"`).join('\n');
            // chatParams.messages = messagesArray referansı — splice ile doğrudan eklenebilir
            const sysIdx = chatParams.messages.findIndex(m => m.role === 'system');
            const insertIdx = sysIdx >= 0 ? sysIdx + 1 : 0;
            // code_interpreter kullanılıyor mu? (native tools listesinden tespit)
            const _hasCodeInterpreter = (nativeToolDefs || []).some(t => t.type === 'code_interpreter');
            const fileInstruction = _hasCodeInterpreter
                ? `[DOSYA ÇIKTISI KURALI — CODE INTERPRETER]\nBu görevin aşağıdaki field'ları dosya çıktısı içindir:\n${fileFieldList}\n\ncode_interpreter ile bu dosyaları üretirken:\n  • Dosya adını MUTLAKA field adıyla aynı yap (uzantı ekleyebilirsin). Örnek: "${[...fileFieldsSet][0]}.pdf"\n  • Dosya field'larını JSON çıktına EKLEME — platform dosyayı code_interpreter çıktısından otomatik okur ve ilgili alana kaydeder.\n  • JSON çıktında yalnızca non-file field'ları döndür.`
                : `[DOSYA ÇIKTISI KURALI — FILE PAYLOAD SİSTEMİ]\nBu görevin aşağıdaki field'ları dosya çıktısı içindir (image_pdf tipi):\n${fileFieldList}\n\nBu field'lar json_schema'ya dahil edilmemiştir — yine de JSON çıktında şu formatlarda ekle:\n  - Base64: "data:image/png;base64,..." veya ham base64 string\n  - Doğrudan URL: "https://..."\nBu field'lar için herhangi bir upload tool ÇAĞIRMA — platform dosyayı otomatik yükler.\nDiğer JSON field'larınla birlikte aynı obje içinde bulunmalı.`;
            chatParams.messages.splice(insertIdx, 0, {
                role: "user",
                content: fileInstruction
            });
            log(`[FILE-FIELDS] ${fileFieldsSet.size} dosya field talimatı mesaja eklendi: ${[...fileFieldsSet].join(', ')}`);
        }

        // -------------------------
        // BÖLÜM 3: LLM DÖNGÜSÜ
        // -------------------------
        let finalContent = "";
        let runCount = 0;
        const maxRuns = 15; // Node.JS olduğu için döngü sayısını esnetebiliriz!
        // NOT: Bu alan kavramsal olarak "filepayload" — sadece AI-üretimi görsel değil,
        // gelecekte PDF ve diğer dosya türlerini de taşıyabilir. Değişken adı aynı kalıyor.
        // Gaia sisteminde file çıktısı olan her görevin o field'ı zaten custom field olarak tanımlıdır;
        // bu array formdaki ilgili field'a otomatik uygulanır — GAIA_UPLOAD_FILE tool'una gerek yoktur.
        let generatedPhotosArray = []; // döngü içinde de doldurulabilir (image_generation_call)

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
                        mappedTools = chatParams.tools
                            .map(tool => {
                                if (tool.type === "function" && tool.function) {
                                    // GAIA / Composio function tool → Responses API formatı
                                    return { type: "function", name: tool.function.name, description: tool.function.description || "", parameters: tool.function.parameters || {} };
                                }
                                // OpenAI native tool (code_interpreter, web_search_preview, image_generation, file_search)
                                // Responses API bunları olduğu gibi kabul eder
                                if (['code_interpreter','web_search_preview','image_generation','file_search'].includes(tool.type)) {
                                    return tool;
                                }
                                return null; // Chat Completions'a özgü format — Responses API'de filtrele
                            })
                            .filter(Boolean);
                    }

                    const payload = { ...chatParams, input: responsesInput };
                    if (mappedTools.length > 0) payload.tools = mappedTools;
                    delete payload.messages;
                    delete payload.reasoning_effort; // Responses API bunu desteklemiyor, reasoning.effort kullanıyor 

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
                            // GAIA / Composio tool call
                            const funcName = item.name || (item.function && item.function.name);
                            toolCalls.push({
                                id: item.id || item.call_id || "call_" + Math.random().toString(36).substr(2, 9),
                                type: "function",
                                function: { name: funcName, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) }
                            });
                        } else if (item.type === "image_generation_call") {
                            // image_generation tool output — base64 PNG
                            // NOT: filepayload sistemi — sadece image değil, tüm dosya türleri bu yapıyla işlenir
                            if (item.result) {
                                log(`[AI-IMG] image_generation_call yakalandı (base64 ${item.result.length} karakter)`);
                                generatedPhotosArray.push({
                                    customFieldName: "ai_generated_image",
                                    newFiles: [{ base64: item.result, filename: "ai_generated_image.png", contentType: "image/png" }],
                                    newUrls: [], keptUrls: [], removedUrls: []
                                });
                            }
                        } else if (item.type === "web_search_call") {
                            // web_search tool output — sonuç text olarak assistant mesajına yansır, burada sadece logla
                            log(`[WEB-SEARCH] web_search_call çalıştı`);
                        } else if (item.type === "code_interpreter_call") {
                            // code_interpreter çıktısı — image ve files (PDF vb.) çıktıları
                            log(`[CODE] code_interpreter_call çalıştı | outputs: ${JSON.stringify((item.outputs||[]).map(o=>o.type)).slice(0,100)}`);

                            // Dosya adından fileFieldsSet field key'i bul
                            // Kural: dosya adı (uzantısız) field adıyla eşleşiyorsa o field'a at
                            //        eşleşme yoksa tek file field varsa onu kullan, yoksa generic
                            const _matchFileField = (filename) => {
                                const base = (filename || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
                                for (const k of fileFieldsSet) {
                                    if (k.toLowerCase() === base || base.includes(k.toLowerCase()) || k.toLowerCase().includes(base)) return k;
                                }
                                if (fileFieldsSet.size === 1) return [...fileFieldsSet][0];
                                return null; // eşleşme bulunamadı
                            };

                            for (const o of (item.outputs || [])) {
                                // — inline image çıktısı
                                if (o.type === "image" && o.image_url) {
                                    const imgB64 = o.image_url.includes(',') ? o.image_url.split(',')[1] : o.image_url;
                                    const imgField = _matchFileField('image') || "code_interpreter_image";
                                    log(`[CODE] image output → field "${imgField}"`);
                                    generatedPhotosArray.push({
                                        customFieldName: imgField,
                                        newFiles: [{ base64: imgB64, filename: imgField + ".png", contentType: "image/png" }],
                                        newUrls: [], keptUrls: [], removedUrls: []
                                    });
                                }
                                // — file çıktısı (PDF, XLSX vb.) → OpenAI file API'den indir
                                else if (o.type === "files" && Array.isArray(o.files)) {
                                    for (const f of o.files) {
                                        const fid = f.file_id;
                                        const fname = f.name || f.filename || (fid + '.bin');
                                        log(`[CODE] files output: file_id=${fid} name=${fname} — indiriliyor...`);
                                        try {
                                            // openai.files.content() → ReadableStream / Buffer
                                            const fileResp = await openai.files.content(fid);
                                            // SDK döndürdüğü tipe göre buffer al
                                            let buf;
                                            if (Buffer.isBuffer(fileResp)) {
                                                buf = fileResp;
                                            } else if (fileResp && typeof fileResp.arrayBuffer === 'function') {
                                                buf = Buffer.from(await fileResp.arrayBuffer());
                                            } else if (fileResp && fileResp.body) {
                                                // Node.js ReadableStream
                                                const chunks = [];
                                                for await (const chunk of fileResp.body) chunks.push(chunk);
                                                buf = Buffer.concat(chunks);
                                            } else {
                                                buf = Buffer.from(await fileResp.text(), 'utf8');
                                            }
                                            const b64 = buf.toString('base64');
                                            // Content-type tahmin
                                            const extLow = fname.split('.').pop().toLowerCase();
                                            const ctMap = { pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', svg:'image/svg+xml', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv:'text/csv' };
                                            const ct = ctMap[extLow] || 'application/octet-stream';
                                            // Field eşleştir
                                            const targetField = _matchFileField(fname) || "code_interpreter_file";
                                            log(`[CODE] file indirildi: ${fname} (${buf.length} byte, ${ct}) → field "${targetField}"`);
                                            generatedPhotosArray.push({
                                                customFieldName: targetField,
                                                newFiles: [{ base64: b64, filename: fname, contentType: ct }],
                                                newUrls: [], keptUrls: [], removedUrls: []
                                            });
                                            // Geçici file'ı sil (opsiyonel — kotayı temizler)
                                            try { await openai.files.del(fid); } catch(_) {}
                                        } catch (dlErr) {
                                            log(`[CODE] HATA: file_id=${fid} indirilemedi: ${dlErr.message}`);
                                        }
                                    }
                                }
                            }
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
        // generatedPhotosArray döngü içinde de doldurulabilir (image_generation_call)
        // — zaten yukarıda tanımlandı, burada sadece referans
        
        // --- PHOTO PAYLOAD (AI IMAGE DETECTION) ---
        // Eğer LLM bir tool kullandıysa ve bu tool (örn. image_generate) resim URL'si VEYA Base64 text döndürdüyse:
        // --- TOOL RESPONSE FILE DETECTION (filepayload sistemi) ---
        // Tool response'lardan gelen dosyaları yakala — NOT: sadece image değil, tüm dosya türleri
        try {
            for (const msg of chatParams.messages) {
                if (msg.role === "tool" && msg.content) {

                    // 1) RAW BASE64 KONTROLÜ (Veri zaten base64 gelmişse)
                    const base64Match = msg.content.match(/(?:base64["']?\s*:\s*["']|data:(?:image|application)\/[a-zA-Z.+-]+;base64,)([^"'\\]{100,})/i);
                    if (base64Match && base64Match[1]) {
                        const rawVal = base64Match[1];
                        log(`[FILE-PAYLOAD] Tool response'ta base64 dosya verisi yakalandı!`);
                        generatedPhotosArray.push({
                            customFieldName: "ai_generated_file",
                            newFiles: [{ base64: rawVal, filename: "ai_generated_file.png", contentType: "image/png" }],
                            newUrls: [], keptUrls: [], removedUrls: []
                        });
                        continue;
                    }

                    // 2) URL KONTROLÜ — dosya/görsel URL'si varsa indir
                    const urlMatch = msg.content.match(/https?:\/\/[^\s"'<>]+/g);
                    if (urlMatch) {
                        for (const url of urlMatch) {
                            if (url.includes("image") || url.includes("dalle") || url.match(/\.(jpeg|jpg|gif|png|webp|pdf)$/i)) {
                                log(`[FILE-PAYLOAD] Dosya URL bulundu, indiriliyor: ${url.substring(0, 50)}...`);
                                try {
                                    const imgRes = await axios.get(url, { responseType: 'arraybuffer' });
                                    const b64 = Buffer.from(imgRes.data, 'binary').toString('base64');
                                    const isPdf = url.match(/\.pdf$/i);
                                    generatedPhotosArray.push({
                                        customFieldName: "ai_generated_file",
                                        newFiles: [{ base64: b64, filename: isPdf ? "ai_file.pdf" : "ai_image.png", contentType: isPdf ? "application/pdf" : "image/png" }],
                                        newUrls: [], keptUrls: [], removedUrls: []
                                    });
                                } catch (e) {
                                    log(`[FILE-PAYLOAD] URL'den indirilemedi: ${e.message}`);
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) { log("File payload extraction error: " + e); }

        // Agent JSON çıktısını işle:
        // - configuration_notes_to_myself → ayrı webhook field
        // - file_fields (image_pdf tipi) → photopayload'a taşı, final_json'dan çıkar
        // - notes_to_user → final_json içinde kalır (form elementi handle eder)
        let configNotesOutput = "";

        // Dosya içeriği tespit yardımcıları
        function _isBase64OrUrl(val) {
            if (typeof val !== 'string') return false;
            const v = val.trim();
            return v.startsWith('data:') || /^https?:\/\//i.test(v) || (v.length > 100 && /^[A-Za-z0-9+/=]+$/.test(v.replace(/[\r\n]/g,'')));
        }
        function _guessContentType(val, fieldKey) {
            const v = String(val || '');
            const k = String(fieldKey || '').toLowerCase();
            if (v.startsWith('data:')) { const m = v.match(/^data:([^;]+)/); if (m) return m[1]; }
            if (k.includes('pdf')) return 'application/pdf';
            if (k.includes('png')) return 'image/png';
            if (k.includes('jpg') || k.includes('jpeg')) return 'image/jpeg';
            if (k.includes('webp')) return 'image/webp';
            if (k.includes('svg')) return 'image/svg+xml';
            if (/pdf|doc|xls|ppt/i.test(v.slice(0, 80))) return 'application/pdf';
            return 'image/png'; // default — görsel varsayım
        }
        function _guessFilename(val, fieldKey) {
            const k = String(fieldKey || '').replace(/[^a-z0-9_-]/gi, '_');
            const ct = _guessContentType(val, fieldKey);
            const ext = ct.split('/')[1]?.split('+')[0] || 'bin';
            return `${k}.${ext}`;
        }

        try {
            // GPT'den dönen temiz JSON Objesini yakalama ve listeye çevirme:
            let tempJSON = JSON.parse(parsedFinalObject);

            if (typeof tempJSON === 'object' && !Array.isArray(tempJSON)) {

                let mappedList = [];
                for (let key in tempJSON) {
                    const keyLow = key.trim().toLowerCase();
                    if (keyLow === "predictedaction") {
                        predictedActionObj = tempJSON[key];
                        continue;
                    }
                    // configuration_notes_to_myself: ayrı webhook field, final_json'a dahil edilmez
                    if (keyLow === "configuration_notes_to_myself") {
                        configNotesOutput = String(tempJSON[key] || "");
                        continue;
                    }
                    // FILE PAYLOAD: file_fields listesindeki field'lar → photopayload'a, final_json'dan çıkar
                    // NOT: image/pdf dışında da geçerli — her dosya türü bu sistemi kullanır
                    if (fileFieldsSet.size > 0 && fileFieldsSet.has(key)) {
                        const fVal = String(tempJSON[key] || "").trim();
                        if (fVal && _isBase64OrUrl(fVal)) {
                            const isUrl = /^https?:\/\//i.test(fVal);
                            const fileItem = {
                                customFieldName: key,
                                newFiles: isUrl ? [] : [{ base64: fVal.includes(',') ? fVal.split(',')[1] : fVal, filename: _guessFilename(fVal, key), contentType: _guessContentType(fVal, key) }],
                                newUrls: isUrl ? [fVal] : [],
                                keptUrls: [],
                                removedUrls: []
                            };
                            generatedPhotosArray.push(fileItem);
                            log(`[FILE-PAYLOAD] "${key}" field'ı photopayload'a taşındı (${isUrl ? 'URL' : 'base64'}, ${fVal.length} karakter)`);
                        } else {
                            log(`[FILE-PAYLOAD] UYARI: "${key}" field'ı file_fields'da ama geçerli base64/URL bulunamadı`);
                        }
                        continue; // final_json'a ekleme
                    }
                    // notes_to_user: final_json içinde kalır — form elementi okur, gösterir, siler
                    let val = tempJSON[key];
                    if (val === null || val === undefined) val = "";
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

        // Agent notu doldurduysa → yeni notla güncelle (Bubble DB'yi güncelle)
        // Agent notu boş bıraktıysa → null döndür (Bubble workflow DB'yi güncellemez)
        const finalConfigNotes = configNotesOutput.trim() ? configNotesOutput : null;

        log(`[CONFIG-NOTES] ${finalConfigNotes !== null ? "YENİ not yazıldı → " + finalConfigNotes.slice(0,100) + (finalConfigNotes.length > 100 ? '...' : '') : "Boş bırakıldı → null (DB güncellenmeyecek)"}`);

        const successPayload = {
            status: "SUCCESS",
            final_json: parsedFinalObject,
            predicted_action: predictedActionObj ? JSON.stringify(predictedActionObj) : "",
            // "filepayload" — image, PDF ve tüm dosya türleri için.
            // {items:[...]} formatı photoBackend'in beklediği yapıdır.
            // Her item: {customFieldName, newFiles:[{base64,filename,contentType}], newUrls:[], keptUrls:[], removedUrls:[]}
            photopayload: generatedPhotosArray.length > 0 ? JSON.stringify({ items: generatedPhotosArray }) : "",
            configuration_notes_to_myself: finalConfigNotes,    // null = DB güncellenmez, string = yeni not
            // notes_to_user: final_json içinde geliyor — form elementi handle eder
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
                configuration_notes_to_myself: "",
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
        // Format A (eski): ["mcp_gmail"] | Format B (yeni): [{type, app, display_name}]
        const requiredApps = new Set();
        const rawTools = properties.tools_list;
        if (rawTools && rawTools.length > 5) {
            try {
                const parsedArray = typeof rawTools === 'string' ? JSON.parse(rawTools) : rawTools;
                parsedArray.forEach(t => {
                    if (typeof t === 'object' && t !== null) {
                        if (t.app) requiredApps.add(t.app.toLowerCase());
                        if (t.type && t.type.toLowerCase().startsWith('mcp_')) requiredApps.add(t.type.split("mcp_")[1].toLowerCase());
                    } else if (typeof t === 'string' && t.includes("mcp_")) {
                        requiredApps.add(t.split("mcp_")[1].toLowerCase());
                    }
                });
            } catch(e) {}
        }

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
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`[TEMP] ▶ MANAGE-TRIGGERS ENDPOINT ÇAĞRILDI`);
    console.log(`[TEMP] Gelen request body:`, JSON.stringify(properties).substring(0, 500));

    const SECURE_API_KEY = process.env.ADMIN_API_KEY || "gaia_secure_render_key_2026";
    if (!properties.admin_api_key || properties.admin_api_key !== SECURE_API_KEY) {
        console.log(`[TEMP] ❌ YETKİSİZ İSTEK! admin_api_key eşleşmiyor.`);
        return res.status(401).json({ status: "UNAUTHORIZED", message: "Geçersiz veya eksik Admin API Key!" });
    }

    try {
        // Bubble'dan gelecek parametreler
        const { action_type, trigger_slug, trigger_instance_id, trigger_config, composio_api_key, connected_account_id, user_id, files, openai_api_key, vector_store_name, trigger_instance_ids } = properties;

        console.log(`[TEMP] Parametreler:`);
        console.log(`[TEMP]  - action_type          : ${action_type}`);
        console.log(`[TEMP]  - trigger_slug         : ${trigger_slug}`);
        console.log(`[TEMP]  - trigger_instance_id  : ${trigger_instance_id}`);
        console.log(`[TEMP]  - trigger_config       : ${typeof trigger_config === 'object' ? JSON.stringify(trigger_config) : trigger_config}`);
        console.log(`[TEMP]  - composio_api_key var?: ${!!composio_api_key}`);
        console.log(`[TEMP]  - openai_api_key var?  : ${!!openai_api_key} | değer: ${openai_api_key ? openai_api_key.substring(0,12)+'...' : 'BOŞ'}`);
        console.log(`[TEMP]  - files var?           : ${!!files} | sayı: ${Array.isArray(files) ? files.length : 'array değil'}`);
        console.log(`[TEMP]  - tüm body keys        : ${Object.keys(properties).join(', ')}`);
        console.log(`[TEMP]  - connected_account_id : ${connected_account_id}`);
        console.log(`[TEMP]  - user_id              : ${user_id}`);

        if (!composio_api_key) {
            console.log(`[TEMP] ❌ Composio API Key eksik! İstek reddedildi.`);
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
                console.log(`[TEMP] ⚡ İşlem Tipi: CREATE/UPSERT`);
                let parsedConfig = {};
                try {
                    parsedConfig = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : (trigger_config || {});
                    console.log(`[TEMP] parsedConfig hazırlandı:`, JSON.stringify(parsedConfig));
                } catch(e) { 
                    console.log(`[TEMP] ⚠️ trigger_config parse edilemedi. Düz metin/fall-back kullanılıyor. Mevcut değer:`, trigger_config);
                }
                
                const postUrl = `${baseURL}/${trigger_slug}/upsert`;
                const postData = {
                    connected_account_id: connected_account_id,
                    trigger_config: parsedConfig
                };
                console.log(`[TEMP] 🚀 İstek Atılıyor: POST ${postUrl}`);
                console.log(`[TEMP] 🚀 İstek Body:`, JSON.stringify(postData));

                axiosResponse = await axios.post(postUrl, postData, { headers });
                console.log(`[TEMP] ✅ API Yanıtı Alındı! HTTP Status: ${axiosResponse.status}`);
                console.log(`[TEMP] ✅ API Yanıt Data:`, JSON.stringify(axiosResponse.data));
                // Oluşturulan trigger'ı hemen DISABLED yap
                const _newId = axiosResponse.data?.id || axiosResponse.data?.triggerId || axiosResponse.data?.trigger_instance_id;
                if (_newId) {
                    try {
                        await axios.patch(`${baseURL}/manage/${_newId}`, { status: "DISABLED" }, { headers });
                        console.log(`[TEMP] ✅ Trigger DISABLED yapıldı: ${_newId}`);
                    } catch(e) {
                        console.log(`[TEMP] ⚠️ Trigger disable başarısız (devam ediliyor): ${e.message}`);
                    }
                }
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
                console.log(`[TEMP] ⚡ İşlem Tipi: ENABLE (${trigger_instance_id})`);
                axiosResponse = await axios.patch(`${baseURL}/manage/${trigger_instance_id}`, { status: "ENABLED" }, { headers });
                console.log(`[TEMP] ✅ ENABLE Yanıtı Alındı! HTTP Status: ${axiosResponse.status}`);
                break;
                
            case "disable":
                // Tetikleyiciyi devre dışı bırak
                console.log(`[TEMP] ⚡ İşlem Tipi: DISABLE (${trigger_instance_id})`);
                axiosResponse = await axios.patch(`${baseURL}/manage/${trigger_instance_id}`, { status: "DISABLED" }, { headers });
                console.log(`[TEMP] ✅ DISABLE Yanıtı Alındı! HTTP Status: ${axiosResponse.status}`);
                break;
                
            case "delete":
                // Tetikleyiciyi tamamen sil
                console.log(`[TEMP] ⚡ İşlem Tipi: DELETE (${trigger_instance_id})`);
                axiosResponse = await axios.delete(`${baseURL}/manage/${trigger_instance_id}`, { headers });
                console.log(`[TEMP] ✅ DELETE Yanıtı Alındı! HTTP Status: ${axiosResponse.status}`);
                break;
                
            case "enable_batch": {
                // Birden fazla trigger'ı paralel olarak ENABLED yap (fire-and-forget için)
                console.log(`[TEMP] ⚡ İşlem Tipi: ENABLE_BATCH`);
                const _batchIds = Array.isArray(trigger_instance_ids) ? trigger_instance_ids : [];
                console.log(`[TEMP]  - enable edilecek ID sayısı: ${_batchIds.length}`);
                const _batchResults = await Promise.allSettled(
                    _batchIds.map(id => axios.patch(`${baseURL}/manage/${id}`, { status: "ENABLED" }, { headers }))
                );
                _batchResults.forEach((r, i) => {
                    if (r.status === 'fulfilled') console.log(`[TEMP]  ✅ ENABLED: ${_batchIds[i]}`);
                    else console.log(`[TEMP]  ⚠️ Başarısız: ${_batchIds[i]} — ${r.reason?.message}`);
                });
                axiosResponse = { data: { enabled: _batchIds.filter((_, i) => _batchResults[i].status === 'fulfilled') } };
                break;
            }

            case "knowledge_base": {
                console.log(`[TEMP] ⚡ İşlem Tipi: KNOWLEDGE_BASE`);
                // Önce istekten al, yoksa Render env var'ından kullan
                const _oaiKey = openai_api_key || process.env.OPENAI_API_KEY || '';
                if (!_oaiKey) throw new Error("openai_api_key eksik (ne istekten ne env'den geldi)");
                const _openai = new OpenAI({ apiKey: _oaiKey });
                const _files = Array.isArray(files) ? files : [];
                if (_files.length === 0) throw new Error("files dizisi boş veya eksik");

                // Dosyaları paralel indir + yükle
                const _fileIds = await Promise.all(_files.map(async (_file) => {
                    console.log(`[TEMP]  → Dosya indiriliyor: ${_file.name}`);
                    const _fetchRes = await fetch(_file.url);
                    if (!_fetchRes.ok) throw new Error(`Dosya indirilemedi: ${_file.url} (${_fetchRes.status})`);
                    const _buf = Buffer.from(await _fetchRes.arrayBuffer());
                    const _uploaded = await _openai.files.create({
                        file: new File([_buf], _file.name || 'document'),
                        purpose: 'assistants'
                    });
                    console.log(`[TEMP]  ✅ Dosya yüklendi: ${_uploaded.id}`);
                    return _uploaded.id;
                }));

                // SDK versiyonundan bağımsız: direkt HTTP API
                const _vsResp = await fetch('https://api.openai.com/v1/vector_stores', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${_oaiKey}`,
                        'Content-Type': 'application/json',
                        'OpenAI-Beta': 'assistants=v2'
                    },
                    body: JSON.stringify({
                        name: vector_store_name || 'knowledge_base',
                        file_ids: _fileIds
                    })
                });
                const _vsData = await _vsResp.json();
                if (!_vsResp.ok) throw new Error('Vector store oluşturulamadı: ' + JSON.stringify(_vsData));
                console.log(`[TEMP] ✅ Vector Store oluşturuldu: ${_vsData.id}`);
                axiosResponse = { data: { vector_store_id: _vsData.id, file_ids: _fileIds } };
                break;
            }

            case "kb_list_files": {
                console.log(`[TEMP] ⚡ İşlem Tipi: KB_LIST_FILES`);
                const _oaiKey2 = openai_api_key || process.env.OPENAI_API_KEY || '';
                if (!_oaiKey2) throw new Error("openai_api_key eksik");
                const { vector_store_id: _vsId } = properties;
                if (!_vsId) throw new Error("vector_store_id eksik");
                const _oaiHdr = { 'Authorization': `Bearer ${_oaiKey2}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'assistants=v2' };

                // Vector store'daki dosyaları listele
                const _vsFilesResp = await fetch(`https://api.openai.com/v1/vector_stores/${_vsId}/files?limit=100`, { headers: _oaiHdr });
                const _vsFilesData = await _vsFilesResp.json();
                if (!_vsFilesResp.ok) throw new Error('VS dosyaları listelenemedi: ' + JSON.stringify(_vsFilesData));

                // Her dosyanın adını paralel olarak çek
                const _fileList = await Promise.all((_vsFilesData.data || []).map(async (vsFile) => {
                    try {
                        const _fResp = await fetch(`https://api.openai.com/v1/files/${vsFile.id}`, { headers: _oaiHdr });
                        const _fData = await _fResp.json();
                        return { file_id: vsFile.id, name: _fData.filename || vsFile.id, status: vsFile.status };
                    } catch(e) {
                        return { file_id: vsFile.id, name: vsFile.id, status: vsFile.status };
                    }
                }));
                console.log(`[TEMP] ✅ KB dosyaları listelendi: ${_fileList.length} adet`);
                axiosResponse = { data: { files: _fileList, vector_store_id: _vsId } };
                break;
            }

            case "kb_add_files": {
                console.log(`[TEMP] ⚡ İşlem Tipi: KB_ADD_FILES`);
                const _oaiKey3 = openai_api_key || process.env.OPENAI_API_KEY || '';
                if (!_oaiKey3) throw new Error("openai_api_key eksik");
                const _addFiles = Array.isArray(files) ? files : [];
                if (_addFiles.length === 0) throw new Error("files dizisi boş");
                const _vsTarget = properties.vector_store_id || '';
                const _oaiHdr3 = { 'Authorization': `Bearer ${_oaiKey3}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'assistants=v2' };
                const _openai3 = new OpenAI({ apiKey: _oaiKey3 });

                // Dosyaları paralel indir + yükle
                const _newFileIds = await Promise.all(_addFiles.map(async (_file) => {
                    console.log(`[TEMP]  → Dosya yükleniyor: ${_file.name}`);
                    const _fetchRes = await fetch(_file.url);
                    if (!_fetchRes.ok) throw new Error(`Dosya indirilemedi: ${_file.url}`);
                    const _buf = Buffer.from(await _fetchRes.arrayBuffer());
                    const _up = await _openai3.files.create({ file: new File([_buf], _file.name || 'document'), purpose: 'assistants' });
                    return { file_id: _up.id, name: _file.name };
                }));

                let _finalVsId = _vsTarget;
                if (_vsTarget) {
                    // Mevcut VS'e toplu ekle
                    const _batchResp = await fetch(`https://api.openai.com/v1/vector_stores/${_vsTarget}/file_batches`, {
                        method: 'POST', headers: _oaiHdr3,
                        body: JSON.stringify({ file_ids: _newFileIds.map(f => f.file_id) })
                    });
                    const _batchData = await _batchResp.json();
                    if (!_batchResp.ok) throw new Error('Dosyalar VS\'e eklenemedi: ' + JSON.stringify(_batchData));
                } else {
                    // Yeni VS oluştur
                    const _vsResp3 = await fetch('https://api.openai.com/v1/vector_stores', {
                        method: 'POST', headers: _oaiHdr3,
                        body: JSON.stringify({ name: vector_store_name || 'knowledge_base', file_ids: _newFileIds.map(f => f.file_id) })
                    });
                    const _vsData3 = await _vsResp3.json();
                    if (!_vsResp3.ok) throw new Error('VS oluşturulamadı: ' + JSON.stringify(_vsData3));
                    _finalVsId = _vsData3.id;
                }
                console.log(`[TEMP] ✅ KB_ADD_FILES tamamlandı. VS: ${_finalVsId}, yeni dosya: ${_newFileIds.length}`);
                axiosResponse = { data: { vector_store_id: _finalVsId, added_files: _newFileIds } };
                break;
            }

            case "kb_remove_file": {
                console.log(`[TEMP] ⚡ İşlem Tipi: KB_REMOVE_FILE`);
                const _oaiKey4 = openai_api_key || process.env.OPENAI_API_KEY || '';
                if (!_oaiKey4) throw new Error("openai_api_key eksik");
                const _rmVsId  = properties.vector_store_id || '';
                const _rmFileId = properties.file_id || '';
                if (!_rmVsId || !_rmFileId) throw new Error("vector_store_id ve file_id zorunlu");
                const _oaiHdr4 = { 'Authorization': `Bearer ${_oaiKey4}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'assistants=v2' };

                const _rmResp = await fetch(`https://api.openai.com/v1/vector_stores/${_rmVsId}/files/${_rmFileId}`, {
                    method: 'DELETE', headers: _oaiHdr4
                });
                const _rmData = await _rmResp.json();
                if (!_rmResp.ok) throw new Error('Dosya silinemedi: ' + JSON.stringify(_rmData));
                console.log(`[TEMP] ✅ Dosya VS'den silindi: ${_rmFileId}`);
                axiosResponse = { data: { deleted: true, file_id: _rmFileId, vector_store_id: _rmVsId } };
                break;
            }

            default:
                console.log(`[TEMP] ❌ Geçersiz action_type: ${action_type}`);
                return res.status(400).json({ status: "ERROR", message: "Geçersiz action_type." });
        }

        // Başarılı yanıt
        console.log(`[TEMP] 🎉 İşlem Başarıyla Tamamlandı. Bubble'a SUCCESS dönülüyor.`);
        console.log(`\n════════════════════════════════════════════════════════════\n`);
        return res.json({
            status: "SUCCESS",
            action: action_type,
            data: axiosResponse.data
        });

    } catch (err) {
        console.error(`\n[TEMP] ❌ KRTİTİK HATA YAKALANDI!`);
        console.error("[TEMP] ❌ Hata Mesajı:", err.message);
        const errorMsg = err.response && err.response.data && err.response.data.message ? err.response.data.message : err.message;
        
        if (err.response) {
            console.error(`[TEMP] ❌ API Status Kodu: ${err.response.status}`);
            console.error(`[TEMP] ❌ API Yanıtı Data:`, JSON.stringify(err.response.data));
        } else {
            console.error(`[TEMP] ❌ Stack Trace:`, err.stack);
        }
        console.log(`\n════════════════════════════════════════════════════════════\n`);

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
