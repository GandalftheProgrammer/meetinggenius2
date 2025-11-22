
import { GoogleGenAI, Type } from "@google/genai";

// The API Key is SECURELY loaded here on the server.
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is missing in Netlify Env Vars");

const ai = new GoogleGenAI({ apiKey });
const MODEL_NAME = "gemini-3-pro-preview";

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body);
    const { action } = payload;

    // --- ACTION 1: AUTHORIZE UPLOAD (Handshake) ---
    // This gets a Signed Upload URL from Google so the frontend can upload directly.
    if (action === 'authorize_upload') {
      const { mimeType, fileSize } = payload;
      
      // We have to make a raw REST call to get the Upload URL because the Node SDK 
      // abstracts this step and tries to upload the file itself (which we can't do here due to size).
      const initResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': fileSize,
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json'
        },
        // FIX: The API requires the metadata to be wrapped in a 'file' object
        // and uses snake_case ('display_name') for the JSON field.
        body: JSON.stringify({ 
            file: {
                display_name: `Meeting_Audio_${Date.now()}` 
            }
        })
      });

      if (!initResponse.ok) {
         const errText = await initResponse.text();
         console.error("Google Upload Init Failed", initResponse.status, errText);
         throw new Error(`Google Handshake Failed (${initResponse.status}): ${errText}`);
      }

      const uploadUrl = initResponse.headers.get('x-goog-upload-url');
      
      return {
        statusCode: 200,
        body: JSON.stringify({ uploadUrl }),
        headers: { 'Content-Type': 'application/json' }
      };
    }

    // --- ACTION 2: GENERATE CONTENT ---
    // The frontend tells us the file is already uploaded at `fileUri`.
    if (action === 'generate') {
      const { fileUri, mimeType, mode } = payload;

      // 1. Construct Prompts (Same logic as before)
      let systemInstruction = `
        You are an expert professional meeting secretary. 
        Listen to the attached audio recording of a meeting.
        
        CRITICAL INSTRUCTION - SILENCE DETECTION:
        Before processing, verify if there is intelligible speech in the audio.
        - If the audio is silent or just noise, output the FALLBACK JSON.
        
        CRITICAL INSTRUCTION - LANGUAGE DETECTION:
        1. Detect the dominant language spoken in the audio.
        2. You MUST write the "summary", "decisions", and "actionItems" in that EXACT SAME LANGUAGE.
        
        FALLBACK JSON (Only if silence):
        {
            "transcription": "[No intelligible speech detected]",
            "summary": "No conversation was detected in the audio recording.",
            "decisions": [],
            "actionItems": []
        }
      `;

      let taskInstruction = "";
      const transcriptionSchema = { type: Type.STRING, description: "Full verbatim transcription" };
      const summarySchema = { type: Type.STRING, description: "A concise summary" };
      const decisionsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key decisions" };
      const actionItemsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Action items" };

      let schemaProperties: any = {};
      let requiredFields: string[] = [];

      if (mode === 'TRANSCRIPT_ONLY') {
        taskInstruction = "Your task is to Transcribe the audio verbatim. Do not generate summary or notes.";
        schemaProperties = { transcription: transcriptionSchema };
        requiredFields = ["transcription"];
      } else if (mode === 'NOTES_ONLY') {
        taskInstruction = "Your task is to create structured meeting notes.";
        schemaProperties = { summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["summary", "decisions", "actionItems"];
      } else {
        taskInstruction = "Your task is to Transcribe the audio verbatim AND create structured meeting notes.";
        schemaProperties = { transcription: transcriptionSchema, summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["transcription", "summary", "decisions", "actionItems"];
      }

      // 2. Call Gemini with the File URI
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: {
          parts: [
             { fileData: { fileUri: fileUri, mimeType: mimeType } },
             { text: systemInstruction + "\n\n" + taskInstruction + "\n\nReturn the output strictly in JSON format." }
          ]
        },
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: schemaProperties,
                required: requiredFields,
            },
        }
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ text: response.text }),
        headers: { 'Content-Type': 'application/json' }
      };
    }

    return { statusCode: 400, body: "Invalid Action" };

  } catch (error: any) {
    console.error('Backend Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
