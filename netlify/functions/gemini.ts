import { getStore } from "@netlify/blobs";
import { Buffer } from "buffer";

// This function handles Synchronous tasks:
// 1. Upload Handshake (Fast)
// 2. Upload Chunks (Fast)
// 3. Check Status (Fast - Reads from Blob)

export default async (req: Request) => {
  // CORS Preflight
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
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "API_KEY not configured on server" }), { status: 500 });
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
      const granularity = initResponse.headers.get('x-goog-upload-chunk-granularity');
      
      return new Response(JSON.stringify({ uploadUrl, granularity }), {
          headers: { 'Content-Type': 'application/json' }
      });
    }

    // --- ACTION 2: UPLOAD CHUNK (Proxy Fallback - Only for small files if needed) ---
    // Note: Large files should now use Direct Upload from client to avoid Lambda limits
    if (action === 'upload_chunk') {
      const { uploadUrl, chunkData, offset, isLastChunk } = payload;
      
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

    // --- ACTION 3: CHECK JOB STATUS (Polling) ---
    if (action === 'check_status') {
        const { jobId } = payload;
        if (!jobId) return new Response("Missing jobId", { status: 400 });

        // Connect to Netlify Blobs
        const store = getStore({ name: "meeting-results", consistency: "strong" });
        
        const data = await store.get(jobId, { type: "json" });

        if (!data) {
            // Job not finished or doesn't exist yet
            return new Response(JSON.stringify({ status: 'PROCESSING' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Detect old client calls
    if (action === 'generate' || action === 'generate_stream') {
        return new Response(JSON.stringify({ error: "Client outdated. Please refresh page." }), { status: 400 });
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