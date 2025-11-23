import { Type } from "@google/genai";

// We use the Web Standard API (Request/Response) to support streaming
export default async (req: Request) => {
  // 1. CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // 2. Auth: Load API Key
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "API_KEY not configured on server" }), { status: 500 });
    }
    
    // 3. Parse Body
    const payload = await req.json();
    const { action } = payload;
    // Use the requested robust model
    const MODEL_NAME = "gemini-3-pro-preview"; 

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
      
      // Convert Base64 back to Binary Buffer
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

    // --- ACTION 3: GENERATE CONTENT (Streaming with Heartbeat) ---
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

      const requestBody = {
        contents: [
           { 
             parts: [
               { fileData: { fileUri: fileUri, mimeType: mimeType } },
               { text: systemInstruction + "\n\n" + taskInstruction + "\n\nReturn the output strictly in JSON format." }
             ]
           }
        ],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: schemaProperties,
                required: requiredFields,
            },
        }
      };

      // Create a Custom Stream that mixes Heartbeat signals with the Gemini API response
      const mixedStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let hasReceivedData = false;

          // 1. Start the Heartbeat (Keep-Alive)
          // Send a safe HTML comment every 2.5 seconds to keep Netlify connection open
          const heartbeatInterval = setInterval(() => {
            if (!hasReceivedData) {
              try {
                controller.enqueue(encoder.encode("<!-- KEEP_ALIVE_PING -->\n"));
              } catch (e) {
                // Controller might be closed if client disconnected
                clearInterval(heartbeatInterval);
              }
            }
          }, 2500);

          try {
            // 2. Call Google API
            const googleResponse = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:streamGenerateContent?key=${apiKey}`, 
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
              }
            );

            if (!googleResponse.ok) {
              clearInterval(heartbeatInterval);
              const err = await googleResponse.text();
              controller.enqueue(encoder.encode(JSON.stringify({ error: `Google API Error: ${err}` })));
              controller.close();
              return;
            }

            if (!googleResponse.body) {
              clearInterval(heartbeatInterval);
              controller.enqueue(encoder.encode(JSON.stringify({ error: "No response body" })));
              controller.close();
              return;
            }

            // 3. Pipe Google Response to Client
            const reader = googleResponse.body.getReader();
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              // Once we have real data, we mark it so heartbeat stops sending
              hasReceivedData = true;
              clearInterval(heartbeatInterval);
              
              controller.enqueue(value);
            }
            
            controller.close();

          } catch (error: any) {
            clearInterval(heartbeatInterval);
            const errJson = JSON.stringify({ error: error.message || "Unknown stream error" });
            controller.enqueue(encoder.encode(errJson));
            controller.close();
          }
        }
      });

      return new Response(mixedStream, {
        headers: { "Content-Type": "application/json" }
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