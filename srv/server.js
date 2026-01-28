const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors'); 

// --- CARGA DE CREDENCIALES ---
let env;
try { env = require('../default-env.json'); } catch (e) { env = process.env; }
if (env.VCAP_SERVICES && typeof env.VCAP_SERVICES === 'string') {
    try { env.VCAP_SERVICES = JSON.parse(env.VCAP_SERVICES); } catch(e){}
}

const doxCreds = env.VCAP_SERVICES && env.VCAP_SERVICES['document-information-extraction'] ? env.VCAP_SERVICES['document-information-extraction'][0].credentials : null;
const doxServiceUrl = doxCreds ? (doxCreds.url || doxCreds.baseurl).replace(/\/$/, "") : null;

const transCreds = env.VCAP_SERVICES && env.VCAP_SERVICES['document-translation'] ? env.VCAP_SERVICES['document-translation'][0].credentials : null;

// CREDENCIALES ILOVEPDF
const ILOVEPDF_PUBLIC_KEY = env.ILOVEPDF_PUBLIC_KEY // || "project_public_key";
const CLIENT_ID = "c_00"; 

const app = express();
app.use(cors()); 
app.use(express.json());
app.use(express.static(path.join(__dirname, '../app'))); 

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- HELPERS AUTENTICACIÓN ---

async function getDoxToken() {
    if(!doxCreds) throw new Error("Faltan credenciales DOX");
    const p = new URLSearchParams({grant_type:'client_credentials', client_id:doxCreds.clientid, client_secret:doxCreds.clientsecret});
    const r = await axios.post((doxCreds.uaa ? doxCreds.uaa.url : doxCreds.url) + "/oauth/token", p);
    return r.data.access_token;
}

async function getTransToken() {
    if(!transCreds) throw new Error("Faltan credenciales Translation");
    const p = new URLSearchParams({grant_type:'client_credentials', client_id:transCreds.clientid, client_secret:transCreds.clientsecret});
    const r = await axios.post(`${transCreds.uaa.url}/oauth/token`, p);
    return r.data.access_token;
}

async function waitForJob(jobId, token) {
    let status = 'PENDING', attempts = 0, data = null;
    while (status !== 'DONE' && status !== 'FAILED' && attempts < 40) {
        attempts++; await new Promise(r => setTimeout(r, 1000));
        try {
            const url = `${doxServiceUrl}/document-information-extraction/v1/document/jobs/${jobId}?clientId=${CLIENT_ID}`;
            const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }});
            status = r.data.status; data = r.data;
        } catch (e) {}
    }
    return data;
}

// --- HELPER DE DETECCIÓN DE FORMATO (MAGIC BYTES) ---
function detectBufferType(buffer) {
    if (!buffer || buffer.length < 10) return 'unknown';
    const header = buffer.slice(0, 10).toString('hex');
    // Firmas mágicas
    if (header.startsWith('25504446')) return 'pdf'; // %PDF
    if (header.startsWith('504b0304')) return 'office'; // PK.. (Zip: Docx, Xlsx, Pptx)
    return 'unknown';
}

// --- HELPER ILOVEPDF REST MANUAL ---
async function runILovePDFManual(fileBuffer, originalExtension, toolName) {
    console.log(`-> [iLovePDF] Herramienta: ${toolName.toUpperCase()} (Origen .${originalExtension})`);
    
    // 1. AUTH
    const authRes = await axios.post('https://api.ilovepdf.com/v1/auth', { public_key: ILOVEPDF_PUBLIC_KEY });
    const token = authRes.data.token;
    
    // 2. START
    const startRes = await axios.get(`https://api.ilovepdf.com/v1/start/${toolName}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const server = startRes.data.server;
    const task = startRes.data.task;

    // 3. UPLOAD
    const tempPath = path.join('uploads', `upload_${task}.${originalExtension}`);
    fs.writeFileSync(tempPath, fileBuffer);
    
    try {
        const form = new FormData();
        form.append('task', task);
        // Es vital poner un nombre de archivo correcto aquí para que iLovePDF sepa qué formato entra
        form.append('file', fs.createReadStream(tempPath), { filename: `input.${originalExtension}` });

        const uploadRes = await axios.post(`https://${server}/v1/upload`, form, { 
            headers: { 'Authorization': `Bearer ${token}`, ...form.getHeaders() } 
        });
        const serverFilename = uploadRes.data.server_filename;

        // 4. PROCESS
        await axios.post(`https://${server}/v1/process`, {
            task: task,
            tool: toolName,
            files: [{ server_filename: serverFilename, filename: `output.${originalExtension}` }]
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        // 5. DOWNLOAD
        await new Promise(r => setTimeout(r, 1000)); 
        const downloadRes = await axios.get(`https://${server}/v1/download/${task}`, { 
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'arraybuffer' 
        });

        console.log(`   -> Generado PDF (${downloadRes.data.length} bytes)`);
        return downloadRes.data;

    } catch (e) {
        console.error(`❌ iLovePDF Error:`, e.response ? e.response.data : e.message);
        throw e;
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

// --- ENDPOINTS ---

app.post('/uploadInvoice', upload.single('file'), async (req, res) => {
    let filePath = req.file.path;
    try {
        const token = await getDoxToken();
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath), { filename: req.file.originalname, contentType: req.file.mimetype });
        const options = { clientId: CLIENT_ID, documentType: "invoice", schemaName: "SAP_invoice_schema", receivedDate: new Date().toISOString().split('T')[0] };
        form.append('options', JSON.stringify(options));
        const upRes = await axios.post(`${doxServiceUrl}/document-information-extraction/v1/document/jobs?clientId=${CLIENT_ID}`, form, { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }});
        const sapResult = await waitForJob(upRes.data.id, token);
        res.json(sapResult);
    } catch (e) { res.status(500).json({ error: e.message }); } finally { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
});

app.post('/confirmDocument', async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) throw new Error("Falta el Job ID para confirmar");

        console.log(`-> [Confirm] Confirmando documento en SAP: ${jobId}`);
        const token = await getDoxToken();

        // Llamada a POST /document/jobs/{id}/confirm
        const url = `${doxServiceUrl}/document-information-extraction/v1/document/jobs/${jobId}/confirm?clientId=${CLIENT_ID}`;
        
        const response = await axios.post(url, {}, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        console.log("-> [Confirm] Documento confirmado exitosamente.");
        res.json(response.data); // Devuelve { status: "CONFIRMED", ... }

    } catch (e) {
        console.error("❌ Error en Confirm Document:", e.message);
        if (e.response) console.error("Detalle SAP:", JSON.stringify(e.response.data));
        res.status(500).json({ error: "Error al confirmar: " + e.message });
    }
});


// 3. TRANSLATE (FLUJO CORREGIDO PARA FORZAR PDF AL FINAL)
app.post('/translateFile', upload.single('file'), async (req, res) => {
    let filePath = req.file.path;
    try {
        const { sourceLang, targetLang, convertToPdf } = req.body;
        const mimeType = req.file.mimetype;
        
        let fileBuffer = fs.readFileSync(filePath);
        let filenameToSend = req.file.originalname; 
        let contentTypeToSend = mimeType;

        // --- PASO 1: CONVERTIR IMAGEN A PDF (Si aplica) ---
        if (mimeType.startsWith('image/')) {
            console.log("-> 1. Convirtiendo Imagen a PDF (Pre-Traducción)...");
            let imgExt = path.extname(filenameToSend).replace('.', '') || 'jpg';
            // Usamos 'imagepdf' de iLovePDF
            fileBuffer = await runILovePDFManual(fileBuffer, imgExt, 'imagepdf');
            
            // Ahora nuestro archivo fuente para SAP es un PDF
            filenameToSend = "source_image.pdf";
            contentTypeToSend = "application/pdf";
        }

        // --- PASO 2: ENVIAR A SAP TRANSLATION ---
        console.log(`-> 2. Enviando a SAP Translation (${sourceLang} -> ${targetLang})...`);
        const token = await getTransToken();
        const form = new FormData();
        form.append('file', fileBuffer, { filename: filenameToSend, contentType: contentTypeToSend });
        form.append('sourceLanguage', sourceLang);
        form.append('targetLanguage', targetLang); 

        const sapRes = await axios.post(`${transCreds.documenttranslation.url}/api/v1/translation`, form, {
            headers: { 'Authorization': `Bearer ${token}`, ...form.getHeaders() }
        });

        // Decodificar respuesta de SAP
        let resBuff;
        if (sapRes.data && sapRes.data.data) {
             resBuff = Buffer.from(sapRes.data.data, 'base64');
        } else {
             resBuff = Buffer.from(sapRes.data); 
        }

        // --- PASO 3: INSPECCIONAR Y CONVERTIR A PDF DE NUEVO ---
        const typeReturned = detectBufferType(resBuff);
        console.log(`-> SAP devolvió un archivo tipo: [${typeReturned.toUpperCase()}]`);

        let finalBuffer = resBuff;
        let finalMime = contentTypeToSend; // Default al mismo que enviamos (o docx)

        const userWantsPdf = (convertToPdf === "true" || convertToPdf === true);

        if (userWantsPdf) {
            // Si el usuario quiere PDF, nos aseguramos que salga PDF
            if (typeReturned === 'pdf') {
                console.log("-> El resultado ya es PDF. Todo listo.");
                finalMime = "application/pdf";
            } else if (typeReturned === 'office') {
                console.log("-> El resultado es Office (Word/Excel). Convirtiendo a PDF Final...");
                
                // Determinamos qué tipo de Office es basado en lo que enviamos originalmente
                let conversionInputExt = "docx"; // Default
                if (contentTypeToSend.includes("sheet") || contentTypeToSend.includes("excel")) {
                    conversionInputExt = "xlsx";
                } else if (contentTypeToSend.includes("presentation") || contentTypeToSend.includes("powerpoint")) {
                    conversionInputExt = "pptx";
                }
                // Si enviamos PDF/Imagen y volvió Office, seguro es DOCX (comportamiento standard de SAP)
                
                finalBuffer = await runILovePDFManual(resBuff, conversionInputExt, 'officepdf');
                finalMime = "application/pdf";
            }
        } else {
            // Si el usuario NO pidió PDF, determinamos el MIME correcto del Office
            if (typeReturned === 'office') {
                // Intentamos adivinar si es xlsx, pptx o docx
                if (contentTypeToSend.includes("sheet")) finalMime = "application/vnd.openxmlformats-officedocument.sheetml.sheet";
                else if (contentTypeToSend.includes("presentation")) finalMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
                else finalMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            }
        }

        res.set('Content-Type', finalMime); 
        res.send(finalBuffer);

    } catch (e) { 
        console.error("Trans Err:", e.message); 
        if(e.response && e.response.data) {
             try { console.error("Body:", JSON.stringify(e.response.data)); } catch(x){ console.error("Body:", e.response.data.toString()); }
        }
        res.status(500).json({ error: "Error traducción: " + e.message }); 
    } finally { 
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
    }
});

app.post('/updateDocument', async (req, res) => {
    try {
        // Recibimos el ID y los datos estructurados (cabecera e items)
        const { jobId, headerFields, lineItems } = req.body;
        
        if (!jobId) throw new Error("Falta el Job ID");

        console.log(`-> [Update] Enviando correcciones a SAP para Job: ${jobId}`);
        const token = await getDoxToken();

        // Construimos el payload exacto que pide el Swagger de SAP
        // Nota: lineItems debe ser un array de arrays (filas -> campos)
        const payload = {
            extraction: {
                headerFields: headerFields || [],
                lineItems: lineItems || [] 
            }
        };

        const url = `${doxServiceUrl}/document-information-extraction/v1/document/jobs/${jobId}?clientId=${CLIENT_ID}`;
        
        // Llamada a POST /document/jobs/{id}
        await axios.post(url, payload, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        console.log("-> [Update] Datos guardados correctamente en SAP.");
        res.json({ status: "success", message: "Ground truth updated" });

    } catch (e) {
        console.error("❌ Error en Update Document:", e.message);
        if (e.response) console.error("Detalle SAP:", JSON.stringify(e.response.data));
        res.status(500).json({ error: "Error al actualizar datos: " + e.message });
    }
});


const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`Backend ready: ${PORT}`));