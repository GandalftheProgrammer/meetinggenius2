
import { GoogleUser } from '../types';

declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;

export const initDrive = (callback: (token: string | null) => void) => {
  if (typeof google === 'undefined') return;

  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, 
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse: any) => {
      if (tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        localStorage.setItem('drive_token', accessToken);
        localStorage.setItem('drive_token_expiry', (Date.now() + tokenResponse.expires_in * 1000).toString());
        localStorage.setItem('drive_sticky_connection', 'true');
        callback(accessToken);
      }
    },
  });

  const storedToken = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  
  if (storedToken && expiry && Date.now() < parseInt(expiry)) {
    accessToken = storedToken;
    callback(storedToken);
  } else {
    callback(null);
  }
};

export const connectToDrive = () => {
  if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent select_account' });
};

export const disconnectDrive = () => {
  const t = accessToken;
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  localStorage.removeItem('drive_sticky_connection');
  if (t && typeof google !== 'undefined') google.accounts.oauth2.revoke(t, () => {});
};

const getFolderId = async (name: string, parentId?: string): Promise<string | null> => {
  if (!accessToken) return null;
  let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const d = await r.json();
  return d.files?.[0]?.id || null;
};

const createFolder = async (name: string, parentId?: string): Promise<string> => {
  const meta: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const d = await r.json();
  return d.id;
};

const ensureFolder = async (sub: string): Promise<string> => {
    const main = localStorage.getItem('drive_folder_name') || 'MeetingGenius';
    let mId = await getFolderId(main) || await createFolder(main);
    return await getFolderId(sub, mId) || await createFolder(sub, mId);
};

const convertMarkdownToHtml = (md: string): string => {
    let html = md.trim()
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/- \[ \] (.*$)/gm, '<li>☐ $1</li>')
        .replace(/- (.*$)/gm, '<li>$1</li>');

    html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');
    
    const lines = html.split('\n');
    html = lines.map(l => {
        const t = l.trim();
        if (!t) return '';
        if (t.startsWith('<h') || t.startsWith('<ul') || t.startsWith('<li')) return l;
        return `<p>${l}</p>`;
    }).join('');

    return `
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.2; color: #333; margin: 0; padding: 0; }
        h1 { color: #1e293b; font-size: 22pt; margin: 0 0 8pt 0; padding: 0; font-weight: bold; }
        h2 { color: #334155; font-size: 16pt; margin: 10pt 0 4pt 0; font-weight: bold; }
        h3 { color: #475569; font-size: 13pt; margin: 8pt 0 2pt 0; font-weight: bold; }
        p { margin: 0 0 6pt 0; }
        ul { margin: 0 0 8pt 0; padding-left: 20pt; }
        li { margin-bottom: 2pt; }
      </style>
      </head><body>${html}</body></html>`;
};

const uploadFile = async (name: string, content: string | Blob, type: string, sub: string, toDoc: boolean): Promise<any> => {
  if (!accessToken) throw new Error("No token");
  const fId = await ensureFolder(sub);
  
  const cleanName = toDoc ? name.replace(/\.(md|html|txt)$/i, '').replace(/_/g, ' ') : name;
  const meta = { 
    name: cleanName, 
    parents: [fId], 
    mimeType: toDoc ? 'application/vnd.google-apps.document' : type 
  };
  
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart = JSON.stringify(meta);
  
  // Use a Blob to construct the multipart body efficiently (especially for large audio files)
  const bodyParts: (string | Blob | ArrayBuffer)[] = [
    delimiter,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    metadataPart,
    delimiter,
    `Content-Type: ${type}\r\n\r\n`,
    content,
    closeDelimiter
  ];

  const body = new Blob(bodyParts);

  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${accessToken}`, 
      'Content-Type': `multipart/related; boundary=${boundary}` 
    },
    body
  });
  
  if (!r.ok) {
     const errText = await r.text();
     throw new Error(errText);
  }
  
  return await r.json();
};

export const uploadAudioToDrive = (name: string, blob: Blob) => uploadFile(name, blob, blob.type, 'Audio', false);
export const uploadTextToDrive = (name: string, content: string, sub: 'Notes' | 'Transcripts') => uploadFile(name, convertMarkdownToHtml(content), 'text/html', sub, true);
