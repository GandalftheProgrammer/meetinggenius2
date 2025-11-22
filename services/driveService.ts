import { GoogleUser } from '../types';

const FOLDER_NAME = 'MeetingGenius';

// This relies on the Google Identity Services script loaded in index.html
declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;

export const initDrive = (callback: (token: string) => void) => {
  if (typeof google === 'undefined') {
    console.error('Google Identity Services script not loaded');
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE', // In production, use env var
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
  // Force prompt if token is missing or expired, otherwise skip prompt if possible
  tokenClient.requestAccessToken({ prompt: '' });
};

export const disconnectDrive = () => {
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  if (typeof google !== 'undefined') {
    google.accounts.oauth2.revoke(accessToken, () => { console.log('Token revoked') });
  }
};

const getFolderId = async (): Promise<string | null> => {
  if (!accessToken) return null;

  const query = `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  const data = await response.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }
  return null;
};

const createFolder = async (): Promise<string> => {
  const metadata = {
    name: FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
  };

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

export const uploadToDrive = async (filename: string, content: string): Promise<string> => {
  if (!accessToken) throw new Error("Not authenticated");

  // 1. Find or Create Folder
  let folderId = await getFolderId();
  if (!folderId) {
    folderId = await createFolder();
  }

  // 2. Upload File
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: 'text/markdown',
  };

  const fileContent = new Blob([content], { type: 'text/markdown' });
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileContent);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!response.ok) throw new Error("Upload failed");
  const data = await response.json();
  return data.id;
};
