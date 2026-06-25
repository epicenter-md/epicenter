# 能说会道 · 云端共用后端 交接文档

> 给「桌面端开发」的零上下文交接。目标:把桌面端已验证的成文/转写逻辑,
> 收敛成一套**云端共用后端**;iOS / 桌面 / 小程序都调同一套 API,客户端只管录音 + 收发 + 显示。

---

## 一、目标 & 架构原则

```
        桌面(Tauri/Svelte)  ┐
        iOS(SwiftUI)        ┼──→  共用后端 /v1/*  ──→  ASR(火山/SenseVoice) + LLM(DeepSeek/豆包)
        (以后小程序)        ┘     ↑ 唯一"大脑"在这里
```

- **客户端瘦**:只做「录音(WAV 16k mono)→ POST 接口 → 拿文字显示/上屏」。
- **大脑全在云端**:prompt、改写程度、模式路由(口述/翻译/随便问)、ASR 选型,**只此一份**,各端共用,避免发散。
- **你的核心任务**:把桌面端那套验证过的 transformation / transcription 逻辑,搬进这套后端的 `/v1/polish` 和 ASR 路由,作为唯一大脑;然后部署到新服务器、上域名 + HTTPS。

---

## 二、现状速览

**后端代码(已存在,可直接接手):** `~/Projects/JustSayAi/server/`
```
main.py            FastAPI:/v1/audio/transcriptions + /v1/polish + /health,ASR 后端可换
requirements.txt   fastapi / uvicorn / httpx / python-multipart
.env.example       配置模板
deploy.sh          一键部署到 ECS(scp + venv + systemd)
README.md          跑法
```
- 本地已端到端跑通:iOS 录音 → 转写 → 成文 → 上屏(口述/翻译/随便问三模式实测过)。
- ASR 后端两种:`sensevoice`(本地自部署,`~/sensevoice-test` :8000,开发用)/ `volc`(火山豆包大模型,生产用,**已修正可用**,见第七节)。

**新生产服务器(已买好):**
```
阿里云 ECS  47.101.149.157   2核2G / Ubuntu 26.04 / 上海
安全组      已放行 22 / 80 / 443 / 8080
备案        和 dailyyun.com 同阿里云接入 → 子域名 api.dailyyun.com 免新备案(直接可用)
```

**iOS 端(另一 session 负责,已基本成型):** 原生框架(首页/历史/风格/账户 Tab + 词典/设置/关于)+ 键盘(口述/翻译/随便问 + 长按/波形/⚙ + 上屏/撤销 + 结果同步进历史)。**iOS 只对接 API,不含任何 prompt 逻辑。**

---

## 三、★ API 契约(各端共用 —— 请勿改 shape)

iOS 已按此契约对接,改 shape 会同时弄坏 iOS,所以**字段名/返回结构保持稳定**;要扩展用「新增可选字段」。

### 1) 转写 `POST /v1/audio/transcriptions`(OpenAI 兼容)
和桌面端 `apps/whispering/.../self-hosted/speaches.ts` 是**同一个契约**。
```
multipart/form-data:
  file   音频文件(WAV 16k mono PCM,客户端已统一成这个)
  model  字符串(可忽略具体值)
返回: {"text": "转写原文"}
```
服务端按 `ASR_BACKEND` 路由到 SenseVoice 或火山,客户端无感。

### 2) 成文/翻译/问答 `POST /v1/polish`
```
application/json:
  text             必填,转写原文
  mode             dictate | translate | ask   (口述 / 翻译 / 随便问)
  rewrite_level    light | medium | heavy       (改写程度 轻/中/重)
  target_language  可选,translate 时用,如 "en"
  style            可选,自定义风格字符串
返回: {"text": "成文/译文/回答"}
```
当前 prompt 逻辑在 `main.py` 的 `_build_prompt(mode, rewrite_level, target_language, style)` + `_LEVELS`。
**这里就是你要把桌面 transformation prompt 搬进来的地方。**

### 3) `GET /health` → `{"ok": true, "asr_backend": "..."}`

---

## 四、你(桌面开发)要做的

```
1. 收敛大脑:把桌面端验证过的逻辑搬进这套后端
   · 桌面 transformation(成文/改写)→ /v1/polish 的 _build_prompt / _LEVELS
     (桌面参考:apps/whispering/src/lib/state/transformations*.ts、query/transformer.ts)
   · 桌面 transcription 选型/参数 → ASR 路由(query/transcription.ts、self-hosted/speaches.ts)
   · 保持上面第三节的 API 契约不变(iOS 已对接)
2. 部署:把 server 推上新 ECS(见第五节),配 .env,起 systemd
3. 域名 + HTTPS:api.dailyyun.com 解析到 47.101.149.157,Nginx 反代 8080,配阿里云免费证书
4. 生产 ASR:用 volc(火山豆包),_asr_volc 已修好(第七节);填火山 key + 开通服务
5. 桌面端改为调这套 https://api.dailyyun.com(和 iOS 同根)
```

---

## 五、部署操作手册

**A. 推代码 + 装环境(在能访问该 ECS 的机器上跑)**
```bash
bash ~/Projects/JustSayAi/server/deploy.sh        # scp + venv + pip + 注册 systemd(justsay.service)
```

**B. 配 .env(服务器 /opt/justsay-server/.env)—— 生产用火山**
```bash
ASR_BACKEND=volc
VOLC_APP_KEY=火山App ID
VOLC_ACCESS_KEY=火山Access Token
VOLC_ASR_RESOURCE=volc.bigasr.auc
PUBLIC_BASE_URL=https://api.dailyyun.com     # 火山要靠它来下载上传的音频,必须公网可达
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=DeepSeek key
LLM_MODEL=deepseek-chat
# 或 LLM 换火山方舟豆包(OpenAI 兼容):LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3 ...
```

**C. 启动 + 自检**
```bash
systemctl restart justsay && systemctl status justsay --no-pager
curl -s https://api.dailyyun.com/health
curl -s https://api.dailyyun.com/v1/polish -H 'content-type: application/json' \
  -d '{"text":"嗯 那个 我们尽快对齐交付物","mode":"dictate"}'
journalctl -u justsay -n 50      # 排错看这里
```

**D. HTTPS(域名解析后)**:阿里云 SSL 免费 DV 证书 → Nginx 443 反代 `127.0.0.1:8080`,
开 `Always Use HTTPS`,然后 `PUBLIC_BASE_URL` 用 https 域名。生产稳定后可在安全组关掉 8080 对外。

---

## 六、分工边界

```
桌面开发(本交接对象)
  · 云端共用后端:成文/转写大脑 + 部署 + 域名/HTTPS + 火山生产 ASR
  · 桌面端改调这套 API
iOS session(已在做)
  · iOS 客户端体验:录音/键盘/UI;只把 baseURL 指到这套后端,不碰 prompt 逻辑
约定
  · API 契约(第三节)是两端的合同,变更前同步,优先"加可选字段"不破坏现有 shape
```

---

## 七、关键文件 & 已知事项

```
后端代码        ~/Projects/JustSayAi/server/main.py
桌面参考逻辑    apps/whispering/src/lib/{state/transformations*.ts, query/transformer.ts,
               query/transcription.ts, services/transcription/self-hosted/speaches.ts}
SenseVoice(开发ASR) ~/sensevoice-test/sensevoice_server.py(:8000,OpenAI 兼容;生产不用,2c2g 跑不动)
```

**火山豆包 ASR 已修(之前的坑)**:`main.py` 的 `_asr_volc` 已校正:
- resource id = `volc.bigasr.auc`(原来误写 `volc.seedasr.auc`,是主 bug)
- 状态码在**响应头** `X-Api-Status-Code`(20000000 成功 / 20000001-2 处理中 / 其它失败),不在 body
- submit 与 query 用**同一个** `X-Api-Request-Id`;query body 为空 `{}`;带上 submit 返回头里的 `X-Tt-Logid`
- 文本在 `result.text`(空则拼 `result.utterances[].text`)
- 火山控制台:用「语音 App ID + Access Token」,且必须**开通「大模型录音文件识别标准版」**,否则 key 对也报权限错

**合规(中国区上架,和域名备案分开)**:App 备案(工信部)+ 生成式AI 备案/登记 + AI 生成内容标识 —— 另线推进。

**网络注意**:`localhost` 在真机=手机自己;客户端连服务器要用公网域名/IP。本地调试时 server 绑 `0.0.0.0`。
