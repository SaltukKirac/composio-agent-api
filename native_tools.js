// ─────────────────────────────────────────────────────────────────────────────
// GAIA NATIVE TOOLS
// Agent bu tool'ları çağırınca server.js composio yerine bu handler'ları çalıştırır.
// Yeni tool eklemek için:
//   1. DEFINITIONS dizisine tanımı ekle
//   2. HANDLERS objesine aynı isimle handler ekle
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getBubbleBase(appVersion) {
    const v = (appVersion || "").trim();
    const path = v ? `${v}/` : "";
    return `https://gaiasphere.io/${path}api/1.1/wf`;
}

// ─── TOOL DEFINITIONS (OpenAI function format) ───────────────────────────────

const DEFINITIONS = [

    {
        type: "function",
        function: {
            name: "GAIA_LIST_FIELDS",
            description: "Bir tablonun (sheet) tüm custom field'larını listeler. GAIA_CREATE_OBJECT veya GAIA_UPDATE_OBJECT çağrısından önce hangi field'ların mevcut olduğunu öğrenmek için kullan.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: {
                        type: "string",
                        description: "Organizasyonun benzersiz ID'si"
                    },
                    sheet: {
                        type: "string",
                        description: "Field listesi alınacak tablo adı (örn: 'Müşteriler', 'Siparişler')"
                    }
                },
                required: ["organisation_id", "sheet"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: "GAIA_CREATE_OBJECT",
            description: "Gaia'da belirtilen tabloya yeni bir kayıt (obje) oluşturur. Önce GAIA_LIST_FIELDS ile mevcut field'ları öğren, sonra bu tool'u çağır.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: {
                        type: "string",
                        description: "Organizasyonun benzersiz ID'si"
                    },
                    sheet: {
                        type: "string",
                        description: "Kaydın oluşturulacağı tablo adı"
                    },
                    referencevalue: {
                        type: "string",
                        description: "Referans değeri (genellikle benzersiz tanımlayıcı)"
                    },
                    action: {
                        type: "string",
                        description: "Uygulama butonu / aksiyon değeri"
                    },
                    fields: {
                        type: "object",
                        description: "GAIA_LIST_FIELDS'tan dönen field key'lerini kullanarak doldurulacak alanlar. Örn: { 'ad_soyad': 'Ali Veli', 'email': 'ali@test.com' }",
                        additionalProperties: true
                    }
                },
                required: ["organisation_id", "sheet", "fields"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: "GAIA_SEARCH_OBJECT",
            description: "Gaia'da (Bubble Data API üzerinden) belirtilen tabloda kayıt arar. Eğer unique_id biliniyorsa sadece onunla sorgula — diğer parametrelere gerek yok. Metin alanları için 'key':'value', sayısal alanlar için 'key':value formatında jsonarray constraint kullanır. referedeğer ile de arama yapabilir.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: {
                        type: "string",
                        description: "Organizasyonun benzersiz ID'si"
                    },
                    sheet: {
                        type: "string",
                        description: "Arama yapılacak tablo adı (örn: 'Müşteriler')"
                    },
                    unique_id: {
                        type: "string",
                        description: "Bubble obje ID'si (_id). Biliniyorsa sadece bu yeterli, diğer arama parametrelerine gerek yok."
                    },
                    referencevalue: {
                        type: "string",
                        description: "Referans değerine göre arama (isteğe bağlı)"
                    },
                    search_fields: {
                        type: "object",
                        description: "Aranacak alanlar ve değerleri. Metin: string değer, Sayı: number değer. Örn: { 'ad_soyad': 'Ali', 'yas': 30 }",
                        additionalProperties: true
                    },
                    cursor: {
                        type: "number",
                        description: "Sayfalama başlangıcı (varsayılan: 0)"
                    },
                    limit: {
                        type: "number",
                        description: "Döndürülecek maksimum kayıt sayısı (varsayılan: 10, maks: 100)"
                    }
                },
                required: ["organisation_id", "sheet"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: "GAIA_UPLOAD_FILE",
            description: "Gaia'da bir objeye dosya yükler. Önce GAIA_LIST_FIELDS ile hangi field'ın file tipi olduğunu öğren, customfield_id'yi oradan al. Dosyayı belirtilen objeye (search_type + object_search_value ile bulunur) yükler ve o field'a atar.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: {
                        type: "string",
                        description: "Organizasyonun benzersiz ID'si"
                    },
                    sheet: {
                        type: "string",
                        description: "Dosyanın yükleneceği tablo adı (isteğe bağlı, log için)"
                    },
                    customfield_id: {
                        type: "string",
                        description: "Dosyanın atanacağı custom field'ın ID'si (GAIA_LIST_FIELDS'tan alınır)"
                    },
                    search_type: {
                        type: "string",
                        description: "Objeyi bulmak için arama tipi (örn: 'uniqueid', 'reference')"
                    },
                    object_search_value: {
                        type: "string",
                        description: "Objeyi bulmak için arama değeri"
                    },
                    filename: {
                        type: "string",
                        description: "Yüklenecek dosyanın adı (uzantısıyla birlikte, örn: 'rapor.pdf')"
                    },
                    content: {
                        type: "string",
                        description: "Dosyanın içeriği (base64 veya text)"
                    },
                    private: {
                        type: "boolean",
                        description: "Dosya gizli mi? (varsayılan: false)"
                    }
                },
                required: ["organisation_id", "customfield_id", "search_type", "object_search_value", "filename", "content"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: "GAIA_MODIFY_OBJECT",
            description: "Gaia'da belirtilen tabloda bir kaydı arar ve günceller. Kayıt bulunamazsa NotAvailable:true olarak YENİ bir kayıt oluşturur — asla 'bulunamadı' hatası döndürmez. fieldtosearch ile arama kriteri belirt, fields ile güncellenecek değerleri gönder.",
            parameters: {
                type: "object",
                properties: {
                    organisation_id: {
                        type: "string",
                        description: "Organizasyonun benzersiz ID'si"
                    },
                    sheet: {
                        type: "string",
                        description: "Güncellenecek tablo adı"
                    },
                    fieldtosearch: {
                        type: "string",
                        enum: ["uniqueid", "reference"],
                        description: "Kaydı bulmak için kullanılacak alan: 'uniqueid' (Bubble _id) veya 'reference' (referans değeri)"
                    },
                    search_value: {
                        type: "string",
                        description: "Aranacak değer (fieldtosearch alanındaki değer)"
                    },
                    action: {
                        type: "string",
                        description: "Uygulama butonu / aksiyon değeri (isteğe bağlı)"
                    },
                    fields: {
                        type: "object",
                        description: "Güncellenecek/oluşturulacak alanlar. GAIA_LIST_FIELDS'tan dönen key'leri kullan. Örn: { 'durum': 'tamamlandı', 'not': 'güncellendi' }",
                        additionalProperties: true
                    }
                },
                required: ["organisation_id", "sheet", "fieldtosearch", "search_value", "fields"]
            }
        }
    }

];

// ─── HANDLERS ────────────────────────────────────────────────────────────────

const HANDLERS = {

    GAIA_LIST_FIELDS: async (args, properties) => {
        const base = getBubbleBase(properties.app_version);
        const token = properties.bubble_api_key || properties.admin_api_key || "";

        const res = await axios.post(
            `https://geit-prototip.bubbleapps.io/${(properties.app_version || "").trim() ? (properties.app_version.trim() + "/") : ""}api/1.1/wf/customfield`,
            {
                organisation_id: args.organisation_id,
                sheet: args.sheet
            },
            {
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                timeout: 15000
            }
        );

        const fields = res.data;
        return {
            success: true,
            sheet: args.sheet,
            fields: fields
        };
    },

    GAIA_CREATE_OBJECT: async (args, properties) => {
        const token = properties.bubble_api_key || properties.admin_api_key || "";
        const appVersion = (properties.app_version || "").trim();
        const versionPath = appVersion ? `${appVersion}/` : "";

        // fields objesini keyValuePairs array'e dönüştür
        const keyValuePairs = Object.entries(args.fields || {}).map(([key, value]) => ({ key, value }));

        const res = await axios.post(
            `https://gaiasphere.io/${versionPath}api/1.1/wf/apicreateobject`,
            {
                sheet: args.sheet,
                organisation_id: args.organisation_id,
                action: args.action || "",
                referencevalue: args.referencevalue || "",
                keyValuePairs: keyValuePairs
            },
            {
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                timeout: 15000
            }
        );

        return {
            success: true,
            result: res.data
        };
    },

    GAIA_SEARCH_OBJECT: async (args, properties) => {
        const token = properties.bubble_api_key || properties.admin_api_key || "";
        const appVersion = (properties.app_version || "").trim();
        const versionPath = appVersion ? `${appVersion}/` : "";

        // unique_id varsa direkt /obj/Object/:id endpoint'i ile tek kayıt getir
        if (args.unique_id) {
            const res = await axios.get(
                `https://gaiasphere.io/${versionPath}api/1.1/obj/Object/${args.unique_id}`,
                {
                    headers: {
                        "Accept": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    timeout: 15000
                }
            );
            const record = res.data.response || res.data;
            return {
                success: true,
                count: 1,
                remaining: 0,
                results: [record]
            };
        }

        const cursor = args.cursor || 0;
        const limit = Math.min(args.limit || 10, 100);

        // Constraint'leri oluştur
        const constraints = [];

        // organisation_id her zaman filtrele
        constraints.push({
            key: "organisation_id",
            constraint_type: "equals",
            value: args.organisation_id
        });

        // sheet (tablo) filtresi
        constraints.push({
            key: "sheet",
            constraint_type: "equals",
            value: args.sheet
        });

        // referencevalue araması
        if (args.referencevalue) {
            constraints.push({
                key: "referedeğer",
                constraint_type: "equals",
                value: args.referencevalue
            });
        }

        // search_fields → jsonarray contains araması
        // jsonarray alanı "key":"value" (text) veya "key":value (number) formatında tutar
        if (args.search_fields && Object.keys(args.search_fields).length > 0) {
            for (const [key, value] of Object.entries(args.search_fields)) {
                const jsonEntry = typeof value === "number"
                    ? `"${key}":${value}`
                    : `"${key}":"${value}"`;
                constraints.push({
                    key: "jsonarray",
                    constraint_type: "contains",
                    value: jsonEntry
                });
            }
        }

        const res = await axios.get(
            `https://gaiasphere.io/${versionPath}api/1.1/obj/Object`,
            {
                params: {
                    constraints: JSON.stringify(constraints),
                    cursor: cursor,
                    limit: limit
                },
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                timeout: 15000
            }
        );

        const data = res.data.response || res.data;
        return {
            success: true,
            count: data.count || 0,
            remaining: data.remaining || 0,
            results: data.results || []
        };
    },

    GAIA_UPLOAD_FILE: async (args, properties) => {
        const token = properties.bubble_api_key || properties.admin_api_key || "";
        const appVersion = (properties.app_version || "").trim();
        const versionPath = appVersion ? `${appVersion}/` : "";

        const res = await axios.post(
            `https://gaiasphere.io/${versionPath}api/1.1/wf/uploadfile`,
            {
                key_file: {
                    filename: args.filename,
                    contents: args.content,
                    private: args.private || false
                },
                customfield_id: args.customfield_id,
                organisation_id: args.organisation_id,
                object_search_value: args.object_search_value,
                search_type: args.search_type
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                timeout: 30000
            }
        );

        return {
            success: true,
            result: res.data
        };
    },

    GAIA_MODIFY_OBJECT: async (args, properties) => {
        const token = properties.bubble_api_key || properties.admin_api_key || "";
        const appVersion = (properties.app_version || "").trim();
        const versionPath = appVersion ? `${appVersion}/` : "";

        // 1) Önce kaydı bul
        const constraints = [
            { key: "organisation_id", constraint_type: "equals", value: args.organisation_id },
            { key: "sheet", constraint_type: "equals", value: args.sheet }
        ];

        if (args.fieldtosearch === "uniqueid") {
            constraints.push({ key: "_id", constraint_type: "equals", value: args.search_value });
        } else {
            // reference
            constraints.push({ key: "referedeğer", constraint_type: "equals", value: args.search_value });
        }

        let foundId = null;
        try {
            const searchRes = await axios.get(
                `https://gaiasphere.io/${versionPath}api/1.1/obj/Object`,
                {
                    params: {
                        constraints: JSON.stringify(constraints),
                        cursor: 0,
                        limit: 1
                    },
                    headers: {
                        "Accept": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    timeout: 15000
                }
            );
            const data = searchRes.data.response || searchRes.data;
            const results = data.results || [];
            if (results.length > 0) {
                foundId = results[0]._id;
            }
        } catch (searchErr) {
            // Arama başarısız olsa bile devam et — create ile kurtarılacak
        }

        const keyValuePairs = Object.entries(args.fields || {}).map(([key, value]) => ({ key, value }));

        if (foundId) {
            // 2a) Kayıt bulundu → güncelle
            const res = await axios.post(
                `https://gaiasphere.io/${versionPath}api/1.1/wf/apimodifyobject`,
                {
                    sheet: args.sheet,
                    organisation_id: args.organisation_id,
                    object_id: foundId,
                    action: args.action || "",
                    keyValuePairs: keyValuePairs
                },
                {
                    headers: {
                        "Accept": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    timeout: 15000
                }
            );
            return {
                success: true,
                operation: "modified",
                object_id: foundId,
                result: res.data
            };
        } else {
            // 2b) Kayıt bulunamadı → NotAvailable:true ile oluştur (ZORUNLU)
            const createPairs = [
                ...keyValuePairs,
                { key: "NotAvailable", value: true }
            ];

            // referencevalue alanını da ekle
            const referencevalue = args.fieldtosearch === "reference" ? args.search_value : "";

            const res = await axios.post(
                `https://gaiasphere.io/${versionPath}api/1.1/wf/apicreateobject`,
                {
                    sheet: args.sheet,
                    organisation_id: args.organisation_id,
                    action: args.action || "",
                    referencevalue: referencevalue,
                    keyValuePairs: createPairs
                },
                {
                    headers: {
                        "Accept": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    timeout: 15000
                }
            );
            return {
                success: true,
                operation: "created_not_available",
                note: "Kayıt bulunamadı, NotAvailable:true ile yeni kayıt oluşturuldu.",
                result: res.data
            };
        }
    }

};

// ─── DISPATCHER ──────────────────────────────────────────────────────────────

/**
 * Native tool çağrısını çalıştırır.
 * @param {string} toolName - Tool adı (örn: "GAIA_CREATE_OBJECT")
 * @param {object} args - Agent'ın gönderdiği argümanlar
 * @param {object} properties - Bubble'dan gelen tüm request properties
 * @returns {string} - Agent'a geri dönecek sonuç (string)
 */
async function handleNativeTool(toolName, args, properties) {
    const handler = HANDLERS[toolName];
    if (!handler) {
        throw new Error(`Native tool bulunamadı: ${toolName}`);
    }
    const result = await handler(args, properties);
    return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * Verilen tool adının native tool olup olmadığını kontrol eder.
 * @param {string} toolName
 * @returns {boolean}
 */
function isNativeTool(toolName) {
    return Object.prototype.hasOwnProperty.call(HANDLERS, toolName);
}

module.exports = { DEFINITIONS, handleNativeTool, isNativeTool };
