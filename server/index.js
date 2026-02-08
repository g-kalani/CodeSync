require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

// --- YJS & WEBSOCKET SETUP ---
const yWebsocketDir = path.dirname(require.resolve('y-websocket/package.json'));
const findUtilsPath = (dir) => {
    const targets = ['utils.js', 'utils.cjs', 'index.js', 'index.cjs'];
    const subfolders = ['bin', 'dist', 'src', 'dist/bin', 'lib'];
    for (const folder of subfolders) {
        for (const file of targets) {
            const fullPath = path.join(dir, folder, file);
            if (fs.existsSync(fullPath)) return fullPath;
        }
    }
    return null;
};

const yUtilsPath = findUtilsPath(yWebsocketDir);
if (!yUtilsPath) {
    console.error("❌ CRITICAL ERROR: Could not locate y-websocket utilities.");
    process.exit(1);
}

const { setupWSConnection } = require(yUtilsPath);
const app = express();
app.use(cors());
app.use(express.json());

const buildPath = path.join(__dirname, '../code-collaborator/build');
app.use(express.static(buildPath));

// --- DATASET LOADING ---
const datasetFileName = 'dataset.jsonl';
let localDataset = [];
const loadJSONL = async (filePath) => {
    const data = [];
    if (!fs.existsSync(filePath)) return data;
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, terminal: false });
    for await (const line of rl) {
        if (line.trim()) {
            try { data.push(JSON.parse(line)); } 
            catch (err) { }
        }
    }
    return data;
};

(async () => {
    const localPath = path.join(__dirname, datasetFileName);
    try {
        localDataset = await loadJSONL(localPath);
        console.log(`✅ Loaded ${localDataset.length} examples.`);
    } catch (err) { console.error("Error loading dataset:", err.message); }
})();

const isProduction = process.env.NODE_ENV === 'production' || process.env.PORT;
const tempDir = isProduction ? '/tmp' : __dirname;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

// --- COLLABORATION LOGIC ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const wss = new WebSocket.Server({ noServer: true });

io.on('connection', (socket) => {
    socket.on('join', ({ roomId, username }) => {
        socket.join(roomId);
        socket.to(roomId).emit('user-joined', { username, socketId: socket.id });
    });

    socket.on('language-change', ({ roomId, newLanguage }) => {
        io.to(roomId).emit('language-changed', { newLanguage });
    });

    socket.on('execution-started', ({ roomId }) => {
        io.to(roomId).emit('remote-execution-started');
    });

    socket.on('broadcast-results', ({ roomId, output, aiAnalysis, executionTime }) => { 
        io.to(roomId).emit('execution-results', { 
            output, 
            aiAnalysis, 
            executionTime 
        });
    });

    socket.on('disconnecting', () => {
        const rooms = [...socket.rooms];
        rooms.forEach((roomId) => {
            socket.to(roomId).emit('user-left', { socketId: socket.id });
        });
    });
    socket.on('clear-workspace', ({ roomId }) => {
        io.to(roomId).emit('workspace-cleared');
    });
});

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!url.pathname.startsWith('/socket.io')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            setupWSConnection(ws, request);
        });
    }
});

const runCommand = (cmd) => new Promise((resolve) => {
    const startHr = process.hrtime.bigint(); // Capture start time in nanoseconds
    
    exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
        const endHr = process.hrtime.bigint(); // Capture end time
        
        // Calculate difference and convert nanoseconds to seconds string
        const totalNs = endHr - startHr;
        const executionTime = (Number(totalNs) / 1_000_000_000).toFixed(6);
        
        resolve({ 
            stdout, 
            stderr: stderr || (error ? error.message : ""),
            executionTime 
        });
    });
});

async function getGeminiErrorAnalysis(code, error, language) {
    const languageExamples = localDataset.filter(item => item.lang === language).slice(0, 3); 
    const hasExamples = languageExamples.length > 0; // Check if we have data

    const examplesContext = hasExamples 
        ? languageExamples.map((ex, i) => `Example ${i + 1}:\nError: ${ex.error_context}\nFix:\n${ex.fix || ex.code}`).join("\n\n")
        : "No specific local examples found for this language.";

    const prompt = `
    You are an expert programming tutor for ${language}. 
    
    STRICT FORMATTING RULES:
    1. NEVER use backticks (\`) or code blocks (\`\`\`) in the explanation section.
    2. The ONLY triple-backtick block allowed is at the very end of your response.
    3. ${hasExamples ? 'Start with the tag: [DATASET-GROUNDED ANALYSIS]' : 'Do NOT use the dataset-grounded tag.'}

    Reference Examples from my local database:
    ${examplesContext}

    Student Code:
    ${code}
    
    Error Message:
    ${error}
    
    Response Structure:
    [Explanation in plain text - max 2 sentences]
    
    Corrected Code:
    [\`\`\`language block here]
`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (err) {
        return `AI analysis failed. Error: ${err.message}`;
    }
}

app.post('/execute', async (req, res) => {
    const { code, language } = req.body;
    let filename = "";
    let className = "";
    let executeCmd = ""; 

    if (language === 'java') {
        const classMatch = code.match(/public\s+class\s+(\w+)/);
        className = classMatch ? classMatch[1] : "Main"; 
        filename = `${className}.java`;
        const filePath = path.join(tempDir, filename); 
        fs.writeFileSync(filePath, code);        
        
        if (isProduction) {
            // Render execution (Direct)
            executeCmd = `javac "${filePath}" && java -cp "${tempDir}" ${className}`;
        } else {
            // Local execution (Docker)
            executeCmd = `docker run --rm -v "${process.cwd()}:/app" compiler-box sh -c "javac /app/${filename} && java -cp /app ${className}"`;
        }
    } else {
        const ext = language === 'python' ? 'py' : 'cpp';
        filename = `temp_code.${ext}`;
        const filePath = path.join(tempDir, filename); 
        fs.writeFileSync(filePath, code);

        if (language === 'python') {
            if (isProduction) {
                executeCmd = `python3 "${filePath}"`;
            } else {
                executeCmd = `docker run --rm -v "${process.cwd()}:/app" compiler-box python3 /app/${filename}`;
            }
        } else if (language === 'cpp') {
            if (isProduction) {
                const outPath = path.join(tempDir, 'temp_out');
                executeCmd = `g++ "${filePath}" -o "${outPath}" && chmod +x "${outPath}" && "${outPath}"`;
            } else {
                executeCmd = `docker run --rm -v "${process.cwd()}:/app" compiler-box sh -c "g++ /app/${filename} -o /app/out && /app/out"`;
            }
        }
    }

    try {
        // 1. Run the code and get high-precision time from runCommand
        const { stdout, stderr, executionTime } = await runCommand(executeCmd);

        let aiExplanation = "";        
        
        // 2. Trigger AI analysis only if there is an error
        if (stderr && stderr.trim() !== "") {
            try {
                // Using the Gemini 2.5 Flash model as configured earlier
                aiExplanation = await getGeminiErrorAnalysis(code, stderr, language);
            } catch (aiErr) {
                console.error("AI Analysis Error:", aiErr);
                aiExplanation = "AI Debugger insight failed to load, but code execution completed.";
            }
        }

        // 3. Send 6-decimal precision result to the frontend
        res.json({ 
            stdout, 
            stderr, 
            aiExplanation, 
            executionTime 
        }); 

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        const filesToCleanup = [filename, 'temp_out', 'out', `${className}.class`];
        filesToCleanup.forEach(f => {
            const p = path.join(tempDir, f);
            if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} }
        });
    }
});

app.get(/^(?!\/api).+/, (req, res) => {
  res.sendFile(path.join(__dirname, '../code-collaborator/build', 'index.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});