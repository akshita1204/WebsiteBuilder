

import { GoogleGenAI } from "@google/genai";
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import fs from "fs";

const asyncExecute = promisify(exec);
const platform = os.platform();
const History = [];
const PORT = 3000;

const ai = new GoogleGenAI({ apiKey: "AIzaSyBWUuT9VsZufWHibCcNG5t6XphusmkyODc" });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let socketClient = null;

app.use(express.static("public"));
app.use("/preview", express.static("generated-site"));

wss.on("connection", (ws) => {
  socketClient = ws;
  ws.send("Connected to AI Website Builder!");
});

function sendToClient(message) {
  if (socketClient && socketClient.readyState === 1) {
    socketClient.send(message);
  }
}

async function executeCommand({ coin }) {
  try {
    sendToClient(`🛠 Executing: ${coin}`);
    const { stdout, stderr } = await asyncExecute(coin);
    if (stderr) sendToClient(`Error: ${stderr}`);
    else sendToClient(`Output: ${stdout}`);
    return stdout || "Executed";
  } catch (error) {
    sendToClient(`Exception: ${error.message}`);
    return `Error: ${error.message}`;
  }
}

const executeCommandDeclairation = {
  name: "ExecuteCommand",
  description: "Execute terminal command (create/edit folders/files)",
  parameters: {
    type: "OBJECT",
    properties: {
      coin: {
        type: "String",
        description: "Single terminal command like mkdir, echo, etc"
      }
    },
    required: ["coin"]
  }
};

const availableTools = {
  ExecuteCommand: executeCommand
};

async function generateWithRetry(config, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await ai.models.generateContent(config);
      return response;
    } catch (error) {
      if (error.status === 429 || error.status === 503) {
        const delay = 30000 + Math.random() * 15000; // 30–45 sec
        sendToClient(`Model busy (${error.status}). Retrying in ${Math.floor(delay / 1000)}s...`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        console.error("Gemini API Error:", error.status, error.message);
        sendToClient(`Gemini Error ${error.status}: ${error.message}`);
        throw error;
      }
    }
  }
  throw new Error("Max retries exceeded due to overload or rate limit.");
}

async function runAgent(userProblem) {
  History.push({ role: "user", parts: [{ text: userProblem }] });

  while (true) {
    const response = await generateWithRetry({
      model: "gemini-2.5-flash",
      contents: History,
      config: {
        systemInstruction: `
You are a website generator. You must:
1. Understand the user's input.
2. Generate Windows-friendly terminal commands step by step.
3. Use echo ^<tag^> >> file syntax.
4. Create folder named "generated-site", and inside it:
   - index.html
   - style.css
   - script.js
5. Add real content to those files (header, button, JS click logic, etc.)
6. Use: cd generated-site && echo ^<h1^>... >> index.html

Respond ONLY using ExecuteCommand tool calls.
        `,
        tools: [{ functionDeclarations: [executeCommandDeclairation] }]
      }
    });

    if (response.functionCalls?.length > 0) {
      const { name, args } = response.functionCalls[0];
      sendToClient(`Gemini: ${args.coin}`);
      const toolFn = availableTools[name];
      const result = await toolFn(args);

      History.push({ role: "model", parts: [{ functionCall: response.functionCalls[0] }] });
      History.push({ role: "user", parts: [{ functionResponse: { name, response: { result } } }] });
    } else {
      response.parts?.forEach((part) => {
        if (part.text) sendToClient(part.text);
        else sendToClient(JSON.stringify(part));
      });
      History.push({ role: "model", parts: response.parts });
      break;
    }
  }
}

app.get("/start", async (req, res) => {
  const prompt = req.query.q;
  if (!prompt) return res.status(400).send("Missing prompt");
  sendToClient(`Prompt received: ${prompt}`);
  fs.rmSync("./generated-site", { recursive: true, force: true });
  fs.mkdirSync("./generated-site", { recursive: true });
  runAgent(prompt);
  res.send("Started generating site...");
});

server.listen(PORT, () => {
  console.log(`Running: http://localhost:${PORT}`);
});
