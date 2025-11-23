
import { GoogleGenAI, Type } from "@google/genai";
import { Buffer } from "buffer";

const MODEL_NAME = "gemini-3-pro-preview";

/**
 * Netlify Function using Web Standard API (Request/Response)
 */
export default async (req: Request) => {
  // CORS Preflight
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
    const apiKey = process.env.API_KEY;
    
    // Explicit check to help debug environment issues
    if (!apiKey) {
        throw new Error("SERVER_ERROR: API_KEY environment variable is undefined or empty.");
    }
    
    const ai = new GoogleGenAI({ apiKey });
    const payload = await req.json();
    const { action } = payload;

    // --- ACTION 1: AUTHORIZE UPLOAD ---
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
            file: { display_name: `Meeting_Audio_${Date.now()}` }
        })
      });

      if (!initResponse.ok) {
         const errText = await initResponse.text();
         throw new Error(`Google Upload Handshake Failed. Status: ${initResponse.status}. Details: ${errText}`);
      }

      const uploadUrl = initResponse.headers.get('x-goog-upload-url');
      return new Response(JSON.stringify({ uploadUrl }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // --- ACTION 2: UPLOAD CHUNK ---
    if (action === 'upload_chunk') {
      const { uploadUrl, chunkData, offset, totalSize, isLastChunk } = payload;
      const buffer = Buffer.from(chunkData, 'base64');
      
      const putResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Length': buffer.length.toString(),
          'X-Goog-Upload-Offset': offset,
          'X-Goog-Upload-Command': isLastChunk ? 'upload, finalize' : 'upload',
        },
        body: buffer
      });

      if (!putResponse.ok) {
         const errText = await putResponse.text();
         throw new Error(`Google Chunk Upload Failed. Status: ${putResponse.status}. Details: ${errText}`);
      }

      const body = isLastChunk ? await putResponse.json() : {};
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }

    // --- ACTION 3: GENERATE CONTENT ---
    if (action === 'generate') {
      const { fileUri, mimeType, mode } = payload;

      let systemInstruction = `
        You are an expert meeting secretary.
        1. If silence/noise, return "summary": "No conversation detected".
        2. Detect language and use it for the output.
      `;
      
      let taskInstruction = "";
      const transcriptionSchema = { type: Type.STRING, description: "Verbatim transcription" };
      const summarySchema = { type: Type.STRING, description: "Concise summary" };
      const decisionsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key decisions" };
      const actionItemsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Action items" };

      let schemaProperties: any = {};
      let requiredFields: string[] = [];

      if (mode === 'TRANSCRIPT_ONLY') {
        taskInstruction = "Transcribe audio verbatim.";
        schemaProperties = { transcription: transcriptionSchema };
        requiredFields = ["transcription"];
      } else if (mode === 'NOTES_ONLY') {
        taskInstruction = "Create structured notes.";
        schemaProperties = { summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["summary", "decisions", "actionItems"];
      } else {
        taskInstruction = "Transcribe verbatim AND create structured notes.";
        schemaProperties = { transcription: transcriptionSchema, summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["transcription", "summary", "decisions", "actionItems"];
      }

      const result = await ai.models.generateContentStream({
        model: MODEL_NAME,
        contents: {
          parts: [
             { fileData: { fileUri: fileUri, mimeType: mimeType } },
             { text: systemInstruction + "\n\n" + taskInstruction + "\n\nReturn strict JSON." }
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

      const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            try {
                for await (const chunk of result) {
                    if (chunk.text) controller.enqueue(encoder.encode(chunk.text));
                }
                controller.close();
            } catch (err) {
                console.error("Streaming error:", err);
                controller.error(err);
            }
        }
      });

      return new Response(stream, {
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }
      });
    }

    return new Response("Invalid Action", { status: 400 });

  } catch (error: any) {
    console.error('Backend Error:', error);
    
    // DEBUG HELP: If unauthorized, give hints about the environment variable
    let debugMsg = "";
    if (error.message && (error.message.includes('401') || error.message.includes('Unauthorized'))) {
        const key = process.env.API_KEY;
        const keyLen = key ? key.length : 0;
        const keyStart = key ? key.substring(0, 4) : "null";
        debugMsg = ` [DEBUG: Key Length=${keyLen}, StartsWith=${keyStart}]`;
    }

    return new Response(JSON.stringify({ error: error.message + debugMsg }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
    });
  }
};
