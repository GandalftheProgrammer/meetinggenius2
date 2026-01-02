
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

const FALLBACK_CHAINS: Record<string, string[]> = {
    'gemini-3-pro-preview': ['gemini-3-pro-preview', 'gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-2.5-pro': ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-2.5-flash': ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'],
    'gemini-2.0-flash': ['gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-3-pro-image-preview': ['gemini-2.5-flash-image']
};

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  let apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  if (apiKey.startsWith('"') && apiKey.endsWith('"')) apiKey = apiKey.slice(1, -1);
  if (!apiKey) return;

  const encodedKey = encodeURIComponent(apiKey);
  let jobId: string = "";

  try {
    const payload = await req.json();
    const { totalChunks, mimeType, mode, model, fileSize } = payload;
    jobId = payload.jobId;
    if (!jobId) return;

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // --- 1. UPLOAD HANDSHAKE ---
    const handshakeUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodedKey}`;
    const initResp = await fetch(handshakeUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: `Meeting_${jobId}` } })
    });

    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("Geen upload URL van Google");
    if (!uploadUrl.includes('key=')) {
        uploadUrl += (uploadUrl.includes('?') ? '&' : '?') + `key=${encodedKey}`;
    }

    // --- 2. STITCH & UPLOAD ---
    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        const chunkBase64 = await uploadStore.get(`${jobId}/${i}`, { type: 'text' });
        if (!chunkBase64) throw new Error(`Missing chunk ${i}`);
        
        buffer = Buffer.concat([buffer, Buffer.from(chunkBase64, 'base64')]);
        await uploadStore.delete(`${jobId}/${i}`);

        while (buffer.length >= GEMINI_CHUNK_SIZE) {
            const chunkToSend = buffer.subarray(0, GEMINI_CHUNK_SIZE);
            buffer = buffer.subarray(GEMINI_CHUNK_SIZE);
            await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'X-Goog-Upload-Command': 'upload',
                    'X-Goog-Upload-Offset': String(uploadOffset),
                    'Content-Type': 'application/octet-stream'
                },
                body: chunkToSend
            });
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    // Finalize
    await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': String(uploadOffset),
            'Content-Type': 'application/octet-stream'
        },
        body: buffer
    });

    const fileResult = await (await fetch(`${handshakeUrl.replace('/upload/', '/')}&q=name=Meeting_${jobId}`)).json();
    const fileUri = fileResult.files?.[0]?.uri || fileResult.uri;
    
    // Wait for ACTIVE
    await waitForFileActive(fileUri, encodedKey);

    // --- 3. GENERATE ---
    const modelsToTry = FALLBACK_CHAINS[model] || [model];
    let resultText = "";
    
    for (const currentModel of modelsToTry) {
        try {
            resultText = await generateContentREST(fileUri, mimeType, mode, currentModel, encodedKey);
            if (resultText && resultText !== "{}") break;
        } catch (e) {
            console.warn(`Fallback triggered for ${currentModel}`);
        }
    }

    if (!resultText || resultText === "{}") throw new Error("De AI kon geen inhoud genereren voor deze audio.");

    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
};

async function waitForFileActive(fileUri: string, encodedKey: string) {
    if (!fileUri) return;
    const pollUrl = `${fileUri}?key=${encodedKey}`;
    for (let i = 0; i < 30; i++) {
        const r = await fetch(pollUrl);
        if (r.ok) {
            const d = await r.json();
            if (d.state === 'ACTIVE') return;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function generateContentREST(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;
    
    const systemInstruction = `Je bent een expert in het samenvatten van vergaderingen.
    STRENG: Je MOET antwoorden in de taal die in de audio wordt gesproken.
    STRENG: Je MOET een geldig JSON object teruggeven met EXACT deze velden: transcription, summary, conclusions, actionItems.
    
    Summary: Maak een zeer uitgebreide en gedetailleerde samenvatting.
    Conclusions: Maak een lijst van alle besluiten en inzichten.
    ActionItems: Maak een lijst van concrete taken.
    Transcription: Een letterlijk verslag van wat er is gezegd.`;

    let taskText = "";
    if (mode === 'TRANSCRIPT_ONLY') taskText = "Focus volledig op de transcription. Laat de rest leeg.";
    else if (mode === 'NOTES_ONLY') taskText = "Focus op summary, conclusions en actionItems. Laat transcription leeg.";
    else taskText = "Doe alles: transcription en uitgebreide notes.";

    const payload = {
        contents: [{ parts: [
            { file_data: { file_uri: fileUri, mime_type: mimeType } },
            { text: taskText + " Output MOET pure JSON zijn." }
        ]}],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generation_config: { response_mime_type: "application/json", max_output_tokens: 8192 },
        safety_settings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) throw new Error(`Gemini Error: ${resp.status}`);
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}
