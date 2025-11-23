import { GoogleGenAI, Type } from "@google/genai";
import { Buffer } from "buffer";

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is missing in Netlify Env Vars");

const ai = new GoogleGenAI({ apiKey });
const MODEL_NAME = "gemini-3-pro-preview";

/**
 * Netlify Function using Web Standard API (Request/Response)
 * This is required to support Streaming responses.
 */
export default async (req: Request) => {
  // CORS Preflight handling (if needed, though usually handled by Netlify config)
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const payload = await req.json();
    const { action } = payload;

    // --- ACTION 1: AUTHORIZE UPLOAD (Handshake) ---
    if (action === 'authorize_upload') {
      const { mimeType, fileSize } = payload;
      
      const initResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': fileSize,
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json'
        },
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
      
      return new Response(JSON.stringify({ uploadUrl }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // --- ACTION 2: UPLOAD CHUNK (Proxy) ---
    if (action === 'upload_chunk') {
      const { uploadUrl, chunkData, offset, totalSize, isLastChunk } = payload;
      
      // Buffer is available in Node.js environment
      const buffer = Buffer.from(chunkData, 'base64');
      const chunkLength = buffer.length;
      
      const command = isLastChunk ? 'upload, finalize' : 'upload';
      
      const putResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Length': chunkLength.toString(),
          'X-Goog-Upload-Offset': offset,
          'X-Goog-Upload-Command': command,
        },
        body: buffer
      });

      if (!putResponse.ok) {
         const errText = await putResponse.text();
         throw new Error(`Google Chunk Upload Failed: ${errText}`);
      }

      let body = {};
      if (isLastChunk) {
        body = await putResponse.json();
      }

      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // --- ACTION 3: GENERATE CONTENT (STREAMING) ---
    if (action === 'generate') {
      const { fileUri, mimeType, mode } = payload;

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

      // Use generateContentStream instead of generateContent
      const result = await ai.models.generateContentStream({
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

      // Create a ReadableStream to pipe chunks to the client
      const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            try {
                for await (const chunk of result) {
                    const text = chunk.text;
                    if (text) {
                        controller.enqueue(encoder.encode(text));
                    }
                }
                controller.close();
            } catch (err) {
                console.error("Streaming error:", err);
                controller.error(err);
            }
        }
      });

      return new Response(stream, {
        headers: { 
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked'
        }
      });
    }

    return new Response("Invalid Action", { status: 400 });

  } catch (error: any) {
    console.error('Backend Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
    });
  }
};