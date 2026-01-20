const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit'); 
const ILovePDFApi = require('@ilovepdf/ilovepdf-nodejs'); 

// --- IMPORTAR INTEGRACIÓN AI CORE ---
const { callDeployedAICore, CORRECTIONS_FILE } = require('./ai-core-integration');

// --- CARGA DE CREDENCIALES ---
let env;
try { env = require('../default-env.json'); } catch (e) { env = process.env; }
if (env.VCAP_SERVICES && typeof env.VCAP_SERVICES === 'string') {
    try { env.VCAP_SERVICES = JSON.parse(env.VCAP_SERVICES); } catch(e){}
}

const doxCreds = env.VCAP_SERVICES && env.VCAP_SERVICES['document-ai'] ? env.VCAP_SERVICES['document-ai'][0].credentials : null;
const doxServiceUrl = doxCreds ? doxCreds.baseurl.replace(/\/$/, "") : null;
const SANDBOX_API_KEY = env["SANDBOX-API-KEY"] || env.SANDBOX_API_KEY;

// CREDENCIALES ILOVEPDF
const ILOVEPDF_PUBLIC_KEY = "project_public_b969a38fd4601924ed29a0b22c2dbf7c_9f-Gj2993a87832a396acedd998c2dc10a9e8";
const ILOVEPDF_SECRET_KEY = "secret_key_628753aae97614d5f2683b024f4b7153_k8nCd3d52ff56bf07565d8e0169dfd788a1aa";

const CLIENT_ID = "c_00"; 

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../app')));
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- HELPERS ---
async function getDoxToken() {
    if(!doxCreds) throw new Error("Faltan credenciales DOX");
    const p = new URLSearchParams({grant_type:'client_credentials', client_id:doxCreds.clientid, client_secret:doxCreds.clientsecret});
    const r = await axios.post(doxCreds.tokenurl, p);
    return r.data.access_token;
}

async function waitForJob(jobId, token) {
    let status = 'PENDING', attempts = 0, data = null;
    while (status !== 'DONE' && status !== 'FAILED' && attempts < 40) {
        attempts++; await new Promise(r => setTimeout(r, 1000));
        try {
            const r = await axios.get(`${doxServiceUrl}/document/jobs/${jobId}?clientId=${CLIENT_ID}`, { headers: { Authorization: `Bearer ${token}` }});
            status = r.data.status; data = r.data;
        } catch (e) {}
    }
    return data;
}

function imageToPdfBuffer(imagePath) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ autoFirstPage: false });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            const img = doc.openImage(imagePath);
            doc.addPage({ size: [img.width, img.height] });
            doc.image(img, 0, 0);
            doc.end();
        } catch (e) { reject(e); }
    });
}

async function convertDocxToPdfILovePDF(docxBuffer) {
    console.log("-> [iLovePDF] DOCX a PDF...");
    const instance = new ILovePDFApi(ILOVEPDF_PUBLIC_KEY, ILOVEPDF_SECRET_KEY);
    const task = instance.newTask('officepdf');
    await task.start();
    const tempIn = path.join('uploads', `temp_${Date.now()}.docx`);
    const tempOut = path.join('uploads'); 
    fs.writeFileSync(tempIn, docxBuffer);
    try {
        await task.addFile(tempIn); await task.process(); await task.download(tempOut); 
        const pdfName = path.basename(tempIn, '.docx') + '.pdf';
        const pdfPath = path.join(tempOut, pdfName);
        if (fs.existsSync(pdfPath)) { const b = fs.readFileSync(pdfPath); fs.unlinkSync(pdfPath); return b; } 
        else throw new Error("No PDF generated");
    } finally { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); }
}

// --- ENDPOINTS ---

// 1. UPLOAD (SCHEMA ESTÁNDAR)
app.post('/uploadInvoice', upload.single('file'), async (req, res) => {
    let filePath = req.file.path;
    try {
        console.log(`-> [Upload] Recibido: ${req.file.originalname}`);
        const token = await getDoxToken();
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath), { filename: req.file.originalname, contentType: req.file.mimetype });
        
        const options = { clientId: CLIENT_ID, documentType: "invoice", schemaName: "SAP_invoice_schema", receivedDate: new Date().toISOString().split('T')[0] };
        form.append('options', JSON.stringify(options));

        const upRes = await axios.post(`${doxServiceUrl}/document/jobs?clientId=${CLIENT_ID}`, form, { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }});
        console.log(`-> [Upload] Job ID: ${upRes.data.id}`);
        const sapResult = await waitForJob(upRes.data.id, token);

        let correctionsDB = {};
        if (fs.existsSync(CORRECTIONS_FILE)) { try { correctionsDB = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8')); } catch (e) {} }
        const historyKeys = Object.keys(correctionsDB);
        
        if (historyKeys.length > 0) {
            console.log("-> 🧠 AI Core: Mejorando...");
            const recentHistory = historyKeys.slice(-5).map(k => correctionsDB[k]);
            const rawExtraction = { headerFields: sapResult.extraction.headerFields, lineItems: sapResult.extraction.lineItems };
            const prompt = `Actúa como validador de facturas. HISTORIAL: ${JSON.stringify(recentHistory, null, 2)}. EXTRACCIÓN: ${JSON.stringify(rawExtraction, null, 2)}. Devuelve JSON corregido.`;

            try {
                const aiResponse = await callDeployedAICore(prompt);
                const jsonStart = aiResponse.indexOf('{');
                const jsonEnd = aiResponse.lastIndexOf('}') + 1;
                if (jsonStart !== -1) {
                    const improvedData = JSON.parse(aiResponse.substring(jsonStart, jsonEnd));
                    if (improvedData.headerFields) sapResult.extraction.headerFields = improvedData.headerFields;
                    if (improvedData.lineItems) sapResult.extraction.lineItems = improvedData.lineItems;
                    console.log("-> ✅ Mejorado.");
                }
            } catch (aiErr) { console.error("-> ⚠️ AI Error:", aiErr.message); }
        }
        res.json(sapResult);
    } catch (e) {
        console.error("❌ Error Upload:", e.message);
        res.status(500).json({ error: e.message });
    } finally { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
});

// 2. CONFIRM
app.post('/confirmDocument', async (req, res) => {
    try {
        const { jobId, headerFields, lineItems } = req.body;
        let db = {};
        if (fs.existsSync(CORRECTIONS_FILE)) { try { db = JSON.parse(fs.readFileSync(CORRECTIONS_FILE)); } catch (e) {} }
        db[jobId] = { headerFields, lineItems, confirmedAt: new Date().toISOString() };
        fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(db, null, 2));
        
        const token = await getDoxToken();
        const url = `${doxServiceUrl}/document/jobs/${jobId}/confirm?clientId=${CLIENT_ID}`;
        await axios.post(url, { headerFields, lineItems }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
        res.json({ status: "success", message: "Confirmado." });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. TRANSLATE (CORREGIDO PARA ORIGINAL)
app.post('/translateFile', upload.single('file'), async (req, res) => {
    let filePath = req.file.path;
    try {
        const { sourceLang, targetLang, convertToPdf } = req.body;
        const mimeType = req.file.mimetype;
        let fileBuffer, filenameToSend, contentTypeToSend;

        if ((convertToPdf === "true" || convertToPdf === true) && mimeType.startsWith('image/')) {
            fileBuffer = await imageToPdfBuffer(filePath);
            filenameToSend = "src.pdf"; contentTypeToSend = "application/pdf";
        } else {
            fileBuffer = fs.readFileSync(filePath);
            filenameToSend = req.file.originalname; contentTypeToSend = mimeType;
        }

        const form = new FormData();
        form.append('file', fileBuffer, { filename: filenameToSend, contentType: contentTypeToSend });
        
        const sapRes = await axios.post("https://sandbox.api.sap.com/sapdocumenttranslation/translation", form, {
            params: { sourceLanguage: sourceLang||"en-US", targetLanguage: targetLang||"es-ES", strictMode:'false', model:'llm' },
            headers: { 'APIKey': SANDBOX_API_KEY, ...form.getHeaders() }
        });

        if (sapRes.data && sapRes.data.data) {
            let resBuff = Buffer.from(sapRes.data.data, 'base64');
            // MimeType por defecto: DOCX
            let outMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            
            // DETECTAR TIPO DE ORIGINAL
            if(contentTypeToSend.includes("sheet") || contentTypeToSend.includes("excel")) {
                outMime = "application/vnd.openxmlformats-officedocument.sheetml.sheet"; // Excel
            } else if (contentTypeToSend.includes("presentation") || contentTypeToSend.includes("powerpoint")) {
                outMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"; // PPTX
            }

            // SOLO CONVERTIR A PDF SI SE PIDE Y NO ES EXCEL/PPT (iLovePDF suele fallar con PPT complejo, mejor dejar nativo)
            if ((convertToPdf === "true" || convertToPdf === true) && !outMime.includes("sheet") && !outMime.includes("presentation")) {
                try { resBuff = await convertDocxToPdfILovePDF(resBuff); outMime = "application/pdf"; } catch(e){ console.error("iLovePDF Fail:", e.message); }
            }
            res.set('Content-Type', outMime); res.send(resBuff);
        } else { res.json(sapRes.data); }

    } catch (e) { console.error("Trans Err:", e.message); res.status(500).json({ error: "Error traducción" }); } 
    finally { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`Backend ready: ${PORT}`));