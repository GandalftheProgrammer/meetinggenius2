
import { GoogleUser } from '../types';

declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;
let isInitializing = false;

const isTokenValid = () => {
  const token = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  return token && expiry && Date.now() < parseInt(expiry) - 60000;
};

export const initDrive = (callback: (token: string | null) => void): boolean => {
  if (typeof google === 'undefined' || !google.accounts) return false;
  if (tokenClient && isInitializing) return true;
  isInitializing = true;

  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId, 
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (tokenResponse: any) => {
        if (tokenResponse && tokenResponse.access_token) {
          accessToken = tokenResponse.access_token;
          localStorage.setItem('drive_token', accessToken!);
          localStorage.setItem('drive_token_expiry', (Date.now() + tokenResponse.expires_in * 1000).toString());
          localStorage.setItem('drive_sticky_connection', 'true');
          callback(accessToken);
        }
      },
    });

    if (isTokenValid()) {
      accessToken = localStorage.getItem('drive_token');
      callback(accessToken);
    }
    return true;
  } catch (err) {
    return false;
  } finally {
    isInitializing = false;
  }
};

export const connectToDrive = () => {
  if (!tokenClient) initDrive(() => {});
  tokenClient.requestAccessToken({ prompt: 'consent select_account' });
};

export const disconnectDrive = () => {
  const token = accessToken || localStorage.getItem('drive_token');
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  localStorage.removeItem('drive_sticky_connection');
  if (token) google.accounts.oauth2.revoke(token);
};

const ensureFolderHierarchy = async (subFolder: string): Promise<string> => {
    const mainFolderName = localStorage.getItem('drive_folder_name') || 'MeetingGenius';
    let mainId = await getFolderId(mainFolderName);
    if (!mainId) mainId = await createFolder(mainFolderName);

    let subId = await getFolderId(subFolder, mainId);
    if (!subId) subId = await createFolder(subFolder, mainId);
    
    return subId;
};

const getFolderId = async (name: string, parentId?: string) => {
  const token = accessToken || localStorage.getItem('drive_token');
  let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const d = await r.json();
  return d.files?.[0]?.id || null;
};

const createFolder = async (name: string, parentId?: string) => {
  const token = accessToken || localStorage.getItem('drive_token');
  const meta: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const d = await r.json();
  return d.id;
};

const convertMarkdownToHtml = (markdown: string, title: string): string => {
    let html = markdown
        .replace(/^# (.*$)/gm, '<h1 style="color:#1a73e8; font-family:Arial; font-size:24pt; margin-bottom:12pt; border-bottom:1px solid #eee; padding-bottom:8pt;">$1</h1>')
        .replace(/^## (.*$)/gm, '<h2 style="color:#202124; font-family:Arial; font-size:16pt; margin-top:20pt; margin-bottom:8pt;">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 style="color:#5f6368; font-family:Arial; font-size:13pt; margin-top:16pt;">$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/- \[ \] (.*$)/gm, '<div style="margin-bottom:4pt;">☐ $1</div>')
        .replace(/- \[x\] (.*$)/gm, '<div style="margin-bottom:4pt; text-decoration:line-through; color:#9aa0a6;">☑ $1</div>')
        .replace(/^- (.*$)/gm, '<li style="margin-bottom:4pt;">$1</li>')
        .replace(/\n\n/g, '<p style="margin-bottom:10pt;"></p>');

    html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul style="padding-left:20pt; margin-bottom:12pt;">$1</ul>');
    
    return `
      <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family: 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #3c4043; padding: 1in;">
        <div style="text-align: right; color: #9aa0a6; font-size: 9pt; margin-bottom: 20pt;">Gegenereerd door MeetingGenius op ${new Date().toLocaleString()}</div>
        ${html}
      </body>
      </html>
    `;
};

const uploadFileToDrive = async (
    filename: string, 
    content: Blob | string, 
    mimeType: string, 
    folderName: string,
    convertToGoogleDoc: boolean = false
) => {
  const token = accessToken || localStorage.getItem('drive_token');
  if (!token) throw new Error("Not authenticated");

  const folderId = await ensureFolderHierarchy(folderName);
  
  // Strip extensies voor een schone titel in Google Docs
  const cleanTitle = filename.replace(/\.(md|html|txt)$/i, '');

  const metadata: any = {
    name: cleanTitle,
    parents: [folderId],
  };

  if (convertToGoogleDoc) {
      metadata.mimeType = 'application/vnd.google-apps.document';
  }

  const fileContent = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileContent);

  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!r.ok) throw new Error("Drive upload mislukt");
  return await r.json();
};

export const uploadAudioToDrive = async (filename: string, audioBlob: Blob) => {
    return uploadFileToDrive(filename, audioBlob, audioBlob.type, 'Audio', false);
};

export const uploadTextToDrive = async (filename: string, content: string, subFolder: 'Notes' | 'Transcripts') => {
    const htmlContent = convertMarkdownToHtml(content, filename);
    // Forceer ALTIJD conversie naar Google Doc voor tekstbestanden
    return uploadFileToDrive(filename, htmlContent, 'text/html', subFolder, true);
};
