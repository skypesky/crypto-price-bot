# ============================================================
# Crypto Price Bot v2 - Makefile
#
# 设计原则（沿用 v1）：
#   - make dev / start / stop / build / test → native（铁律：不碰 docker）
#   - make xxx.docker                       → Docker 系列
# ============================================================

.PHONY: install dev build start stop test test.coverage clean help \
        build.docker dev.docker start.docker stop.docker restart.docker \
        logs.docker shell.docker clean.docker

# === 变量 ===
IMAGE_NAME       := crypto-price-bot
IMAGE_TAG        := latest
CONTAINER_NAME   := crypto-price-bot
ENV_FILE         := .env

# === 帮助 ===
help:
	@echo "Crypto Price Bot v2 - Makefile"
	@echo ""
	@echo "Native 服务（铁律不碰 docker）:"
	@echo "  make install         安装依赖 (server + web)"
	@echo "  make dev             启动开发模式（并行 server + web）"
	@echo "  make build           编译后端 + 前端"
	@echo "  make start           启动生产模式 (前台)"
	@echo "  make stop            停止 native 进程"
	@echo "  make test            运行测试 (server vitest)"
	@echo "  make test.coverage   单元测试 + 覆盖率"
	@echo "  make clean           清理 dist + node_modules + data"
	@echo ""
	@echo "Docker 系列 (xxx.docker):"
	@echo "  make build.docker        构建镜像"
	@echo "  make dev.docker          启动容器 (假定镜像已存在)"
	@echo "  make start.docker        重建并启动"
	@echo "  make stop.docker         停止容器"
	@echo "  make restart.docker      重启容器"
	@echo "  make logs.docker         跟踪日志"
	@echo "  make shell.docker        进入容器 shell"
	@echo "  make clean.docker        删除容器和镜像"

# ============================================================
# Native 服务
# ============================================================

install:
	@echo "Installing server deps..."
	@cd server && npm install
	@echo "Installing web deps..."
	@cd web && npm install
	@echo "✅ Done."

# 杀旧 native 进程
kill-old:
	@if pgrep -f "node.*dist/index.js" > /dev/null; then \
		echo "Stopping old server..."; \
		pkill -f "node.*dist/index.js" 2>/dev/null || true; \
		sleep 1; \
	fi

build:
	@echo "Building server..."
	@cd server && npm run build
	@echo "Building web..."
	@cd web && npm run build
	@echo "✅ Build complete."

dev: kill-old
	@if [ ! -f $(ENV_FILE) ]; then \
		echo "❌ $(ENV_FILE) not found. cp .env.example .env 并填入配置"; \
		exit 1; \
	fi
	@echo "Starting dev mode (server tsx watch + web vite)..."
	@cd server && set -a && . ../$(ENV_FILE) && set +a && npx tsx watch src/index.ts &
	@cd web && npx vite

start: kill-old build
	@if [ ! -f $(ENV_FILE) ]; then \
		echo "❌ $(ENV_FILE) not found. cp .env.example .env 并填入配置"; \
		exit 1; \
	fi
	@echo "Starting production mode..."
	@set -a && . $(ENV_FILE) && set +a && node server/dist/index.js

stop:
	@echo "Stopping native service..."
	@pkill -f "node.*dist/index.js" 2>/dev/null || true
	@echo "✅ Stopped."

# ============================================================
# 测试
# ============================================================

test:
	@echo "Running tests..."
	@cd server && npm test

test.coverage:
	@echo "Running tests with coverage..."
	@cd server && npm run test:coverage

# ============================================================
# Docker 系列
# ============================================================

build.docker:
	@echo "Building Docker image..."
	@docker build -t $(IMAGE_NAME):$(IMAGE_TAG) .
	@echo "✅ Image built: $(IMAGE_NAME):$(IMAGE_TAG)"

dev.docker:
	@if [ ! -f $(ENV_FILE) ]; then \
		echo "❌ $(ENV_FILE) not found. cp .env.example .env 并填入配置"; \
		exit 1; \
	fi
	@docker compose up -d
	@echo "✅ Started. Use 'make logs.docker' to follow."

start.docker: build.docker dev.docker

stop.docker:
	@docker compose down

restart.docker: stop.docker dev.docker

logs.docker:
	@docker compose logs -f

shell.docker:
	@docker compose exec crypto-price-bot sh

clean.docker:
	@docker compose down --rmi all 2>/dev/null || true
	@echo "✅ Docker cleaned."

# ============================================================
# 清理
# ============================================================

clean: clean.docker
	@rm -rf server/dist server/src/static web/dist data/*.db
	@echo "✅ Cleaned."