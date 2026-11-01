// 整理自动更新发布目录：把最新安装包 + blockmap + latest.yml 收进 release/update-feed/
// 用法：
//   node scripts/make-update-feed.mjs            整理目录
//   node scripts/make-update-feed.mjs --serve    整理后起本地 HTTP 服务（测试更新用）
//   node scripts/make-update-feed.mjs --port 8899
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const outDir = path.join(releaseDir, "update-feed");

const args = process.argv.slice(2);
const serve = args.includes("--serve");
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8899;

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const exeName = `DouyinKnowledge-Setup-${version}.exe`;

if (!fs.existsSync(releaseDir)) {
  console.error(`找不到 ${releaseDir}，请先执行打包：npm run dist`);
  process.exit(1);
}

const latestPath = path.join(releaseDir, "latest.yml");
if (!fs.existsSync(latestPath)) {
  console.error("release/latest.yml 不存在：打包时没有生成更新元数据，检查 package.json 的 build.publish 配置");
  process.exit(1);
}

const latest = fs.readFileSync(latestPath, "utf8");
const declared = (latest.match(/^version:\s*(.+)$/m) || [])[1];
if (declared && declared.trim() !== version) {
  console.error(`版本不一致：package.json = ${version}，latest.yml = ${declared.trim()}。请重新打包。`);
  process.exit(1);
}
if (!latest.includes(exeName)) {
  console.error(`latest.yml 里没有指向 ${exeName}，可能与当前 package.json 版本不匹配，请重新打包。`);
  process.exit(1);
}

const wanted = [exeName, `${exeName}.blockmap`, "latest.yml"];
const missing = wanted.filter((f) => !fs.existsSync(path.join(releaseDir, f)));
if (missing.length) {
  console.error(`以下文件缺失，无法发布：${missing.join(", ")}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
for (const f of wanted) {
  const from = path.join(releaseDir, f);
  const to = path.join(outDir, f);
  if (fs.existsSync(to)) fs.rmSync(to, { force: true });
  // 同盘优先硬链接：安装包 800MB+，复制一份纯属浪费空间
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
  const mb = (fs.statSync(to).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${f}  ${mb} MB`);
}

console.log(`\n发布目录已就绪：${outDir}`);
console.log(`版本：${version}`);
console.log(`
下一步（任选一种）：
  A. GitHub Releases
     新建 tag v${version}，把 update-feed 里三个文件作为 Release 附件上传。
     软件设置页「更新源 · GitHub 仓库」填 owner/仓库名。
  B. 自有/对象存储直链
     把 update-feed 整个目录传到任意能直链访问的地址（OSS/COS/静态站点），
     软件设置页「更新源 · 直链目录」填该地址（结尾带 /）。
     注意：latest.yml 必须在根目录，且三个文件同级。

以后发新版本：
  1) 改 package.json 的 version
  2) npm run dist
  3) node scripts/make-update-feed.mjs
  4) 上传覆盖
`);

if (serve) {
  const mime = { ".yml": "text/yaml" };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "latest.yml";
    const file = path.join(outDir, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`本地更新源已启动：http://127.0.0.1:${port}/`);
    console.log(`把安装版软件设置页的「直链目录」填成上面这个地址，即可测试检查更新。`);
    console.log(`测试完按 Ctrl+C 停止。`);
  });
}
