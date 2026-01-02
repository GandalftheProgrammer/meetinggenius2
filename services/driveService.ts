
import { GoogleUser } from '../types';

// This relies on the Google Identity Services script loaded in index.html
declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;

// Initialize the Drive Client
export const initDrive = (callback: (token: string | null) => void) => {
  if (typeof google === 'undefined') {
    console.error('Google Identity Services script not loaded');
    return;
  }

  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, 
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse: any) => {
      if (tokenResponse.error) {
         console.warn("Drive connection error:", tokenResponse.error);
         callback(null);
         return;
      }

      if (tokenResponse && tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        const expiresIn = tokenResponse.expires_in; 
        const expiresAt = Date.now() + expiresIn * 1000;
        localStorage.setItem('drive_token', accessToken);
        localStorage.setItem('drive_token_expiry', expiresAt.toString());
        localStorage.setItem('drive_sticky_connection', 'true');
        callback(accessToken);
      }
    },
  });

  // Check for existing valid token
  const storedToken = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  
  if (storedToken && expiry && Date.now() < parseInt(expiry)) {
    accessToken = storedToken;
    callback(storedToken);
  } else {
    const isSticky = localStorage.getItem('drive_sticky_connection') === 'true';
    if (isSticky) {
        try {
            // Attempt silent refresh
            tokenClient.requestAccessToken({ prompt: 'none' });
        } catch (e) {
            console.error("Silent refresh failed", e);
            callback(null);
        }
    } else {
        callback(null);
    }
  }
};

export const connectToDrive = () => {
  if (!tokenClient) {
    console.error("Drive client not initialized");
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent select_account' });
};

export const disconnectDrive = () => {
  const tokenToRevoke = accessToken;
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  localStorage.removeItem('drive_sticky_connection');
  
  if (typeof google !== 'undefined' && tokenToRevoke) {
    google.accounts.oauth2.revoke(tokenToRevoke, () => { console.log('Token revoked') });
  }
};

const getFolderId = async (folderName: string, parentId?: string): Promise<string | null> => {
  if (!accessToken) return null;

  let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  
  const data = await response.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }
  return null;
};

const createFolder = async (folderName: string, parentId?: string): Promise<string> => {
  const metadata: any = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });
  const data = await response.json();
  return data.id;
};

const ensureFolderHierarchy = async (subFolder: string): Promise<string> => {
    const mainFolderName = localStorage.getItem('drive_folder_name') || 'MeetingGenius';
    let mainId = await getFolderId(mainFolderName);
    if (!mainId) {
        mainId = await createFolder(mainFolderName);
    }

    let subId = await getFolderId(subFolder, mainId);
    if (!subId) {
        subId = await createFolder(subFolder, mainId);
    }
    
    return subId;
};

const convertMarkdownToHtml = (markdown: string): string => {
    let html = markdown
        .replace(/^# (.*$)/gm, '<h1 style="color:#1e293b; font-size:24px; margin-top:20px;">$1</h1>')
        .replace(/^## (.*$)/gm, '<h2 style="color:#334155; font-size:18px; margin-top:16px;">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 style="color:#475569; font-size:16px; margin-top:12px;">$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/- \[ \] (.*$)/gm, '<li style="list-style-type: none;">☐ $1</li>')
        .replace(/- (.*$)/gm, '<li>$1</li>')
        .replace(/\n\n/g, '<br><br>');

    html = html.replace(/((?:<li.*?>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          ul { margin-bottom: 10px; padding-left: 20px; }
          li { margin-bottom: 5px; }
          h1, h2, h3 { color: #334155; }
        </style>
      </head>
      <body>
        ${html}
      </body>
      </html>
    `;
};

/**
 * Perform a multipart/related upload to ensure Google Doc conversion.
 * Google is very specific about the structure for conversion.
 */
const uploadFileToDrive = async (
    filename: string, 
    content: Blob | string, 
    sourceMimeType: string, 
    folderName: string,
    convertToGoogleDoc: boolean = false
): Promise<{id: string, webViewLink?: string}> => {
  if (!accessToken) throw new Error("Not authenticated");

  const folderId = await ensureFolderHierarchy(folderName);
  
  // Clean filename: remove .md extensions for Docs conversion
  const cleanName = convertToGoogleDoc ? filename.replace(/\.md$/i, '').replace(/\.html$/i, '') : filename;

  const metadata = {
    name: cleanName,
    parents: [folderId],
    mimeType: convertToGoogleDoc ? 'application/vnd.google-apps.document' : sourceMimeType
  };

  const boundary = '-------314159265358979323846';
  const delimiter = "\r\n--" + boundary + "\r\n";
  const close_delim = "\r\n--" + boundary + "--";

  const reader = new FileReader();
  const fileBlob = typeof content === 'string' ? new Blob([content], { type: sourceMimeType }) : content;
  
  return new Promise((resolve, reject) => {
    reader.onload = async () => {
      const contentType = sourceMimeType;
      const base64Data = btoa(
        new Uint8Array(reader.result as ArrayBuffer)
          .reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      const multipartRequestBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: ' + contentType + '\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        base64Data +
        close_delim;

      try {
        const response = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body: multipartRequestBody,
          }
        );

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Upload failed: ${err}`);
        }
        
        const data = await response.json();
        resolve({ id: data.id, webViewLink: data.webViewLink });
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsArrayBuffer(fileBlob);
  });
};

export const uploadAudioToDrive = async (filename: string, audioBlob: Blob): Promise<{id: string, webViewLink?: string}> => {
    const ext = audioBlob.type.includes('mp4') ? '.mp4' : '.webm';
    const finalName = filename.endsWith(ext) ? filename : `${filename}${ext}`;
    return uploadFileToDrive(finalName, audioBlob, audioBlob.type, 'Audio', false);
};

export const uploadTextToDrive = async (filename: string, content: string, subFolder: 'Notes' | 'Transcripts'): Promise<{id: string, webViewLink?: string}> => {
    // 1. Convert to HTML for better Doc rendering
    const htmlContent = convertMarkdownToHtml(content);
    // 2. Upload with source as text/html and target as Google Doc
    return uploadFileToDrive(filename, htmlContent, 'text/html', subFolder, true);
};
