# 能说会道 · 账户 / 数据 API 契约

> 给「数据库 session」(正在建 `server/db.py` + sqlmodel)。本文件定义 iOS / 桌面 共用的
> 账户、历史、额度 接口契约。**契约先行**:你按此实现端点,客户端照此对接,最后只换地址。
> 已有的 `/v1/audio/transcriptions`、`/v1/polish` 契约**不变**;本文件是在其上新增「登录态 + 落库 + 额度」。

---

## 一、原则

```
DB session 拥有:用户表 / 鉴权 / 服务端历史 / 额度计量,全在 server 端(db.py + 路由)
客户端拥有:UI + 本地缓存 + 调这些 API
鉴权方式:登录拿 token → 之后所有请求带 Authorization: Bearer <token>
匿名可用:未登录也能调 /v1/* (试用),带 token 才记历史 / 扣额度。
         即「Authorization 头可选」,不破坏现有匿名调用。
```

---

## 二、鉴权(登录)

```
POST /auth/phone/send      { "phone": "138..." }                 → { "ok": true }   发验证码
POST /auth/phone/verify    { "phone": "138...", "code": "1234" } → { "token", "user" }
POST /auth/wechat          { "code": "微信授权code" }            → { "token", "user" }
POST /auth/apple           { "identity_token": "...", "nonce" } → { "token", "user" }

user 对象:
  { "id", "nickname", "avatar"?, "plan": "free|pro", "created_at" }
token:长期 session token(JWT 或随机串存库),客户端存 Keychain,后续 Bearer 携带。
```

---

## 三、用户 / 额度

```
GET  /me        (Bearer)  → { "user": {...}, "quota": { "used": 3840, "limit": 8000, "period": "week" } }
GET  /quota     (Bearer)  → { "used", "limit", "period", "reset_at" }
```
- **额度计量放服务端**(DB session 做):按「成文输出字数」累加;免费档 limit = 每周 1 万字。
- 客户端只读 + 展示进度 + 超额提示;**不在客户端算额度**(防绕过)。

---

## 四、历史(关键:落库时机)

**推荐方案:在 `/v1/polish` 成功时,若带 token,服务端自动落一条历史 + 扣额度。**
客户端不单独 POST 历史,省一次往返,也天然跨端同步。

```
/v1/polish 带 Authorization 时,服务端在返回前:
  - 写一条 DictationRecord(见数据模型)
  - quota.used += len(输出文本)

GET /history?cursor=<id>&limit=20   (Bearer)
  → { "items": [ DictationRecord... ], "next_cursor": "..." }

DictationRecord:
  { "id", "raw", "polished", "mode", "created_at" }

DELETE /history/{id}    (Bearer)  → { "ok": true }     (可选)
```
> 客户端目前用 App Group 在本机做「键盘→App」临时同步;**上线 DB 历史后,以服务端 /history 为准**,本地仅作缓存。

---

## 五、设置云同步(可选,二期)

一期客户端把成文设置(改写程度 / 风格 / 词库)存在 App Group 本地即可。二期再加:
```
GET  /settings   (Bearer) → { "rewrite_level", "style", "dictionary", "scenario_default" }
PUT  /settings   (Bearer)   同上字段,云端保存,多端拉取
```

---

## 六、给 DB session 的数据模型参考(sqlmodel)

```python
class User(SQLModel, table=True):
    id: str (pk)            # uuid
    phone: str | None
    wechat_openid: str | None
    apple_sub: str | None
    nickname: str
    plan: str = "free"
    created_at: datetime

class Session(SQLModel, table=True):      # token
    token: str (pk)
    user_id: str (fk)
    created_at: datetime
    expires_at: datetime

class DictationRecord(SQLModel, table=True):
    id: str (pk)
    user_id: str (fk)
    raw: str
    polished: str
    mode: str               # dictate|translate|ask
    created_at: datetime

class Quota(SQLModel, table=True):        # 或并进 User
    user_id: str (pk)
    period: str = "week"
    used: int = 0
    reset_at: datetime
```

---

## 七、对接约定 / 边界

```
· 不改现有 /v1/audio/transcriptions、/v1/polish 的请求/返回 shape(iOS 已对接)
· 鉴权用「可选 Authorization 头」叠加,匿名仍可用
· 历史 + 额度逻辑只在服务端(DB session),客户端只调 + 展示
· 字段命名沿用 snake_case(和现有接口一致)
· 客户端会像 ServerConfig 一样,先本地 Mock 这些端点,你上线后切真地址
```

> 配套文档:`HANDOFF-云端共用后端.md`(成文/转写大脑 + 部署)。两份合起来 = 完整后端契约。
