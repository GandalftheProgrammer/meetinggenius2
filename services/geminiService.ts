
import { GoogleGenAI, Type } from "@google/genai";
import { MeetingData, ProcessingMode } from '../types';

// Initialize Gemini Client (Client-side)
// In production/SaaS, this 'ai' instance is only used for File API uploads (which require a key currently in this demo)
// or we switch entirely to the backend proxy for generation.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const MODEL_NAME = "gemini-3-pro-preview";
// Toggle this to TRUE when you deploy to Netlify with the backend function
const USE_BACKEND_PROXY = false; 
const FILE_UPLOAD_THRESHOLD = 20 * 1024 * 1024; 

export const processMeetingAudio = async (
  audioBlob: Blob, 
  mimeType: string, 
  mode: ProcessingMode = 'ALL'
): Promise<MeetingData> => {
  try {
    console.log(`Processing Audio: ${audioBlob.size} bytes, mime: ${mimeType}, mode: ${mode}`);
    
    let contentPart: any;

    // --- STEP 1: HANDLE AUDIO DATA ---
    if (audioBlob.size < FILE_UPLOAD_THRESHOLD) {
      // SMALL FILE: Use Inline Data
      console.log("File is small. Using Inline Data.");
      const base64Data = await blobToBase64(audioBlob);
      contentPart = {
        inlineData: {
          mimeType: mimeType,
          data: base64Data,
        },
      };
    } else {
      // LARGE FILE: Use File API
      console.log("File > Threshold. Uploading via File API...");
      // Note: For a strict SaaS with no client-side keys, you would need a separate backend endpoint 
      // that handles signed URLs for uploads. For this demo, we still use the client key for the upload phase.
      const uploadResponse = await ai.files.upload({
        file: audioBlob,
        config: { mimeType: mimeType }
      });
      
      const fileUri = uploadResponse.uri;
      const fileMimeType = uploadResponse.mimeType;
      console.log(`File Uploaded. URI: ${fileUri}`);
      
      contentPart = {
        fileData: {
          fileUri: fileUri,
          mimeType: fileMimeType,
        },
      };
    }

    // --- STEP 2: CONSTRUCT PROMPT ---
    let systemInstruction = `
      You are an expert professional meeting secretary. 
      Listen to the attached audio recording of a meeting.
      
      CRITICAL INSTRUCTION - SILENCE DETECTION:
      Before processing, verify if there is intelligible speech in the audio.
      - If the audio is silent or just noise, output the FALLBACK JSON.
      
      CRITICAL INSTRUCTION - LANGUAGE DETECTION:
      1. Detect the dominant language spoken in the audio.
      2. You MUST write the "summary", "decisions", and "actionItems" in that EXACT SAME LANGUAGE.
      3. Do not translate the content into English if the meeting was in another language.
      
      FALLBACK JSON (Only if silence):
      {
        "transcription": "[No intelligible speech detected]",
        "summary": "No conversation was detected in the audio recording.",
        "decisions": [],
        "actionItems": []
      }
    `;

    let taskInstruction = "";
    
    // Schema setup
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
      taskInstruction = "Your task is to create structured meeting notes. Do not generate a full verbatim transcription.";
      schemaProperties = { summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
      requiredFields = ["summary", "decisions", "actionItems"];
    } else {
      taskInstruction = "Your task is to Transcribe the audio verbatim AND create structured meeting notes.";
      schemaProperties = { transcription: transcriptionSchema, summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
      requiredFields = ["transcription", "summary", "decisions", "actionItems"];
    }

    // --- STEP 3: CALL GEMINI (DIRECT or BACKEND) ---
    
    if (USE_BACKEND_PROXY) {
        // SAAS MODE: Call Netlify Function
        console.log("Calling Backend Proxy...");
        const response = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL_NAME,
                contents: {
                    parts: [
                        contentPart,
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
            })
        });
        
        if (!response.ok) throw new Error("Backend Proxy failed");
        const result = await response.json();
        return parseResponse(result.text, mode);

    } else {
        // CLIENT SIDE MODE (Dev/Demo)
        console.log("Calling Gemini Direct...");
        const response = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: {
                parts: [
                contentPart,
                {
                    text: systemInstruction + "\n\n" + taskInstruction + "\n\nReturn the output strictly in JSON format.",
                },
                ],
            },
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                type: Type.OBJECT,
                properties: schemaProperties,
                required: requiredFields,
                },
            },
        });
        
        if (!response.text) throw new Error("No response from Gemini");
        return parseResponse(response.text, mode);
    }

  } catch (error) {
    console.error("Error processing meeting audio:", error);
    throw error;
  }
};

// Helper to normalize partial data
function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    const rawData = JSON.parse(jsonText);
    return {
      transcription: rawData.transcription || "",
      summary: rawData.summary || "",
      decisions: rawData.decisions || [],
      actionItems: rawData.actionItems || [],
    };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      } else {
        reject(new Error('Failed to convert blob to base64'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
