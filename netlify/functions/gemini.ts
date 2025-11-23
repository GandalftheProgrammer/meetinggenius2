import { GoogleGenAI, Type } from "@google/genai";
import { Buffer } from "buffer";

const apiKey = process.env.API_KEY;

// Helper to sanitize error messages
const getErrorMessage = (error: any): string => {
  if (!error) return "Unknown error";
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
};

const ai = new GoogleGenAI({ apiKey: apiKey || "" });
// We use the Flash model for speed/reliability in this demo, but user requested Pro logic.
// Keeping gemini-3-pro-preview as requested.
const MODEL_NAME = "gemini-3-pro-preview";

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
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Server Configuration Error: API_KEY missing." }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

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
        body: JSON.stringify({ file: { display_name: `Meeting_Audio_${Date.now()}` } })
      });

      if (!initResponse.ok) {
         throw new Error(`Google Upload Init Failed: ${await initResponse.text()}`);
      }

      const uploadUrl = initResponse.headers.get('x-goog-upload-url');
      return new Response(JSON.stringify({ uploadUrl }), { headers: { 'Content-Type': 'application/json' } });
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
         throw new Error(`Chunk Upload Failed: ${await putResponse.text()}`);
      }

      let body = {};
      if (isLastChunk) body = await putResponse.json();
      
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }

    // --- ACTION 3: GENERATE (STREAMING) ---
    if (action === 'generate') {
      const { fileUri, mimeType, mode } = payload;

      let systemInstruction = `You are an expert meeting secretary. Listen to the audio. 
      If silent, return fallback JSON. Detect language and use it for output.`;
      
      let taskInstruction = "";
      const transcriptionSchema = { type: Type.STRING, description: "Full verbatim transcription" };
      const summarySchema = { type: Type.STRING, description: "A concise summary" };
      const decisionsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key decisions" };
      const actionItemsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Action items" };

      let schemaProperties: any = {};
      let requiredFields: string[] = [];

      if (mode === 'TRANSCRIPT_ONLY') {
        taskInstruction = "Transcribe audio verbatim. No notes.";
        schemaProperties = { transcription: transcriptionSchema };
        requiredFields = ["transcription"];
      } else if (mode === 'NOTES_ONLY') {
        taskInstruction = "Create structured meeting notes.";
        schemaProperties = { summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["summary", "decisions", "actionItems"];
      } else {
        taskInstruction = "Transcribe audio AND create notes.";
        schemaProperties = { transcription: transcriptionSchema, summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["transcription", "summary", "decisions", "actionItems"];
      }

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let heartbeatInterval: any = null;

          try {
             // 1. Send Heartbeats ONLY during "Thinking" phase.
             // We send a space every 5 seconds to keep LB alive.
             heartbeatInterval = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(" ")); 
                } catch(e) {
                  clearInterval(heartbeatInterval);
                }
             }, 5000);

             // 2. Start Generation
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

             // 3. Pump data
             for await (const chunk of result) {
                // CRITICAL: Stop heartbeat as soon as real data starts to avoid JSON corruption.
                if (heartbeatInterval) {
                  clearInterval(heartbeatInterval);
                  heartbeatInterval = null;
                }

                const text = chunk.text();
                if (text) {
                    controller.enqueue(encoder.encode(text));
                }
             }

             controller.close();
          } catch (err) {
             console.error("Stream generation error:", err);
             if (heartbeatInterval) clearInterval(heartbeatInterval);
             
             const errorMsg = getErrorMessage(err);
             // Send error as JSON so client can parse it
             controller.enqueue(encoder.encode(JSON.stringify({ error: errorMsg })));
             controller.close();
          }
        }
      });

      // Return stream immediately
      return new Response(stream, {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response("Invalid Action", { status: 400 });

  } catch (error: any) {
    console.error('General Backend Error:', error);
    return new Response(JSON.stringify({ error: getErrorMessage(error) }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
    });
  }
};
