const axios = require('axios');
const path = require('path');
const fs = require('fs');

// URL de tu chatbot desplegado (NO CAMBIES esto)
const AI_CORE_CHAT_URL = 'https://asistente-sap-ia-tired-gazelle-zq.cfapps.us10-001.hana.ondemand.com/chat';

// Archivo para guardar correcciones localmente (por jobId)
const CORRECTIONS_FILE = path.join(__dirname, 'corrections.json');

// Función para llamar al chatbot desplegado
async function callDeployedAICore(prompt) {
  try {
    const response = await axios.post(AI_CORE_CHAT_URL, { question: prompt }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 45000  // 45 segundos max (gpt-4o-mini es rápido, pero por si acaso)
    });

    if (!response.data || !response.data.response) {
      throw new Error('Respuesta inválida del chatbot AI Core');
    }

    return response.data.response.trim();
  } catch (error) {
    console.error('Error llamando al chatbot AI Core desplegado:', error.message);
    throw error;
  }
}

// Exportar lo necesario
module.exports = {
  callDeployedAICore,
  CORRECTIONS_FILE
};