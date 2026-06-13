"""
MegaForm v2 — 数据库层
节点-回答模型: root nodes + nodes + responses + nuts
SQLite + FTS5, 同步实现 + async 包装层
"""

import sqlite3
import os
import re
import uuid
import json
import logging
import base64
import hashlib

from datetime import datetime, timezone, timedelta
from typing import Optional
from pathlib import Path
from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger("megaform.db")

DB_PATH = os.path.join(os.path.dirname(__file__), "megaform.db")
LOCAL_USER_ID = "local-user"
SECRET_PREFIX = "enc:v1:"
SECRET_KEY_PATH = Path(__file__).with_name(".megaform_secret.key")
PROFILE_VERSION_RETENTION = 10



def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _trim_user_profile_versions(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute(
        """DELETE FROM user_profile_versions
           WHERE user_id=?
             AND id NOT IN (
                 SELECT id
                   FROM user_profile_versions
                  WHERE user_id=?
                  ORDER BY created_at DESC, rowid DESC
                  LIMIT ?
             )""",
        (user_id, user_id, PROFILE_VERSION_RETENTION),
    )


def _trim_all_user_profile_versions(conn: sqlite3.Connection) -> None:
    for row in conn.execute("SELECT DISTINCT user_id FROM user_profile_versions").fetchall():
        _trim_user_profile_versions(conn, row["user_id"])


def _load_secret_material() -> bytes:
    env_key = os.environ.get("MEGAFORM_SECRET_KEY", "").strip()
    if env_key:
        return env_key.encode("utf-8")

    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_bytes().strip()

    key = Fernet.generate_key()
    SECRET_KEY_PATH.write_bytes(key)
    try:
        os.chmod(SECRET_KEY_PATH, 0o600)
    except OSError:
        pass
    log.warning("MEGAFORM_SECRET_KEY 未配置，已生成本地密钥文件 %s", SECRET_KEY_PATH)
    return key


def _get_fernet() -> Fernet:
    material = _load_secret_material()
    try:
        return Fernet(material)
    except ValueError:
        digest = hashlib.sha256(material).digest()
        return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str | None) -> str:
    if not value:
        return ""
    if isinstance(value, str) and value.startswith(SECRET_PREFIX):
        return value
    token = _get_fernet().encrypt(str(value).encode("utf-8")).decode("utf-8")
    return SECRET_PREFIX + token


def decrypt_secret(value: str | None) -> str:
    if not value:
        return ""
    if not isinstance(value, str) or not value.startswith(SECRET_PREFIX):
        return value or ""
    token = value[len(SECRET_PREFIX):].encode("utf-8")
    try:
        return _get_fernet().decrypt(token).decode("utf-8")
    except InvalidToken:
        log.error("密钥解密失败：MEGAFORM_SECRET_KEY 可能已改变")
        return ""


def _decrypt_model_config(row: dict) -> dict:
    if "api_key" in row:
        row["api_key"] = decrypt_secret(row.get("api_key"))
    return row


# ═══════════════════════════════════════════════
# 初始化 — Schema 定义、FTS5 全文索引、触发器
# ═══════════════════════════════════════════════

def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return bool(row)


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _table_exists(conn, table):
        return set()
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _parse_meta_obj_for_migration(raw) -> dict:
    meta = raw or "{}"
    for _ in range(2):
        if isinstance(meta, dict):
            return meta
        if not isinstance(meta, str):
            return {}
        try:
            meta = json.loads(meta)
        except Exception:
            return {}
    return meta if isinstance(meta, dict) else {}


def _infer_model_image_input_capability(provider: str, base_url: str, model_name: str) -> bool:
    provider_l = (provider or "").lower()
    base_l = (base_url or "").lower()
    name = (model_name or "").lower().removeprefix("models/")
    short_name = name.split("/", 1)[1] if "/" in name else name

    if "generativelanguage.googleapis.com" in base_l or "gemini" in short_name:
        return "embedding" not in short_name

    if provider_l == "anthropic" or short_name.startswith("claude-") or name.startswith("anthropic/claude"):
        return (
            short_name.startswith("claude-3")
            or short_name.startswith("claude-opus-4")
            or short_name.startswith("claude-sonnet-4")
            or short_name.startswith("claude-haiku-4")
            or short_name.startswith("claude-4")
        )

    openai_like = provider_l == "openai" or "api.openai.com" in base_l or name.startswith("openai/")
    if openai_like:
        if short_name.startswith((
            "gpt-5",
            "gpt-4.5",
            "gpt-4.1",
            "gpt-4o",
            "gpt-4-turbo",
            "gpt-4-vision",
            "o1",
            "o3",
            "o4",
        )):
            return True

    qwen_like = provider_l in {"qwen", "dashscope"} or "dashscope" in base_l or name.startswith("qwen/")
    if qwen_like:
        return "omni" in short_name or "-vl" in short_name or "vision" in short_name

    zhipu_like = provider_l in {"zhipu", "bigmodel"} or "bigmodel.cn" in base_l
    if zhipu_like:
        return "glm" in short_name and ("-v" in short_name or "4v" in short_name or "vision" in short_name)

    if "openrouter.ai" in base_l or provider_l == "openrouter":
        return (
            name.startswith("google/gemini")
            or name.startswith("anthropic/claude")
            or name.startswith("openai/gpt-5")
            or name.startswith("openai/gpt-4.5")
            or name.startswith("openai/gpt-4.1")
            or name.startswith("openai/gpt-4o")
            or name.startswith("openai/o1")
            or name.startswith("openai/o3")
            or name.startswith("openai/o4")
            or ("qwen" in name and ("omni" in name or "-vl" in name or "vision" in name))
        )

    return False


def _patch_model_image_input_capabilities(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "model_configs"):
        return
    rows = conn.execute("SELECT id, provider, base_url, model_name, meta FROM model_configs").fetchall()
    patched = 0
    for row in rows:
        meta = _parse_meta_obj_for_migration(row["meta"])
        capabilities = meta.get("capabilities")
        if not isinstance(capabilities, dict):
            capabilities = {}
        if "image_input" in capabilities:
            continue
        if not _infer_model_image_input_capability(row["provider"], row["base_url"], row["model_name"]):
            continue
        meta["capabilities"] = {**capabilities, "image_input": True}
        conn.execute(
            "UPDATE model_configs SET meta=? WHERE id=?",
            (json.dumps(meta, ensure_ascii=False), row["id"]),
        )
        patched += 1
    if patched:
        log.info("迁移: 为 %d 个存量模型补充图片输入能力标记", patched)


def _create_nodes_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nodes (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            root_id         TEXT NOT NULL,
            parent_id       TEXT REFERENCES nodes(id) ON DELETE CASCADE,
            child_order     INTEGER NOT NULL DEFAULT 0,
            content         TEXT NOT NULL,
            relation        TEXT DEFAULT 'progression',
            nut_id          TEXT REFERENCES nuts(id),
            parent_model_id TEXT,
            search_enabled  INTEGER,
            attachments     TEXT DEFAULT '[]',
            summary         TEXT DEFAULT '',
            pinned          INTEGER DEFAULT 0,
            archived        INTEGER DEFAULT 0,
            meta            TEXT DEFAULT '{}',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


def _migrate_nodes_to_root_schema(conn: sqlite3.Connection):
    """Physically remove the old topics table and make root nodes the tree entity."""
    if not _table_exists(conn, "nodes"):
        return
    cols = _columns(conn, "nodes")
    needs_rebuild = (
        "topic_id" in cols
        or "root_id" not in cols
        or "pinned" not in cols
        or "archived" not in cols
    )
    if not needs_rebuild:
        if _table_exists(conn, "topics"):
            conn.execute("DROP TABLE topics")
        return

    log.info("迁移: topics → root nodes，重建 nodes 表")
    conn.execute("PRAGMA foreign_keys=OFF")
    # Prevent SQLite from rewriting child-table FKs to the temporary
    # `nodes_old` name while we rebuild the parent table.
    conn.execute("PRAGMA legacy_alter_table=ON")
    conn.executescript("""
        DROP TRIGGER IF EXISTS nodes_ai;
        DROP TRIGGER IF EXISTS nodes_ad;
        DROP TRIGGER IF EXISTS nodes_au;
        DROP INDEX IF EXISTS idx_nodes_topic;
        DROP INDEX IF EXISTS idx_nodes_topic_root;
        DROP INDEX IF EXISTS idx_nodes_root;
        DROP INDEX IF EXISTS idx_nodes_parent;
        DROP INDEX IF EXISTS idx_nodes_created;
        DROP INDEX IF EXISTS idx_nodes_roots_pinned_updated;
        DROP TABLE IF EXISTS nodes_fts;
    """)

    old_nodes = [dict(r) for r in conn.execute("SELECT * FROM nodes").fetchall()]
    topics_by_id: dict[str, dict] = {}
    if _table_exists(conn, "topics"):
        topics_by_id = {
            r["id"]: dict(r)
            for r in conn.execute("SELECT * FROM topics").fetchall()
        }
    root_by_topic: dict[str, str] = {}
    for node in old_nodes:
        if node.get("parent_id") is None:
            topic_id = node.get("topic_id")
            if topic_id:
                root_by_topic[topic_id] = node["id"]

    conn.execute("ALTER TABLE nodes RENAME TO nodes_old")
    _create_nodes_table(conn)

    for node in old_nodes:
        old_topic_id = node.get("topic_id")
        is_root = node.get("parent_id") is None
        root_id = node.get("root_id") or (node["id"] if is_root else root_by_topic.get(old_topic_id, node["id"]))
        topic = topics_by_id.get(old_topic_id or "", {})
        summary = node.get("summary") or ""
        if is_root and not summary:
            summary = topic.get("summary") or ""
        pinned = int(topic.get("pinned") or 0) if is_root else int(node.get("pinned") or 0)
        archived = int(topic.get("archived") or 0) if is_root else int(node.get("archived") or 0)
        conn.execute(
            """INSERT INTO nodes
               (id, user_id, root_id, parent_id, child_order, content, relation,
                nut_id, parent_model_id, search_enabled, attachments, summary,
                pinned, archived, meta, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                node["id"],
                node.get("user_id") or LOCAL_USER_ID,
                root_id,
                node.get("parent_id"),
                node.get("child_order") or 0,
                node.get("content") or "",
                node.get("relation") or "progression",
                node.get("nut_id"),
                node.get("parent_model_id"),
                node.get("search_enabled"),
                node.get("attachments") or "[]",
                summary,
                pinned,
                archived,
                node.get("meta") or "{}",
                node.get("created_at") or _now(),
                node.get("updated_at") or _now(),
            ),
        )

    conn.execute("DROP TABLE nodes_old")
    if _table_exists(conn, "topics"):
        conn.execute("DROP TABLE topics")
    conn.execute("PRAGMA legacy_alter_table=OFF")
    conn.execute("PRAGMA foreign_keys=ON")
    log.info("迁移: nodes.root_id 已建立，topics 表已删除")


def _repair_nodes_old_foreign_keys(conn: sqlite3.Connection):
    """Repair older root-schema migrations that left responses.node_id pointing at nodes_old."""
    if not _table_exists(conn, "responses"):
        return
    refs_nodes_old = any(
        row["table"] == "nodes_old"
        for row in conn.execute("PRAGMA foreign_key_list(responses)").fetchall()
    )
    if not refs_nodes_old:
        return
    log.warning("迁移修复: responses.node_id 外键仍指向 nodes_old，正在修正为 nodes")
    conn.execute("PRAGMA writable_schema=ON")
    conn.execute(
        """UPDATE sqlite_master
           SET sql = replace(replace(sql,
               'REFERENCES "nodes_old"', 'REFERENCES nodes'),
               'REFERENCES nodes_old', 'REFERENCES nodes')
           WHERE type='table' AND name='responses'"""
    )
    version = conn.execute("PRAGMA schema_version").fetchone()[0]
    conn.execute(f"PRAGMA schema_version={version + 1}")
    conn.execute("PRAGMA writable_schema=OFF")

def init_db():
    """初始化数据库 Schema。

    创建所有表（使用 IF NOT EXISTS 幂等），设置索引、唯一约束、
    FTS5 全文索引及自动同步触发器。在应用启动时调用。
    
    表结构:
        nodes          — 对话节点（根节点即问题树实体）
        responses      — 模型回答
        nuts           — 文字锚点（用于选中追问定位）
        model_configs  — LLM 模型配置（支持软删除）
        settings       — KV 键值设置（如网络搜索 provider/API key）
    """
    conn = get_db()
    _migrate_nodes_to_root_schema(conn)
    _repair_nodes_old_foreign_keys(conn)
    conn.executescript("""
        DROP TRIGGER IF EXISTS nodes_au;
        DROP TRIGGER IF EXISTS responses_au;
    """)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS nodes (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            root_id         TEXT NOT NULL,
            parent_id       TEXT REFERENCES nodes(id) ON DELETE CASCADE,
            child_order     INTEGER NOT NULL DEFAULT 0,
            content         TEXT NOT NULL,
            relation        TEXT DEFAULT 'progression',
            nut_id          TEXT REFERENCES nuts(id),
            parent_model_id TEXT,
            search_enabled  INTEGER,
            attachments     TEXT DEFAULT '[]',
            summary         TEXT DEFAULT '',
            pinned          INTEGER DEFAULT 0,
            archived        INTEGER DEFAULT 0,
            group_id        TEXT REFERENCES root_groups(id) ON DELETE SET NULL,
            group_order     INTEGER,
            meta            TEXT DEFAULT '{}',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS root_groups (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            sort_order      INTEGER NOT NULL DEFAULT 0,
            collapsed       INTEGER DEFAULT 0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS responses (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            model_id        TEXT NOT NULL,
            content         TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'completed',
            tokens_input    INTEGER DEFAULT 0,
            tokens_output   INTEGER DEFAULT 0,
            latency_ms      INTEGER,
            finish_reason   TEXT,
            thinking_budget INTEGER DEFAULT 0,
            sources         TEXT DEFAULT '[]',
            meta            TEXT DEFAULT '{}',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS nuts (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
            seek        INTEGER NOT NULL,
            end_seek    INTEGER NOT NULL,
            label       TEXT,
            style       TEXT,
            meta        TEXT DEFAULT '{}',
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS model_configs (
            id               TEXT PRIMARY KEY,
            user_id          TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            name             TEXT NOT NULL,
            provider         TEXT NOT NULL,
            base_url         TEXT,
            proxy_url        TEXT,
            api_key          TEXT,
            model_name       TEXT NOT NULL,
            max_tokens       INTEGER DEFAULT 4096,
            price_per_input  REAL DEFAULT 0,
            price_per_output REAL DEFAULT 0,
            price_unit       TEXT DEFAULT 'CNY',
            thinking_budget  INTEGER DEFAULT 0,
            usage            REAL DEFAULT 0,
            deleted          INTEGER DEFAULT 0,
            meta             TEXT DEFAULT '{}',
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            user_id TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
            key     TEXT NOT NULL,
            value   TEXT,
            PRIMARY KEY (user_id, key)
        );

        CREATE TABLE IF NOT EXISTS users (
            id              TEXT PRIMARY KEY,
            email           TEXT,
            password_hash   TEXT NOT NULL DEFAULT '',
            display_name    TEXT NOT NULL DEFAULT '',
            avatar_url      TEXT NOT NULL DEFAULT '',
            locale          TEXT NOT NULL DEFAULT '',
            timezone        TEXT NOT NULL DEFAULT '',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
            last_login_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS user_profiles (
            user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            content             TEXT NOT NULL DEFAULT '',
            current_version_id  TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_profile_versions (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content     TEXT NOT NULL DEFAULT '',
            note        TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS oauth_accounts (
            id                  TEXT PRIMARY KEY,
            user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider            TEXT NOT NULL,
            provider_user_id    TEXT NOT NULL,
            email               TEXT,
            raw_profile         TEXT DEFAULT '{}',
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(provider, provider_user_id)
        );

        CREATE TABLE IF NOT EXISTS oauth_states (
            state       TEXT PRIMARY KEY,
            provider    TEXT NOT NULL,
            next_url    TEXT NOT NULL DEFAULT '/',
            bind_user_id TEXT,
            locale      TEXT NOT NULL DEFAULT '',
            expires_at  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash      TEXT NOT NULL UNIQUE,
            expires_at      TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS families (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS family_members (
            id              TEXT PRIMARY KEY,
            family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
            user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role            TEXT NOT NULL DEFAULT 'member',
            status          TEXT NOT NULL DEFAULT 'active',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(family_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS shared_capabilities (
            id              TEXT PRIMARY KEY,
            family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
            credential_id   TEXT NOT NULL,
            type            TEXT NOT NULL DEFAULT 'model',
            name            TEXT NOT NULL,
            config_json     TEXT DEFAULT '{}',
            is_active       INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS usage_logs (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
            capability_id   TEXT NOT NULL REFERENCES shared_capabilities(id) ON DELETE CASCADE,
            provider        TEXT NOT NULL DEFAULT '',
            model           TEXT NOT NULL DEFAULT '',
            input_tokens    INTEGER DEFAULT 0,
            output_tokens   INTEGER DEFAULT 0,
            estimated_cost  REAL DEFAULT 0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- 索引
        CREATE INDEX IF NOT EXISTS idx_nodes_root       ON nodes(root_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_parent     ON nodes(parent_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_created    ON nodes(created_at);
        CREATE INDEX IF NOT EXISTS idx_nodes_roots_pinned_updated
            ON nodes(pinned DESC, updated_at DESC)
            WHERE parent_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_responses_node   ON responses(node_id);
        CREATE INDEX IF NOT EXISTS idx_responses_model  ON responses(model_id);
        CREATE INDEX IF NOT EXISTS idx_responses_created ON responses(created_at);
        CREATE INDEX IF NOT EXISTS idx_nuts_response    ON nuts(response_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_families_owner ON families(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_shared_capabilities_family ON shared_capabilities(family_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_usage_logs_family_created ON usage_logs(family_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created ON usage_logs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
        CREATE INDEX IF NOT EXISTS idx_user_profile_versions_user_created
            ON user_profile_versions(user_id, created_at DESC);

        -- FTS5
        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
            content, content=nodes, content_rowid=rowid
        );
        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF content ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS responses_fts USING fts5(
            content, content=responses, content_rowid=rowid
        );
        CREATE TRIGGER IF NOT EXISTS responses_ai AFTER INSERT ON responses BEGIN
            INSERT INTO responses_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS responses_ad AFTER DELETE ON responses BEGIN
            INSERT INTO responses_fts(responses_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS responses_au AFTER UPDATE OF content ON responses BEGIN
            INSERT INTO responses_fts(responses_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            INSERT INTO responses_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
    """)
    try:
        node_count = conn.execute("SELECT COUNT(*) AS c FROM nodes").fetchone()["c"]
        fts_count = conn.execute("SELECT COUNT(*) AS c FROM nodes_fts").fetchone()["c"]
        if node_count != fts_count:
            conn.execute("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')")
            log.info("FTS: nodes_fts 已重建")
        resp_count = conn.execute("SELECT COUNT(*) AS c FROM responses").fetchone()["c"]
        resp_fts_count = conn.execute("SELECT COUNT(*) AS c FROM responses_fts").fetchone()["c"]
        if resp_count != resp_fts_count:
            conn.execute("INSERT INTO responses_fts(responses_fts) VALUES('rebuild')")
            log.info("FTS: responses_fts 已重建")
    except Exception as e:
        log.warning("FTS: 重建检查失败: %s", e)
    _trim_all_user_profile_versions(conn)
    conn.commit()
    conn.close()
    log.debug("数据库 Schema 初始化完成")


# ═══════════════════════════════════════════════
# Schema 迁移
# ═══════════════════════════════════════════════

def migrate_schema():
    """在应用启动时执行增量迁移，确保存量数据库结构最新"""
    conn = get_db()
    try:
        _migrate_nodes_to_root_schema(conn)
        _repair_nodes_old_foreign_keys(conn)

        # V4→V5: model_configs 新增 usage 字段
        cols = _columns(conn, "model_configs")
        if "usage" not in cols:
            conn.execute("ALTER TABLE model_configs ADD COLUMN usage REAL DEFAULT 0")
            log.info("迁移: model_configs 新增 usage 字段")

        # V5→V6: responses 新增 thinking_budget 字段
        resp_cols = _columns(conn, "responses")
        if "thinking_budget" not in resp_cols:
            conn.execute("ALTER TABLE responses ADD COLUMN thinking_budget INTEGER DEFAULT 0")
            log.info("迁移: responses 新增 thinking_budget 字段")

        # V6→V7: model_configs 新增 input_tokens / output_tokens（累计 token 计数）
        if "input_tokens" not in cols:
            conn.execute("ALTER TABLE model_configs ADD COLUMN input_tokens INTEGER DEFAULT 0")
            log.info("迁移: model_configs 新增 input_tokens 字段")
        if "output_tokens" not in cols:
            conn.execute("ALTER TABLE model_configs ADD COLUMN output_tokens INTEGER DEFAULT 0")
            log.info("迁移: model_configs 新增 output_tokens 字段")
        if "proxy_url" not in cols:
            conn.execute("ALTER TABLE model_configs ADD COLUMN proxy_url TEXT DEFAULT ''")
            log.info("迁移: model_configs 新增 proxy_url 字段")

        # V7→V8: nodes 新增 summary 字段
        node_cols = _columns(conn, "nodes")
        if "summary" not in node_cols:
            conn.execute("ALTER TABLE nodes ADD COLUMN summary TEXT DEFAULT ''")
            log.info("迁移: nodes 新增 summary 字段")
        if "pinned" not in node_cols:
            conn.execute("ALTER TABLE nodes ADD COLUMN pinned INTEGER DEFAULT 0")
            log.info("迁移: nodes 新增 pinned 字段")
        if "archived" not in node_cols:
            conn.execute("ALTER TABLE nodes ADD COLUMN archived INTEGER DEFAULT 0")
            log.info("迁移: nodes 新增 archived 字段")
        if "group_id" not in node_cols:
            conn.execute("ALTER TABLE nodes ADD COLUMN group_id TEXT REFERENCES root_groups(id) ON DELETE SET NULL")
            log.info("迁移: nodes 新增 group_id 字段")
        if "group_order" not in node_cols:
            conn.execute("ALTER TABLE nodes ADD COLUMN group_order INTEGER")
            log.info("迁移: nodes 新增 group_order 字段")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS root_groups (
                id              TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL DEFAULT 'local-user' REFERENCES users(id) ON DELETE CASCADE,
                name            TEXT NOT NULL,
                sort_order      INTEGER NOT NULL DEFAULT 0,
                collapsed       INTEGER DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)

        user_cols = _columns(conn, "users")
        if user_cols and "password_hash" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''")
            log.info("迁移: users 新增 password_hash 字段")

        # V8→V9: DeepSeek 官方 OpenAI-compatible endpoint 统一使用 /v1。
        cur = conn.execute(
            """UPDATE model_configs
               SET base_url='https://api.deepseek.com/v1'
               WHERE provider='deepseek'
                 AND lower(rtrim(coalesce(base_url, ''), '/'))='https://api.deepseek.com'"""
        )
        if cur.rowcount:
            log.info("迁移: 规范化 DeepSeek 官方 base_url %d 条", cur.rowcount)

        # V10: 多用户隔离基础字段。存量数据归属 local-user。
        for table in ("nodes", "responses", "nuts", "model_configs"):
            table_cols = _columns(conn, table)
            if table_cols and "user_id" not in table_cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN user_id TEXT NOT NULL DEFAULT '{LOCAL_USER_ID}'")
                log.info("迁移: %s 新增 user_id 字段并归属 %s", table, LOCAL_USER_ID)

        settings_cols = _columns(conn, "settings")
        if settings_cols and "user_id" not in settings_cols:
            log.info("迁移: settings 改为按 user_id 隔离")
            existing_settings = [dict(r) for r in conn.execute("SELECT key, value FROM settings").fetchall()]
            conn.execute("ALTER TABLE settings RENAME TO settings_old")
            conn.execute(
                """CREATE TABLE settings (
                    user_id TEXT NOT NULL DEFAULT 'local-user',
                    key     TEXT NOT NULL,
                    value   TEXT,
                    PRIMARY KEY (user_id, key)
                )"""
            )
            for row in existing_settings:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)",
                    (LOCAL_USER_ID, row["key"], row["value"]),
                )
            conn.execute("DROP TABLE settings_old")

        oauth_state_cols = _columns(conn, "oauth_states")
        if oauth_state_cols and "locale" not in oauth_state_cols:
            conn.execute("ALTER TABLE oauth_states ADD COLUMN locale TEXT NOT NULL DEFAULT ''")
            log.info("迁移: oauth_states 新增 locale 字段")

        conn.execute("UPDATE nodes SET user_id=? WHERE user_id IS NULL OR user_id=''", (LOCAL_USER_ID,))
        conn.execute("UPDATE responses SET user_id=? WHERE user_id IS NULL OR user_id=''", (LOCAL_USER_ID,))
        conn.execute("UPDATE nuts SET user_id=? WHERE user_id IS NULL OR user_id=''", (LOCAL_USER_ID,))
        conn.execute("UPDATE model_configs SET user_id=? WHERE user_id IS NULL OR user_id=''", (LOCAL_USER_ID,))

        for row in conn.execute("SELECT id, api_key FROM model_configs").fetchall():
            api_key = row["api_key"]
            if api_key and not str(api_key).startswith(SECRET_PREFIX):
                conn.execute(
                    "UPDATE model_configs SET api_key=? WHERE id=?",
                    (encrypt_secret(api_key), row["id"]),
                )

        for row in conn.execute("SELECT user_id, key, value FROM settings WHERE key LIKE '%api_key%'").fetchall():
            value = row["value"]
            if value and not str(value).startswith(SECRET_PREFIX):
                conn.execute(
                    "UPDATE settings SET value=? WHERE user_id=? AND key=?",
                    (encrypt_secret(value), row["user_id"], row["key"]),
                )

        conn.executescript("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
                ON users(lower(email))
                WHERE email IS NOT NULL AND email != '';
            CREATE INDEX IF NOT EXISTS idx_nodes_user_root ON nodes(user_id, root_id);
            CREATE INDEX IF NOT EXISTS idx_nodes_user_group_order ON nodes(user_id, group_id, group_order);
            CREATE INDEX IF NOT EXISTS idx_root_groups_user_order ON root_groups(user_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_responses_user_node ON responses(user_id, node_id);
            CREATE INDEX IF NOT EXISTS idx_nuts_user_response ON nuts(user_id, response_id);
            CREATE INDEX IF NOT EXISTS idx_model_configs_user ON model_configs(user_id, name);
            CREATE TABLE IF NOT EXISTS families (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS family_members (
                id              TEXT PRIMARY KEY,
                family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role            TEXT NOT NULL DEFAULT 'member',
                status          TEXT NOT NULL DEFAULT 'active',
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(family_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS shared_capabilities (
                id              TEXT PRIMARY KEY,
                family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                credential_id   TEXT NOT NULL,
                type            TEXT NOT NULL DEFAULT 'model',
                name            TEXT NOT NULL,
                config_json     TEXT DEFAULT '{}',
                is_active       INTEGER NOT NULL DEFAULT 1,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS usage_logs (
                id              TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                capability_id   TEXT NOT NULL REFERENCES shared_capabilities(id) ON DELETE CASCADE,
                provider        TEXT NOT NULL DEFAULT '',
                model           TEXT NOT NULL DEFAULT '',
                input_tokens    INTEGER DEFAULT 0,
                output_tokens   INTEGER DEFAULT 0,
                estimated_cost  REAL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_families_owner ON families(owner_user_id);
            CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members(user_id, status);
            CREATE INDEX IF NOT EXISTS idx_shared_capabilities_family ON shared_capabilities(family_id, is_active);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_family_created ON usage_logs(family_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created ON usage_logs(user_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS user_profiles (
                user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                content             TEXT NOT NULL DEFAULT '',
                current_version_id  TEXT,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS user_profile_versions (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content     TEXT NOT NULL DEFAULT '',
                note        TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_user_profile_versions_user_created
                ON user_profile_versions(user_id, created_at DESC);
        """)
        _patch_model_image_input_capabilities(conn)
        _trim_all_user_profile_versions(conn)
    finally:
        conn.commit()
        conn.close()


# ═══════════════════════════════════════════════
# Users & Sessions
# ═══════════════════════════════════════════════

def ensure_user(
    user_id: str,
    *,
    email: str | None = None,
    display_name: str = "",
    avatar_url: str = "",
    locale: str = "",
    timezone_name: str = "",
) -> dict:
    """Create or update a user row and return it."""
    conn = get_db()
    now = _now()
    existing = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if existing:
        conn.execute(
            """UPDATE users
               SET email=coalesce(?, email),
                   display_name=coalesce(nullif(?, ''), display_name),
                   avatar_url=coalesce(nullif(?, ''), avatar_url),
                   locale=coalesce(nullif(?, ''), locale),
                   timezone=coalesce(nullif(?, ''), timezone),
                   updated_at=?
               WHERE id=?""",
            (email, display_name, avatar_url, locale, timezone_name, now, user_id),
        )
    else:
        conn.execute(
            """INSERT INTO users
               (id, email, display_name, avatar_url, locale, timezone, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                email,
                display_name or user_id,
                avatar_url,
                locale,
                timezone_name,
                now,
                now,
            ),
        )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row)


def ensure_local_user() -> dict:
    return ensure_user(
        LOCAL_USER_ID,
        email="local@megaform",
        display_name="Local User",
        timezone_name=os.environ.get("TZ", ""),
    )


def get_user(user_id: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def list_users() -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user_by_email(email: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE lower(email)=lower(?)",
        ((email or "").strip(),),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def update_user_locale(user_id: str, locale: str) -> Optional[dict]:
    conn = get_db()
    normalized = locale if locale in {"zh-CN", "en"} else "zh-CN"
    conn.execute(
        "UPDATE users SET locale=?, updated_at=? WHERE id=?",
        (normalized, _now(), user_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_password_user(email: str, password_hash: str, display_name: str = "", locale: str = "") -> dict:
    conn = get_db()
    now = _now()
    user_id = new_id()
    normalized_locale = locale if locale in {"zh-CN", "en"} else ""
    conn.execute(
        """INSERT INTO users
           (id, email, password_hash, display_name, locale, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (user_id, email, password_hash, display_name or email, normalized_locale, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row)


def touch_user_login(user_id: str) -> None:
    conn = get_db()
    conn.execute(
        "UPDATE users SET last_login_at=?, updated_at=? WHERE id=?",
        (_now(), _now(), user_id),
    )
    conn.commit()
    conn.close()


def create_session(user_id: str, token_hash: str, days: int = 30) -> dict:
    conn = get_db()
    sid = new_id()
    now = _now()
    expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        """INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (sid, user_id, token_hash, expires_at, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    conn.close()
    return dict(row)


def get_session_by_token_hash(token_hash: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        """SELECT sessions.*, users.email, users.display_name, users.avatar_url,
                  users.locale, users.timezone, users.last_login_at
           FROM sessions
           JOIN users ON users.id = sessions.user_id
           WHERE sessions.token_hash=? AND sessions.expires_at > ?""",
        (token_hash, _now()),
    ).fetchone()
    if row:
        conn.execute("UPDATE sessions SET last_seen_at=? WHERE id=?", (_now(), row["id"]))
        conn.commit()
    conn.close()
    return dict(row) if row else None


def create_oauth_state(provider: str, state: str, next_url: str = "/", bind_user_id: str | None = None, ttl_seconds: int = 600, locale: str = "") -> dict:
    conn = get_db()
    now = _now()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")
    normalized_locale = locale if locale in {"zh-CN", "en"} else ""
    conn.execute(
        """INSERT INTO oauth_states (state, provider, next_url, bind_user_id, locale, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (state, provider, next_url or "/", bind_user_id, normalized_locale, expires_at, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM oauth_states WHERE state=?", (state,)).fetchone()
    conn.close()
    return dict(row)


def consume_oauth_state(provider: str, state: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM oauth_states WHERE state=? AND provider=? AND expires_at > ?",
        (state, provider, _now()),
    ).fetchone()
    conn.execute("DELETE FROM oauth_states WHERE state=?", (state,))
    conn.execute("DELETE FROM oauth_states WHERE expires_at <= ?", (_now(),))
    conn.commit()
    conn.close()
    return dict(row) if row else None


def get_oauth_account(provider: str, provider_user_id: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM oauth_accounts WHERE provider=? AND provider_user_id=?",
        (provider, provider_user_id),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def link_oauth_account(
    user_id: str,
    provider: str,
    provider_user_id: str,
    *,
    email: str | None = None,
    raw_profile: dict | None = None,
) -> dict:
    conn = get_db()
    existing = conn.execute(
        "SELECT * FROM oauth_accounts WHERE provider=? AND provider_user_id=?",
        (provider, provider_user_id),
    ).fetchone()
    if existing and existing["user_id"] != user_id:
        conn.close()
        raise ValueError("OAuth account already linked to another user")
    if existing:
        conn.execute(
            """UPDATE oauth_accounts
               SET email=?, raw_profile=?
               WHERE provider=? AND provider_user_id=?""",
            (email, json.dumps(raw_profile or {}, ensure_ascii=False), provider, provider_user_id),
        )
    else:
        conn.execute(
            """INSERT INTO oauth_accounts
               (id, user_id, provider, provider_user_id, email, raw_profile, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                new_id(),
                user_id,
                provider,
                provider_user_id,
                email,
                json.dumps(raw_profile or {}, ensure_ascii=False),
                _now(),
            ),
        )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM oauth_accounts WHERE provider=? AND provider_user_id=?",
        (provider, provider_user_id),
    ).fetchone()
    conn.close()
    return dict(row)


def delete_session_by_token_hash(token_hash: str) -> int:
    conn = get_db()
    cur = conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
    conn.commit()
    count = cur.rowcount
    conn.close()
    return count


def delete_user_sessions(user_id: str) -> int:
    conn = get_db()
    cur = conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    conn.commit()
    count = cur.rowcount
    conn.close()
    return count


def cleanup_expired_sessions() -> int:
    conn = get_db()
    cur = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (_now(),))
    conn.commit()
    count = cur.rowcount
    conn.close()
    return count


# ═══════════════════════════════════════════════
# User Profile Markdown
# ═══════════════════════════════════════════════

DEFAULT_PROFILE_MD = """# User Profile

## Background

## Research Preferences

## Language Preferences

## Timezone

## Other Notes
"""


def get_user_profile(user_id: str = LOCAL_USER_ID) -> dict:
    conn = get_db()
    row = conn.execute("SELECT * FROM user_profiles WHERE user_id=?", (user_id,)).fetchone()
    if not row:
        now = _now()
        version_id = new_id()
        conn.execute(
            """INSERT INTO user_profile_versions (id, user_id, content, note, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (version_id, user_id, DEFAULT_PROFILE_MD, "初始版本", now),
        )
        conn.execute(
            """INSERT INTO user_profiles (user_id, content, current_version_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, DEFAULT_PROFILE_MD, version_id, now, now),
        )
        _trim_user_profile_versions(conn, user_id)
        conn.commit()
        row = conn.execute("SELECT * FROM user_profiles WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row)


def save_user_profile(content: str, user_id: str = LOCAL_USER_ID, note: str = "") -> dict:
    conn = get_db()
    existing = conn.execute("SELECT * FROM user_profiles WHERE user_id=?", (user_id,)).fetchone()
    normalized = content or ""
    now = _now()

    if existing and (existing["content"] or "") == normalized:
        _trim_user_profile_versions(conn, user_id)
        conn.commit()
        conn.close()
        return dict(existing)

    version_id = new_id()
    conn.execute(
        """INSERT INTO user_profile_versions (id, user_id, content, note, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (version_id, user_id, normalized, note or "手动保存", now),
    )
    if existing:
        conn.execute(
            """UPDATE user_profiles
               SET content=?, current_version_id=?, updated_at=?
               WHERE user_id=?""",
            (normalized, version_id, now, user_id),
        )
    else:
        conn.execute(
            """INSERT INTO user_profiles (user_id, content, current_version_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, normalized, version_id, now, now),
        )
    _trim_user_profile_versions(conn, user_id)
    conn.commit()
    row = conn.execute("SELECT * FROM user_profiles WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row)


def list_user_profile_versions(user_id: str = LOCAL_USER_ID, limit: int = 50) -> list[dict]:
    conn = get_db()
    _trim_user_profile_versions(conn, user_id)
    conn.commit()
    rows = conn.execute(
        """SELECT id, user_id, content, note, created_at
           FROM user_profile_versions
           WHERE user_id=?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?""",
        (user_id, max(1, min(int(limit or PROFILE_VERSION_RETENTION), PROFILE_VERSION_RETENTION))),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def restore_user_profile_version(version_id: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM user_profile_versions WHERE id=? AND user_id=?",
        (version_id, user_id),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return save_user_profile(row["content"], user_id=user_id, note=f"恢复版本 {version_id}")


# ═══════════════════════════════════════════════
# Roots
# ═══════════════════════════════════════════════

def get_all_roots(user_id: str | None = LOCAL_USER_ID) -> list[dict]:
    """获取所有问题树根节点，按分组和对话更新时间返回。"""
    conn = get_db()
    user_filter = "" if user_id is None else "AND root.user_id=?"
    params = [] if user_id is None else [user_id]
    rows = conn.execute(
        f"""SELECT root.*, COUNT(child.id) AS node_count
           FROM nodes AS root
           LEFT JOIN nodes AS child ON child.root_id = root.id AND child.user_id = root.user_id
           WHERE root.parent_id IS NULL {user_filter}
           GROUP BY root.id
           ORDER BY root.group_id IS NOT NULL,
                    root.group_id,
                    root.updated_at DESC"""
        , params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_root_groups(user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM root_groups WHERE user_id=? ORDER BY sort_order, created_at",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_root_group(name: str, user_id: str = LOCAL_USER_ID) -> dict:
    conn = get_db()
    gid = new_id()
    now = _now()
    row = conn.execute(
        "SELECT MAX(sort_order) AS m FROM root_groups WHERE user_id=?",
        (user_id,),
    ).fetchone()
    sort_order = (row["m"] if row and row["m"] is not None else -1) + 1
    conn.execute(
        """INSERT INTO root_groups
           (id, user_id, name, sort_order, collapsed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)""",
        (gid, user_id, name.strip() or "未命名分组", sort_order, now, now),
    )
    conn.commit()
    group = conn.execute("SELECT * FROM root_groups WHERE id=? AND user_id=?", (gid, user_id)).fetchone()
    conn.close()
    return dict(group)


def update_root_group(group_id: str, user_id: str = LOCAL_USER_ID, **data) -> Optional[dict]:
    allowed = {"name", "sort_order", "collapsed"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return get_root_group(group_id, user_id=user_id)
    if "name" in updates:
        updates["name"] = str(updates["name"]).strip() or "未命名分组"
    if "collapsed" in updates:
        updates["collapsed"] = 1 if updates["collapsed"] else 0

    conn = get_db()
    sets = ", ".join([f"{k}=?" for k in updates.keys()])
    vals = list(updates.values()) + [_now(), group_id, user_id]
    conn.execute(
        f"UPDATE root_groups SET {sets}, updated_at=? WHERE id=? AND user_id=?",
        vals,
    )
    conn.commit()
    row = conn.execute("SELECT * FROM root_groups WHERE id=? AND user_id=?", (group_id, user_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_root_group(group_id: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM root_groups WHERE id=? AND user_id=?", (group_id, user_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_root_group(group_id: str, user_id: str = LOCAL_USER_ID) -> bool:
    conn = get_db()
    exists = conn.execute("SELECT id FROM root_groups WHERE id=? AND user_id=?", (group_id, user_id)).fetchone()
    if not exists:
        conn.close()
        return False
    conn.execute(
        "UPDATE nodes SET group_id=NULL, group_order=NULL WHERE user_id=? AND parent_id IS NULL AND group_id=?",
        (user_id, group_id),
    )
    conn.execute("DELETE FROM root_groups WHERE id=? AND user_id=?", (group_id, user_id))
    conn.commit()
    conn.close()
    return True


def move_root_to_group(
    root_id: str,
    group_id: str | None,
    user_id: str = LOCAL_USER_ID,
) -> Optional[dict]:
    """Move a root between sidebar groups without touching the conversation updated_at."""
    conn = get_db()
    root = conn.execute(
        "SELECT id, group_id FROM nodes WHERE id=? AND user_id=? AND parent_id IS NULL",
        (root_id, user_id),
    ).fetchone()
    if not root:
        conn.close()
        return None
    if group_id:
        group = conn.execute("SELECT id FROM root_groups WHERE id=? AND user_id=?", (group_id, user_id)).fetchone()
        if not group:
            conn.close()
            return None

    conn.execute(
        "UPDATE nodes SET group_id=?, group_order=NULL WHERE id=? AND user_id=? AND parent_id IS NULL",
        (group_id, root_id, user_id),
    )

    conn.commit()
    moved = conn.execute("SELECT * FROM nodes WHERE id=? AND user_id=?", (root_id, user_id)).fetchone()
    conn.close()
    return dict(moved) if moved else None


def get_root(root_id: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM nodes WHERE id=? AND user_id=? AND parent_id IS NULL",
        (root_id, user_id),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_root_nodes(root_id: str, user_id: str = LOCAL_USER_ID) -> list[dict]:
    """获取一棵问题树下所有节点。"""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM nodes WHERE root_id=? AND user_id=? ORDER BY created_at",
        (root_id, user_id),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_root(root_id: str, user_id: str = LOCAL_USER_ID):
    delete_subtree(root_id, user_id=user_id)


# ═══════════════════════════════════════════════
# Nodes
# ═══════════════════════════════════════════════

def create_node(root_id: str | None, content: str, user_id: str = LOCAL_USER_ID, **kwargs) -> dict:
    conn = get_db()
    nid = kwargs.get("id") or new_id()
    now = _now()
    parent_id = kwargs.get("parent_id")
    if parent_id and not root_id:
        parent = conn.execute("SELECT root_id FROM nodes WHERE id=? AND user_id=?", (parent_id, user_id)).fetchone()
        root_id = parent["root_id"] if parent else None
    if not root_id:
        root_id = nid

    # 自动计算 child_order: 同一 parent 下的下一个序号
    if "child_order" in kwargs:
        child_order = kwargs["child_order"]
    else:
        if parent_id:
            row = conn.execute(
                "SELECT MAX(child_order) as m FROM nodes WHERE parent_id=? AND user_id=?", (parent_id, user_id)
            ).fetchone()
        else:
            row = None
        child_order = (row["m"] if row and row["m"] is not None else -1) + 1

    conn.execute(
        """INSERT INTO nodes
           (id, user_id, root_id, parent_id, child_order, content, relation,
            nut_id, parent_model_id, search_enabled, summary, pinned, archived,
            attachments, meta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (nid, user_id, root_id, parent_id, child_order, content,
         kwargs.get("relation", "progression"),
         kwargs.get("nut_id"),
         kwargs.get("parent_model_id"),
         kwargs.get("search_enabled"),
         kwargs.get("summary", ""),
         kwargs.get("pinned", 0),
         kwargs.get("archived", 0),
         json.dumps(kwargs.get("attachments", []), ensure_ascii=False),
         json.dumps(kwargs.get("meta", {}), ensure_ascii=False),
         now, now),
    )
    conn.execute("UPDATE nodes SET updated_at=? WHERE id=? AND user_id=?", (now, root_id, user_id))
    conn.commit()
    row = conn.execute("SELECT * FROM nodes WHERE id=? AND user_id=?", (nid, user_id)).fetchone()
    conn.close()
    log.debug("创建节点 id=%s root=%s parent=%s", nid, root_id, parent_id or "root")
    return dict(row)


def get_node(nid: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM nodes WHERE id=? AND user_id=?", (nid, user_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_node_children(nid: str, parent_model_id: str=None, user_id: str = LOCAL_USER_ID) -> list[dict]:
    """获取某节点的直接子节点（按 child_order 排序）"""
    conn = get_db()
    if parent_model_id is None:
        rows = conn.execute(
            "SELECT * FROM nodes WHERE parent_id=? AND user_id=? ORDER BY child_order", (nid, user_id)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM nodes WHERE parent_id=? AND user_id=? AND parent_model_id=? ORDER BY child_order", (nid, user_id, parent_model_id)
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_nodes_created_between(
    user_id: str,
    start_at: str,
    end_at: str,
    limit: int = 200,
) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT id, root_id, parent_id, content, summary, created_at
           FROM nodes
           WHERE user_id=?
             AND created_at>=?
             AND created_at<?
           ORDER BY created_at
           LIMIT ?""",
        (user_id, start_at, end_at, max(1, min(int(limit or 200), 1000))),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]



def get_path_to_root(nid: str, reverse=True, user_id: str = LOCAL_USER_ID) -> list[dict]:
    """从当前节点沿 parent_id 向上追溯到根"""
    conn = get_db()
    path = []
    current = nid
    while current:
        row = conn.execute("SELECT * FROM nodes WHERE id=? AND user_id=?", (current, user_id)).fetchone()
        if not row:
            break
        path.append(dict(row))
        current = row["parent_id"]
    conn.close()
    if reverse:
        path.reverse()
    return path


def get_progression_siblings_before(parent_id: str, child_order: int, user_id: str = LOCAL_USER_ID) -> list[dict]:
    """获取同父节点下 relation='progression' 且 child_order 小于指定值的兄弟节点（按 child_order 升序）"""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM nodes WHERE parent_id=? AND user_id=? AND relation='progression' AND child_order < ? ORDER BY child_order",
        (parent_id, user_id, child_order)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_node(nid: str, touch_updated_at: bool = True, user_id: str = LOCAL_USER_ID, **kwargs) -> Optional[dict]:
    conn = get_db()
    sets = []
    vals = []
    for k in (
        "content", "relation", "nut_id", "parent_model_id", "search_enabled",
        "child_order", "summary", "pinned", "archived", "attachments", "meta",
    ):
        if k in kwargs:
            v = kwargs[k]
            if k in ("attachments", "meta") and not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        conn.close()
        return get_node(nid, user_id=user_id)
    if touch_updated_at:
        sets.append("updated_at=?")
        vals.append(_now())
    conn.execute(f"UPDATE nodes SET {', '.join(sets)} WHERE id=? AND user_id=?", [*vals, nid, user_id])
    row = conn.execute("SELECT * FROM nodes WHERE id=? AND user_id=?", (nid, user_id)).fetchone()
    if row and row["root_id"] != nid and touch_updated_at:
        conn.execute("UPDATE nodes SET updated_at=? WHERE id=? AND user_id=?", (_now(), row["root_id"], user_id))
    conn.commit()
    conn.close()
    return dict(row) if row else None



def delete_subtree(nid: str, user_id: str = LOCAL_USER_ID) -> int:
    """
    级联删除节点及其所有后代。
    返回被删除的节点总数。
    """
    conn = get_db()
    # 先获取 root_id（删除前）
    node = conn.execute("SELECT root_id FROM nodes WHERE id=? AND user_id=?", (nid, user_id)).fetchone()
    if not node:
        conn.close()
        return 0
    root_id = node["root_id"] if node else None

    # BFS 收集所有后代 ID（含自身）
    all_ids = []
    queue = [nid]
    while queue:
        current = queue.pop(0)
        all_ids.append(current)
        children = conn.execute(
            "SELECT id FROM nodes WHERE parent_id=? AND user_id=?", (current, user_id)
        ).fetchall()
        for child in children:
            queue.append(child["id"])

    # 清除引用子树中 nodes 的 nut_id 的外节点
    # （被删节点的 nut_id 引用的 nut 会随 response CASCADE 删除，
    #   但其他未删除的节点也可能引用相同的 nut？不会，每个 nut 只对应一个 followup 节点）
    # 实际上只需清除子树内节点的 nut_id（因为子树内节点的 nut_id 引用的 nut
    # 在删除 response 时会被 CASCADE 删，但节点的 nut_id 字段需要先清空）
    # 更安全做法：先清空子树所有节点的 nut_id
    if all_ids:
        placeholders = ','.join(['?'] * len(all_ids))
        conn.execute(
            f"UPDATE nodes SET nut_id=NULL WHERE user_id=? AND id IN ({placeholders})",
            [user_id, *all_ids]
        )

    # 现在可以安全删除（CASCADE 会自动删 responses → nuts）
    for did in reversed(all_ids):
        conn.execute("DELETE FROM nodes WHERE id=? AND user_id=?", (did, user_id))

    if root_id:
        conn.execute("UPDATE nodes SET updated_at=? WHERE id=? AND user_id=?", (_now(), root_id, user_id))
    conn.commit()
    conn.close()
    return len(all_ids)


def get_node_meta(nid: str, user_id: str = LOCAL_USER_ID) -> dict:
    """读取 node 的 meta JSON"""
    node = get_node(nid, user_id=user_id)
    if not node:
        return {}
    try:
        return json.loads(node.get("meta") or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}


def set_node_meta(nid: str, user_id: str = LOCAL_USER_ID, **kwargs):
    """更新 node 的 meta 字段（合并）"""
    meta = get_node_meta(nid, user_id=user_id)
    meta.update(kwargs)
    update_node(nid, meta=meta, user_id=user_id)


def expand_subtree(nid: str, user_id: str = LOCAL_USER_ID):
    """展开节点及其所有后代（清除 meta.collapsed）"""
    conn = get_db()
    descendants = []
    queue = [nid]
    while queue:
        current = queue.pop(0)
        children = conn.execute(
            "SELECT id FROM nodes WHERE parent_id=? AND user_id=?", (current, user_id)
        ).fetchall()
        for child in children:
            descendants.append(child["id"])
            queue.append(child["id"])

    # 批量更新 meta
    for did in [nid] + descendants:
        meta = {}
        row = conn.execute("SELECT meta FROM nodes WHERE id=? AND user_id=?", (did, user_id)).fetchone()
        if row:
            try:
                meta = json.loads(row["meta"] or "{}")
            except:
                pass
        meta.pop("collapsed", None)
        conn.execute("UPDATE nodes SET meta=? WHERE id=? AND user_id=?",
                     (json.dumps(meta, ensure_ascii=False), did, user_id))
    conn.commit()
    conn.close()


# ═══════════════════════════════════════════════
# Responses
# ═══════════════════════════════════════════════

def create_response(node_id: str, model_id: str, content: str, user_id: str = LOCAL_USER_ID, **kwargs) -> dict:
    conn = get_db()
    rid = kwargs.get("id") or new_id()
    now = _now()
    conn.execute(
        """INSERT INTO responses
           (id, user_id, node_id, model_id, content, status,
            tokens_input, tokens_output, latency_ms, finish_reason,
            thinking_budget, sources, meta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (rid, user_id, node_id, model_id, content,
         kwargs.get("status", "completed"),
         kwargs.get("tokens_input", 0), kwargs.get("tokens_output", 0),
         kwargs.get("latency_ms"), kwargs.get("finish_reason"),
         kwargs.get("thinking_budget", 0),
         json.dumps(kwargs.get("sources", []), ensure_ascii=False),
         json.dumps(kwargs.get("meta", {}), ensure_ascii=False),
         now, now),
    )
    # 更新所属问题树根节点的 updated_at
    node = conn.execute("SELECT root_id FROM nodes WHERE id=? AND user_id=?", (node_id, user_id)).fetchone()
    if node:
        conn.execute("UPDATE nodes SET updated_at=? WHERE id=? AND user_id=?", (now, node["root_id"], user_id))
    conn.commit()
    row = conn.execute("SELECT * FROM responses WHERE id=? AND user_id=?", (rid, user_id)).fetchone()
    conn.close()
    log.debug("创建回复 id=%s node=%s model=%s", rid, node_id, model_id)
    return dict(row)


def get_response(rid: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM responses WHERE id=? AND user_id=?", (rid, user_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_node_responses(node_id: str, user_id: str = LOCAL_USER_ID) -> list[dict]:
    """获取节点的所有回答"""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM responses WHERE node_id=? AND user_id=? ORDER BY created_at", (node_id, user_id)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_response(rid: str, user_id: str = LOCAL_USER_ID, **kwargs) -> Optional[dict]:
    conn = get_db()
    sets = []
    vals = []
    for k in ("content", "status", "tokens_input", "tokens_output",
              "latency_ms", "finish_reason", "thinking_budget", "sources", "meta"):
        if k in kwargs:
            v = kwargs[k]
            if k in ("sources", "meta") and not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        conn.close()
        return get_response(rid, user_id=user_id)
    conn.execute(f"UPDATE responses SET {', '.join(sets)}, updated_at=? WHERE id=? AND user_id=?",
                 [*vals, _now(), rid, user_id])
    conn.commit()
    row = conn.execute("SELECT * FROM responses WHERE id=? AND user_id=?", (rid, user_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_response(rid: str, user_id: str = LOCAL_USER_ID):
    conn = get_db()
    resp = conn.execute("SELECT node_id FROM responses WHERE id=? AND user_id=?", (rid, user_id)).fetchone()
    root_id = None
    if resp:
        node = conn.execute("SELECT root_id FROM nodes WHERE id=? AND user_id=?", (resp["node_id"], user_id)).fetchone()
        root_id = node["root_id"] if node else None

    nuts = conn.execute("SELECT id FROM nuts WHERE response_id=? AND user_id=?", (rid, user_id)).fetchall()
    nut_ids = [n["id"] for n in nuts]
    if nut_ids:
        placeholders = ",".join(["?"] * len(nut_ids))
        linked_nodes = conn.execute(
            f"SELECT id FROM nodes WHERE user_id=? AND nut_id IN ({placeholders})",
            [user_id, *nut_ids],
        ).fetchall()

        # 删除由这些 nut 派生出的追问节点及其全部后代。
        all_ids: list[str] = []
        seen: set[str] = set()
        queue = [row["id"] for row in linked_nodes]
        while queue:
            current = queue.pop(0)
            if current in seen:
                continue
            seen.add(current)
            all_ids.append(current)
            children = conn.execute(
                "SELECT id FROM nodes WHERE parent_id=? AND user_id=?",
                (current, user_id),
            ).fetchall()
            queue.extend(child["id"] for child in children)

        if all_ids:
            node_placeholders = ",".join(["?"] * len(all_ids))
            conn.execute(
                f"UPDATE nodes SET nut_id=NULL WHERE user_id=? AND id IN ({node_placeholders})",
                [user_id, *all_ids],
            )
            for node_id in reversed(all_ids):
                conn.execute("DELETE FROM nodes WHERE id=? AND user_id=?", (node_id, user_id))

    conn.execute("DELETE FROM responses WHERE id=? AND user_id=?", (rid, user_id))
    if root_id:
        conn.execute("UPDATE nodes SET updated_at=? WHERE id=? AND user_id=?", (_now(), root_id, user_id))
    conn.commit()
    conn.close()


def update_response_content(rid: str, content: str, user_id: str = LOCAL_USER_ID) -> None:
    """流式更新 response content — 直接替换整个 content 字段（用于渐进写入）"""
    conn = get_db()
    conn.execute(
        "UPDATE responses SET content=?, updated_at=? WHERE id=? AND user_id=?",
        (content, _now(), rid, user_id)
    )
    conn.commit()
    conn.close()


def get_responses_by_status(node_id: str, status: str, user_id: str = LOCAL_USER_ID) -> list[dict]:
    """按状态查询节点下的 responses（如查询 streaming 中的 response）"""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM responses WHERE node_id=? AND user_id=? AND status=? ORDER BY created_at",
        (node_id, user_id, status)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_node_responses(node_id: str, model_id: str=None, user_id: str = LOCAL_USER_ID) -> int:
    """删除节点的所有 responses（含级联的 nuts），返回删除数量"""
    conn = get_db()
    # 1. 找到这些 responses 的所有 nuts
    if model_id is None:
        resps = conn.execute("SELECT id FROM responses WHERE node_id=? AND user_id=?", (node_id, user_id)).fetchall()
    else:
        resps = conn.execute("SELECT id FROM responses WHERE node_id=? AND user_id=? AND model_id=?", (node_id, user_id, model_id)).fetchall()
    resp_ids = [r["id"] for r in resps]
    count = len(resp_ids)

    if count == 0:
        conn.close()
        return 0

    # 2. 清除引用这些 nuts 的 node 的 nut_id 字段
    # （nodes.nut_id 没有设 ON DELETE CASCADE，需手动清除）
    if resp_ids:
        placeholders = ','.join(['?'] * len(resp_ids))
        nut_ids = conn.execute(
            f"SELECT id FROM nuts WHERE user_id=? AND response_id IN ({placeholders})", [user_id, *resp_ids]
        ).fetchall()
        nut_id_list = [n["id"] for n in nut_ids]
        if nut_id_list:
            nut_placeholders = ','.join(['?'] * len(nut_id_list))
            conn.execute(
                f"UPDATE nodes SET nut_id=NULL WHERE user_id=? AND nut_id IN ({nut_placeholders})",
                [user_id, *nut_id_list]
            )

    # 3. 删除 responses（CASCADE 会自动删除 nuts）
    if model_id is None:
        conn.execute("DELETE FROM responses WHERE node_id=? AND user_id=?", (node_id, user_id))
    else:
        conn.execute("DELETE FROM responses WHERE node_id=? AND user_id=? AND model_id=?", (node_id, user_id, model_id))
    conn.commit()
    conn.close()
    return count


# ═══════════════════════════════════════════════
# Nuts (螺母)
# ═══════════════════════════════════════════════

def create_nut(response_id: str, seek: int, end_seek: int, user_id: str = LOCAL_USER_ID, **kwargs) -> dict:
    conn = get_db()
    nid = kwargs.get("id") or new_id()
    now = _now()
    conn.execute(
        """INSERT INTO nuts (id, user_id, response_id, seek, end_seek, label, style, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (nid, user_id, response_id, seek, end_seek,
         kwargs.get("label"), kwargs.get("style"),
         json.dumps(kwargs.get("meta", {}), ensure_ascii=False), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM nuts WHERE id=? AND user_id=?", (nid, user_id)).fetchone()
    conn.close()
    return dict(row)


def get_nut(nid: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM nuts WHERE id=? AND user_id=?", (nid, user_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_response_nuts(response_id: str, user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM nuts WHERE response_id=? AND user_id=? ORDER BY seek", (response_id, user_id)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_nut(nid: str, user_id: str = LOCAL_USER_ID):
    conn = get_db()
    conn.execute("DELETE FROM nuts WHERE id=? AND user_id=?", (nid, user_id))
    conn.commit()
    conn.close()


# ═══════════════════════════════════════════════
# 模型配置
# ═══════════════════════════════════════════════

def get_model_configs(user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM model_configs WHERE user_id=? ORDER BY name", (user_id,)).fetchall()
    conn.close()
    return [_decrypt_model_config(dict(r)) for r in rows]


def get_model_config(mid: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM model_configs WHERE id=? AND user_id=? AND (deleted=0 OR deleted IS NULL)", (mid, user_id)).fetchone()
    conn.close()
    return _decrypt_model_config(dict(row)) if row else None


def get_model_config_by_id(mid: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    """按 ID 查找模型配置（含已删除），仅用于名称展示等非调用场景"""
    conn = get_db()
    row = conn.execute("SELECT * FROM model_configs WHERE id=? AND user_id=?", (mid, user_id)).fetchone()
    conn.close()
    return _decrypt_model_config(dict(row)) if row else None


def get_all_model_configs_map(user_id: str = LOCAL_USER_ID) -> dict[str, dict]:
    """返回 id -> config 映射（含已删除），用于历史记录中的模型名称解析"""
    conn = get_db()
    rows = conn.execute("SELECT * FROM model_configs WHERE user_id=?", (user_id,)).fetchall()
    conn.close()
    return {r["id"]: _decrypt_model_config(dict(r)) for r in rows}


def save_model_config(cfg: dict, user_id: str = LOCAL_USER_ID) -> dict:
    """保存模型配置。已存在则 UPDATE（仅更新传入字段，保留 usage/input_tokens/output_tokens/deleted），
    不存在则 INSERT。"""
    conn = get_db()
    cfg_id = cfg.get("id") or new_id()

    existing = conn.execute(
        "SELECT * FROM model_configs WHERE id=? AND user_id=?", (cfg_id, user_id)
    ).fetchone()

    if not existing and cfg.get("id"):
        cross_user = conn.execute(
            "SELECT 1 FROM model_configs WHERE id=? AND user_id<>?",
            (cfg_id, user_id),
        ).fetchone()
        if cross_user:
            cfg_id = new_id()

    if existing:
        # UPDATE — 仅覆盖传入字段，usage / input_tokens / output_tokens / deleted 不受影响
        conn.execute(
            """UPDATE model_configs SET
               name=?, provider=?, base_url=?, proxy_url=?, api_key=?, model_name=?,
               max_tokens=?, price_per_input=?, price_per_output=?, price_unit=?,
               thinking_budget=?, meta=?, created_at=?
               WHERE id=? AND user_id=?""",
            (cfg.get("name", existing["name"]),
             cfg.get("provider", existing["provider"]),
             cfg.get("base_url", existing["base_url"]),
             cfg.get("proxy_url", existing["proxy_url"] if "proxy_url" in existing.keys() else ""),
             encrypt_secret(cfg.get("api_key")) if "api_key" in cfg else existing["api_key"],
             cfg.get("model_name", existing["model_name"]),
             cfg.get("max_tokens", existing["max_tokens"]),
             cfg.get("price_per_input", existing["price_per_input"]),
             cfg.get("price_per_output", existing["price_per_output"]),
             cfg.get("price_unit", existing["price_unit"]),
             cfg.get("thinking_budget", existing["thinking_budget"]),
             _json_dumps_meta(cfg.get("meta", existing["meta"])),
             cfg.get("created_at", existing["created_at"]),
             cfg_id, user_id),
        )
    else:
        # INSERT — 新记录
        conn.execute(
            """INSERT INTO model_configs
               (id, user_id, name, provider, base_url, proxy_url, api_key, model_name,
                max_tokens, price_per_input, price_per_output, price_unit,
                thinking_budget, usage, deleted, meta, created_at,
                input_tokens, output_tokens)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0)""",
            (cfg_id, user_id, cfg["name"], cfg["provider"],
             cfg.get("base_url", ""), cfg.get("proxy_url", ""),
             encrypt_secret(cfg.get("api_key", "")),
             cfg["model_name"], cfg.get("max_tokens", 4096),
             cfg.get("price_per_input", 0), cfg.get("price_per_output", 0),
             cfg.get("price_unit", "CNY"),
             cfg.get("thinking_budget", 0),
             _json_dumps_meta(cfg.get("meta")),
             cfg.get("created_at", _now())),
        )

    conn.commit()
    row = conn.execute("SELECT * FROM model_configs WHERE id=? AND user_id=?", (cfg_id, user_id)).fetchone()
    conn.close()
    log.info("保存模型配置 id=%s name=%s", cfg_id, cfg.get("name", "?"))
    return dict(row)


def _json_dumps_meta(v) -> str:
    """安全序列化 meta 字段，防止双重 JSON 编码。
    
    如果 v 已经是字符串（从 DB 读出或前端传回），先尝试 json.loads 还原为对象，
    再重新 json.dumps。对已是 dict/list 的值直接序列化。
    """
    if v is None:
        return "{}"
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            # 递归处理：parsed 也可能是被多层编码的字符串
            if isinstance(parsed, str):
                return _json_dumps_meta(parsed)
            return json.dumps(parsed, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            # 无法解析的纯字符串，直接存原文
            return v
    return json.dumps(v, ensure_ascii=False)


def delete_model_config(mid: str, user_id: str = LOCAL_USER_ID):
    """软删除：标记 deleted=1（保留记录用于历史展示，但前端不再显示）"""
    conn = get_db()
    conn.execute("UPDATE model_configs SET deleted=1 WHERE id=? AND user_id=?", (mid, user_id))
    conn.commit()
    conn.close()


def add_model_usage(mid: str, cost_delta: float, user_id: str = LOCAL_USER_ID):
    """累加模型消费金额（usage += cost_delta），单位与 price_unit 一致"""
    conn = get_db()
    conn.execute(
        "UPDATE model_configs SET usage = COALESCE(usage, 0) + ? WHERE id=? AND user_id=?",
        (cost_delta, mid, user_id),
    )
    conn.commit()
    conn.close()


def add_model_tokens(mid: str, input_delta: int, output_delta: int, user_id: str = LOCAL_USER_ID):
    """累加模型 token 计数（input_tokens += input_delta, output_tokens += output_delta）"""
    conn = get_db()
    conn.execute(
        "UPDATE model_configs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ? WHERE id=? AND user_id=?",
        (input_delta, output_delta, mid, user_id),
    )
    conn.commit()
    conn.close()


# ═══════════════════════════════════════════════
# 家庭共享 MVP
# ═══════════════════════════════════════════════

SHARED_MODEL_PREFIX = "shared:"


def shared_model_id(capability_id: str) -> str:
    return f"{SHARED_MODEL_PREFIX}{capability_id}"


def is_shared_model_id(model_id: str | None) -> bool:
    return bool(model_id and str(model_id).startswith(SHARED_MODEL_PREFIX))


def capability_id_from_model_id(model_id: str) -> str:
    return str(model_id)[len(SHARED_MODEL_PREFIX):]


def _public_shared_capability(row: dict) -> dict:
    cfg = {}
    try:
        cfg = json.loads(row.get("config_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        cfg = {}
    return {
        **row,
        "config": cfg,
        "shared_model_id": shared_model_id(row["id"]),
    }


def create_family(name: str, owner_user_id: str = LOCAL_USER_ID) -> dict:
    fid = new_id()
    now = _now()
    family_name = (name or "Family").strip() or "Family"
    conn = get_db()
    conn.execute(
        "INSERT INTO families (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (fid, family_name, owner_user_id, now, now),
    )
    conn.execute(
        "INSERT INTO family_members (id, family_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
        (new_id(), fid, owner_user_id, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM families WHERE id=?", (fid,)).fetchone()
    conn.close()
    return dict(row)


def list_families_for_user(user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT f.*, fm.role, fm.status
           FROM families f
           JOIN family_members fm ON fm.family_id=f.id
           WHERE fm.user_id=? AND fm.status='active'
           ORDER BY f.updated_at DESC""",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_family_for_user(family_id: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        """SELECT f.*, fm.role, fm.status
           FROM families f
           JOIN family_members fm ON fm.family_id=f.id
           WHERE f.id=? AND fm.user_id=? AND fm.status='active'""",
        (family_id, user_id),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_family_owned_by_user(family_id: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM families WHERE id=? AND owner_user_id=?",
        (family_id, user_id),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def list_family_members(family_id: str, owner_user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT fm.id, fm.family_id, fm.user_id, fm.role, fm.status, fm.created_at,
                  u.email, u.display_name, u.avatar_url
           FROM family_members fm
           JOIN families f ON f.id=fm.family_id
           JOIN users u ON u.id=fm.user_id
           WHERE fm.family_id=? AND f.owner_user_id=?
           ORDER BY CASE fm.role WHEN 'owner' THEN 0 ELSE 1 END, fm.created_at""",
        (family_id, owner_user_id),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_family_member_by_email(
    family_id: str, email: str, owner_user_id: str = LOCAL_USER_ID,
) -> Optional[dict]:
    normalized = (email or "").strip().lower()
    conn = get_db()
    family = conn.execute(
        "SELECT * FROM families WHERE id=? AND owner_user_id=?",
        (family_id, owner_user_id),
    ).fetchone()
    user = conn.execute(
        "SELECT * FROM users WHERE lower(email)=lower(?)",
        (normalized,),
    ).fetchone()
    if not family or not user:
        conn.close()
        return None
    now = _now()
    conn.execute(
        """INSERT INTO family_members (id, family_id, user_id, role, status, created_at)
           VALUES (?, ?, ?, 'member', 'active', ?)
           ON CONFLICT(family_id, user_id) DO UPDATE SET status='active', role='member'""",
        (new_id(), family_id, user["id"], now),
    )
    conn.commit()
    row = conn.execute(
        """SELECT fm.id, fm.family_id, fm.user_id, fm.role, fm.status, fm.created_at,
                  u.email, u.display_name, u.avatar_url
           FROM family_members fm
           JOIN users u ON u.id=fm.user_id
           WHERE fm.family_id=? AND fm.user_id=?""",
        (family_id, user["id"]),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def remove_family_member(family_id: str, member_user_id: str, owner_user_id: str = LOCAL_USER_ID) -> bool:
    conn = get_db()
    family = conn.execute(
        "SELECT * FROM families WHERE id=? AND owner_user_id=?",
        (family_id, owner_user_id),
    ).fetchone()
    if not family or member_user_id == owner_user_id:
        conn.close()
        return False
    cur = conn.execute(
        "UPDATE family_members SET status='removed' WHERE family_id=? AND user_id=? AND role<>'owner'",
        (family_id, member_user_id),
    )
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def create_shared_model_capability(
    family_id: str,
    model_id: str,
    name: str,
    owner_user_id: str = LOCAL_USER_ID,
    config: Optional[dict] = None,
) -> Optional[dict]:
    conn = get_db()
    family = conn.execute(
        "SELECT * FROM families WHERE id=? AND owner_user_id=?",
        (family_id, owner_user_id),
    ).fetchone()
    model = conn.execute(
        "SELECT * FROM model_configs WHERE id=? AND user_id=? AND (deleted=0 OR deleted IS NULL)",
        (model_id, owner_user_id),
    ).fetchone()
    if not family or not model:
        conn.close()
        return None
    cid = new_id()
    now = _now()
    display_name = (name or model["name"] or model_id).strip()
    conn.execute(
        """INSERT INTO shared_capabilities
           (id, family_id, credential_id, type, name, config_json, is_active, created_at, updated_at)
           VALUES (?, ?, ?, 'model', ?, ?, 1, ?, ?)""",
        (cid, family_id, model_id, display_name, json.dumps(config or {}, ensure_ascii=False), now, now),
    )
    conn.commit()
    row = conn.execute(
        """SELECT sc.*, f.owner_user_id
           FROM shared_capabilities sc
           JOIN families f ON f.id=sc.family_id
           WHERE sc.id=?""",
        (cid,),
    ).fetchone()
    conn.close()
    return _public_shared_capability(dict(row)) if row else None


def list_shared_capabilities_for_family(family_id: str, user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT sc.*, f.owner_user_id
           FROM shared_capabilities sc
           JOIN families f ON f.id=sc.family_id
           JOIN family_members fm ON fm.family_id=f.id
           WHERE sc.family_id=? AND fm.user_id=? AND fm.status='active'
           ORDER BY sc.created_at DESC""",
        (family_id, user_id),
    ).fetchall()
    conn.close()
    return [_public_shared_capability(dict(r)) for r in rows]


def list_shared_model_configs_for_user(user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT sc.id AS capability_id, sc.name AS capability_name, sc.family_id,
                  sc.config_json, sc.is_active, f.name AS family_name, f.owner_user_id,
                  mc.*
           FROM shared_capabilities sc
           JOIN families f ON f.id=sc.family_id
           JOIN family_members fm ON fm.family_id=f.id
           JOIN model_configs mc ON mc.id=sc.credential_id AND mc.user_id=f.owner_user_id
           WHERE fm.user_id=? AND fm.status='active'
             AND sc.type='model' AND sc.is_active=1
             AND (mc.deleted=0 OR mc.deleted IS NULL)
           ORDER BY f.name, sc.name""",
        (user_id,),
    ).fetchall()
    conn.close()
    configs = []
    for r in rows:
        row = _decrypt_model_config(dict(r))
        cfg = {
            "id": shared_model_id(row["capability_id"]),
            "name": f"{row['capability_name']} · {row['family_name']}",
            "provider": row["provider"],
            "base_url": row["base_url"],
            "proxy_url": row.get("proxy_url", ""),
            "api_key": "",
            "model_name": row["model_name"],
            "max_tokens": row["max_tokens"],
            "price_per_input": row["price_per_input"],
            "price_per_output": row["price_per_output"],
            "price_unit": row.get("price_unit", "CNY"),
            "thinking_budget": row.get("thinking_budget", 0),
            "usage": 0,
            "deleted": 0,
            "meta": json.dumps({
                "shared": True,
                "family_id": row["family_id"],
                "family_name": row["family_name"],
                "capability_id": row["capability_id"],
                "owner_user_id": row["owner_user_id"],
                "source_model_id": row["credential_id"],
            }, ensure_ascii=False),
            "created_at": row["created_at"],
            "recent_usage_count": 0,
            "recent_token_usage": 0,
        }
        configs.append(cfg)
    return configs


def resolve_shared_model_config(shared_id: str, user_id: str = LOCAL_USER_ID) -> Optional[dict]:
    capability_id = capability_id_from_model_id(shared_id) if is_shared_model_id(shared_id) else shared_id
    conn = get_db()
    row = conn.execute(
        """SELECT sc.id AS capability_id, sc.name AS capability_name, sc.family_id,
                  sc.config_json, f.name AS family_name, f.owner_user_id, mc.*
           FROM shared_capabilities sc
           JOIN families f ON f.id=sc.family_id
           JOIN family_members fm ON fm.family_id=f.id
           JOIN model_configs mc ON mc.id=sc.credential_id AND mc.user_id=f.owner_user_id
           WHERE sc.id=? AND fm.user_id=? AND fm.status='active'
             AND sc.type='model' AND sc.is_active=1
             AND (mc.deleted=0 OR mc.deleted IS NULL)""",
        (capability_id, user_id),
    ).fetchone()
    conn.close()
    if not row:
        return None
    cfg = _decrypt_model_config(dict(row))
    cfg["id"] = shared_model_id(cfg["capability_id"])
    cfg["name"] = f"{cfg['capability_name']} · {cfg['family_name']}"
    cfg["_shared"] = {
        "capability_id": cfg["capability_id"],
        "family_id": cfg["family_id"],
        "owner_user_id": cfg["owner_user_id"],
        "source_model_id": cfg["credential_id"],
    }
    return cfg


def set_shared_capability_active(
    capability_id: str, is_active: bool, owner_user_id: str = LOCAL_USER_ID,
) -> Optional[dict]:
    conn = get_db()
    cap = conn.execute(
        """SELECT sc.id
           FROM shared_capabilities sc
           JOIN families f ON f.id=sc.family_id
           WHERE sc.id=? AND f.owner_user_id=?""",
        (capability_id, owner_user_id),
    ).fetchone()
    if not cap:
        conn.close()
        return None
    conn.execute(
        "UPDATE shared_capabilities SET is_active=?, updated_at=? WHERE id=?",
        (1 if is_active else 0, _now(), capability_id),
    )
    conn.commit()
    row = conn.execute(
        """SELECT sc.*, f.owner_user_id
           FROM shared_capabilities sc
           JOIN families f ON f.id=sc.family_id
           WHERE sc.id=?""",
        (capability_id,),
    ).fetchone()
    conn.close()
    return _public_shared_capability(dict(row)) if row else None


def delete_shared_capability(capability_id: str, owner_user_id: str = LOCAL_USER_ID) -> bool:
    conn = get_db()
    cur = conn.execute(
        """DELETE FROM shared_capabilities
           WHERE id=? AND family_id IN (SELECT id FROM families WHERE owner_user_id=?)""",
        (capability_id, owner_user_id),
    )
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def add_usage_log(
    user_id: str,
    family_id: str,
    capability_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    estimated_cost: float,
) -> dict:
    conn = get_db()
    uid = new_id()
    conn.execute(
        """INSERT INTO usage_logs
           (id, user_id, family_id, capability_id, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            uid, user_id, family_id, capability_id, provider or "", model or "",
            int(input_tokens or 0), int(output_tokens or 0), float(estimated_cost or 0), _now(),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM usage_logs WHERE id=?", (uid,)).fetchone()
    conn.close()
    return dict(row)


def list_family_usage(family_id: str, owner_user_id: str = LOCAL_USER_ID, limit: int = 200) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT ul.*, u.email, u.display_name, sc.name AS capability_name
           FROM usage_logs ul
           JOIN families f ON f.id=ul.family_id
           LEFT JOIN users u ON u.id=ul.user_id
           LEFT JOIN shared_capabilities sc ON sc.id=ul.capability_id
           WHERE ul.family_id=? AND f.owner_user_id=?
           ORDER BY ul.created_at DESC
           LIMIT ?""",
        (family_id, owner_user_id, int(limit)),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def cleanup_orphan_models(user_id: str | None = None) -> int:
    """硬删除没有任何回答关联的已删除模型配置。

    用于后台守护任务定期清理，防止模型配置表爆炸。
    返回删除的模型数量。
    """
    conn = get_db()
    # 找出所有在 responses 表中没有记录的 model_configs，排除默认模型
    params: list = []
    user_filter = ""
    if user_id:
        user_filter = " AND mc.user_id=?"
        params.append(user_id)
    rows = conn.execute(f"""
        SELECT mc.id, mc.name FROM model_configs mc
        WHERE NOT EXISTS (
            SELECT 1 FROM responses r WHERE r.model_id = mc.id AND r.user_id = mc.user_id
        )
          AND mc.deleted = 1
          {user_filter}
    """, params).fetchall()
    count = len(rows)
    if count > 0:
        ids = [r["id"] for r in rows]
        if user_id:
            conn.executemany("DELETE FROM model_configs WHERE id=? AND user_id=?", [(i, user_id) for i in ids])
        else:
            conn.executemany("DELETE FROM model_configs WHERE id=?", [(i,) for i in ids])
        conn.commit()
        log.info("cleanup_orphan_models: 硬删除 %d 个无关联回答的模型: %s",
                 count, [r["name"] for r in rows])
    conn.close()
    return count


def cleanup_zombie_streaming() -> int:
    """清理僵尸 streaming response：服务重启后遗留的 streaming 状态记录。
    
    - 内容为空的 → 标记为 error（meta 中记录原因）
    - 有部分内容的 → 标记为 completed（保留已有内容）
    """
    conn = get_db()
    # 找到所有 status='streaming' 的 response
    rows = conn.execute(
        "SELECT id, content, meta FROM responses WHERE status='streaming'"
    ).fetchall()
    
    if not rows:
        conn.close()
        return 0
    
    count = 0
    for row in rows:
        rid, content, meta = row["id"], row["content"], row["meta"]
        if content and content.strip():
            # 有部分内容 → 保留为 completed
            conn.execute(
                "UPDATE responses SET status='completed', updated_at=datetime('now') WHERE id=?",
                (rid,)
            )
            log.info("cleanup_zombie_streaming: response %s 有部分内容，标记为 completed", rid[:12])
        else:
            # 内容为空 → 标记为 error
            try:
                meta_obj = json.loads(meta) if meta else {}
                if not isinstance(meta_obj, dict):
                    meta_obj = {}
            except (json.JSONDecodeError, TypeError):
                meta_obj = {}
            meta_obj["error"] = "流式输出中断（服务重启）"
            conn.execute(
                "UPDATE responses SET status='error', meta=?, updated_at=datetime('now') WHERE id=?",
                (json.dumps(meta_obj, ensure_ascii=False), rid)
            )
            log.info("cleanup_zombie_streaming: response %s 内容为空，标记为 error", rid[:12])
        count += 1
    
    conn.commit()
    conn.close()
    return count


# ═══════════════════════════════════════════════
# Settings
# ═══════════════════════════════════════════════

def get_setting(key: str, default: str = "", user_id: str = LOCAL_USER_ID) -> str:
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE user_id=? AND key=?", (user_id, key)).fetchone()
    conn.close()
    if not row:
        return default
    value = row["value"]
    return decrypt_secret(value) if "api_key" in key else value


def set_setting(key: str, value: str, user_id: str = LOCAL_USER_ID):
    conn = get_db()
    stored_value = encrypt_secret(value) if "api_key" in key else value
    conn.execute("INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)", (user_id, key, stored_value))
    conn.commit()
    conn.close()


def batch_set_settings(data: dict[str, str], user_id: str = LOCAL_USER_ID):
    """批量写入设置（单连接），避免并发锁错误"""
    conn = get_db()
    for key, value in data.items():
        stored_value = encrypt_secret(str(value)) if "api_key" in key else str(value)
        conn.execute("INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)", (user_id, key, stored_value))
    conn.commit()
    conn.close()


def get_all_settings(user_id: str = LOCAL_USER_ID) -> dict:
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings WHERE user_id=?", (user_id,)).fetchall()
    conn.close()
    return {
        r["key"]: decrypt_secret(r["value"]) if "api_key" in r["key"] else r["value"]
        for r in rows
    }


def increment_setting_ints(increments: dict[str, int], user_id: str = LOCAL_USER_ID) -> dict[str, int]:
    """Atomically increment integer settings and return their new values."""
    conn = get_db()
    next_values: dict[str, int] = {}
    for key, delta in increments.items():
        row = conn.execute(
            "SELECT value FROM settings WHERE user_id=? AND key=?",
            (user_id, key),
        ).fetchone()
        try:
            current = int(row["value"]) if row and row["value"] is not None else 0
        except (TypeError, ValueError):
            current = 0
        next_value = current + int(delta)
        conn.execute(
            "INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)",
            (user_id, key, str(next_value)),
        )
        next_values[key] = next_value
    conn.commit()
    conn.close()
    return next_values


# ═══════════════════════════════════════════════
# 搜索
# ═══════════════════════════════════════════════

DEFAULT_SEARCH_GROUP_ID = "__default__"


def _search_group_filter_sql(group_ids: list[str] | None, root_alias: str = "root") -> tuple[str, list[str]]:
    """Build an optional SQL filter for root sidebar groups."""
    if not group_ids:
        return "", []

    include_default = DEFAULT_SEARCH_GROUP_ID in group_ids
    custom_group_ids = [gid for gid in group_ids if gid and gid != DEFAULT_SEARCH_GROUP_ID]
    clauses = []
    params: list[str] = []
    if custom_group_ids:
        placeholders = ",".join("?" for _ in custom_group_ids)
        clauses.append(f"{root_alias}.group_id IN ({placeholders})")
        params.extend(custom_group_ids)
    if include_default:
        clauses.append(f"{root_alias}.group_id IS NULL")
    if not clauses:
        return "", []
    return f" AND ({' OR '.join(clauses)})", params


def search_nodes(query: str, user_id: str = LOCAL_USER_ID, group_ids: list[str] | None = None) -> list[dict]:
    """FTS5 搜索节点内容，CJK 用 LIKE fallback"""
    conn = get_db()
    has_cjk = bool(re.search(r'[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]', query))
    group_filter, group_params = _search_group_filter_sql(group_ids)
    if has_cjk:
        rows = conn.execute(
            f"""SELECT n.* FROM nodes n
                JOIN nodes root ON root.id = COALESCE(n.root_id, n.id)
                                AND root.user_id = n.user_id
                WHERE n.user_id=? AND n.content LIKE ?{group_filter}
                ORDER BY n.created_at DESC LIMIT 50""",
            [user_id, f"%{query}%"] + group_params,
        ).fetchall()
    else:
        try:
            rows = conn.execute(
                """SELECT n.* FROM nodes n
                   JOIN nodes_fts fts ON n.rowid = fts.rowid
                   JOIN nodes root ON root.id = COALESCE(n.root_id, n.id)
                                   AND root.user_id = n.user_id
                   WHERE n.user_id=? AND nodes_fts MATCH ?""" + group_filter + """
                   ORDER BY rank LIMIT 50""",
                [user_id, query] + group_params,
            ).fetchall()
        except Exception:
            rows = conn.execute(
                f"""SELECT n.* FROM nodes n
                    JOIN nodes root ON root.id = COALESCE(n.root_id, n.id)
                                    AND root.user_id = n.user_id
                    WHERE n.user_id=? AND n.content LIKE ?{group_filter}
                    ORDER BY n.created_at DESC LIMIT 50""",
                [user_id, f"%{query}%"] + group_params,
            ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_responses(query: str, user_id: str = LOCAL_USER_ID, group_ids: list[str] | None = None) -> list[dict]:
    """FTS5 搜索回答内容"""
    conn = get_db()
    has_cjk = bool(re.search(r'[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]', query))
    group_filter, group_params = _search_group_filter_sql(group_ids)
    if has_cjk:
        rows = conn.execute(
            f"""SELECT r.* FROM responses r
                JOIN nodes n ON n.id = r.node_id AND n.user_id = r.user_id
                JOIN nodes root ON root.id = COALESCE(n.root_id, n.id)
                                AND root.user_id = n.user_id
                WHERE r.user_id=? AND r.content LIKE ?{group_filter}
                ORDER BY r.created_at DESC LIMIT 50""",
            [user_id, f"%{query}%"] + group_params,
        ).fetchall()
    else:
        try:
            rows = conn.execute(
                """SELECT r.* FROM responses r
                   JOIN responses_fts fts ON r.rowid = fts.rowid
                   JOIN nodes n ON n.id = r.node_id AND n.user_id = r.user_id
                   JOIN nodes root ON root.id = COALESCE(n.root_id, n.id)
                                   AND root.user_id = n.user_id
                   WHERE r.user_id=? AND responses_fts MATCH ?""" + group_filter + """
                   ORDER BY rank LIMIT 50""",
                [user_id, query] + group_params,
            ).fetchall()
        except Exception:
            rows = conn.execute(
                f"""SELECT r.* FROM responses r
                    JOIN nodes n ON n.id = r.node_id AND n.user_id = r.user_id
                    JOIN nodes root ON root.id = COALESCE(n.root_id, n.id)
                                    AND root.user_id = n.user_id
                    WHERE r.user_id=? AND r.content LIKE ?{group_filter}
                    ORDER BY r.created_at DESC LIMIT 50""",
                [user_id, f"%{query}%"] + group_params,
            ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_all(query: str, user_id: str = LOCAL_USER_ID, group_ids: list[str] | None = None) -> list[dict]:
    """同时搜索 nodes 和 responses，返回合并结果带 root 信息。"""
    nodes = search_nodes(query, user_id=user_id, group_ids=group_ids)
    responses = search_responses(query, user_id=user_id, group_ids=group_ids)
    conn = get_db()
    results = []
    for n in nodes:
        results.append({"type": "node", **n})
    for r in responses:
        # 补充 root_id
        node = conn.execute("SELECT root_id FROM nodes WHERE id=? AND user_id=?", (r["node_id"], user_id)).fetchone()
        r["root_id"] = node["root_id"] if node else None
        results.append({"type": "response", **r})
    conn.close()
    return results


# ═══════════════════════════════════════════════
# Token 统计
# ═══════════════════════════════════════════════

def get_token_usage(user_id: str = LOCAL_USER_ID) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT model_id,
                  SUM(tokens_input) as total_input,
                  SUM(tokens_output) as total_output,
                  COUNT(*) as resp_count
           FROM responses
           WHERE user_id=?
           GROUP BY model_id
           ORDER BY total_input DESC""",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_token_usage_call_counts(user_id: str = LOCAL_USER_ID) -> dict:
    """返回 {model_id: call_count} 映射（仅计数，用于 /api/token-usage）"""
    conn = get_db()
    rows = conn.execute(
        "SELECT model_id, COUNT(*) as cnt FROM responses WHERE user_id=? GROUP BY model_id",
        (user_id,),
    ).fetchall()
    conn.close()
    return {r["model_id"]: r["cnt"] for r in rows}


def get_recent_model_usage(days: int = 2, user_id: str = LOCAL_USER_ID) -> dict:
    """返回最近 N 天内各模型的使用次数和 token 总量。"""
    conn = get_db()
    rows = conn.execute(
        """SELECT model_id,
                  COUNT(*) as usage_count,
                  SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)) as token_usage
           FROM responses
           WHERE user_id=? AND created_at >= datetime('now', ?)
           GROUP BY model_id""",
        (user_id, f"-{days} days"),
    ).fetchall()
    conn.close()
    return {
        r["model_id"]: {
            "usage_count": r["usage_count"] or 0,
            "token_usage": r["token_usage"] or 0,
        }
        for r in rows
    }
