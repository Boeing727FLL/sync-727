import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Logo Duplication Logic ---
try {
  const publicDir = path.join(__dirname, 'public');
  const logoPath = path.join(publicDir, 'logo.png');
  const logo2Path = path.join(publicDir, 'Logo2.png');

  if (fs.existsSync(logoPath) && !fs.existsSync(logo2Path)) {
    fs.copyFileSync(logoPath, logo2Path);
    console.log('Successfully duplicated logo.png to Logo2.png for splash screen');
  }
} catch (err) {
  console.error('Error duplicating logo:', err);
}

// --- Push Notifications Setup ---
// Removed

export const app = express();

// --- Middleware & Routes Configuration (Exposed for Netlify) ---
app.use(express.json());
app.use(cookieParser());

// --- Helper to get token ---
const getToken = (req: any) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  return req.cookies.google_access_token;
};

// --- Shared Token Storage (Simple File Persistence) ---
const TOKEN_FILE = path.join(__dirname, 'drive-token.json');
let sharedAccessToken: string | null = null;

// Load token on startup
try {
  if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    sharedAccessToken = data.token;
    console.log("Loaded shared Drive token from disk");
  }
} catch (e) {
  console.error("Failed to load token file", e);
}

const saveToken = (token: string) => {
  sharedAccessToken = token;
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
  } catch (e) {
    console.error("Failed to save token file", e);
  }
};

// --- Auth Endpoints ---

app.post("/api/config/drive-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });
  saveToken(token);
  res.json({ success: true });
});

app.get("/api/config/drive-status", (req, res) => {
  res.json({ isConnected: !!sharedAccessToken });
});

app.post("/api/auth/session", (req, res) => {
  const { token, user } = req.body;
  console.log("Received auth session request. Token length:", token?.length, "User:", user?.email);
  
  if (!token) {
    console.error("No token provided in session request");
    return res.status(400).json({ error: "No token provided" });
  }

  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: "none" as const,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };

  res.cookie("google_access_token", token, cookieOptions);
  res.cookie("user_info", JSON.stringify(user), cookieOptions);
  console.log("Cookies set successfully");
  res.json({ success: true });
});

app.get("/api/auth/me", (req, res) => {
  const userInfo = req.cookies.user_info;
  if (!userInfo) return res.status(401).json({ error: "Not authenticated" });
  res.json(JSON.parse(userInfo));
});

app.get("/api/auth/check", (req, res) => {
  const token = getToken(req);
  res.json({ 
    hasToken: !!token, 
    tokenPreview: token ? `${token.substring(0, 5)}...` : null 
  });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("google_access_token");
  res.clearCookie("user_info");
  res.json({ success: true });
});

// --- Google Drive Proxy Endpoints ---

app.get("/api/drive/info", async (req, res) => {
  const token = sharedAccessToken || getToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Get the root folder ID
    const response = await axios.get("https://www.googleapis.com/drive/v3/files/root", {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: "id, webViewLink" }
    });
    res.json(response.data);
  } catch (error: any) {
    res.status(error.response?.status || 500).json(error.response?.data);
  }
});

const driveHandler = async (req: any, res: any) => {
  // Use shared token if available, otherwise check user token
  const token = sharedAccessToken || getToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const folderId = req.query.folderId || 'root';

  try {
    const response = await axios.get("https://www.googleapis.com/drive/v3/files", {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, modifiedTime, iconLink, webViewLink, thumbnailLink)",
        pageSize: 100,
        orderBy: "folder,name"
      },
    });
    res.json(response.data);
  } catch (error: any) {
    const errorData = error.response?.data || { error: { message: error.message } };
    
    const errorObj = errorData.error || {};
    const details = errorObj.details || [];
    const errors = errorObj.errors || [];
    
    // Check new format (details array)
    const errorInfo = details.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
    
    // Check old format (errors array)
    const accessError = errors.find((e: any) => e.reason === 'accessNotConfigured' || e.reason === 'forbidden');

    // Only log full error if it's NOT a known configuration issue
    if (errorInfo?.reason === 'SERVICE_DISABLED' || (accessError && errorObj.code === 403)) {
      console.warn("Drive API disabled. Sending 403 to client.");
    } else if (error.response?.status === 401) {
      console.warn("Drive API token expired. Sending 401 to client.");
    } else {
      console.error("Drive API Error Detail:", JSON.stringify(errorData, null, 2));
    }

    if (errorInfo?.reason === 'SERVICE_DISABLED' || (accessError && errorObj.code === 403)) {
      const envProjectId = process.env.VITE_FIREBASE_PROJECT_ID;
      let projectId = envProjectId || 'your-project';
      let actionUrl = `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`;

      if (errorInfo) {
        const projectMetadata = details.find((d: any) => d.metadata?.consumer)?.metadata;
        const detectedId = projectMetadata?.consumer?.split('/')[1];
        if (detectedId) {
          projectId = detectedId;
          actionUrl = `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`;
        }
      } else if (accessError?.extendedHelp) {
        actionUrl = accessError.extendedHelp;
      }
      
      return res.status(403).json({
        error: "Google Drive API is not enabled",
        message: "עליך להפעיל את Google Drive API בקונסול של Google Cloud.",
        action_url: actionUrl,
        project_id: projectId
      });
    }

    // Handle 401 Unauthorized (Token expired)
    if (error.response?.status === 401) {
      res.clearCookie("google_access_token");
      return res.status(401).json({ 
        error: "Session expired", 
        message: "פג תוקף החיבור ל-Google. אנא התחבר מחדש." 
      });
    }

    res.status(error.response?.status || 500).json(errorData);
  }
};

app.get("/api/drive/files", driveHandler);
app.get("/api/drive/files/", driveHandler);

app.delete("/api/drive/files/:fileId", async (req, res) => {
  const token = sharedAccessToken || getToken(req);
  const { fileId } = req.params;
  try {
    await axios.delete(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.response?.status || 500).json(error.response?.data);
  }
});

app.patch("/api/drive/files/:fileId", async (req, res) => {
  const token = sharedAccessToken || getToken(req);
  const { fileId } = req.params;
  const { name } = req.body;
  try {
    const response = await axios.patch(`https://www.googleapis.com/drive/v3/files/${fileId}`, 
      { name },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (error: any) {
    res.status(error.response?.status || 500).json(error.response?.data);
  }
});

app.post("/api/drive/folders", async (req, res) => {
  const token = sharedAccessToken || getToken(req);
  const { name, parentId } = req.body;
  try {
    const response = await axios.post("https://www.googleapis.com/drive/v3/files", 
      { 
        name, 
        mimeType: "application/vnd.google-apps.folder",
        parents: parentId ? [parentId] : []
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (error: any) {
    res.status(error.response?.status || 500).json(error.response?.data);
  }
});

app.post("/api/drive/upload", async (req, res) => {
  const token = sharedAccessToken || getToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  // This is a simplified version. For real multipart uploads, 
  // we'd use a library like busboy or multer.
  // For now, we'll assume the client sends the file metadata and content.
  try {
    const { name, content, mimeType } = req.body;
    
    // 1. Create metadata
    const metadataResponse = await axios.post("https://www.googleapis.com/drive/v3/files", 
      { name, mimeType },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    const fileId = metadataResponse.data.id;

    // 2. Upload content (Simple upload for small files)
    await axios.patch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, 
      content,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType } }
    );

    res.json({ success: true, fileId });
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error("Upload Error Detail:", JSON.stringify(errorData, null, 2));
    res.status(500).json({ error: "Upload failed", details: errorData });
  }
});

// iOS Configuration Profile Generator (The "Innovative" Way)
app.get("/api/ios-profile", (req, res) => {
  const appUrl = process.env.APP_URL || `https://${req.get('host')}`;
  const iconUrl = `${appUrl}/logo.png`;
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>FullScreen</key>
            <true/>
            <key>IsRemovable</key>
            <true/>
            <key>Label</key>
            <string>Sync 727</string>
            <key>PayloadDescription</key>
            <string>Configures Sync 727 Aerospace OS</string>
            <key>PayloadDisplayName</key>
            <string>Sync 727 Web Clip</string>
            <key>PayloadIdentifier</key>
            <string>com.boeing727.teamapp.webclip</string>
            <key>PayloadType</key>
            <string>com.apple.webClip.managed</string>
            <key>PayloadUUID</key>
            <string>72772772-7277-7277-7277-727727727277</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>URL</key>
            <string>${appUrl}</string>
            <key>IconURL</key>
            <string>${iconUrl}</string>
            <key>Precomposed</key>
            <true/>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Sync 727 Team OS Installation Profile. This will add Sync 727 to your home screen as a standalone application.</string>
    <key>PayloadDisplayName</key>
    <string>Sync 727 Installation</string>
    <key>PayloadIdentifier</key>
    <string>com.boeing727.profile</string>
    <key>PayloadOrganization</key>
    <string>Boeing 727 Team</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>12345678-1234-1234-1234-123456789012</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="sync727.mobileconfig"');
  res.send(profile);
});

// Android APK Download Route
app.get("/api/android-apk", (req, res) => {
  // In a real scenario, we would serve the actual .apk file.
  // Since we don't have one, we'll serve a dummy file and inform the user.
  const dummyApkContent = "This is a placeholder for the Sync 727 Android APK. In a production environment, this would be a real .apk file generated via Android Studio.";
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="sync727.apk"');
  res.send(dummyApkContent);
});

// Global Error Handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error("Global Server Error:", err);
  res.status(500).json({ 
    error: "Internal Server Error", 
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

const startServer = async () => {
  const server = createServer(app);
  const PORT = 3000;

  // WebSocket Server setup
  const wss = new WebSocketServer({ server });

  interface Client {
    ws: WebSocket;
    userId: string;
    userName: string;
    role: string;
    channel: string | null;
  }

  const clients = new Map<string, Client>();

  wss.on("connection", (ws) => {
    const connectionId = Math.random().toString(36).substring(2, 15);
    let currentUserId: string | null = null;

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case "auth":
            currentUserId = message.userId;
            clients.set(connectionId, {
              ws,
              userId: message.userId,
              userName: message.userName,
              role: message.role,
              channel: null
            });
            console.log(`Client authenticated: ${message.userName} (${message.role}) [Conn: ${connectionId}]`);
            broadcastPresence();
            break;

          case "join_channel":
            if (clients.has(connectionId)) {
              const client = clients.get(connectionId)!;
              client.channel = message.channel;
              console.log(`${client.userName} joined channel: ${message.channel}`);
              broadcastPresence();
            }
            break;
        }
      } catch (e) {
        console.error("WS Message Error:", e);
      }
    });

    ws.on("close", () => {
      if (clients.has(connectionId)) {
        clients.delete(connectionId);
        broadcastPresence();
      }
    });
  });

  function broadcastPresence() {
    // Deduplicate presence by userId so a user with multiple tabs only shows up once
    const uniqueUsers = new Map<string, any>();
    Array.from(clients.values()).forEach(c => {
      uniqueUsers.set(c.userId, {
        userId: c.userId,
        userName: c.userName,
        role: c.role,
        channel: c.channel
      });
    });
    const presence = Array.from(uniqueUsers.values());
    broadcastToAll({ type: "presence_update", presence });
  }

  function broadcastToAll(data: any) {
    const payload = JSON.stringify(data);
    clients.forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    });
  }

  // --- Helper to get token ---
  const getToken = (req: any) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
    return req.cookies.google_access_token;
  };

  // --- Shared Token Storage (Simple File Persistence) ---
  const TOKEN_FILE = path.join(__dirname, 'drive-token.json');
  let sharedAccessToken: string | null = null;

  // Load token on startup
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      sharedAccessToken = data.token;
      console.log("Loaded shared Drive token from disk");
    }
  } catch (e) {
    console.error("Failed to load token file", e);
  }

  const saveToken = (token: string) => {
    sharedAccessToken = token;
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
    } catch (e) {
      console.error("Failed to save token file", e);
    }
  };

  // --- Auth Endpoints ---
  
  app.post("/api/config/drive-token", (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "No token provided" });
    saveToken(token);
    res.json({ success: true });
  });

  app.get("/api/config/drive-status", (req, res) => {
    res.json({ isConnected: !!sharedAccessToken });
  });

  app.post("/api/auth/session", (req, res) => {
    const { token, user } = req.body;
    console.log("Received auth session request. Token length:", token?.length, "User:", user?.email);
    
    if (!token) {
      console.error("No token provided in session request");
      return res.status(400).json({ error: "No token provided" });
    }

    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: "none" as const,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    };

    res.cookie("google_access_token", token, cookieOptions);
    res.cookie("user_info", JSON.stringify(user), cookieOptions);
    console.log("Cookies set successfully");
    res.json({ success: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const userInfo = req.cookies.user_info;
    if (!userInfo) return res.status(401).json({ error: "Not authenticated" });
    res.json(JSON.parse(userInfo));
  });

  app.get("/api/auth/check", (req, res) => {
    const token = getToken(req);
    res.json({ 
      hasToken: !!token, 
      tokenPreview: token ? `${token.substring(0, 5)}...` : null 
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("google_access_token");
    res.clearCookie("user_info");
    res.json({ success: true });
  });

  // --- Google Drive Proxy Endpoints ---

  app.get("/api/drive/info", async (req, res) => {
    const token = sharedAccessToken || getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      // Get the root folder ID
      const response = await axios.get("https://www.googleapis.com/drive/v3/files/root", {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: "id, webViewLink" }
      });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data);
    }
  });

  const driveHandler = async (req: any, res: any) => {
    // Use shared token if available, otherwise check user token
    const token = sharedAccessToken || getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const folderId = req.query.folderId || 'root';

    try {
      const response = await axios.get("https://www.googleapis.com/drive/v3/files", {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, modifiedTime, iconLink, webViewLink, thumbnailLink)",
          pageSize: 100,
          orderBy: "folder,name"
        },
      });
      res.json(response.data);
    } catch (error: any) {
      const errorData = error.response?.data || { error: { message: error.message } };
      
      const errorObj = errorData.error || {};
      const details = errorObj.details || [];
      const errors = errorObj.errors || [];
      
      // Check new format (details array)
      const errorInfo = details.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
      
      // Check old format (errors array)
      const accessError = errors.find((e: any) => e.reason === 'accessNotConfigured' || e.reason === 'forbidden');

      // Only log full error if it's NOT a known configuration issue
      if (errorInfo?.reason === 'SERVICE_DISABLED' || (accessError && errorObj.code === 403)) {
        console.warn("Drive API disabled. Sending 403 to client.");
      } else if (error.response?.status === 401) {
        console.warn("Drive API token expired. Sending 401 to client.");
      } else {
        console.error("Drive API Error Detail:", JSON.stringify(errorData, null, 2));
      }

      if (errorInfo?.reason === 'SERVICE_DISABLED' || (accessError && errorObj.code === 403)) {
        const envProjectId = process.env.VITE_FIREBASE_PROJECT_ID;
        let projectId = envProjectId || 'your-project';
        let actionUrl = `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`;

        if (errorInfo) {
          const projectMetadata = details.find((d: any) => d.metadata?.consumer)?.metadata;
          const detectedId = projectMetadata?.consumer?.split('/')[1];
          if (detectedId) {
            projectId = detectedId;
            actionUrl = `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`;
          }
        } else if (accessError?.extendedHelp) {
          actionUrl = accessError.extendedHelp;
        }
        
        return res.status(403).json({
          error: "Google Drive API is not enabled",
          message: "עליך להפעיל את Google Drive API בקונסול של Google Cloud.",
          action_url: actionUrl,
          project_id: projectId
        });
      }

      // Handle 401 Unauthorized (Token expired)
      if (error.response?.status === 401) {
        res.clearCookie("google_access_token");
        return res.status(401).json({ 
          error: "Session expired", 
          message: "פג תוקף החיבור ל-Google. אנא התחבר מחדש." 
        });
      }

      res.status(error.response?.status || 500).json(errorData);
    }
  };

  app.get("/api/drive/files", driveHandler);
  app.get("/api/drive/files/", driveHandler);

  app.delete("/api/drive/files/:fileId", async (req, res) => {
    const token = sharedAccessToken || getToken(req);
    const { fileId } = req.params;
    try {
      await axios.delete(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data);
    }
  });

  app.patch("/api/drive/files/:fileId", async (req, res) => {
    const token = sharedAccessToken || getToken(req);
    const { fileId } = req.params;
    const { name } = req.body;
    try {
      const response = await axios.patch(`https://www.googleapis.com/drive/v3/files/${fileId}`, 
        { name },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data);
    }
  });

  app.post("/api/drive/folders", async (req, res) => {
    const token = sharedAccessToken || getToken(req);
    const { name, parentId } = req.body;
    try {
      const response = await axios.post("https://www.googleapis.com/drive/v3/files", 
        { 
          name, 
          mimeType: "application/vnd.google-apps.folder",
          parents: parentId ? [parentId] : []
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data);
    }
  });

  app.post("/api/drive/upload", async (req, res) => {
    const token = sharedAccessToken || getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    // This is a simplified version. For real multipart uploads, 
    // we'd use a library like busboy or multer.
    // For now, we'll assume the client sends the file metadata and content.
    try {
      const { name, content, mimeType } = req.body;
      
      // 1. Create metadata
      const metadataResponse = await axios.post("https://www.googleapis.com/drive/v3/files", 
        { name, mimeType },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );

      const fileId = metadataResponse.data.id;

      // 2. Upload content (Simple upload for small files)
      await axios.patch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, 
        content,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType } }
      );

      res.json({ success: true, fileId });
    } catch (error: any) {
      const errorData = error.response?.data;
      console.error("Upload Error Detail:", JSON.stringify(errorData, null, 2));
      res.status(500).json({ error: "Upload failed", details: errorData });
    }
  });

  // --- Vite Middleware ---
  
  // iOS Configuration Profile Generator (The "Innovative" Way)
  app.get("/api/ios-profile", (req, res) => {
    const appUrl = process.env.APP_URL || `https://${req.get('host')}`;
    const iconUrl = `${appUrl}/logo.png`;
    const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>FullScreen</key>
            <true/>
            <key>IsRemovable</key>
            <true/>
            <key>Label</key>
            <string>Sync 727</string>
            <key>PayloadDescription</key>
            <string>Configures Sync 727 Aerospace OS</string>
            <key>PayloadDisplayName</key>
            <string>Sync 727 Web Clip</string>
            <key>PayloadIdentifier</key>
            <string>com.boeing727.teamapp.webclip</string>
            <key>PayloadType</key>
            <string>com.apple.webClip.managed</string>
            <key>PayloadUUID</key>
            <string>72772772-7277-7277-7277-727727727277</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>URL</key>
            <string>${appUrl}</string>
            <key>IconURL</key>
            <string>${iconUrl}</string>
            <key>Precomposed</key>
            <true/>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Sync 727 Team OS Installation Profile. This will add Sync 727 to your home screen as a standalone application.</string>
    <key>PayloadDisplayName</key>
    <string>Sync 727 Installation</string>
    <key>PayloadIdentifier</key>
    <string>com.boeing727.profile</string>
    <key>PayloadOrganization</key>
    <string>Boeing 727 Team</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>12345678-1234-1234-1234-123456789012</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;

    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'attachment; filename="sync727.mobileconfig"');
    res.send(profile);
  });

  // Android APK Download Route
  app.get("/api/android-apk", (req, res) => {
    // In a real scenario, we would serve the actual .apk file.
    // Since we don't have one, we'll serve a dummy file and inform the user.
    const dummyApkContent = "This is a placeholder for the Sync 727 Android APK. In a production environment, this would be a real .apk file generated via Android Studio.";
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="sync727.apk"');
    res.send(dummyApkContent);
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  // Global Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Global Server Error:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Only start the server if this file is run directly (not as a function)
if (process.env.NODE_ENV !== "production" || !process.env.NETLIFY) {
  startServer();
}
