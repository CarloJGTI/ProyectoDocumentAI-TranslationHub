const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// --- CARGA DE CREDENCIALES ---
let env;
try { 
    env = require('../default-env.json'); 
} catch (e) { 
    process.exit(1); 
}

const doxCreds = env.VCAP_SERVICES['document-ai'][0].credentials;
const doxServiceUrl = doxCreds.baseurl.replace(/\/$/, ""); 
const SANDBOX_API_KEY = env["SANDBOX-API-KEY"] || env.SANDBOX_API_KEY;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../app')));
const upload = multer({ dest: 'uploads/' });

// --- HELPERS ---
async function getDoxToken() {
    const p = new URLSearchParams({grant_type:'client_credentials', client_id:doxCreds.clientid, client_secret:doxCreds.clientsecret});
    const r = await axios.post(doxCreds.tokenurl, p);
    return r.data.access_token;
}

async function waitForJob(jobId, token) {
    let status = 'PENDING', attempts = 0, data = null;
    while (status !== 'DONE' && status !== 'FAILED' && attempts < 40) {
        attempts++; await new Promise(r => setTimeout(r, 1000));
        try {
            const r = await axios.get(`${doxServiceUrl}/document/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` }});
            status = r.data.status; data = r.data;
        } catch (e) {}
    }
    return data;
}

// --- ENDPOINTS ---

// 1. Extracción (Document AI)
app.post('/uploadInvoice', upload.single('file'), async (req, res) => {
    let filePath = null;
    try {
        if (!req.file) throw new Error("Falta archivo");
        filePath = req.file.path;
        
        const token = await getDoxToken();
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath), { filename: req.file.originalname, contentType: req.file.mimetype });
        form.append('options', JSON.stringify({ clientId: "c_00", documentType: "invoice", schemaName: "SAP_invoice_schema", receivedDate: new Date().toISOString().split('T')[0] }));

        const upRes = await axios.post(`${doxServiceUrl}/document/jobs`, form, { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }});
        const result = await waitForJob(upRes.data.id, token);
        res.json(result.extraction || result);

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});

// 2. Traducción (Sandbox con Base64)
app.post('/translateFile', upload.single('file'), async (req, res) => {
    let filePath = null;
    try {
        if (!req.file) throw new Error("Falta archivo");
        if (!SANDBOX_API_KEY) throw new Error("Falta SANDBOX-API-KEY");
        
        filePath = req.file.path;
        const sourceLang = req.body.sourceLang || "en-US";
        const targetLang = req.body.targetLang || "es-ES";

        console.log(`[SANDBOX] Traduciendo: ${req.file.originalname}`);
        
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath), { 
            filename: req.file.originalname, 
            contentType: req.file.mimetype 
        });

        const url = "https://sandbox.api.sap.com/sapdocumenttranslation/translation";

        // Solicitamos JSON porque el Sandbox devuelve el archivo en Base64 dentro de un JSON
        const response = await axios.post(url, form, {
            params: {
                sourceLanguage: sourceLang,
                targetLanguage: targetLang,
                strictMode: 'false',
                model: 'llm'
            },
            headers: { 
                'APIKey': SANDBOX_API_KEY, 
                ...form.getHeaders() 
            }
        });

        console.log(`[SANDBOX] Respuesta recibida. Procesando Base64...`);

        // --- LÓGICA DE DECODIFICACIÓN ---
        const responseData = response.data;

        if (responseData && responseData.data && responseData.encoding === "base64") {
            // 1. Convertimos el string Base64 a un Buffer binario real
            const fileBuffer = Buffer.from(responseData.data, 'base64');
            
            // 2. Configuramos cabeceras para descargar DOCX
            res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.set('Content-Length', fileBuffer.length);
            
            // 3. Enviamos el archivo limpio
            res.send(fileBuffer);
        } else {
            // Si por alguna razón no es el formato esperado, devolvemos lo que llegó
            console.warn("Formato inesperado, enviando raw...");
            res.json(responseData);
        }

    } catch (error) {
        console.error("Error Sandbox:", error.message);
        let errorMsg = "Error interno";
        if (error.response && error.response.data) {
            try { errorMsg = JSON.stringify(error.response.data); } catch(e) { errorMsg = error.response.data.toString(); }
            console.error("Detalle:", errorMsg);
        }
        res.status(500).json({ error: errorMsg });
    } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listo en ${PORT}`));