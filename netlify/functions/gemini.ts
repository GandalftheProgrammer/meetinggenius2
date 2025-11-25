import { getStore } from "@netlify/blobs";

// This function handles Synchronous tasks:
// 1. Upload Handshake (Fast)
// 2. Check Status (Fast - Reads from Blob)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req: Request) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "API_KEY not configured on server" }), { 
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
    
    const payload = await req.json();
    const { action } = payload;

    // --- ACTION 1: AUTHORIZE UPLOAD (Handshake) ---
    // This implements Option B: Backend gets URL, Frontend uploads directly.
    if (action === 'authorize_upload') {
      const { mimeType, fileSize } = payload;
      
      // Strict type check
      const fileSizeStr = String(fileSize);

      const initResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': fileSizeStr,
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
      
      if (!uploadUrl) {
          throw new Error("Google did not return an upload URL");
      }
      
      return new Response(JSON.stringify({ uploadUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // --- ACTION 2: CHECK JOB STATUS (Polling) ---
    if (action === 'check_status') {
        const { jobId } = payload;
        if (!jobId) return new Response("Missing jobId", { status: 400, headers: corsHeaders });

        // Connect to Netlify Blobs
        const store = getStore({ name: "meeting-results", consistency: "strong" });
        
        const data = await store.get(jobId, { type: "json" });

        if (!data) {
            // Job not finished or doesn't exist yet
            return new Response(JSON.stringify({ status: 'PROCESSING' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    return new Response("Invalid Action", { status: 400, headers: corsHeaders });

  } catch (error: any) {
    console.error('Backend Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};