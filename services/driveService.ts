
import { GoogleUser } from '../types';

// This relies on the Google Identity Services script loaded in index.html
declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;

// Initialize the Drive Client
export const initDrive = (callback: (token: string) => void) => {
  if (typeof google === 'undefined') {
    console.error('Google Identity Services script not loaded');
    return;
  }

  // Vite uses import.meta.env for environment variables
  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, 
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse: any) => {
      if (tokenResponse && tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        // Store expiration time to manage session locally if needed
        const expiresIn = tokenResponse.expires_in; 
        const expiresAt = Date.now() + expiresIn * 1000;
        localStorage.setItem('drive_token', accessToken);
        localStorage.setItem('drive_token_expiry', expiresAt.toString());
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
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  if (typeof google !== 'undefined') {
    google.accounts.oauth2.revoke(accessToken, () => { console.log('Token revoked') });
  }
};

// --- FOLDER LOGIC ---

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

// Ensures the structure: MainFolder -> SubFolder exists
const ensureFolderHierarchy = async (subFolder: string): Promise<string> => {
    // 1. Get Main Folder
    const mainFolderName = localStorage.getItem('drive_folder_name') || 'MeetingGenius';
    let mainId = await getFolderId(mainFolderName);
    if (!mainId) {
        mainId = await createFolder(mainFolderName);
    }

    // 2. Get/Create Sub Folder
    let subId = await getFolderId(subFolder, mainId);
    if (!subId) {
        subId = await createFolder(subFolder, mainId);
    }
    
    return subId;
};

// --- UPLOAD LOGIC ---

// Generic upload function for both Blob (Audio) and String (Text)
const uploadFileToDrive = async (filename: string, content: Blob | string, mimeType: string, folderName: string): Promise<{id: string, webViewLink?: string}> => {
  if (!accessToken) throw new Error("Not authenticated");

  const folderId = await ensureFolderHierarchy(folderName);

  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: mimeType, // MIME type for the file itself (e.g. 'audio/webm' or 'text/markdown')
  };

  const fileContent = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileContent);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!response.ok) throw new Error("Upload failed");
  const data = await response.json();
  return { id: data.id, webViewLink: data.webViewLink };
};

// Wrapper for Audio
export const uploadAudioToDrive = async (filename: string, audioBlob: Blob): Promise<{id: string, webViewLink?: string}> => {
    // Determine extension based on blob type if possible, otherwise default to .webm
    const ext = audioBlob.type.includes('mp4') ? '.mp4' : '.webm';
    const finalName = filename.endsWith(ext) ? filename : `${filename}${ext}`;
    return uploadFileToDrive(finalName, audioBlob, audioBlob.type, 'Audio');
};

// Wrapper for Text (Notes/Transcripts)
export const uploadTextToDrive = async (filename: string, content: string, subFolder: 'Notes' | 'Transcripts'): Promise<{id: string, webViewLink?: string}> => {
    return uploadFileToDrive(filename, content, 'text/markdown', subFolder);
};
