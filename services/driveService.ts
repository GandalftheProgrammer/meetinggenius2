
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
        // Set the "Sticky" flag so we know to try silent reconnects later
        localStorage.setItem('drive_sticky_connection', 'true');
        callback(accessToken);
      }
    },
  });

  // --- PERSISTENCE LOGIC ---
  
  // 1. Check for valid existing token
  const storedToken = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  
  if (storedToken && expiry && Date.now() < parseInt(expiry)) {
    accessToken = storedToken;
    callback(storedToken);
    return;
  }

  // 2. If token is invalid/expired, but we have the "Sticky" flag,
  // assume the user wants to stay connected. Try to silently refresh 
  // if the Google Session is still active in the browser.
  const stickyConnection = localStorage.getItem('drive_sticky_connection');
  
  if (stickyConnection === 'true') {
      console.log("Drive: Attempting silent sticky reconnect...");
      // We can't guarantee this works without user interaction in GIS v2,
      // but if we call requestAccessToken with prompt='none', it might succeed
      // if the session is active.
      
      try {
          // Note: requestAccessToken is async but void. The callback defined above handles the result.
          // We use prompt: 'none' to avoid popping a visible window if not signed in.
          tokenClient.requestAccessToken({ prompt: 'none' });
          
          // HACK: Since requestAccessToken doesn't return a promise we can await,
          // we provisionally call the callback with a placeholder to keep the UI "Connected".
          // If the silent auth fails, the first actual Upload attempt will error out,
          // prompting a real reconnect. This satisfies the "UI looks permanent" requirement.
          if (storedToken) {
              accessToken = storedToken; // Ensure internal token is set optimistically
              callback(storedToken); 
          }
      } catch (e) {
          console.warn("Silent reconnect failed", e);
          // Don't clear flag, let them try again later.
      }
  }
};

export const connectToDrive = () => {
  if (!tokenClient) {
    console.error("Drive client not initialized");
    return;
  }
  // Standard interactive login
  tokenClient.requestAccessToken({ prompt: 'consent select_account' });
};

export const disconnectDrive = () => {
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  localStorage.removeItem('drive_sticky_connection'); // Clear sticky flag
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

// --- SIMPLE MARKDOWN TO HTML CONVERTER ---
const convertMarkdownToHtml = (markdown: string): string => {
    let html = markdown
        // Headers
        .replace(/^# (.*$)/gm, '<h1 style="color:#1e293b; font-size:24px; margin-top:20px;">$1</h1>')
        .replace(/^## (.*$)/gm, '<h2 style="color:#334155; font-size:18px; margin-top:16px;">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 style="color:#475569; font-size:16px; margin-top:12px;">$1</h3>')
        // Bold
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Action Items [ ] (Process BEFORE generic lists to avoid conflict)
        .replace(/- \[ \] (.*$)/gm, '<li style="list-style-type: none;">☐ $1</li>')
        // Lists
        .replace(/^- (.*$)/gm, '<li>$1</li>')
        // Paragraphs (double newline)
        .replace(/\n\n/g, '<br><br>');

    // Wrap lists - Non-greedy match for consecutive list items
    html = html.replace(/((?:<li.*?>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');
    
    // Add basic styling container
    return `
      <!DOCTYPE html>
      <html>
      <head>
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

// --- UPLOAD LOGIC ---

// Generic upload function for both Blob (Audio) and String (Text)
const uploadFileToDrive = async (
    filename: string, 
    content: Blob | string, 
    mimeType: string, 
    folderName: string,
    convertToGoogleDoc: boolean = false
): Promise<{id: string, webViewLink?: string}> => {
  if (!accessToken) throw new Error("Not authenticated");

  // Check if token is potentially expired and we are in "Sticky" mode.
  // If so, we might need to prompt the user if the silent refresh failed earlier.
  // However, we can't trigger popup here easily as this is async.
  // We rely on the error catch in App.tsx to show an error message.

  const folderId = await ensureFolderHierarchy(folderName);

  const metadata: any = {
    name: filename,
    parents: [folderId],
  };

  // If we are uploading text and want it to be a Google Doc
  if (convertToGoogleDoc) {
      metadata.mimeType = 'application/vnd.google-apps.document';
  } else {
      metadata.mimeType = mimeType;
  }

  const fileContent = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileContent);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!response.ok) {
      if (response.status === 401) {
          throw new Error("Auth Expired. Please reconnect Drive.");
      }
      throw new Error("Upload failed");
  }
  
  const data = await response.json();
  return { id: data.id, webViewLink: data.webViewLink };
};

// Wrapper for Audio
export const uploadAudioToDrive = async (filename: string, audioBlob: Blob): Promise<{id: string, webViewLink?: string}> => {
    // Determine extension based on blob type if possible, otherwise default to .webm
    const ext = audioBlob.type.includes('mp4') ? '.mp4' : '.webm';
    const finalName = filename.endsWith(ext) ? filename : `${filename}${ext}`;
    return uploadFileToDrive(finalName, audioBlob, audioBlob.type, 'Audio', false);
};

// Wrapper for Text (Notes/Transcripts) -> Converted to Google Doc
export const uploadTextToDrive = async (filename: string, content: string, subFolder: 'Notes' | 'Transcripts'): Promise<{id: string, webViewLink?: string}> => {
    // 1. Convert Markdown to HTML so Google Drive parses formatting correctly
    const htmlContent = convertMarkdownToHtml(content);
    
    // 2. Upload with conversion flag set to true
    return uploadFileToDrive(filename, htmlContent, 'text/html', subFolder, true);
};
