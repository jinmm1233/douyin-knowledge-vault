// AI 诊断：读取失败上下文文件，调用 DeepSeek 分析并输出简短结论（供 run-sync.ps1 失败时自动调用）
// 用法: node ai-diagnose.mjs --context <上下文文件路径>
// 依赖环境变量: DOK_LLM_BASE_URL, DOK_LLM_API_KEY（与 cli.mjs 相同）
import fs from "fs";
import https from "https";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}
const ctxFile = arg("--context");
let context = "";
if (ctxFile && fs.existsSync(ctxFile)) {
  const raw = fs.readFileSync(ctxFile, "utf8");
  context = raw.slice(-6000); // 只喂最近 6000 字符，控制 token
} else {
  context = "（未找到上下文文件，仅做通用检查）";
}

const base = (process.env.DOK_LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const key = process.env.DOK_LLM_API_KEY || "";
if (!key) {
  console.log("AI 诊断不可用：缺少 DOK_LLM_API_KEY 环境变量");
  process.exit(0);
}

const payload = JSON.stringify({
  model: "deepseek-chat",
  messages: [
    {
      role: "system",
      content: "你是「抖音收藏→Obsidian 知识库」每日定时同步任务的运维诊断助手。用户给出任务失败日志，请用简体中文直接输出三段，每段一行：1) 最可能的原因（一句话，说明是脚本问题/接口问题/登录问题/网络问题中的哪一类）2) 严重程度（低/中/高，并说明是否需要立即处理）3) 建议动作（一句话，可直接执行）。总字数不超过150字，不要客套，不要解释 AI 身份。",
    },
    { role: "user", content: "以下是失败上下文（含时间戳、错误信息、各阶段子命令输出）：\n" + context },
  ],
  max_tokens: 500,
  temperature: 0.2,
});

const url = new URL(base + "/chat/completions");
const req = https.request(
  url,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      try {
        const j = JSON.parse(d);
        const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "（模型未返回内容）";
        console.log(text.split("\n").filter(Boolean).join(" | "));
      } catch {
        console.log("AI 响应解析失败: " + d.slice(0, 300));
      }
    });
  }
);
req.on("error", (e) => console.log("AI 调用失败: " + e.message));
req.write(payload);
req.end();
