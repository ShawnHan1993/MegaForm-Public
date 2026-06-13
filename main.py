"""MegaForm FastAPI application entrypoint."""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app_state import DIST_DIR, lifespan
from routes.auth_routes import router as auth_router
from routes.tree_routes import router as tree_router
from routes.import_routes import router as import_router
from routes.chat_routes import router as chat_router
from routes.response_routes import router as response_router
from routes.settings_routes import router as settings_router
from routes.spa_routes import router as spa_router

app = FastAPI(title="MegaForm", lifespan=lifespan)

# 开发时 Vite dev server 处理 HMR，生产时 FastAPI serve dist/
if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")

app.include_router(auth_router)
app.include_router(tree_router)
app.include_router(import_router)
app.include_router(chat_router)
app.include_router(response_router)
app.include_router(settings_router)
# SPA fallback 必须最后注册，避免吞掉 API 路由。
app.include_router(spa_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
