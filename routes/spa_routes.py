from app_state import DIST_DIR
from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

router = APIRouter()

@router.get("/", response_class=HTMLResponse)
async def serve_spa():
    index_html = DIST_DIR / "index.html"
    if index_html.exists():
        return FileResponse(str(index_html))
    return HTMLResponse(
        """
        <!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>MegaForm</title>
          </head>
          <body>
            <main style="font-family: system-ui, sans-serif; max-width: 640px; margin: 15vh auto; line-height: 1.6;">
              <h1>MegaForm 后端已启动</h1>
              <p>未找到前端构建产物 <code>static/dist/index.html</code>。</p>
              <p>开发模式请运行 <code>cd frontend && npm run dev</code> 后访问 <code>http://localhost:5173</code>。</p>
              <p>生产模式请先运行 <code>cd frontend && npm run build</code>，再访问 <code>http://localhost:8080</code>。</p>
            </main>
          </body>
        </html>
        """,
        status_code=200,
    )


# ═══════════════════════════════════════════════
# API: Roots
# ═══════════════════════════════════════════════


@router.get("/{path:path}")
async def spa_catchall(path: str):
    """SPA 路由 fallback: 优先尝试静态文件，否则返回 index.html"""
    static_file = DIST_DIR / path
    if static_file.exists() and static_file.is_file():
        return FileResponse(str(static_file))
    # SPA fallback
    index_html = DIST_DIR / "index.html"
    if index_html.exists():
        return FileResponse(str(index_html))
    return JSONResponse({"error": "Not found"}, status_code=404)


# ── 启动 ─────────────────────────────────────────────────────────────
