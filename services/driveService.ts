
import { GoogleUser } from '../types';

declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;
let mainFolderId: string | null = null;
let folderLock: Promise<string> | null = null;
const subFolderCache: Record<string, string> = {};

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
  mainFolderId = null;
  folderLock = null;
  Object.keys(subFolderCache).forEach(k => delete subFolderCache[k]);
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
    
    if (!mainFolderId) {
        if (!folderLock) {
            folderLock = (async () => {
                const id = await getFolderId(main) || await createFolder(main);
                mainFolderId = id;
                return id;
            })();
        }
        await folderLock;
    }

    if (!mainFolderId) throw new Error("Could not access main folder");
    
    if (subFolderCache[sub]) return subFolderCache[sub];

    const subId = await getFolderId(sub, mainFolderId) || await createFolder(sub, mainFolderId);
    subFolderCache[sub] = subId;
    return subId;
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

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        body { font-family: sans-serif; line-height: 1.4; padding: 40px; }
        h1 { color: #1e293b; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        h2 { color: #334155; margin-top: 20px; border-bottom: 1px solid #eee; }
        li { margin-bottom: 5px; }
      </style>
      </head><body>${html}</body></html>`;
};

const uploadFile = async (name: string, content: string | Blob, type: string, sub: string, toDoc: boolean): Promise<any> => {
  if (!accessToken) throw new Error("No token");
  const fId = await ensureFolder(sub);
  
  const cleanName = toDoc ? name.replace(/\.(md|html|txt)$/i, '') : name;
  const meta = { 
    name: cleanName, 
    parents: [fId], 
    mimeType: toDoc ? 'application/vnd.google-apps.document' : type 
  };
  
  const boundary = '-------314159265358979323846';
  // FIX: Gebruik backticks voor template literals om de boundary correct in te voegen
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart = JSON.stringify(meta);
  
  const bodyParts: (string | Blob)[] = [
    delimiter,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    metadataPart,
    delimiter,
    `Content-Type: ${type}\r\n\r\n`,
    content instanceof Blob ? content : new Blob([content], { type }),
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
     throw new Error(`Drive Upload Failed: ${errText}`);
  }
  
  return await r.json();
};

export const uploadAudioToDrive = (name: string, blob: Blob) => uploadFile(name, blob, blob.type, 'Audio', false);
export const uploadTextToDrive = (name: string, content: string, sub: 'Notes' | 'Transcripts') => uploadFile(name, convertMarkdownToHtml(content), 'text/html', sub, true);
